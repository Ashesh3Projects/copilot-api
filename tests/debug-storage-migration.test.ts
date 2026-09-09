/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejection matchers must be awaited at runtime. */
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import type { Storage } from "~/lib/storage/types"

import { StorageSchemaError } from "~/lib/storage/errors"
import { migrateStorage } from "~/lib/storage/migrations"
import { initialMigration } from "~/lib/storage/migrations/001-initial"
import { gatewaySecretsMigration } from "~/lib/storage/migrations/002-gateway-secrets"

import { createSchemaFixture, faultStorage } from "./helpers/storage-schema"

const storeId = "9651030a-b765-456c-a4b7-6021149c9f64"
const fixtures: Array<Awaited<ReturnType<typeof createSchemaFixture>>> = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})

async function legacyFixture(version: 1 | 2): Promise<Storage> {
  const fixture = await createSchemaFixture()
  fixtures.push(fixture)
  await fixture.storage.transaction(async (session) => {
    for (const migration of [initialMigration, gatewaySecretsMigration].slice(
      0,
      version,
    )) {
      for (const sql of migration.statements)
        await session.execute({ sql, args: [] })
      await session.execute({
        sql: "INSERT INTO capi_schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,0)",
        args: [
          migration.version,
          migration.name,
          createHash("sha256").update(JSON.stringify(migration)).digest("hex"),
        ],
      })
    }
    for (const [key, value] of [
      ["store_id", storeId],
      ["schema_version", String(version)],
      ["config_revision", "7"],
      ["history_activity_generation", "4"],
      ["history_debug_generation", "9"],
    ])
      await session.execute({
        sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
        args: [key, value],
      })
    await session.execute({
      sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app','{}',7)",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_activity(id,generation,created_at,expires_at,kind,payload_json,payload_bytes) VALUES('retained-activity',4,1,9999999999999,'info','{}',2)",
      args: [],
    })
    const payload = JSON.stringify({ request: "legacy-private-fixture" })
    await session.execute({
      sql: "INSERT INTO capi_debug(id,generation,created_at,updated_at,expires_at,status,payload_json,payload_bytes) VALUES('retired-debug',9,1,1,9999999999999,'complete',?,?)",
      args: [payload, Buffer.byteLength(payload)],
    })
  })
  return fixture.storage
}

test("debug retirement leaves both applied migration checksums immutable", () => {
  expect(
    [initialMigration, gatewaySecretsMigration].map((migration) =>
      createHash("sha256").update(JSON.stringify(migration)).digest("hex"),
    ),
  ).toEqual([
    "4f3288a9efc4afe51f417e3b1212e3738309b3c95afffd2fed14fa9830d853a1",
    "4bfc8a99b4e7c89d01fa1f35e3d7f67d3f7c6454db14891ce3f4e258f6d12eeb",
  ])
})

test.each([1, 2] as const)(
  "schema %i upgrade removes persisted debug and its indexes without altering durable state",
  async (version) => {
    const storage = await legacyFixture(version)
    await migrateStorage(storage)
    await migrateStorage(storage)
    const state = await storage.read(async (session) => ({
      retired: await session.query({
        sql: "SELECT name FROM sqlite_master WHERE name LIKE 'capi_debug%'",
        args: [],
      }),
      metadata: await session.query({
        sql: "SELECT key,value FROM capi_metadata ORDER BY key",
        args: [],
      }),
      activity: await session.query({
        sql: "SELECT id,generation FROM capi_activity",
        args: [],
      }),
      settings: await session.query({
        sql: "SELECT namespace,revision FROM capi_settings",
        args: [],
      }),
    }))
    expect(state.retired).toEqual([])
    expect(state.metadata).toEqual([
      { key: "config_revision", value: "7" },
      { key: "history_activity_generation", value: "4" },
      { key: "schema_version", value: "3" },
      { key: "store_id", value: storeId },
    ])
    expect(state.activity).toEqual([{ id: "retained-activity", generation: 4 }])
    expect(state.settings).toEqual([{ namespace: "app", revision: 7 }])
  },
)

test.each([
  "DELETE FROM capi_metadata WHERE key='history_debug_generation'",
  "UPDATE capi_metadata SET value='-1' WHERE key='history_debug_generation'",
  "DROP INDEX capi_debug_expiry",
  "DROP TABLE capi_debug",
])(
  "legacy preflight rejects incomplete schema before debug retirement: %s",
  async (sql) => {
    const storage = await legacyFixture(2)
    await storage.atomicBatch([{ sql, args: [] }])
    await expect(migrateStorage(storage)).rejects.toBeInstanceOf(
      StorageSchemaError,
    )
    expect(
      await storage.read((session) =>
        session.query({
          sql: "SELECT value FROM capi_metadata WHERE key='schema_version'",
          args: [],
        }),
      ),
    ).toEqual([{ value: "2" }])
  },
)

test("debug retirement rolls back atomically if its transaction fails", async () => {
  const storage = await legacyFixture(2)
  await expect(
    migrateStorage(
      faultStorage(storage, {
        beforeCommit: () => {
          throw new Error("fixture rollback")
        },
      }),
    ),
  ).rejects.toThrow("fixture rollback")
  expect(
    await storage.read((session) =>
      session.query({ sql: "SELECT id FROM capi_debug", args: [] }),
    ),
  ).toEqual([{ id: "retired-debug" }])
  await migrateStorage(storage)
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT name FROM sqlite_master WHERE name='capi_debug'",
        args: [],
      }),
    ),
  ).toEqual([])
})
