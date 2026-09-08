/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejects assertions require awaiting despite their typings. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  authenticateAdminRequest,
  issueAdminSetupCode,
  initializeAdminAuth,
  loginAdmin,
  resetAdminPassword,
  setAdminAuthClockForTest,
  validateAdminPasswordHash,
} from "../src/lib/admin-auth"
import { resolveCredential } from "../src/lib/credential-resolver"
import { forwardError } from "../src/lib/error"
import { isIpBlocked, resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { OAuthStore, createPkceChallenge } from "../src/lib/oauth-store"
import { credentialDigest } from "../src/lib/storage/credentials-repository"
import { dashboardAuthRoutes } from "../src/routes/dashboard/auth-route"
import { createAuthStorageFixture } from "./helpers/auth-storage"

const GATEWAY_KEY = "test-gateway-key-that-is-long-and-random"
const PASSWORD = "correct horse battery staple"
const ORIGIN = "https://gateway.example.com"
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let originalHash: string | undefined
const app = new Hono()
  .onError((error, c) => forwardError(c, error))
  .route("/dashboard/auth", dashboardAuthRoutes)
app.get("/protected", async (c) =>
  (await authenticateAdminRequest(c.req.raw)) ?
    c.json({ ok: true })
  : c.json({ error: "Unauthorized" }, 401),
)

beforeEach(async () => {
  originalHash = process.env.COPILOT_ADMIN_PASSWORD_HASH
  process.env.COPILOT_ADMIN_ORIGIN = ORIGIN
  resetIpSecurityForTest()
  fixture = await createAuthStorageFixture()
})
afterEach(async () => {
  await fixture.close()
  setAdminAuthClockForTest()
  resetIpSecurityForTest()
  delete process.env.COPILOT_ADMIN_ORIGIN
  if (originalHash === undefined) delete process.env.COPILOT_ADMIN_PASSWORD_HASH
  else process.env.COPILOT_ADMIN_PASSWORD_HASH = originalHash
})
function cookiesFrom(response: Response) {
  const values = response.headers.getSetCookie()
  const cookie = values.map((value) => value.split(";", 1)[0]).join("; ")
  const csrf =
    values
      .find((value) => value.startsWith(`${ADMIN_CSRF_COOKIE}=`))
      ?.split(";", 1)[0]
      ?.slice(ADMIN_CSRF_COOKIE.length + 1) ?? ""
  return { cookie, csrf }
}
function post(
  action: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/dashboard/auth/${action}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}
async function setup(password = PASSWORD) {
  const { code } = await issueAdminSetupCode()
  const response = await post("setup", {
    setupCode: code,
    gatewayKey: GATEWAY_KEY,
    password,
  })
  expect(response.status).toBe(201)
  return { ...cookiesFrom(response), response }
}
function passwordChange(
  session: ReturnType<typeof cookiesFrom>,
  currentPassword = PASSWORD,
  newPassword = "new password",
) {
  return app.request("/dashboard/auth/password", {
    method: "PUT",
    headers: {
      cookie: session.cookie,
      origin: ORIGIN,
      "x-copilot-csrf": session.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

test("first setup requires a one-use code, initial key and four-character password", async () => {
  const { code } = await issueAdminSetupCode()
  expect(
    (await post("setup", { gatewayKey: GATEWAY_KEY, password: PASSWORD }))
      .status,
  ).toBe(400)
  expect(
    (
      await post("setup", {
        setupCode: "wrong",
        gatewayKey: GATEWAY_KEY,
        password: PASSWORD,
      })
    ).status,
  ).toBe(401)
  expect(
    (
      await post("setup", {
        setupCode: code,
        gatewayKey: "",
        password: PASSWORD,
      })
    ).status,
  ).toBe(401)
  expect(
    (
      await post("setup", {
        setupCode: code,
        gatewayKey: GATEWAY_KEY,
        password: "123",
      })
    ).status,
  ).toBe(401)
  const response = await post("setup", {
    setupCode: code,
    gatewayKey: GATEWAY_KEY,
    password: "1234",
  })
  expect(response.status).toBe(201)
  expect(response.headers.getSetCookie().join(";")).toContain(
    "HttpOnly; Secure; SameSite=Strict",
  )
  expect(response.headers.getSetCookie().join(";")).toContain("Max-Age=2592000")
  expect(
    (await post("login", { gatewayKey: GATEWAY_KEY, password: "1234" })).status,
  ).toBe(200)
})

test("setup requires exact allowed Origin without requiring preexisting CSRF", async () => {
  const { code } = await issueAdminSetupCode()
  const body = { setupCode: code, gatewayKey: GATEWAY_KEY, password: PASSWORD }
  for (const origin of [
    "",
    "https://evil.invalid",
    `${ORIGIN}/`,
    "https://gateway.example.com.evil.invalid",
  ]) {
    expect((await post("setup", body, { origin })).status).toBe(401)
  }
  expect((await post("setup", body)).status).toBe(201)
})

test("login retains gateway-key-plus-password and ignores environment password authority", async () => {
  const session = await setup()
  process.env.COPILOT_ADMIN_PASSWORD_HASH = "invalid legacy hash"
  await initializeAdminAuth()
  expect(
    (await post("login", { gatewayKey: GATEWAY_KEY, password: PASSWORD }))
      .status,
  ).toBe(200)
  expect(
    (await post("login", { gatewayKey: "wrong", password: PASSWORD })).status,
  ).toBe(401)
  expect(
    (await post("login", { gatewayKey: GATEWAY_KEY, password: "wrong" }))
      .status,
  ).toBe(401)
  expect(
    (
      await app.request("/protected", {
        headers: { authorization: `Bearer ${GATEWAY_KEY}` },
      })
    ).status,
  ).toBe(401)
  expect(
    (await app.request("/protected", { headers: { cookie: session.cookie } }))
      .status,
  ).toBe(200)
  expect(await (await app.request("/dashboard/auth/status")).json()).toEqual({
    configured: true,
    gatewayConfigured: true,
    passwordManagedExternally: false,
  })
})

test("password change requires CSRF and current password, then revokes every older session atomically", async () => {
  const session = await setup()
  const other = cookiesFrom(
    await post("login", { gatewayKey: GATEWAY_KEY, password: PASSWORD }),
  )
  expect((await passwordChange({ ...session, csrf: "wrong" })).status).toBe(401)
  expect((await passwordChange(session, "wrong")).status).toBe(401)
  expect((await passwordChange(session, PASSWORD, "123")).status).toBe(400)
  const changed = await passwordChange(session)
  expect(changed.status).toBe(200)
  for (const cookie of [session.cookie, other.cookie])
    expect(
      (await app.request("/protected", { headers: { cookie } })).status,
    ).toBe(401)
  expect(
    (
      await app.request("/protected", {
        headers: { cookie: cookiesFrom(changed).cookie },
      })
    ).status,
  ).toBe(200)
  expect(await loginAdmin(GATEWAY_KEY, PASSWORD)).toBeNull()
  expect(await loginAdmin(GATEWAY_KEY, "new password")).not.toBeNull()
})

test("password transaction failure preserves the old password and sessions", async () => {
  const session = await setup()
  fixture.failWrites()
  expect((await passwordChange(session)).status).toBe(503)
  fixture.failWrites(false)
  expect(
    (await app.request("/protected", { headers: { cookie: session.cookie } }))
      .status,
  ).toBe(200)
  expect(await loginAdmin(GATEWAY_KEY, PASSWORD)).not.toBeNull()
  expect(await loginAdmin(GATEWAY_KEY, "new password")).toBeNull()
})

test("sessions survive restart with no raw session, csrf, password or gateway in storage", async () => {
  const session = await setup()
  const stored = await fixture.storage.read((sql) =>
    sql.query({
      sql: "SELECT password_hash FROM capi_admin UNION ALL SELECT token_hash FROM capi_admin_sessions UNION ALL SELECT csrf_hash FROM capi_admin_sessions UNION ALL SELECT digest FROM capi_gateway_credentials",
      args: [],
    }),
  )
  const serialized = JSON.stringify(stored)
  expect(serialized).not.toContain(GATEWAY_KEY)
  expect(serialized).not.toContain(PASSWORD)
  expect(serialized).not.toContain(session.csrf)
  await fixture.restart()
  expect(
    (await app.request("/protected", { headers: { cookie: session.cookie } }))
      .status,
  ).toBe(200)
})

test("admin sessions use a 30-day sliding expiry persisted at five-minute cadence", async () => {
  let current = Date.now()
  setAdminAuthClockForTest({ now: () => current })
  const session = await setup()
  const started = current
  const read = () =>
    fixture.storage.read((sql) =>
      sql.query({
        sql: "SELECT last_seen_at,expires_at FROM capi_admin_sessions",
        args: [],
      }),
    )
  current += 60_000
  expect(
    (await app.request("/protected", { headers: { cookie: session.cookie } }))
      .status,
  ).toBe(200)
  expect((await read())[0]?.last_seen_at).toBe(started)
  current += 5 * 60_000
  expect(
    (await app.request("/protected", { headers: { cookie: session.cookie } }))
      .status,
  ).toBe(200)
  expect((await read())[0]?.expires_at).toBe(current + ADMIN_SESSION_TTL_MS)
  await fixture.restart()
  current += ADMIN_SESSION_TTL_MS + 1
  expect(
    (await app.request("/protected", { headers: { cookie: session.cookie } }))
      .status,
  ).toBe(401)
})

test("logout requires CSRF, revokes only its session and clears cookies", async () => {
  const session = await setup()
  expect((await post("logout", {}, { cookie: session.cookie })).status).toBe(
    401,
  )
  const response = await post(
    "logout",
    {},
    { cookie: session.cookie, "x-copilot-csrf": session.csrf },
  )
  expect(response.status).toBe(200)
  expect(response.headers.getSetCookie().join(";")).toContain("Max-Age=0")
  expect(
    (await app.request("/protected", { headers: { cookie: session.cookie } }))
      .status,
  ).toBe(401)
})

test("owner reset preserves administrator and independent gateway credentials", async () => {
  const session = await setup()
  await resetAdminPassword("owner reset password")
  await fixture.restart()
  expect(
    (await app.request("/protected", { headers: { cookie: session.cookie } }))
      .status,
  ).toBe(401)
  expect(await loginAdmin(GATEWAY_KEY, "owner reset password")).not.toBeNull()
  expect(await resolveCredential(GATEWAY_KEY)).toMatchObject({
    kind: "gateway",
  })
  await expect(issueAdminSetupCode()).rejects.toThrow("already configured")
})

test("inference digests cannot reserve admin cookie values as privileged credentials", async () => {
  const session = await setup()
  const token = session.cookie
    .split("; ")
    .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`))
    ?.slice(ADMIN_SESSION_COOKIE.length + 1)
  if (!token) throw new Error("Missing fixture session token")
  await fixture.storage.transaction(async (sql) => {
    await sql.execute({
      sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      args: [
        credentialDigest(token),
        "reserved-session",
        "managed",
        "inference-managed:reserved-session",
        Date.now(),
        Date.now(),
      ],
    })
  })
  expect(
    (await app.request("/protected", { headers: { cookie: session.cookie } }))
      .status,
  ).toBe(401)
})

test("database failures return no-store 503 without adding failed-password strikes", async () => {
  await setup()
  fixture.failReads()
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await post(
      "login",
      { gatewayKey: GATEWAY_KEY, password: PASSWORD },
      { "x-copilot-peer-ip": "198.51.100.9" },
    )
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
  }
  expect(isIpBlocked("198.51.100.9")).toBe(false)
  expect((await app.request("/dashboard/auth/status")).status).toBe(503)
})

test("Argon2id verifier validation retains parameter and encoding bounds", async () => {
  const valid = await Bun.password.hash(PASSWORD, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  })
  expect(validateAdminPasswordHash(valid)).toBe(valid)
  expect(() =>
    validateAdminPasswordHash(valid.replace("m=65536", "m=1024")),
  ).toThrow("unsupported")
  expect(() => validateAdminPasswordHash(valid.replace("t=3", "t=1"))).toThrow(
    "unsupported",
  )
  expect(() => validateAdminPasswordHash("invalid")).toThrow("Argon2id")
  expect(() =>
    validateAdminPasswordHash(
      `$argon2id$v=19$m=65536,t=3,p=1$${"A".repeat(25)}$${"A".repeat(45)}`,
    ),
  ).toThrow("Base64")
})

test("owner password recovery preserves usable OAuth access and reusable refresh credentials", async () => {
  await setup()
  const oauth = new OAuthStore({ storage: fixture.storage })
  const binding = {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirectUri: "http://localhost:54545/callback",
    state: "state-with-enough-entropy-123456789",
    codeVerifier: "v".repeat(64),
  }
  const code = await oauth.issueAuthorizationCode({
    ...binding,
    codeChallenge: createPkceChallenge(binding.codeVerifier),
    scopes: ["user:inference", "user:profile"],
  })
  const issued = await oauth.exchangeAuthorizationCode({ ...binding, code })
  if (issued.status !== "ok") throw new Error("OAuth fixture failed")
  await resetAdminPassword("recovered password")
  await fixture.restart()
  const reopened = new OAuthStore({ storage: fixture.storage })
  expect(
    await reopened.resolveAccessToken(issued.tokens.accessToken),
  ).not.toBeNull()
  const refreshed = await reopened.refreshAccessToken({
    refreshToken: issued.tokens.refreshToken,
    clientId: binding.clientId,
  })
  expect(refreshed.status).toBe("ok")
  if (refreshed.status === "ok")
    expect(refreshed.tokens.refreshToken).toBe(issued.tokens.refreshToken)
})
