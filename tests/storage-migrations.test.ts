/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited; Bun's matcher types return void. */
import { afterEach, expect, test } from "bun:test"

import { StorageSchemaError } from "~/lib/storage/errors"
import { migrateStorage } from "~/lib/storage/migrations"
import { getStoreRevision } from "~/lib/storage/operations"

import { createSchemaFixture, faultStorage } from "./helpers/storage-schema"

const fixtures: Array<Awaited<ReturnType<typeof createSchemaFixture>>> = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})

async function fixture() {
  const value = await createSchemaFixture()
  fixtures.push(value)
  return value.storage
}

test("fresh schema includes auth, settings and history with revision zero", async () => {
  const storage = await fixture()
  await migrateStorage(storage)
  expect(await getStoreRevision(storage)).toBe(0)
  const rows = await storage.read((session) =>
    session.query({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'capi_%'",
      args: [],
    }),
  )
  const names = rows.map((row) => row.name)
  for (const name of [
    "accounts",
    "account_credentials",
    "providers",
    "provider_secrets",
    "service_secrets",
    "gateway_credentials",
    "gateway_secrets",
    "inference_credentials",
    "ip_allowlist",
    "admin",
    "admin_sessions",
    "setup_codes",
    "device_login_intents",
    "oauth_codes",
    "oauth_families",
    "oauth_access",
    "oauth_refresh",
    "settings",
    "usage_minutes",
    "usage_lifetime",
    "routing_minutes",
    "activity",
    "applied_operations",
    "imports",
    "process_runs",
    "collection_gaps",
  ])
    expect(names).toContain(`capi_${name}`)
  expect(names).not.toContain("capi_debug")
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT input_tokens, output_tokens, request_count FROM capi_usage_lifetime WHERE id = 1",
        args: [],
      }),
    ),
  ).toEqual([{ input_tokens: 0, output_tokens: 0, request_count: 0 }])
})

test("repeated migration preserves store identity and committed data", async () => {
  const storage = await fixture()
  await migrateStorage(storage)
  const before = await storage.read((session) =>
    session.query({
      sql: "SELECT * FROM capi_metadata ORDER BY key",
      args: [],
    }),
  )
  await migrateStorage(storage)
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT * FROM capi_metadata ORDER BY key",
        args: [],
      }),
    ),
  ).toEqual(before)
})

test.each([
  "UPDATE capi_schema_migrations SET checksum = 'altered'",
  "UPDATE capi_schema_migrations SET name = 'altered'",
  "UPDATE capi_schema_migrations SET version = 999 WHERE version = 2",
  "DELETE FROM capi_metadata WHERE key = 'config_revision'",
  "UPDATE capi_metadata SET value = '-1' WHERE key = 'config_revision'",
  "UPDATE capi_metadata SET value = '01' WHERE key = 'config_revision'",
  "DELETE FROM capi_usage_lifetime",
  "DROP TABLE capi_settings",
  "DROP TABLE capi_gateway_secrets",
])(
  "incompatible or incomplete persisted schema fails closed: %s",
  async (sql) => {
    const storage = await fixture()
    await migrateStorage(storage)
    await storage.atomicBatch([{ sql, args: [] }])
    await expect(migrateStorage(storage)).rejects.toBeInstanceOf(
      StorageSchemaError,
    )
  },
)

test("DDL and metadata roll back together when migration fails", async () => {
  const storage = await fixture()
  const injected = faultStorage(storage, {
    beforeCommit: async (session) => {
      await session.execute({
        sql: "INSERT INTO capi_missing_table VALUES (1)",
        args: [],
      })
    },
  })
  await expect(migrateStorage(injected)).rejects.toThrow()
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'capi_%'",
        args: [],
      }),
    ),
  ).toEqual([])
  await migrateStorage(storage)
})

test("unversioned application tables are never guessed into a migration", async () => {
  const storage = await fixture()
  await storage.atomicBatch([
    { sql: "CREATE TABLE capi_settings (namespace TEXT)", args: [] },
  ])
  await expect(migrateStorage(storage)).rejects.toBeInstanceOf(
    StorageSchemaError,
  )
})

test("account zero is preserved and automatic IDs never recycle removed maximum", async () => {
  const storage = await fixture()
  await migrateStorage(storage)
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_accounts (id,domain,upstream_user_id,created_at,updated_at) VALUES (0,'github.com','user-0',1,1)",
      args: [],
    },
    {
      sql: "INSERT INTO capi_accounts (id,domain,upstream_user_id,created_at,updated_at) VALUES (9,'github.com','user-9',1,1)",
      args: [],
    },
    { sql: "DELETE FROM capi_accounts WHERE id = 9", args: [] },
    {
      sql: "INSERT INTO capi_accounts (domain,upstream_user_id,created_at,updated_at) VALUES ('github.com','user-new',1,1)",
      args: [],
    },
  ])
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT id FROM capi_accounts ORDER BY id",
        args: [],
      }),
    ),
  ).toEqual([{ id: 0 }, { id: 10 }])
  await expect(
    storage.atomicBatch([
      {
        sql: "INSERT INTO capi_account_credentials (account_id,oauth_value,updated_at) VALUES (500,'synthetic-test-value',1)",
        args: [],
      },
    ]),
  ).rejects.toThrow()
  await expect(
    storage.atomicBatch([
      {
        sql: "INSERT INTO capi_accounts (domain,upstream_user_id,created_at,updated_at) VALUES ('github.com','user-0',1,1)",
        args: [],
      },
    ]),
  ).rejects.toThrow()
})
