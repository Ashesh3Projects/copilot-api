/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejection matchers are awaited at runtime. */
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import type { Storage } from "~/lib/storage/types"

import { migrateStorage } from "~/lib/storage/migrations"
import { initialMigration } from "~/lib/storage/migrations/001-initial"

import { createSchemaFixture, faultStorage } from "./helpers/storage-schema"

const initialChecksum =
  "4f3288a9efc4afe51f417e3b1212e3738309b3c95afffd2fed14fa9830d853a1"
const storeId = "9651030a-b765-456c-a4b7-6021149c9f64"
const fixtures: Array<Awaited<ReturnType<typeof createSchemaFixture>>> = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})

async function createV1(): Promise<Storage> {
  const fixture = await createSchemaFixture()
  fixtures.push(fixture)
  await fixture.storage.transaction(async (session) => {
    for (const sql of initialMigration.statements)
      await session.execute({ sql, args: [] })
    for (const [key, value] of [
      ["store_id", storeId],
      ["schema_version", "1"],
      ["config_revision", "7"],
      ["history_activity_generation", "0"],
      ["history_debug_generation", "0"],
    ])
      await session.execute({
        sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
        args: [key, value],
      })
    await session.execute({
      sql: "INSERT INTO capi_schema_migrations(version,name,checksum,applied_at) VALUES(1,?,?,0)",
      args: [initialMigration.name, initialChecksum],
    })
    await session.execute({
      sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app','{}',7)",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at,revoked_at) VALUES('old-active','old-active-digest','Old active',0,NULL),('old-revoked','old-revoked-digest','Old revoked',0,1)",
      args: [],
    })
  })
  return fixture.storage
}

test("gateway migration leaves the applied initial migration immutable", () => {
  expect(
    createHash("sha256").update(JSON.stringify(initialMigration)).digest("hex"),
  ).toBe(initialChecksum)
})

test("version two removes old digest-only keys without replacing unrelated state", async () => {
  const storage = await createV1()
  await migrateStorage(storage)
  const state = await storage.read(async (session) => ({
    migrations: await session.query({
      sql: "SELECT version FROM capi_schema_migrations ORDER BY version",
      args: [],
    }),
    gateways: await session.query({
      sql: "SELECT id FROM capi_gateway_credentials",
      args: [],
    }),
    settings: await session.query({
      sql: "SELECT namespace,value_json,revision FROM capi_settings",
      args: [],
    }),
    identity: await session.query({
      sql: "SELECT value FROM capi_metadata WHERE key='store_id'",
      args: [],
    }),
    version: await session.query({
      sql: "SELECT value FROM capi_metadata WHERE key='schema_version'",
      args: [],
    }),
  }))
  expect(state.migrations).toEqual([
    { version: 1 },
    { version: 2 },
    { version: 3 },
  ])
  expect(state.gateways).toEqual([])
  expect(state.settings).toEqual([
    { namespace: "app", value_json: "{}", revision: 7 },
  ])
  expect(state.identity).toEqual([{ value: storeId }])
  expect(state.version).toEqual([{ value: "3" }])
  expect(
    await storage.read((session) =>
      session.query({ sql: "SELECT * FROM capi_gateway_secrets", args: [] }),
    ),
  ).toEqual([])
})

test("fresh storage includes gateway secrets with cascading deletion", async () => {
  const fixture = await createSchemaFixture()
  fixtures.push(fixture)
  await migrateStorage(fixture.storage)
  const names = await fixture.storage.read((session) =>
    session.query({
      sql: "SELECT name FROM sqlite_master WHERE type='table'",
      args: [],
    }),
  )
  expect(names.map((row) => row.name)).toContain("capi_gateway_secrets")
  await fixture.storage.transaction(async (session) => {
    await session.execute({
      sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES('fixture','fixture-digest','Fixture',0)",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_gateway_secrets(credential_id,secret_value,updated_at) VALUES('fixture','fixture-raw-key',0)",
      args: [],
    })
    await session.execute({
      sql: "DELETE FROM capi_gateway_credentials WHERE id='fixture'",
      args: [],
    })
  })
  expect(
    await fixture.storage.read((session) =>
      session.query({ sql: "SELECT * FROM capi_gateway_secrets", args: [] }),
    ),
  ).toEqual([])
})

test("a failed upgrade retains old keys and schema until the transaction succeeds", async () => {
  const storage = await createV1()
  const failing = faultStorage(storage, {
    beforeCommit: () => {
      throw new Error("fixture rollback")
    },
  })
  await expect(migrateStorage(failing)).rejects.toThrow("fixture rollback")
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT id FROM capi_gateway_credentials",
        args: [],
      }),
    ),
  ).toHaveLength(2)
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT name FROM sqlite_master WHERE name='capi_gateway_secrets'",
        args: [],
      }),
    ),
  ).toEqual([])
  await migrateStorage(storage)
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT id FROM capi_gateway_credentials",
        args: [],
      }),
    ),
  ).toEqual([])
})

test("repeat startup does not clear newly stored gateway keys", async () => {
  const storage = await createV1()
  await migrateStorage(storage)
  const names = await storage.read((session) =>
    session.query({
      sql: "SELECT name FROM sqlite_master WHERE type='table'",
      args: [],
    }),
  )
  expect(names.map((row) => row.name)).toContain("capi_gateway_secrets")
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES('new','new-digest','New',0)",
      args: [],
    },
    {
      sql: "INSERT INTO capi_gateway_secrets(credential_id,secret_value,updated_at) VALUES('new','new-raw-key',0)",
      args: [],
    },
  ])
  await migrateStorage(storage)
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT secret_value FROM capi_gateway_secrets WHERE credential_id='new'",
        args: [],
      }),
    ),
  ).toEqual([{ secret_value: "new-raw-key" }])
})
