/* eslint-disable max-lines-per-function -- One test-only closure owns the exact namespace and cleanup capability. */
import { randomUUID } from "node:crypto"

import type { SqlSession, SqlStatement, Storage } from "~/lib/storage/types"

import { migrateStorage } from "~/lib/storage/migrations"
import {
  initialIndexes,
  initialTables,
} from "~/lib/storage/migrations/001-initial"
import {
  currentIndexes,
  currentTables,
  storageMigrations,
} from "~/lib/storage/schema"

const applicationObjectsSql =
  "SELECT name, type FROM sqlite_master WHERE substr(name, 1, 5) = 'capi_'"
const tableNames = Object.keys(currentTables)
const indexNames = Object.keys(currentIndexes)

/** No unprefixed application SQL reaches the supplied backend. */
export function isolatedNamespace(underlying: Storage) {
  const prefix = `test_${randomUUID().replaceAll("-", "")}_`
  if (!/^test_[a-f\d]{32}_$/.test(prefix))
    throw new Error("Invalid test namespace")
  const mapping = new Map(
    // Migration 001 creates Activity before migration 004 removes it. Scope all
    // historical objects to the same owned prefix during that transaction.
    [
      ...new Set([
        ...tableNames,
        ...indexNames,
        ...Object.keys(initialTables),
        ...Object.keys(initialIndexes),
      ]),
    ].map((name) => [name, `${prefix}${name}`]),
  )
  const reverse = new Map(
    [...mapping].map(([logical, physical]) => [physical, logical]),
  )
  const permittedStoreIds = new Set<string>()
  let created = false
  let rewrittenStatements = 0

  function rewrite(statement: SqlStatement): SqlStatement {
    if (
      [
        "SELECT 1 AS ok",
        "SELECT sqlite_version() AS version",
        "SELECT turso_version() AS version",
      ].includes(statement.sql)
      && statement.args.length === 0
    )
      return statement
    if (
      statement.sql
      === "SELECT name FROM sqlite_master WHERE type = ? AND name = ?"
    ) {
      const physical =
        typeof statement.args[1] === "string" ?
          mapping.get(statement.args[1])
        : undefined
      if (statement.args[0] !== "table" || !physical)
        throw new Error("Unapproved table readiness probe")
      return { sql: statement.sql, args: ["table", physical] }
    }
    if (statement.sql === applicationObjectsSql) {
      return {
        sql: "SELECT name, type FROM sqlite_master WHERE substr(name, 1, ?) = ?",
        args: [prefix.length, prefix],
      }
    }
    if (/\bsqlite_(?:master|schema|sequence)\b/i.test(statement.sql))
      throw new Error("Unapproved schema access in transfer test")
    if (/\b(?:ATTACH|DETACH|PRAGMA|VACUUM)\b/i.test(statement.sql))
      throw new Error("Unapproved database operation in transfer test")
    const sql = statement.sql.replaceAll(/\bcapi_\w+\b/g, (name) => {
      const physical = mapping.get(name)
      if (!physical)
        throw new Error("Transfer accessed an unapproved application object")
      return physical
    })
    if (sql === statement.sql)
      throw new Error("Transfer SQL did not address its isolated namespace")
    // Reject non-application table references as well as attempts to escape via a qualified name.
    const code = sql.replaceAll(/'(?:''|[^'])*'/g, "''")
    for (const match of code.matchAll(
      /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?: IF (?:NOT )?EXISTS)?)\s+([\w.]+)/gi,
    )) {
      if (match[1].toUpperCase() === "SET") continue
      if (!reverse.has(match[1]))
        throw new Error("Transfer SQL addressed a non-owned table")
    }
    rewrittenStatements += 1
    return { ...statement, sql }
  }
  const wrap = (session: SqlSession): SqlSession => ({
    query: async (statement) => {
      const rows = await session.query(rewrite(statement))
      return statement.sql.includes("FROM sqlite_master") ?
          rows.map((row) => ({
            ...row,
            name: reverse.get(String(row.name)) ?? row.name,
          }))
        : rows
    },
    execute: (statement) => session.execute(rewrite(statement)),
  })
  const storage: Storage = {
    read: (work) => underlying.read((session) => work(wrap(session))),
    transaction: (work) =>
      underlying.transaction((session) => work(wrap(session))),
    atomicBatch: (statements) =>
      underlying.atomicBatch(statements.map((statement) => rewrite(statement))),
    readSnapshot: (work, options) =>
      underlying.readSnapshot ?
        underlying.readSnapshot((session) => work(wrap(session)), options)
      : underlying.read((session) => work(wrap(session))),
    close: async () => {},
  }
  async function objects() {
    return underlying.read((session) =>
      session.query({
        sql: "SELECT name, type FROM sqlite_master WHERE substr(name, 1, ?) = ?",
        args: [prefix.length, prefix],
      }),
    )
  }
  async function storeId() {
    const rows = await storage.read((session) =>
      session.query({
        sql: "SELECT value FROM capi_metadata WHERE key='store_id'",
        args: [],
      }),
    )
    const id = String(rows[0]?.value)
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id))
      throw new Error("Invalid isolated store identity")
    return id
  }
  return {
    storage,
    prefix,
    rewrite,
    allowRestoredStore(id: string) {
      permittedStoreIds.add(id)
    },
    async initialize() {
      if ((await objects()).length > 0)
        throw new Error("Random test namespace already exists")
      await migrateStorage(storage)
      created = true
      permittedStoreIds.add(await storeId())
      // Exercise mapped sqlite_master names on the existing-schema migration path.
      await migrateStorage(storage)
    },
    async cleanup() {
      const owned = await objects()
      if (owned.length === 0) return
      if (!created || !permittedStoreIds.has(await storeId()))
        throw new Error("Refusing cleanup without verified test ownership")
      for (const object of owned) {
        const logical = reverse.get(String(object.name))
        const expectedType =
          logical && tableNames.includes(logical) ? "table" : "index"
        if (
          !logical
          || object.type !== expectedType
          || !String(object.name).startsWith(prefix)
        )
          throw new Error(
            "Unexpected object in owned test namespace; cleanup refused",
          )
      }
      const migrations = await storage.read((session) =>
        session.query({
          sql: "SELECT version,name FROM capi_schema_migrations ORDER BY version",
          args: [],
        }),
      )
      if (
        migrations.length !== storageMigrations.length
        || migrations.some(
          (row, index) =>
            row.version !== storageMigrations[index].version
            || row.name !== storageMigrations[index].name,
        )
      )
        throw new Error("Invalid test migration ownership")
      // Initial DDL is in dependency order; reverse order preserves FK enforcement.
      await underlying.transaction(async (session) => {
        for (const name of [...tableNames].reverse()) {
          const physical = mapping.get(name)
          if (
            !physical
            || !reverse.has(physical)
            || !physical.startsWith(prefix)
          )
            throw new Error("Unsafe cleanup target")
          await session.execute({
            sql: `DROP TABLE IF EXISTS ${physical}`,
            args: [],
          })
        }
      })
      if ((await objects()).length > 0 || rewrittenStatements === 0)
        throw new Error("Isolated schema cleanup failed")
    },
  }
}
