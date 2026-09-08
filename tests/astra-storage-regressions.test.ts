/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejection matchers require awaiting despite their declarations. */
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import type { SqlSession, Storage } from "~/lib/storage/types"

const testRoot = resolve(
  import.meta.dir,
  "../.superpowers/test-data/astra-storage",
)
process.env.DATA_DIR = testRoot
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN

const auth = await import("~/lib/admin-auth")
const { mergeConfigWithDefaults, setConfigForTest } = await import(
  "~/lib/config"
)
const { createBackupStream } = await import("~/lib/config-backup")
const { createCredentialsRepository } = await import(
  "~/lib/storage/credentials-repository"
)
const { StorageCommitUnknownError, StorageUnavailableError } = await import(
  "~/lib/storage/errors"
)
const { LocalSqliteStorage } = await import("~/lib/storage/local-sqlite")
const { migrateStorage } = await import("~/lib/storage/migrations")
const { restoreBackup } = await import("~/lib/storage/restore")
const { closeStorageRuntime, initializeStorageRuntime } = await import(
  "~/lib/storage/runtime"
)

const fixtures: Array<{ storage: Storage; directory: string }> = []
async function createFixture() {
  await mkdir(testRoot, { recursive: true })
  const directory = await mkdtemp(join(testRoot, "store-"))
  const config = {
    kind: "sqlite" as const,
    path: join(directory, "copilot-api.sqlite"),
  }
  const storage = new LocalSqliteStorage(config.path)
  fixtures.push({ storage, directory })
  await migrateStorage(storage)
  return { storage, config }
}
afterEach(async () => {
  setConfigForTest(null)
  auth.setAdminAuthClockForTest()
  await closeStorageRuntime()
  for (const { storage, directory } of fixtures.splice(0)) {
    await storage.close()
    const checked = resolve(directory)
    if (!checked.startsWith(`${testRoot}${sep}`))
      throw new Error("Unsafe storage fixture cleanup")
    await rm(checked, { recursive: true, force: true })
  }
})
async function backup(storage: Storage) {
  return new Uint8Array(
    await new Response(
      createBackupStream("fixture-backup-password", undefined, storage),
    ).arrayBuffer(),
  )
}
function stream(bytes: Uint8Array) {
  const body = new Response(bytes).body
  if (!body) throw new Error("Missing fixture stream")
  return body
}
async function markers(storage: Storage) {
  return storage.read((session) =>
    session.query({
      sql: "SELECT value FROM capi_metadata WHERE key='transfer_incomplete'",
      args: [],
    }),
  )
}
async function appDocument(storage: Storage) {
  const rows = await storage.read((session) =>
    session.query({
      sql: "SELECT value_json FROM capi_settings WHERE namespace='app'",
      args: [],
    }),
  )
  return JSON.parse(String(rows[0].value_json)) as Record<string, unknown>
}
async function freshBackup() {
  const source = await createFixture()
  return backup(source.storage)
}

test("first-run defaults and browser setup produce a backup that restores the same login", async () => {
  const source = await createFixture()
  await initializeStorageRuntime(source)
  setConfigForTest(null)
  await mergeConfigWithDefaults()
  const { code } = await auth.issueAdminSetupCode()
  const setup = await auth.setupAdminAuth(
    "fixture-gateway-key",
    "fixture-admin-password",
    code,
  )
  expect(setup).toHaveProperty("session")
  const bytes = await backup(source.storage)
  const target = await createFixture()
  const restored = await restoreBackup(
    stream(bytes),
    "fixture-backup-password",
    target.storage,
  )
  expect(restored.phase).toBe("complete")
  expect(await markers(target.storage)).toHaveLength(0)
  expect(await appDocument(target.storage)).not.toHaveProperty("auth")
  await closeStorageRuntime()
  await initializeStorageRuntime(target)
  expect(await auth.getAdminAuthStatus()).toMatchObject({
    configured: true,
    gatewayConfigured: true,
  })
  expect(
    await target.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_admin_sessions",
        args: [],
      }),
    ),
  ).toEqual([{ count: 0 }])
  expect(
    await auth.loginAdmin("fixture-gateway-key", "fixture-admin-password"),
  ).not.toBeNull()
  expect(
    await auth.loginAdmin("wrong-gateway-key", "fixture-admin-password"),
  ).toBeNull()
})

test.each([
  { auth: { apiKeys: [] } },
  { auth: {} },
  { customProviders: [], groqApiKey: "" },
])(
  "old empty credential shadow fields remain restorable: %j",
  async (shadow) => {
    const source = await createFixture()
    await source.storage.atomicBatch([
      {
        sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app',?,0)",
        args: [JSON.stringify({ smallModel: "retained-model", ...shadow })],
      },
    ])
    const bytes = await backup(source.storage)
    const target = await createFixture()
    expect(
      (
        await restoreBackup(
          stream(bytes),
          "fixture-backup-password",
          target.storage,
        )
      ).phase,
    ).toBe("complete")
    expect((await appDocument(target.storage)).smallModel).toBe(
      "retained-model",
    )
    expect(
      await createCredentialsRepository(
        target.storage,
      ).hasActiveGatewayCredentials(),
    ).toBe(false)
  },
)

test("restoring an app document never revives a nonempty shadow gateway credential", async () => {
  const source = await createFixture()
  await source.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app',?,0)",
      args: [JSON.stringify({ auth: { apiKeys: ["fixture-shadow-key"] } })],
    },
  ])
  const bytes = await backup(source.storage)
  const target = await createFixture()
  await expect(
    restoreBackup(stream(bytes), "fixture-backup-password", target.storage),
  ).rejects.toThrow()
  expect(await markers(target.storage)).toHaveLength(1)
  expect(
    await createCredentialsRepository(target.storage).gateway(
      "fixture-shadow-key",
    ),
  ).toBeNull()
})

test.each(["validation", "marker-removal"] as const)(
  "abort during restore promotion at %s keeps the target incomplete",
  async (stage) => {
    const bytes = await freshBackup()
    const target = await createFixture()
    const controller = new AbortController()
    const wrap = (session: SqlSession): SqlSession => ({
      query: async (statement) => {
        const rows = await session.query(statement)
        if (
          stage === "validation"
          && statement.sql === "SELECT key,value FROM capi_metadata"
        )
          controller.abort()
        return rows
      },
      execute: async (statement) => {
        const result = await session.execute(statement)
        if (
          stage === "marker-removal"
          && statement.sql
            === "DELETE FROM capi_metadata WHERE key=? AND value=?"
        )
          controller.abort()
        return result
      },
    })
    const interrupted: Storage = {
      read: (work) => target.storage.read(work),
      transaction: (work) =>
        target.storage.transaction((session) => work(wrap(session))),
      atomicBatch: (statements) => target.storage.atomicBatch(statements),
      close: () => Promise.resolve(),
    }
    await expect(
      restoreBackup(
        stream(bytes),
        "fixture-backup-password",
        interrupted,
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(await markers(target.storage)).toHaveLength(1)
  },
)

function losePromotionResponse(
  storage: Storage,
  reconcile: "available" | "unavailable" | "mismatched",
) {
  const state = { promotionAttempts: 0, lost: false }
  const wrapped: Storage = {
    read: (work) =>
      state.lost && reconcile === "unavailable" ?
        Promise.reject(new StorageUnavailableError())
      : storage.read(work),
    transaction: async (work) => {
      const transaction = { promoting: false }
      const result = await storage.transaction((session) =>
        work({
          query: (statement) => session.query(statement),
          execute: (statement) => {
            if (
              statement.sql
              === "DELETE FROM capi_metadata WHERE key=? AND value=?"
            )
              transaction.promoting = true
            return session.execute(statement)
          },
        }),
      )
      if (transaction.promoting) {
        state.promotionAttempts++
        state.lost = true
        if (reconcile === "mismatched")
          await storage.atomicBatch([
            {
              sql: "UPDATE capi_applied_operations SET input_digest='mismatched' WHERE kind='restore.complete'",
              args: [],
            },
          ])
        throw new StorageCommitUnknownError()
      }
      return result
    },
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: () => Promise.resolve(),
  }
  return { wrapped, state }
}

test("lost final restore commit reconciles its receipt without repeating promotion", async () => {
  const bytes = await freshBackup()
  const target = await createFixture()
  const { wrapped, state } = losePromotionResponse(target.storage, "available")
  const result = await restoreBackup(
    stream(bytes),
    "fixture-backup-password",
    wrapped,
  )
  expect(result.phase).toBe("complete")
  expect(await markers(target.storage)).toHaveLength(0)
  expect(state.promotionAttempts).toBe(1)
  const receipts = await target.storage.read((session) =>
    session.query({
      sql: "SELECT id,result_json FROM capi_applied_operations WHERE kind='restore.complete'",
      args: [],
    }),
  )
  expect(receipts).toHaveLength(1)
  expect(receipts[0].id).toBe(result.operationId)
  expect(JSON.stringify(receipts)).not.toContain("fixture-backup-password")
})

test.each(["unavailable", "mismatched"] as const)(
  "unconfirmed restore promotion returns an operation ID when reconciliation is %s",
  async (mode) => {
    const bytes = await freshBackup()
    const target = await createFixture()
    const { wrapped, state } = losePromotionResponse(target.storage, mode)
    let failure: unknown
    try {
      await restoreBackup(stream(bytes), "fixture-backup-password", wrapped)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(StorageCommitUnknownError)
    if (!(failure instanceof StorageCommitUnknownError))
      throw new Error("Expected an uncertain commit outcome")
    expect(typeof failure.operationId).toBe("string")
    expect(String(failure)).not.toContain("remains incomplete")
    expect(await markers(target.storage)).toHaveLength(0)
    expect(state.promotionAttempts).toBe(1)
  },
)
