import { afterAll, beforeEach } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

const root = resolve(import.meta.dir, "../../.superpowers/test-data/protocol")
await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(root, "suite-"))
process.env.DATA_DIR = directory
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN

// Import application modules only after redirecting all file-backed paths.
const { closeStorageRuntime, initializeStorageRuntime, getStorageRuntime } =
  await import("../../src/lib/storage/runtime")
const { mergeConfigWithDefaults } = await import("../../src/lib/config")
const { createHistoryRuntime, peekHistoryRuntime } = await import(
  "../../src/lib/telemetry-writer"
)
const { credentialDigest } = await import(
  "../../src/lib/storage/credentials-repository"
)
const { tokenPool } = await import("../../src/lib/token-pool")
const { state } = await import("../../src/lib/state")

export const PROTOCOL_GATEWAY_KEY = "protocol-fixture-gateway-key"
let databaseNumber = 0

export async function setupProtocolDatabase() {
  await peekHistoryRuntime()?.close(1000)
  await closeStorageRuntime()
  const runtime = await initializeStorageRuntime({
    config: {
      kind: "sqlite",
      path: join(directory, `protocol-${databaseNumber++}.sqlite`),
    },
  })
  await mergeConfigWithDefaults()
  await createHistoryRuntime(runtime.storage, { autoFlush: false })
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
}

/** Register before the suite's own hooks, so those hooks can set explicit overrides. */
// eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix -- Registers Bun test lifecycle hooks.
export function useProtocolDatabase() {
  beforeEach(setupProtocolDatabase)
  afterAll(async () => {
    await peekHistoryRuntime()?.close(1000)
    await closeStorageRuntime()
    const checked = resolve(directory)
    if (!checked.startsWith(`${root}${sep}`))
      throw new Error("Unsafe protocol fixture cleanup path")
    await rm(checked, { recursive: true, force: true })
  })
}

/** Persist the test's explicit credential and account fixtures before a real request. */
export async function seedProtocolDatabase(
  options: {
    gatewayKeys?: Array<string>
    inferenceKeys?: Array<string>
    singleAccount?: boolean
  } = {},
) {
  const keys = options.gatewayKeys ?? [
    PROTOCOL_GATEWAY_KEY,
    ...(state.apiKeyAuth ? [state.apiKeyAuth] : []),
  ]
  if (
    options.singleAccount !== false
    && !state.isMultiToken
    && state.copilotToken
  ) {
    const models = state.models
    for (const account of tokenPool.getAllAccounts())
      tokenPool.deleteAccount(account.id)
    const account = tokenPool.addAccount(
      state.githubToken ?? "protocol-github-token",
      {
        id: 0,
        accountType: state.accountType,
        githubInstanceDomain: state.githubInstanceDomain,
      },
    )
    account.copilotToken = state.copilotToken
    account.copilotApiBaseUrl = state.copilotApiBaseUrl
    account.modelsData = models?.data ?? []
    account.models = new Set(account.modelsData.map((model) => model.id))
    account.healthy = true
    state.models = models
  }
  const accounts = tokenPool.getAllAccounts()
  for (const account of accounts) account.credentialRevision ??= 0
  tokenPool.rebuildModelIndex()
  const { storage } = getStorageRuntime()
  await storage.transaction(async (session) => {
    for (const key of new Set(keys)) {
      const digest = credentialDigest(key)
      await session.execute({
        sql: "INSERT OR IGNORE INTO capi_gateway_credentials (id,digest,label,created_at) VALUES (?,?,?,?)",
        args: [digest, digest, "Protocol fixture", Date.now()],
      })
    }
    for (const key of options.inferenceKeys ?? []) {
      const digest = credentialDigest(key)
      await session.execute({
        sql: "INSERT OR IGNORE INTO capi_inference_credentials (digest,id,kind,principal_id,scopes_json,created_at,updated_at) VALUES (?,?,'managed',?,'[\"user:inference\"]',?,?)",
        args: [digest, digest, `fixture:${digest}`, Date.now(), Date.now()],
      })
    }
    await session.execute({
      sql: "DELETE FROM capi_account_credentials",
      args: [],
    })
    await session.execute({ sql: "DELETE FROM capi_accounts", args: [] })
    for (const account of accounts) {
      await session.execute({
        sql: "INSERT INTO capi_accounts (id,domain,upstream_user_id,login,enabled,credential_revision,validation_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        args: [
          account.id,
          account.githubInstanceDomain,
          String(account.id),
          account.githubUsername ?? null,
          account.enabled === false ? 0 : 1,
          account.credentialRevision ?? 0,
          JSON.stringify({ accountType: account.accountType }),
          Date.now(),
          Date.now(),
        ],
      })
      await session.execute({
        sql: "INSERT INTO capi_account_credentials (account_id,oauth_value,updated_at) VALUES (?,?,?)",
        args: [account.id, account.githubToken, Date.now()],
      })
    }
    await session.execute({
      sql: "UPDATE capi_metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'config_revision'",
      args: [],
    })
  })
}
