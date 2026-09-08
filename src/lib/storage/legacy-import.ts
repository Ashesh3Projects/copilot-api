import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import type {
  TransferProgress,
  TransferRecord,
} from "~/lib/storage/transfer-records"
import type { SqlSession, Storage } from "~/lib/storage/types"

import { validateAdminPasswordHash } from "~/lib/admin-auth"
import { validateStoredReplacements } from "~/lib/auto-replace"
import { validateAppConfigJson } from "~/lib/config"
import {
  normalizeGitHubDomain,
  parseGitHubCredentials,
} from "~/lib/github-instance"
import { normalizeIpAddress } from "~/lib/ip-allowlist"
import { validateModelFallbackConfig } from "~/lib/model-fallback-config"
import { validateStoredModelRedirects } from "~/lib/model-redirect"
import { validateStoredModelRouting } from "~/lib/model-routing"
import { validateStoredModelSettings } from "~/lib/model-settings"
import { StorageConflictError, StorageSchemaError } from "~/lib/storage/errors"
import { initialMigration } from "~/lib/storage/migrations/001-initial"
import { readStoreRevision } from "~/lib/storage/operations"
import { validateTransferredState } from "~/lib/storage/restore"
import { getStorageRuntime } from "~/lib/storage/runtime"
import {
  assertEmptyTransferTarget,
  completeTransferRecord,
  insertTransferRecord,
  insertTransferRecords,
  sha256,
  TRANSFER_MARKER,
  TRANSFER_TABLES,
} from "~/lib/storage/transfer-records"
import {
  validateTransferDomains,
  validateTransferScopes,
} from "~/lib/storage/transfer-validation"
import { validateStoredFeatureFlags } from "~/routes/feature-flags/store"
import { validateStatsigOverrides } from "~/routes/statsig-overrides/store"

export interface LegacyImportInput {
  directory: string
  includeEnvironment: boolean
  environment?: Readonly<Record<string, string | undefined>>
}
export interface ImportPreview {
  sourceDigest: string
  expectedTargetRevision: number
  counts: Readonly<Record<string, number>>
  warnings: ReadonlyArray<string>
}
const settings = [
  ["config.json", "app", validateAppConfigJson],
  ["replacements.json", "replacements", validateStoredReplacements],
  ["model_redirects.json", "model_redirects", validateStoredModelRedirects],
  ["model_settings.json", "model_settings", validateStoredModelSettings],
  ["model_routing.json", "model_routing", validateStoredModelRouting],
  ["model_fallbacks.json", "model_fallbacks", validateModelFallbackConfig],
  ["feature_flags.json", "feature_flags", validateStoredFeatureFlags],
  ["statsig_overrides.json", "statsig_overrides", validateStatsigOverrides],
] as const
const filenames = [
  ...settings.map(([filename]) => filename),
  "github_token",
  "github_tokens.json",
  "ip_allowlist.json",
  "trusted_jwt_digests.json",
  "usage.json",
  "oauth_tokens.json",
  "admin_auth.json",
  "admin_sessions.json",
]
function invalid(message = "Invalid legacy migration input"): never {
  throw new StorageSchemaError(message)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function array(value: unknown): Array<unknown> {
  if (!Array.isArray(value)) invalid()
  return value
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid()
  return value
}
function timestamp(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === "string" ? Date.parse(value) : value
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0)
    invalid()
  return parsed
}
function nullableTime(value: unknown): number | null {
  return value === undefined || value === null ? null : timestamp(value)
}
function digest64(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

async function readInputs(input: LegacyImportInput) {
  if (!input.directory || !path.isAbsolute(input.directory))
    invalid("Legacy import requires an explicit absolute directory")
  const requested = path.resolve(input.directory)
  for (let ancestor = requested; ; ancestor = path.dirname(ancestor)) {
    if ((await fs.lstat(ancestor)).isSymbolicLink())
      invalid("Legacy directory must not contain symlinks or junctions")
    if (path.dirname(ancestor) === ancestor) break
  }
  const directory = await fs.realpath(requested)
  if (!(await fs.lstat(directory)).isDirectory())
    invalid("Legacy input must be a directory")
  const files = new Map<string, string>()
  for (const filename of filenames) {
    const full = path.join(directory, filename)
    try {
      const info = await fs.lstat(full)
      if (
        !info.isFile()
        || info.isSymbolicLink()
        || path.resolve(await fs.realpath(full)).toLowerCase()
          !== full.toLowerCase()
      )
        invalid("Legacy input must be a regular file")
      const handle = await fs.open(full, "r")
      try {
        const opened = await handle.stat()
        if (
          opened.ino !== info.ino
          || opened.dev !== info.dev
          || opened.size !== info.size
        )
          invalid("Legacy input changed during preview")
        files.set(filename, await handle.readFile("utf8"))
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return files
}

// eslint-disable-next-line max-lines-per-function, complexity -- One read-only preparation pipeline validates every legacy format before any target writes.
async function prepare(input: LegacyImportInput) {
  const files = await readInputs(input)
  const usedEnvironment: Record<string, string> = {}
  const env = (name: string): string | undefined => {
    if (!input.includeEnvironment) return undefined
    if (
      !/^[A-Z_]\w*$/i.test(name)
      || ["DATA_DIR", "TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL"].includes(name)
    )
      invalid("Invalid legacy credential environment name")
    const value = (input.environment ?? process.env)[name]?.trim()
    if (value) usedEnvironment[name] = value
    return value
  }
  const json = (filename: string): unknown => {
    const raw = files.get(filename)
    if (!raw?.trim()) return undefined
    try {
      return JSON.parse(raw) as unknown
    } catch {
      invalid(`Invalid JSON in ${filename}`)
    }
  }
  const records: Array<TransferRecord> = []
  const add = (table: string, value: Record<string, unknown>) => {
    records.push(completeTransferRecord(table, value))
  }
  const config = object(json("config.json") ?? {})
  validateAppConfigJson(config)
  addConfigCredentials(config, env, add)
  for (const [filename, namespace, validate] of settings) {
    const value = namespace === "app" ? config : json(filename)
    if (value === undefined || (namespace === "app" && !files.has(filename)))
      continue
    validate(value)
    add("capi_settings", {
      namespace,
      value_json: JSON.stringify(value),
      revision: 1,
    })
  }
  let accounts =
    json("github_tokens.json") === undefined ?
      []
    : array(json("github_tokens.json"))
  const environmentTokens = env("GITHUB_TOKENS") ?? env("GH_TOKEN")
  if (environmentTokens)
    accounts = parseGitHubCredentials(environmentTokens).map((credential) => ({
      token: credential.token,
      instanceDomain: credential.instanceDomain,
    }))
  const legacyToken = files.get("github_token")?.trim()
  if (accounts.length === 0 && legacyToken) accounts = [{ token: legacyToken }]
  for (const [id, raw] of accounts.entries()) {
    const account = object(raw)
    const domain = normalizeGitHubDomain(
      typeof account.instanceDomain === "string" ?
        account.instanceDomain
      : "github.com",
    )
    add("capi_accounts", {
      id,
      domain,
      label: account.label ?? null,
      credential_revision: 1,
      validation_json: '{"accountType":"individual","legacyImported":true}',
      created_at: 0,
      updated_at: 0,
    })
    add("capi_account_credentials", {
      account_id: id,
      oauth_value: text(account.token).trim(),
      updated_at: 0,
    })
  }
  addAdmin(json("admin_auth.json"), env("COPILOT_ADMIN_PASSWORD_HASH"), add)
  addPolicies(json("ip_allowlist.json"), json("trusted_jwt_digests.json"), add)
  addEnvironmentInference(
    env("COPILOT_INFERENCE_CREDENTIAL_SHA256S"),
    records,
    add,
  )
  addOAuth(json("oauth_tokens.json"), add)
  addUsage(json("usage.json"), add)
  // Validate every SQL constraint and foreign key before the preview authorizes writes.
  records.sort(
    (left, right) =>
      TRANSFER_TABLES.indexOf(left.table)
      - TRANSFER_TABLES.indexOf(right.table),
  )
  const db = new Database(":memory:", { strict: true })
  try {
    db.run("PRAGMA foreign_keys=ON")
    for (const sql of initialMigration.statements) db.run(sql)
    const session: SqlSession = {
      query: (statement) =>
        Promise.resolve(
          db.query(statement.sql).all(...statement.args) as Array<
            Record<string, unknown>
          >,
        ),
      execute: (statement) =>
        Promise.resolve({
          rowsAffected: db.query(statement.sql).run(...statement.args).changes,
        }),
    }
    for (const record of records) await insertTransferRecord(session, record)
    await validateTransferDomains(session)
    const routing = records.find(
      (record) =>
        record.table === "capi_settings"
        && object(record.value).namespace === "model_routing",
    )
    if (routing) {
      const routes = validateStoredModelRouting(
        JSON.parse(String(object(routing.value).value_json)),
      )

      const referenced = Object.values(routes).flatMap((accountMap) =>
        Object.keys(accountMap ?? {}),
      )
      if (
        referenced.some(
          (id) => !/^\d+$/.test(id) || Number(id) >= accounts.length,
        )
      )
        invalid("Legacy routing references a missing account")
    }
  } finally {
    db.close()
  }
  const counts: Record<string, number> = {}
  for (const record of records)
    counts[record.table] = (counts[record.table] ?? 0) + 1
  return {
    records,
    counts,
    sourceDigest: sha256(
      JSON.stringify({
        files: [...files].sort(),
        environment: Object.entries(usedEnvironment).sort(),
        includeEnvironment: input.includeEnvironment,
      }),
    ),
    warnings:
      files.has("admin_sessions.json") ?
        ["Administrator sessions are invalidated during import."]
      : [],
  }
}

type AddRecord = (table: string, value: Record<string, unknown>) => void
async function validatedPreparation(input: LegacyImportInput) {
  try {
    return await prepare(input)
  } catch (error) {
    if (error instanceof StorageSchemaError) throw error
    throw new StorageSchemaError(
      "Invalid or unreadable legacy migration input; repair the explicitly selected source files or credentials and preview again",
    )
  }
}
// eslint-disable-next-line complexity -- Explicit credential migration covers independent legacy credential sources.
function addConfigCredentials(
  config: Record<string, unknown>,
  env: (name: string) => string | undefined,
  add: AddRecord,
): void {
  const auth = config.auth === undefined ? {} : object(config.auth)
  const environmentGatewayKey = env("COPILOT_API_KEY_AUTH")
  const jsonKeys =
    auth.apiKeys === undefined ?
      []
    : array(auth.apiKeys)
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
  const keys = environmentGatewayKey ? [environmentGatewayKey] : jsonKeys
  for (const key of new Set(keys))
    add("capi_gateway_credentials", {
      id: `legacy:${sha256(key)}`,
      digest: sha256(key),
      label: "Imported gateway key",
      created_at: 0,
    })
  delete config.auth
  const groq = env("GROQ_API_KEY") ?? config.groqApiKey
  if (groq)
    add("capi_service_secrets", {
      service: "groq",
      secret_value: text(groq),
      updated_at: 0,
    })
  delete config.groqApiKey
  for (const raw of config.customProviders === undefined ?
    []
  : array(config.customProviders)) {
    const provider = object(raw)
    let key: string | undefined
    if (typeof provider.apiKey === "string" && provider.apiKey.trim())
      key = provider.apiKey.trim()
    else if (provider.apiKeyEnv) key = env(text(provider.apiKeyEnv))
    if (provider.apiKeyEnv && !key)
      invalid(
        "Provider apiKeyEnv requires --from-env and its selected credential",
      )
    const headers = provider.headers ?? {}
    for (const value of Object.values(object(headers))) text(value)
    new Headers(headers as Record<string, string>)
    const metadata = Object.fromEntries(
      ["id", "name", "type", "baseUrl", "models", "passReasoningEffort"]
        .filter((name) => provider[name] !== undefined)
        .map((name) => [name, provider[name]]),
    )
    if (
      !/^https?:$/.test(new URL(text(metadata.baseUrl)).protocol)
      || array(metadata.models).length === 0
    )
      invalid("Invalid legacy provider")
    add("capi_providers", {
      id: text(provider.id),
      name: text(provider.name),
      payload_json: JSON.stringify(metadata),
      revision: 1,
      created_at: 0,
      updated_at: 0,
    })
    add("capi_provider_secrets", {
      provider_id: provider.id,
      api_key: key ?? null,
      headers_json: JSON.stringify(headers),
      updated_at: 0,
    })
  }
  delete config.customProviders
}

function addAdmin(
  raw: unknown,
  environmentHash: string | undefined,
  add: AddRecord,
): void {
  if (raw === undefined && !environmentHash) return
  const admin = raw === undefined ? {} : object(raw)
  if (admin.source === "environment" && !environmentHash)
    invalid(
      "Environment administrator marker requires --from-env and the actual COPILOT_ADMIN_PASSWORD_HASH Argon2id value",
    )
  const hash = validateAdminPasswordHash(
    text(environmentHash ?? admin.passwordHash),
  )
  if (
    admin.source === "environment"
    && admin.credentialFingerprint !== digest64(hash)
  )
    invalid("Environment administrator hash does not match its legacy marker")
  add("capi_admin", {
    id: 1,
    password_hash: hash,
    session_version: Math.max(1, timestamp(admin.sessionVersion, 1)),
    created_at: timestamp(admin.createdAt),
    updated_at: timestamp(admin.updatedAt),
  })
}
function addPolicies(
  ipRaw: unknown,
  trustedRaw: unknown,
  add: AddRecord,
): void {
  for (const raw of ipRaw === undefined ? [] : array(ipRaw)) {
    const entry = object(raw)
    const ip = normalizeIpAddress(text(entry.ip))
    if (!ip) invalid("Invalid legacy IP allowlist")
    add("capi_ip_allowlist", {
      ip,
      enabled: entry.enabled === false ? 0 : 1,
      source: entry.source ?? "manual",
      created_at: timestamp(entry.createdAt),
      updated_at: timestamp(entry.updatedAt),
      last_seen_at: nullableTime(entry.lastSeenAt),
    })
  }
  if (trustedRaw === undefined) return
  const trusted = object(trustedRaw)
  if (trusted.version !== 1) invalid("Unsupported trusted credential format")
  for (const raw of array(trusted.entries)) {
    const entry = object(raw)
    const digest = text(entry.digest).toLowerCase()
    if (!/^[a-f\d]{64}$/.test(digest))
      invalid("Invalid trusted credential digest")
    add("capi_inference_credentials", {
      digest,
      id: text(entry.id),
      kind: "managed",
      principal_id: `inference-managed:${text(entry.id)}`,
      label: text(entry.label),
      enabled: entry.enabled === false ? 0 : 1,
      scopes_json: '["user:inference"]',
      created_at: timestamp(entry.createdAt),
      updated_at: timestamp(entry.updatedAt),
    })
  }
}
function scopes(value: unknown): string {
  const values = array(value).map((item) => text(item))
  validateTransferScopes(values)
  return JSON.stringify(values)
}
function addEnvironmentInference(
  configured: string | undefined,
  records: ReadonlyArray<TransferRecord>,
  add: AddRecord,
): void {
  if (!configured) return
  const managedDigests = new Set(
    records
      .filter((record) => record.table === "capi_inference_credentials")
      .map((record) => object(record.value).digest),
  )
  const digests = new Set(
    configured
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^[a-f\d]{64}$/.test(value)),
  )
  for (const digest of digests) {
    // Existing managed entries retain their principal and disabled state.
    if (managedDigests.has(digest)) continue
    add("capi_inference_credentials", {
      digest,
      id: `legacy-env:${digest}`,
      kind: "environment",
      principal_id: `inference-env:${digest.slice(0, 16)}`,
      scopes_json: '["user:inference"]',
      created_at: 0,
      updated_at: 0,
    })
  }
}
function addOAuth(raw: unknown, add: AddRecord): void {
  if (raw === undefined) return
  const oauth = object(raw)
  if (oauth.version !== 1) invalid("Unsupported OAuth migration format")
  for (const [field, table] of [
    ["tokenFamilies", "capi_oauth_families"],
    ["authorizationCodes", "capi_oauth_codes"],
    ["accessTokens", "capi_oauth_access"],
    ["refreshTokens", "capi_oauth_refresh"],
    ["inferenceCredentials", "capi_inference_credentials"],
  ] as const) {
    for (const [key, value] of Object.entries(object(oauth[field] ?? {}))) {
      const entry = object(value)
      const common = {
        created_at: timestamp(entry.createdAt),
        expires_at: nullableTime(entry.expiresAt),
        revoked_at: nullableTime(entry.revokedAt),
      }
      if (field === "tokenFamilies") add(table, { ...common, id: key })
      else {
        if (!/^[\w-]{43}$/.test(key)) invalid("Invalid legacy OAuth digest")
        if (field === "authorizationCodes")
          add(table, {
            ...common,
            digest: key,
            client_id: text(entry.clientId),
            redirect_uri: text(entry.redirectUri),
            scopes_json: scopes(entry.scopes),
            state: typeof entry.state === "string" ? entry.state : invalid(),
            code_challenge: text(entry.codeChallenge),
            expires_at: timestamp(entry.expiresAt),
            consumed_at: nullableTime(entry.consumedAt),
          })
        else if (field === "inferenceCredentials")
          add(table, {
            digest: key,
            id: `legacy:${key}`,
            kind: "oauth",
            principal_id: text(entry.principalId),
            scopes_json: scopes(entry.scopes),
            created_at: common.created_at,
            updated_at: common.created_at,
            revoked_at: common.revoked_at,
          })
        else
          add(table, {
            ...common,
            digest: key,
            family_id: text(entry.familyId),
            principal_id: text(entry.principalId),
            client_id: text(entry.clientId),
            scopes_json: scopes(entry.scopes),
            consumed_at: nullableTime(entry.consumedAt),
          })
      }
    }
  }
}
// eslint-disable-next-line complexity -- Both historical formats preserve every bucket and exact lifetime totals.
function addUsage(raw: unknown, add: AddRecord): void {
  if (raw === undefined) return
  const usage = object(raw)
  if (usage.version !== undefined && usage.version !== 1 && usage.version !== 2)
    invalid("Unsupported legacy usage version")
  const v2 = usage.version === 2
  const buckets = new Map<string, Record<string, unknown>>()
  let input = 0,
    output = 0,
    requests = 0,
    first: number | null = null
  for (const raw of array(v2 ? usage.buckets : usage.records)) {
    const entry = object(raw)
    const time = timestamp(entry.timestamp)
    const minute = Math.floor(time / 60_000) * 60_000
    const model = entry.model === undefined ? "" : text(entry.model)
    const count = v2 ? timestamp(entry.requestCount) : 1
    const inputTokens = timestamp(entry.inputTokens),
      outputTokens = timestamp(entry.outputTokens)
    const key = JSON.stringify([minute, model])
    const previous = buckets.get(key)
    buckets.set(key, {
      minute,
      model,
      input_tokens: Number(previous?.input_tokens ?? 0) + inputTokens,
      output_tokens: Number(previous?.output_tokens ?? 0) + outputTokens,
      request_count: Number(previous?.request_count ?? 0) + count,
    })
    input += inputTokens
    output += outputTokens
    requests += count
    first = first === null ? time : Math.min(time, first)
  }
  for (const bucket of buckets.values()) add("capi_usage_minutes", bucket)
  const lifetime =
    v2 ?
      object(usage.lifetime)
    : {
        inputTokens: input,
        outputTokens: output,
        requestCount: requests,
        firstRequestAt: first,
      }
  add("capi_usage_lifetime", {
    id: 1,
    input_tokens: timestamp(lifetime.inputTokens),
    output_tokens: timestamp(lifetime.outputTokens),
    request_count: timestamp(lifetime.requestCount),
    first_request_at: nullableTime(lifetime.firstRequestAt),
  })
}

export async function previewLegacyImport(
  input: LegacyImportInput,
  target: Storage = getStorageRuntime().storage,
): Promise<ImportPreview> {
  const prepared = await validatedPreparation(input)
  const expectedTargetRevision = await target.read(async (session) => {
    const imported = await session.query({
      sql: "SELECT id FROM capi_imports WHERE manifest_digest=?",
      args: [prepared.sourceDigest],
    })
    if (imported.length === 0) await assertEmptyTransferTarget(session)
    return readStoreRevision(session)
  })
  return {
    sourceDigest: prepared.sourceDigest,
    expectedTargetRevision,
    counts: prepared.counts,
    warnings: prepared.warnings,
  }
}
export async function applyLegacyImport(
  input: LegacyImportInput,
  preview: ImportPreview,
  target: Storage = getStorageRuntime().storage,
): Promise<TransferProgress> {
  const prepared = await validatedPreparation(input)
  if (prepared.sourceDigest !== preview.sourceDigest)
    throw new StorageConflictError("Legacy source changed; run preview again")
  const operationId = randomUUID()
  const previous = await target.transaction(async (session) => {
    const imported = await session.query({
      sql: "SELECT id,counts_json FROM capi_imports WHERE manifest_digest=?",
      args: [prepared.sourceDigest],
    })
    if (imported[0]) return String(imported[0].id)
    await assertEmptyTransferTarget(session)
    if ((await readStoreRevision(session)) !== preview.expectedTargetRevision)
      throw new StorageConflictError("Legacy target changed; run preview again")
    await session.execute({
      sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
      args: [TRANSFER_MARKER, operationId],
    })
    return undefined
  })
  if (previous)
    return {
      operationId: previous,
      phase: "complete",
      records: prepared.records.length,
    }
  for (let offset = 0; offset < prepared.records.length; offset += 100) {
    await target.transaction(async (session) => {
      const marker = await session.query({
        sql: "SELECT value FROM capi_metadata WHERE key=?",
        args: [TRANSFER_MARKER],
      })
      if (marker[0]?.value !== operationId)
        invalid("Legacy import ownership changed")
      await insertTransferRecords(
        session,
        prepared.records.slice(offset, offset + 100),
      )
    })
  }
  await target.transaction(async (session) => {
    const marker = await session.query({
      sql: "SELECT value FROM capi_metadata WHERE key=?",
      args: [TRANSFER_MARKER],
    })
    if (marker[0]?.value !== operationId)
      invalid("Legacy import ownership changed")
    await validateTransferredState(session)
    await session.execute({
      sql: "UPDATE capi_metadata SET value='1' WHERE key='config_revision'",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_imports(id,manifest_digest,committed_revision,completed_at,counts_json) VALUES(?,?,1,?,?)",
      args: [
        operationId,
        prepared.sourceDigest,
        Date.now(),
        JSON.stringify(prepared.counts),
      ],
    })
    await session.execute({
      sql: "DELETE FROM capi_metadata WHERE key=? AND value=?",
      args: [TRANSFER_MARKER, operationId],
    })
  })
  return { operationId, phase: "complete", records: prepared.records.length }
}
