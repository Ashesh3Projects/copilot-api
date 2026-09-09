import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import type {
  JsonValue,
  MutationContext,
  SettingsNamespace,
  Storage,
} from "~/lib/storage/types"

import { createBackupStream } from "~/lib/config-backup"
import { createPkceChallenge, OAuthStore } from "~/lib/oauth-store"
import { AccountsRepository } from "~/lib/storage/accounts-repository"
import { createAdminRepository } from "~/lib/storage/admin-repository"
import { createStorage } from "~/lib/storage/client"
import { resolveStorageConfig } from "~/lib/storage/config"
import {
  createCredentialsRepository,
  credentialDigest,
} from "~/lib/storage/credentials-repository"
import { createHistoryRepository } from "~/lib/storage/history-repository"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import { getStoreRevision } from "~/lib/storage/operations"
import { createPolicyRepository } from "~/lib/storage/policy-repository"
import {
  createProvidersRepository,
  loadCustomProviderSnapshot,
} from "~/lib/storage/providers-repository"
import { restoreBackup, validateTransferredState } from "~/lib/storage/restore"
import {
  createSettingsRepository,
  settingsInputDigest,
} from "~/lib/storage/settings-repository"
import {
  transferRecords,
  type TransferRecord,
} from "~/lib/storage/transfer-records"

import { isolatedNamespace } from "./helpers/isolated-transfer-storage"
import { bytesStream, streamBytes } from "./helpers/transfer-storage"

const testRoot = resolve(
  import.meta.dir,
  "../.superpowers/test-data/remote-transfer",
)
const password = "remote-transfer-fixture-password"

async function mutation(
  storage: Storage,
  kind: string,
  inputDigest = "fixture-input",
): Promise<MutationContext> {
  return {
    operationId: randomUUID(),
    expectedRevision: await getStoreRevision(storage),
    actorId: "test:remote-transfer",
    kind,
    inputDigest,
  }
}

async function seedSource(storage: Storage) {
  const now = Date.now()
  const accounts = new AccountsRepository(storage)
  const account = await accounts.create(
    {
      instanceDomain: "github.com",
      upstreamUserId: "730001",
      login: "transfer-user",
      token: "fixture-github-transfer-secret",
      label: "Transfer Account",
      accountType: "individual",
      modelCount: 1,
    },
    await mutation(storage, "account.create"),
  )
  const enterprise = await accounts.create(
    {
      instanceDomain: "fixture.ghe.com",
      upstreamUserId: "730002",
      login: "enterprise-transfer",
      token: "fixture-enterprise-transfer-secret",
      label: "Enterprise",
      accountType: "enterprise",
      modelCount: 1,
    },
    await mutation(storage, "account.create"),
  )
  const settings = createSettingsRepository(storage)
  const documents: Array<[SettingsNamespace, JsonValue]> = [
    [
      "app",
      {
        smallModel: "transfer-model",
        extraPrompts: { "transfer-model": "Preserve Unicode 🦉" },
      },
    ],
    [
      "model_routing",
      {
        "transfer-model": {
          [account.value.id]: true,
          [enterprise.value.id]: false,
        },
      },
    ],
    ["replacements", []],
    ["model_redirects", []],
    ["model_settings", []],
    ["model_fallbacks", {}],
    ["feature_flags", {}],
    [
      "statsig_overrides",
      { featureGates: { transfer_gate: true }, dynamicConfigs: {} },
    ],
  ]
  for (const [namespace, value] of documents)
    await settings.replace(
      namespace,
      value,
      await mutation(
        storage,
        "settings.replace",
        settingsInputDigest(namespace, value),
      ),
    )
  const providers = createProvidersRepository(storage)
  await providers.upsert(
    {
      id: "transfer-provider",
      name: "Transfer Provider",
      type: "openai-compatible",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "fixture-provider-transfer-secret",
      headers: { "X-Fixture": "fixture-header-secret" },
      models: [{ id: "provider-model", kind: "chat" }],
    },
    await mutation(storage, "provider.upsert"),
  )
  await providers.setGroqSecret(
    { apiKey: "fixture-groq-transfer-secret" },
    await mutation(storage, "groq.update"),
  )
  await createPolicyRepository(storage).upsertIp("192.0.2.42", {
    enabled: true,
    source: "manual",
  })
  const passwordHash = await Bun.password.hash(
    "fixture-admin-transfer-password",
    { algorithm: "argon2id", memoryCost: 65_536, timeCost: 3 },
  )
  const admin = createAdminRepository(storage)
  await admin.issueSetupCode({
    digest: "fixture-setup-digest",
    now,
    expiresAt: now + 60_000,
  })
  expect(
    await admin.setup({
      codeDigest: "fixture-setup-digest",
      passwordHash,
      gatewayLiteral: "fixture-gateway-transfer-secret",
      gateway: {
        id: "transfer-gateway",
        digest: credentialDigest("fixture-gateway-transfer-secret"),
        label: "Transfer Gateway",
        createdAt: now,
      },
      session: {
        tokenHash: "fixture-admin-session",
        csrfHash: "fixture-admin-csrf",
        sessionVersion: 1,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 60_000,
      },
    }),
  ).toBe("ok")
  const oauth = new OAuthStore({ storage })
  const binding = {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirectUri: "http://localhost:54545/callback",
    state: "transfer-state-with-sufficient-entropy",
    codeVerifier: "v".repeat(64),
  }
  const code = await oauth.issueAuthorizationCode({
    ...binding,
    scopes: ["user:profile", "user:inference"],
    codeChallenge: createPkceChallenge(binding.codeVerifier),
  })
  const issued = await oauth.exchangeAuthorizationCode({ ...binding, code })
  if (issued.status !== "ok") throw new Error("OAuth fixture exchange failed")
  const inference = await oauth.mintInferenceCredential()
  const history = createHistoryRepository(storage, {
    runId: "transfer-process",
  })
  await history.startRun("transfer-process", now)
  await history.applyBatch("transfer-history-batch", [
    {
      id: "old-usage",
      kind: "usage",
      recordedAt: 60_000,
      generation: 0,
      payload: {
        model: "old-model",
        timestamp: 60_000,
        inputTokens: 11,
        outputTokens: 17,
        requestCount: 2,
        firstRequestAt: 60_000,
      },
    },
    {
      id: "transfer-route",
      kind: "routing",
      recordedAt: now,
      generation: 0,
      payload: { requestCount: 3, timestamp: now },
    },
    {
      id: "transfer-debug",
      kind: "debug",
      recordedAt: now,
      generation: 0,
      payload: {
        status: "completed",
        replayable: false,
        message: "redacted fixture",
      },
    },
    {
      id: "transfer-gap",
      kind: "collection-gap",
      recordedAt: now,
      generation: 0,
      payload: { lostRecords: 2, lostBytes: 64 },
    },
  ])
  await history.endRun("transfer-process", now + 1)
  return {
    accountIds: [account.value.id, enterprise.value.id],
    tokens: issued.tokens,
    inference,
    binding,
    now,
  }
}

async function records(storage: Storage): Promise<Array<TransferRecord>> {
  return storage.readSnapshot ?
      storage.readSnapshot(async (session) => {
        const result: Array<TransferRecord> = []
        for await (const record of transferRecords(session)) result.push(record)
        return result
      })
    : storage.read(async (session) => {
        const result: Array<TransferRecord> = []
        for await (const record of transferRecords(session)) result.push(record)
        return result
      })
}

async function verifyRepositories(
  storage: Storage,
  fixture: Awaited<ReturnType<typeof seedSource>>,
) {
  const accounts = await new AccountsRepository(storage).snapshot()
  expect(accounts.accounts.map((account) => account.record.id)).toEqual(
    fixture.accountIds,
  )
  expect(accounts.accounts.map((account) => account.token)).toEqual([
    "fixture-github-transfer-secret",
    "fixture-enterprise-transfer-secret",
  ])
  expect(
    (await createSettingsRepository(storage).loadAll()).find(
      (document) => document.namespace === "app",
    )?.value,
  ).toMatchObject({ smallModel: "transfer-model" })
  expect(await loadCustomProviderSnapshot(storage)).toMatchObject({
    groqApiKey: "fixture-groq-transfer-secret",
    providers: [
      {
        id: "transfer-provider",
        apiKey: "fixture-provider-transfer-secret",
        headers: { "X-Fixture": "fixture-header-secret" },
      },
    ],
  })
  expect(
    await createCredentialsRepository(storage).gateway(
      "fixture-gateway-transfer-secret",
    ),
  ).not.toBeNull()
  expect(
    await createPolicyRepository(storage).findIp("192.0.2.42"),
  ).toMatchObject({ enabled: true })
  expect(await createAdminRepository(storage).get()).toMatchObject({
    sessionVersion: 1,
  })
  const oauth = new OAuthStore({ storage })
  expect(
    await oauth.resolveAccessToken(fixture.tokens.accessToken),
  ).toMatchObject({ scopes: ["user:profile", "user:inference"] })
  expect(
    await oauth.resolveInferenceCredential(fixture.inference),
  ).not.toBeNull()
  const history = createHistoryRepository(storage)
  expect(await history.readUsage(0)).toMatchObject({
    buckets: [
      {
        timestamp: 60_000,
        model: "old-model",
        inputTokens: 11,
        outputTokens: 17,
        requestCount: 2,
      },
    ],
    lifetime: {
      inputTokens: 11,
      outputTokens: 17,
      requestCount: 2,
      firstRequestAt: 60_000,
    },
  })
  expect(
    (await history.get("debug", "transfer-debug", [], fixture.now))?.payload,
  ).toMatchObject({ status: "completed" })
}

async function runTransfer(backend: Storage) {
  await mkdir(testRoot, { recursive: true })
  const directory = await mkdtemp(join(testRoot, "roundtrip-"))
  const source = new LocalSqliteStorage(join(directory, "source.sqlite"))
  const target = new LocalSqliteStorage(join(directory, "returned.sqlite"))
  const namespace = isolatedNamespace(backend)
  try {
    await migrateStorage(source)
    await migrateStorage(target)
    await namespace.initialize()
    const fixture = await seedSource(source)
    await source.read(validateTransferredState)
    const expected = await records(source)
    const sourceId = expected.find(
      (record) =>
        record.table === "capi_metadata" && record.key === '["store_id"]',
    )?.value
    if (
      !sourceId
      || typeof sourceId !== "object"
      || Array.isArray(sourceId)
      || typeof sourceId.value !== "string"
    )
      throw new Error("Source store identity missing")
    namespace.allowRestoredStore(sourceId.value)
    const outbound = await streamBytes(
      createBackupStream(password, undefined, source),
    )
    expect(
      Buffer.from(outbound).includes(
        Buffer.from("fixture-github-transfer-secret"),
      ),
    ).toBe(false)
    expect(
      (
        await restoreBackup(
          bytesStream(outbound, 64 * 1024),
          password,
          namespace.storage,
        )
      ).phase,
    ).toBe("complete")
    expect(await records(namespace.storage)).toEqual(expected)
    await verifyRepositories(namespace.storage, fixture)
    const inbound = await streamBytes(
      createBackupStream(password, undefined, namespace.storage),
    )
    expect(createHash("sha256").update(inbound).digest("hex")).not.toBe(
      createHash("sha256").update(outbound).digest("hex"),
    )
    expect(
      (await restoreBackup(bytesStream(inbound, 64 * 1024), password, target))
        .phase,
    ).toBe("complete")
    expect(await records(target)).toEqual(expected)
    await verifyRepositories(target, fixture)
    const refreshed = await new OAuthStore({
      storage: target,
    }).refreshAccessToken({
      refreshToken: fixture.tokens.refreshToken,
      clientId: fixture.binding.clientId,
    })
    expect(refreshed.status).toBe("ok")
    for (const store of [namespace.storage, target]) {
      for (const table of [
        "capi_admin_sessions",
        "capi_setup_codes",
        "capi_device_login_intents",
      ])
        expect(
          await store.read((session) =>
            session.query({ sql: `SELECT 1 FROM ${table}`, args: [] }),
          ),
        ).toEqual([])
    }
  } finally {
    try {
      await namespace.cleanup()
    } finally {
      await source.close()
      await target.close()
      await removeFixtureDirectory(directory)
    }
  }
}

test("isolated transfer wrapper rejects non-owned SQL before dispatch", () => {
  const namespace = isolatedNamespace({
    read: () => {
      throw new Error("Unexpected backend access")
    },
    transaction: () => {
      throw new Error("Unexpected backend access")
    },
    atomicBatch: () => {
      throw new Error("Unexpected backend access")
    },
    close: async () => {},
  })
  for (const sql of [
    "DROP TABLE other_users",
    "SELECT * FROM capi_unknown",
    "SELECT * FROM sqlite_master",
    "DELETE FROM main.capi_accounts",
    "ATTACH DATABASE 'other' AS other",
    "SELECT * FROM capi_accounts JOIN unrelated ON 1=1",
  ])
    expect(() => namespace.rewrite({ sql, args: [] })).toThrow()
})

test("SQLite simulates the isolated remote namespace and leaves unrelated application tables intact", async () => {
  await mkdir(testRoot, { recursive: true })
  const directory = await mkdtemp(join(testRoot, "simulation-"))
  const backend = new LocalSqliteStorage(join(directory, "remote.sqlite"))
  try {
    await backend.atomicBatch([
      { sql: "CREATE TABLE capi_sentinel(value TEXT)", args: [] },
      { sql: "INSERT INTO capi_sentinel(value) VALUES('untouched')", args: [] },
    ])
    await runTransfer(backend)
    expect(
      await backend.read((session) =>
        session.query({ sql: "SELECT value FROM capi_sentinel", args: [] }),
      ),
    ).toEqual([{ value: "untouched" }])
    expect(
      await backend.read((session) =>
        session.query({
          sql: "SELECT name FROM sqlite_master WHERE substr(name,1,5)='test_'",
          args: [],
        }),
      ),
    ).toEqual([])
  } finally {
    await backend.close()
    await removeFixtureDirectory(directory)
  }
}, 60_000)

test.skipIf(process.env.CAP_STORAGE_REMOTE_TEST !== "1")(
  "encrypted local -> remote -> local transfer preserves persisted identities and credentials",
  async () => {
    const config = resolveStorageConfig()
    if (config.kind !== "turso")
      throw new Error(
        "Remote transfer acceptance requires explicit Turso test configuration",
      )
    const backend = createStorage(config)
    try {
      await runTransfer(backend)
    } finally {
      await backend.close()
    }
  },
  300_000,
)

async function removeFixtureDirectory(directory: string) {
  const checked = resolve(directory)
  if (!checked.startsWith(`${testRoot}${sep}`))
    throw new Error("Unsafe test fixture cleanup path")
  await rm(checked, { recursive: true, force: true })
}
