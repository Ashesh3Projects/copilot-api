/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async rejection matchers have void type declarations. */
import { afterEach, expect, test } from "bun:test"

import type { SqlSession } from "~/lib/storage/types"

import { createStorage } from "~/lib/storage/client"
import {
  StorageCommitUnknownError,
  StorageUnavailableError,
} from "~/lib/storage/errors"

import { createFakeTursoFetch, testConfig } from "./helpers/turso-transport"

let remote: ReturnType<typeof createFakeTursoFetch> | undefined
afterEach(() => {
  remote?.close()
  remote = undefined
})
const sql = (sql: string) => ({ sql, args: [] })

test("backup cancellation during remote session setup prevents callback admission", async () => {
  remote = createFakeTursoFetch()
  const storage = createStorage(testConfig())
  const abort = new AbortController()
  let entered = false
  const result = storage.readSnapshot?.(
    async () => {
      await Promise.resolve()
      entered = true
    },
    { signal: abort.signal },
  )
  abort.abort()
  await expect(result).rejects.toThrow()
  expect(entered).toBe(false)
  await storage.close()
})

test("real SDK normalizes URL and binds string binary null and exact integers", async () => {
  remote = createFakeTursoFetch()
  const storage = createStorage(testConfig())
  const rows = await storage.read((s) =>
    s.query({
      sql: "SELECT ? AS text, ? AS blob, ? AS empty, ? AS large, ? AS small",
      args: [
        "' ; COMMIT --",
        new Uint8Array([0, 255]),
        null,
        9007199254740993n,
        7,
      ],
    }),
  )
  expect(rows).toEqual([
    {
      text: "' ; COMMIT --",
      blob: new Uint8Array([0, 255]),
      empty: null,
      large: 9007199254740993n,
      small: 7,
    },
  ])
  expect(
    remote.requests.every((r) =>
      r.url.startsWith("https://storage-test.example/v3/"),
    ),
  ).toBe(true)
  const statements = remote.requests.flatMap(
    (r) =>
      r.body.batch?.steps.map((s) => s.stmt.sql)
      ?? r.body.requests?.flatMap((s) => (s.sql ? [s.sql] : []))
      ?? [],
  )
  expect(statements.indexOf("PRAGMA foreign_keys=ON")).toBeLessThan(
    statements.indexOf("BEGIN"),
  )
  await storage.close()
})

test("fixed batch has explicit immediate transaction and pipeline commit", async () => {
  remote = createFakeTursoFetch()
  const storage = createStorage(testConfig())
  await storage.atomicBatch([
    sql("CREATE TABLE capi_probe(id TEXT PRIMARY KEY)"),
  ])
  const controls = remote.requests.flatMap(
    (r) => r.body.requests?.flatMap((s) => (s.sql ? [s.sql] : [])) ?? [],
  )
  expect(controls).toContain("BEGIN IMMEDIATE")
  expect(controls).toContain("COMMIT")
  await storage.close()
})

test("lost commit response is not replayed", async () => {
  remote = createFakeTursoFetch()
  const storage = createStorage(testConfig())
  await storage.atomicBatch([
    sql("CREATE TABLE capi_probe(id TEXT PRIMARY KEY)"),
  ])
  remote.close()
  remote = createFakeTursoFetch({ loseFirstCommitResponse: true })
  await expect(
    storage.atomicBatch([
      sql("CREATE TABLE capi_probe(id TEXT PRIMARY KEY)"),
      { sql: "INSERT INTO capi_probe VALUES (?)", args: ["op-1"] },
    ]),
  ).rejects.toBeInstanceOf(StorageCommitUnknownError)
  expect(remote.committedWritesFor("op-1")).toBe(1)
  await storage.close()
})

test("operation connections remain separate and reconnect on next operation", async () => {
  remote = createFakeTursoFetch()
  const storage = createStorage(testConfig())
  await Promise.all([
    storage.read((s) => s.query(sql("SELECT 1"))),
    storage.read((s) => s.query(sql("SELECT 2"))),
  ])
  const starts = remote.requests.filter((r) => r.body.baton === null)
  expect(starts).toHaveLength(2)
  expect(new Set(starts.map((r) => r.session)).size).toBe(2)
  await storage.close()
})

test("cleanly truncated cursor never commits a partial operation", async () => {
  remote = createFakeTursoFetch({ truncateSql: "INSERT" })
  const storage = createStorage(testConfig())
  await storage.atomicBatch([
    sql("CREATE TABLE capi_probe(id TEXT PRIMARY KEY)"),
  ])
  await expect(
    storage.atomicBatch([
      { sql: "INSERT INTO capi_probe VALUES (?)", args: ["op-1"] },
    ]),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  expect(remote.committedWritesFor("op-1")).toBe(0)
  await storage.close()
})

test("call timeout is bounded and sanitized", async () => {
  remote = createFakeTursoFetch({ hangSql: "SELECT 42" })
  const storage = createStorage(testConfig(), {
    queryTimeoutMs: 20,
    operationTimeoutMs: 100,
  })
  const error: unknown = await storage
    .read((s) => s.query(sql("SELECT 42")))
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(StorageUnavailableError)
  expect((error as StorageUnavailableError).reason).toBe("timeout")
  expect(String(error)).not.toContain("test-only")
  await storage.close()
})

test("operation deadline revokes an idle callback before it can write or commit", async () => {
  remote = createFakeTursoFetch()
  const storage = createStorage(testConfig(), {
    queryTimeoutMs: 50,
    operationTimeoutMs: 30,
  })
  let session: SqlSession | undefined
  const error: unknown = await storage
    .transaction(async (s) => {
      session = s
      await new Promise<void>(() => {})
    })
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(StorageUnavailableError)
  expect((error as StorageUnavailableError).reason).toBe("timeout")
  await expect(session?.execute(sql("CREATE TABLE late(id)"))).rejects.toThrow(
    "closed",
  )
  expect(
    remote.requests.some((r) =>
      r.body.requests?.some((s) => s.sql === "COMMIT"),
    ),
  ).toBe(false)
  await storage.close()
})

test("truncated SELECT is rejected rather than returning partial rows", async () => {
  remote = createFakeTursoFetch({ truncateSql: "SELECT 42" })
  const storage = createStorage(testConfig())
  await expect(
    storage.read((s) => s.query(sql("SELECT 42"))),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  await storage.close()
})

test("truncated pipeline COMMIT reports unknown without repeating writes", async () => {
  remote = createFakeTursoFetch({ truncateCommitResponse: true })
  const storage = createStorage(testConfig())
  await expect(
    storage.atomicBatch([
      sql("CREATE TABLE capi_probe(id TEXT PRIMARY KEY)"),
      { sql: "INSERT INTO capi_probe VALUES (?)", args: ["op-1"] },
    ]),
  ).rejects.toBeInstanceOf(StorageCommitUnknownError)
  expect(remote.committedWritesFor("op-1")).toBe(1)
  await storage.close()
})
