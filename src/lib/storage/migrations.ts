import { createHash, randomUUID } from "node:crypto"

import type { SqlSession, Storage } from "~/lib/storage/types"

import {
  StorageCommitUnknownError,
  StorageSchemaError,
} from "~/lib/storage/errors"
import {
  initialMigration,
  initialTables,
  initialIndexes,
} from "~/lib/storage/migrations/001-initial"
import {
  currentIndexes,
  currentSchemaVersion,
  currentTables,
  schemaThreeTables,
  storageMigrations,
} from "~/lib/storage/schema"

const checksums = storageMigrations.map((migration) =>
  createHash("sha256").update(JSON.stringify(migration)).digest("hex"),
)
const counterKeys = ["config_revision", "history_debug_generation"] as const

export function parseStorageCounter(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new StorageSchemaError("Invalid storage counter")
  }
  const counter = Number(value)
  if (!Number.isSafeInteger(counter)) {
    throw new StorageSchemaError("Storage counter exceeds supported range")
  }
  return counter
}

async function applicationObjects(session: SqlSession) {
  return session.query({
    sql: "SELECT name, type FROM sqlite_master WHERE substr(name, 1, 5) = 'capi_'",
    args: [],
  })
}

async function appliedVersion(session: SqlSession): Promise<number> {
  const migrations = await session.query({
    sql: "SELECT version, name, checksum FROM capi_schema_migrations ORDER BY version",
    args: [],
  })
  if (
    migrations.length === 0
    || migrations.length > storageMigrations.length
    || migrations.some((row, index) => {
      const expected = storageMigrations[index]
      return (
        row.version !== expected.version
        || row.name !== expected.name
        || row.checksum !== checksums[index]
      )
    })
  )
    throw new StorageSchemaError("Unsupported or changed schema migration")
  return migrations.length
}

async function validateSchema(
  session: SqlSession,
  version: number,
): Promise<void> {
  const objects = await applicationObjects(session)
  const tables = new Set(
    objects.filter((row) => row.type === "table").map((row) => row.name),
  )
  const indexes = new Set(
    objects.filter((row) => row.type === "index").map((row) => row.name),
  )
  let expectedTables: object = currentTables
  if (version === 1) expectedTables = initialTables
  else if (version < 4) expectedTables = schemaThreeTables
  if (
    Object.keys(expectedTables).some((name) => !tables.has(name))
    || Object.keys(version < 4 ? initialIndexes : currentIndexes).some(
      (name) => !indexes.has(name),
    )
  ) {
    throw new StorageSchemaError("Application schema is incomplete")
  }
  if ((await appliedVersion(session)) !== version) {
    throw new StorageSchemaError("Unsupported or changed schema migration")
  }
  const rows = await session.query({
    sql: "SELECT key, value FROM capi_metadata",
    args: [],
  })
  const metadata = new Map(rows.map((row) => [row.key, row.value]))
  if (
    metadata.get("schema_version") !== String(version)
    || typeof metadata.get("store_id") !== "string"
    || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(
      String(metadata.get("store_id")),
    )
  ) {
    throw new StorageSchemaError("Required storage metadata is invalid")
  }
  for (const key of counterKeys) parseStorageCounter(metadata.get(key))
  if (version < 4)
    parseStorageCounter(metadata.get("history_activity_generation"))
  const lifetime = await session.query({
    sql: "SELECT id FROM capi_usage_lifetime",
    args: [],
  })
  if (lifetime.length !== 1 || lifetime[0]?.id !== 1) {
    throw new StorageSchemaError("Usage lifetime singleton is missing")
  }
}

/** All DDL and migration metadata commit together; never repair partial schemas. */
export async function migrateStorage(storage: Storage): Promise<void> {
  try {
    await storage.transaction(async (session) => {
      const objects = await applicationObjects(session)
      if (objects.length === 0) {
        for (const sql of initialMigration.statements) {
          await session.execute({ sql, args: [] })
        }
        const metadata: Array<[string, string]> = [
          ["schema_version", String(initialMigration.version)],
          ["store_id", randomUUID()],
          ["history_activity_generation", "0"],
          ...counterKeys.map((key): [string, string] => [key, "0"]),
        ]
        for (const [key, value] of metadata) {
          await session.execute({
            sql: "INSERT INTO capi_metadata (key, value) VALUES (?, ?)",
            args: [key, value],
          })
        }
        await session.execute({
          sql: "INSERT INTO capi_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          args: [
            initialMigration.version,
            initialMigration.name,
            checksums[0],
            Date.now(),
          ],
        })
      }
      const version = await appliedVersion(session)
      await validateSchema(session, version)
      for (const migration of storageMigrations.slice(version)) {
        for (const sql of migration.statements)
          await session.execute({ sql, args: [] })
        await session.execute({
          sql: "INSERT INTO capi_schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)",
          args: [
            migration.version,
            migration.name,
            checksums[migration.version - 1],
            Date.now(),
          ],
        })
        await session.execute({
          sql: "UPDATE capi_metadata SET value=? WHERE key='schema_version'",
          args: [String(migration.version)],
        })
      }
      await validateSchema(session, currentSchemaVersion)
    })
  } catch (error) {
    if (!(error instanceof StorageCommitUnknownError)) throw error
    // The adapter opens a fresh read session; no DDL is replayed after ambiguity.
    try {
      await storage.read((session) =>
        validateSchema(session, currentSchemaVersion),
      )
    } catch {
      throw error
    }
  }
}
