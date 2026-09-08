import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"

import {
  createAdminRepository,
  type AdminSessionRecord,
} from "~/lib/storage/admin-repository"
import { credentialDigest } from "~/lib/storage/credentials-repository"
import { StorageConflictError, StorageSchemaError } from "~/lib/storage/errors"
import { getStorageRuntime } from "~/lib/storage/runtime"

import {
  isConfiguredInferenceCredential,
  registerCredentialProvider,
  resolveGatewayCredential,
  resolveRequestCredentialKind,
} from "./credential-resolver"
import { extractClientIpFromHeaders, isIpBlocked } from "./ip-blocker"
import { hasActiveGatewayCredentials } from "./request-auth"

export const ADMIN_SESSION_COOKIE = "__Host-copilot_admin"
export const ADMIN_CSRF_COOKIE = "__Host-copilot_admin_csrf"
export const ADMIN_PASSWORD_MIN_LENGTH = 4
export const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const ADMIN_SETUP_CODE_TTL_MS = 15 * 60 * 1000
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000
const ARGON2ID_HASH_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/
const ARGON2ID_MIN_MEMORY_COST = 65_536
const ARGON2ID_MAX_MEMORY_COST = 1_048_576
const ARGON2ID_MIN_TIME_COST = 3
const ARGON2ID_MAX_TIME_COST = 10
const ARGON2ID_MIN_PARALLELISM = 1
const ARGON2ID_MAX_PARALLELISM = 16
const ARGON2ID_MIN_SALT_BYTES = 16
const ARGON2ID_MIN_HASH_BYTES = 32

export interface CreatedAdminSession {
  token: string
  csrfToken: string
  expiresAt: number
}
export interface AuthenticatedAdminSession {
  tokenHash: string
  csrfToken: string
  expiresAt: number
}
export interface AdminAuthClock {
  now(): number
}
type ChangeAdminPasswordError = {
  error: string
  reason: "credential" | "managed" | "session" | "validation"
}
let clock: AdminAuthClock = { now: () => Date.now() }
function now(): number {
  return clock.now()
}
function repository() {
  return createAdminRepository(getStorageRuntime().storage)
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}
function randomToken(): string {
  return randomBytes(32).toString("base64url")
}
function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  )
}
function validatePassword(password: string): string | null {
  return password.length < ADMIN_PASSWORD_MIN_LENGTH ?
      `Admin password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`
    : null
}
function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  })
}
function newSession(version: number): {
  session: CreatedAdminSession
  record: AdminSessionRecord
} {
  const token = randomToken(),
    csrfToken = randomToken(),
    currentTime = now()
  const expiresAt = currentTime + ADMIN_SESSION_TTL_MS
  return {
    session: { token, csrfToken, expiresAt },
    record: {
      tokenHash: digest(token),
      csrfHash: digest(csrfToken),
      sessionVersion: version,
      createdAt: currentTime,
      lastSeenAt: currentTime,
      expiresAt,
    },
  }
}

export function validateAdminPasswordHash(hash: string): string {
  const configured = hash.trim()
  if (!configured) {
    throw new Error("Administrator password hash cannot be empty")
  }

  const match = ARGON2ID_HASH_PATTERN.exec(configured)
  if (!match) {
    throw new Error(
      "Administrator password hash must be a valid Argon2id PHC string",
    )
  }
  const memoryCost = Number(match[1])
  const timeCost = Number(match[2])
  const parallelism = Number(match[3])
  const saltBytes = decodeCanonicalBase64(match[4])
  const hashBytes = decodeCanonicalBase64(match[5])
  if (
    memoryCost < ARGON2ID_MIN_MEMORY_COST
    || memoryCost > ARGON2ID_MAX_MEMORY_COST
    || timeCost < ARGON2ID_MIN_TIME_COST
    || timeCost > ARGON2ID_MAX_TIME_COST
    || parallelism < ARGON2ID_MIN_PARALLELISM
    || parallelism > ARGON2ID_MAX_PARALLELISM
    || saltBytes < ARGON2ID_MIN_SALT_BYTES
    || hashBytes < ARGON2ID_MIN_HASH_BYTES
  ) {
    throw new Error(
      "Administrator password hash has unsupported Argon2id parameters",
    )
  }
  return configured
}

function decodeCanonicalBase64(value: string): number {
  const decoded = Buffer.from(value, "base64")
  const canonical = decoded.toString("base64").replace(/=+$/, "")
  if (canonical !== value) {
    throw new Error("Administrator password hash has invalid Base64 encoding")
  }
  return decoded.byteLength
}

export async function getAdminAuthStatus(): Promise<{
  configured: boolean
  gatewayConfigured: boolean
  passwordManagedExternally: boolean
}> {
  const [admin, gatewayConfigured] = await Promise.all([
    repository().get(),
    hasActiveGatewayCredentials(),
  ])
  return {
    configured: admin !== null,
    gatewayConfigured,
    passwordManagedExternally: false,
  }
}
export async function initializeAdminAuth(): Promise<void> {
  const admin = await repository().get()
  if (admin) validateAdminPasswordHash(admin.passwordHash)
}
export async function issueAdminSetupCode(): Promise<{
  code: string
  expiresAt: number
}> {
  const code = randomToken(),
    currentTime = now(),
    expiresAt = currentTime + ADMIN_SETUP_CODE_TTL_MS
  await repository().issueSetupCode({
    digest: digest(code),
    now: currentTime,
    expiresAt,
  })
  return { code, expiresAt }
}
export async function setupAdminAuth(
  gatewayKey: string,
  password: string,
  setupCode?: string,
): Promise<{ session: CreatedAdminSession } | { error: string }> {
  if (await repository().get())
    return { error: "Administrator authentication is already configured" }
  if (
    !setupCode
    || !gatewayKey.trim()
    || safeEqual(gatewayKey.trim(), setupCode)
    || (await isConfiguredInferenceCredential(gatewayKey.trim()))
  )
    return { error: "Authentication failed" }
  const error = validatePassword(password)
  if (error) return { error }
  const passwordHash = await hashPassword(password)
  const created = newSession(1)
  const result = await repository().setup({
    codeDigest: digest(setupCode),
    passwordHash,
    gatewayLiteral: gatewayKey.trim(),
    gateway: {
      id: randomUUID(),
      digest: credentialDigest(gatewayKey.trim()),
      label: "Initial gateway key",
      createdAt: created.record.createdAt,
    },
    session: created.record,
  })
  if (result !== "ok")
    return {
      error:
        result === "configured" ?
          "Administrator authentication is already configured"
        : "Authentication failed",
    }
  return { session: created.session }
}
async function verifyPassword(
  password: string,
  passwordHash?: string,
): Promise<boolean> {
  if (!passwordHash) {
    await hashPassword(password || "invalid-admin-password")
    return false
  }
  try {
    validateAdminPasswordHash(passwordHash)
  } catch {
    throw new StorageSchemaError("Invalid administrator password verifier")
  }
  return Bun.password.verify(password, passwordHash)
}
export async function loginAdmin(
  gatewayKey: string,
  password: string,
): Promise<CreatedAdminSession | null> {
  const admin = await repository().get()
  const validPassword = await verifyPassword(password, admin?.passwordHash)
  if (
    !admin
    || !validPassword
    || validatePassword(password)
    || !(await resolveGatewayCredential(gatewayKey))
  )
    return null
  const created = newSession(admin.sessionVersion)
  return (
      (await repository().createSession({
        admin,
        gatewayDigest: credentialDigest(gatewayKey.trim()),
        gatewayLiteral: gatewayKey.trim(),
        session: created.record,
      }))
    ) ?
      created.session
    : null
}

function parseCookieHeader(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >
  if (!header) return cookies
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=")
    if (separator < 1) continue
    const key = segment.slice(0, separator).trim()
    const value = segment.slice(separator + 1).trim()
    if (key) cookies[key] = value
  }
  return cookies
}

async function resolveAdminSession(
  request: Request,
  options: { requireCsrf?: boolean } = {},
): Promise<AuthenticatedAdminSession | null> {
  const cookies = parseCookieHeader(request.headers.get("cookie"))
  const token = cookies[ADMIN_SESSION_COOKIE]
  if (!token || (await isConfiguredInferenceCredential(token))) return null
  const currentTime = now()
  const tokenHash = digest(token)
  const session = await repository().session(tokenHash, currentTime)
  if (!session) return null
  const csrfToken = cookies[ADMIN_CSRF_COOKIE] ?? ""
  if (options.requireCsrf) {
    const supplied = request.headers.get("x-copilot-csrf")
    if (
      !csrfToken
      || !supplied
      || !safeEqual(csrfToken, supplied)
      || !safeEqual(digest(supplied), session.csrfHash)
      || !isAllowedAdminOrigin(request.headers.get("origin"))
    )
      return null
  }
  if (
    currentTime - session.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS
    && !(await repository().refreshSession(
      session,
      currentTime,
      ADMIN_SESSION_TTL_MS,
    ))
  )
    return null
  return { tokenHash, csrfToken, expiresAt: currentTime + ADMIN_SESSION_TTL_MS }
}
export async function authenticateAdminRequest(
  request: Request,
  options: { requireCsrf?: boolean } = {},
): Promise<AuthenticatedAdminSession | null> {
  const clientIp = extractClientIpFromHeaders(request.headers)
  if (clientIp !== null && isIpBlocked(clientIp)) return null
  const credential = await resolveRequestCredentialKind(
    request,
    "admin",
    options,
  )
  const { tokenHash, csrfToken, expiresAt } = credential?.metadata ?? {}
  return (
      typeof tokenHash === "string"
        && typeof csrfToken === "string"
        && typeof expiresAt === "number"
    ) ?
      { tokenHash, csrfToken, expiresAt }
    : null
}
export function isAllowedAdminOrigin(origin: string | null): boolean {
  if (!origin) return false
  const configured = process.env.COPILOT_ADMIN_ORIGIN?.trim()
  if (configured) return origin === configured
  try {
    const url = new URL(origin)
    return (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      && (url.protocol === "http:" || url.protocol === "https:")
    )
  } catch {
    return false
  }
}

export async function logoutAdmin(request: Request): Promise<void> {
  const session = await authenticateAdminRequest(request, { requireCsrf: true })
  if (session) await repository().logout(session.tokenHash)
}
export async function changeAdminPassword(
  request: Request,
  currentPassword: string,
  newPassword: string,
): Promise<CreatedAdminSession | ChangeAdminPasswordError> {
  const session = await authenticateAdminRequest(request, { requireCsrf: true })
  if (!session) return { error: "Authentication failed", reason: "session" }
  const admin = await repository().get()
  if (!admin || !(await verifyPassword(currentPassword, admin.passwordHash)))
    return { error: "Authentication failed", reason: "credential" }
  const error = validatePassword(newPassword)
  if (error) return { error, reason: "validation" }
  const passwordHash = await hashPassword(newPassword)
  const created = newSession(admin.sessionVersion + 1)
  const changed = await repository().changePassword({
    expected: admin,
    passwordHash,
    tokenHash: session.tokenHash,
    now: created.record.createdAt,
    replacement: created.record,
  })
  return changed ?
      created.session
    : { error: "Authentication failed", reason: "session" }
}
export async function resetAdminPassword(password: string): Promise<void> {
  const error = validatePassword(password)
  if (error) throw new StorageConflictError(error)
  const admin = await repository().get()
  if (!admin)
    throw new StorageConflictError(
      "Administrator authentication is not configured; use --setup-code",
    )
  const passwordHash = await hashPassword(password)
  if (
    !(await repository().changePassword({
      expected: admin,
      passwordHash,
      now: now(),
    }))
  )
    throw new StorageConflictError(
      "Administrator authentication changed; retry the reset",
    )
}
/** Retained only for existing tests; storage is always explicitly initialized by fixtures. */
export function setAdminAuthTestMode(_enabled: boolean): void {
  setAdminAuthClockForTest()
}
export function setAdminAuthClockForTest(testClock?: AdminAuthClock): void {
  clock = testClock ?? { now: () => Date.now() }
}
registerCredentialProvider("admin", async (request, context) => {
  const session = await resolveAdminSession(request, {
    requireCsrf: context.requireCsrf,
  })
  return session ?
      {
        kind: "admin",
        metadata: {
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
          tokenHash: session.tokenHash,
        },
        principalId: `admin:${session.tokenHash.slice(0, 16)}`,
        scopes: new Set<string>(),
      }
    : null
})
