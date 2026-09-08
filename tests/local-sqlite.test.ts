/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async rejection matchers have void type declarations. */
import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SqlSession, Storage } from "~/lib/storage/types"

import { createStorage } from "~/lib/storage/client"
import { StorageUnavailableError } from "~/lib/storage/errors"
import { withStorageDeadline } from "~/lib/storage/operation-budget"

const dirs: Array<string> = []
const stores: Array<Storage> = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "capi-sqlite-"))
  dirs.push(dir)
  const path = join(dir, "copilot-api.sqlite")
  const storage = createStorage({ kind: "sqlite", path })
  stores.push(storage)
  return { dir, path, storage }
}
const sql = (sql: string) => ({ sql, args: [] })

test("file database persists and has exactly SQLite-managed sidecars", async () => {
  const { storage, dir, path } = fixture()
  await storage.atomicBatch([
    sql("CREATE TABLE sample(id INTEGER PRIMARY KEY)"),
    sql("INSERT INTO sample VALUES (7)"),
  ])
  expect(readdirSync(dir).sort()).toEqual([
    "copilot-api.sqlite",
    "copilot-api.sqlite-shm",
    "copilot-api.sqlite-wal",
  ])
  const db = new Database(path)
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
  db.close()
  await storage.close()
  const reopened = createStorage({ kind: "sqlite", path })
  stores.push(reopened)
  expect(
    await reopened.read((s) => s.query(sql("SELECT * FROM sample"))),
  ).toEqual([{ id: 7 }])
})

test("connection verifies FK FULL and bounded busy timeout", async () => {
  const { storage } = fixture()
  for (const [name, value] of [
    ["foreign_keys", 1],
    ["synchronous", 2],
    ["busy_timeout", 5000],
  ] as const) {
    const rows = await storage.read((s) => s.query(sql(`PRAGMA ${name}`)))
    expect(Object.values(rows[0])[0]).toBe(value)
  }
})

test("throwing after await rolls back all writes and queued readers see no dirty data", async () => {
  const { storage } = fixture()
  await storage.atomicBatch([sql("CREATE TABLE sample(id INTEGER)")])
  let release!: () => void
  let entered!: () => void
  const hold = new Promise<void>((r) => {
    release = r
  })
  const started = new Promise<void>((r) => {
    entered = r
  })
  const tx = storage.transaction(async (s) => {
    await s.execute(sql("INSERT INTO sample VALUES (1)"))
    entered()
    await hold
    await s.execute(sql("INSERT INTO sample VALUES (2)"))
    throw new Error("rollback fixture")
  })
  const failure = tx.catch((error: unknown) => error)
  await started
  const read = storage.read((s) => s.query(sql("SELECT * FROM sample")))
  release()
  expect(await failure).toEqual(new Error("rollback fixture"))
  expect(await read).toEqual([])
})

test("nested operations and escaped handles reject without deadlock", async () => {
  const { storage } = fixture()
  let leaked!: SqlSession
  await storage.transaction(async (s) => {
    leaked = s
    await expect(
      storage.read((inner) => inner.query(sql("SELECT 1"))),
    ).rejects.toThrow("Nested")
  })
  await expect(leaked.query(sql("SELECT 1"))).rejects.toThrow("closed")
})

test("invalid database fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "capi-corrupt-"))
  dirs.push(dir)
  const path = join(dir, "copilot-api.sqlite")
  writeFileSync(path, "not a database")
  expect(() => createStorage({ kind: "sqlite", path })).toThrow(
    StorageUnavailableError,
  )
})

test("expired queue admission does not bypass its predecessor or run SQL later", async () => {
  const { storage } = fixture()
  let release!: () => void
  let entered!: () => void
  const hold = new Promise<void>((r) => {
    release = r
  })
  const start = new Promise<void>((r) => {
    entered = r
  })
  const first = storage.transaction(async () => {
    entered()
    await hold
  })
  await start
  let executed = false
  const error: unknown = await withStorageDeadline(Date.now() + 20, () =>
    storage.transaction(async () => {
      executed = true
      await Promise.resolve()
    }),
  ).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(StorageUnavailableError)
  expect(executed).toBe(false)
  release()
  await first
  await storage.read((s) => s.query(sql("SELECT 1")))
  expect(executed).toBe(false)
})

test("local callback deadline rolls back and revokes its handle", async () => {
  const { storage } = fixture()
  await storage.atomicBatch([sql("CREATE TABLE sample(id)")])
  let leaked: SqlSession | undefined
  const error: unknown = await withStorageDeadline(Date.now() + 20, () =>
    storage.transaction(async (s) => {
      leaked = s
      await s.execute(sql("INSERT INTO sample VALUES (1)"))
      await new Promise<void>(() => {})
    }),
  ).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(StorageUnavailableError)
  expect(
    await storage.read((s) => s.query(sql("SELECT * FROM sample"))),
  ).toEqual([])
  await expect(leaked?.query(sql("SELECT 1"))).rejects.toThrow("closed")
})
