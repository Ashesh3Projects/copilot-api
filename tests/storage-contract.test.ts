/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async rejection matchers have void type declarations. */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SqlStatement, SqlValue } from "~/lib/storage/types"

import { createStorage } from "~/lib/storage/client"
import { StorageConflictError, StorageSchemaError } from "~/lib/storage/errors"

import { createFakeTursoFetch, testConfig } from "./helpers/turso-transport"

const sql = (sql: string) => ({ sql, args: [] })

function fixture(backend: "sqlite" | "turso") {
  const dir = mkdtempSync(join(tmpdir(), "capi-contract-"))
  const remote = backend === "turso" ? createFakeTursoFetch() : undefined
  const storage = createStorage(
    remote ? testConfig() : (
      { kind: "sqlite", path: join(dir, "copilot-api.sqlite") }
    ),
  )
  return {
    storage,
    async close() {
      await storage.close()
      remote?.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

for (const backend of ["sqlite", "turso"] as const) {
  describe(`${backend} shared storage contract`, () => {
    test("FK, unique and cascading deletes work with awaited rollback", async () => {
      const f = fixture(backend)
      try {
        await f.storage.atomicBatch([
          sql("CREATE TABLE parent(id INTEGER PRIMARY KEY)"),
          sql(
            "CREATE TABLE child(id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE)",
          ),
          sql("INSERT INTO parent VALUES (1)"),
          sql("INSERT INTO child VALUES (1, 1)"),
        ])
        await expect(
          f.storage.atomicBatch([sql("INSERT INTO child VALUES (2, 99)")]),
        ).rejects.toBeInstanceOf(StorageConflictError)
        await expect(
          f.storage.atomicBatch([
            sql("INSERT INTO parent VALUES (2)"),
            sql("INSERT INTO parent VALUES (1)"),
          ]),
        ).rejects.toBeInstanceOf(StorageConflictError)
        expect(
          await f.storage.read((s) => s.query(sql("SELECT * FROM parent"))),
        ).toEqual([{ id: 1 }])
        await f.storage.atomicBatch([sql("DELETE FROM parent WHERE id = 1")])
        expect(
          await f.storage.read((s) => s.query(sql("SELECT * FROM child"))),
        ).toEqual([])
      } finally {
        await f.close()
      }
    })
    test("DDL rolls back with its failing atomic batch", async () => {
      const f = fixture(backend)
      try {
        await expect(
          f.storage.atomicBatch([
            sql("CREATE TABLE rolled_back(id INTEGER PRIMARY KEY)"),
            sql("INSERT INTO rolled_back VALUES (1)"),
            sql("INSERT INTO rolled_back VALUES (1)"),
          ]),
        ).rejects.toBeInstanceOf(StorageConflictError)
        expect(
          await f.storage.read((s) =>
            s.query({
              sql: "SELECT name FROM sqlite_master WHERE name = ?",
              args: ["rolled_back"],
            }),
          ),
        ).toEqual([])
      } finally {
        await f.close()
      }
    })
    test("SQL boundaries reject transaction controls and connection mutation", async () => {
      const f = fixture(backend)
      try {
        for (const statement of [
          "COMMIT",
          "-- hidden\nROLLBACK",
          "SAVEPOINT x",
          "SELECT 1; COMMIT",
          "PRAGMA foreign_keys=OFF",
          "ATTACH 'x' AS y",
        ]) {
          await expect(
            f.storage.atomicBatch([sql(statement)]),
          ).rejects.toBeInstanceOf(StorageSchemaError)
        }
        await expect(
          f.storage.read((s) => s.query(sql("CREATE TABLE forbidden(id)"))),
        ).rejects.toBeInstanceOf(StorageSchemaError)
      } finally {
        await f.close()
      }
    })
    test("64-bit integers BLOB null text and numeric values normalize identically", async () => {
      const f = fixture(backend)
      try {
        const result = await f.storage.read((s) =>
          s.query({
            sql: "SELECT ? AS big, ? AS small, ? AS real, ? AS empty, ? AS blob, ? AS text",
            args: [
              9223372036854775807n,
              123n,
              1.25,
              null,
              new Uint8Array([1, 2, 255]),
              "hello",
            ],
          }),
        )
        expect(result).toEqual([
          {
            big: 9223372036854775807n,
            small: 123,
            real: 1.25,
            empty: null,
            blob: new Uint8Array([1, 2, 255]),
            text: "hello",
          },
        ])
      } finally {
        await f.close()
      }
    })
    test("queued session calls finish before committing, rejected unawaited calls roll back", async () => {
      const f = fixture(backend)
      try {
        await f.storage.atomicBatch([
          sql("CREATE TABLE sample(id INTEGER PRIMARY KEY)"),
        ])
        await expect(
          f.storage.transaction(async (s) => {
            void s.execute(sql("INSERT INTO sample VALUES (1)"))
            void s.execute(sql("INSERT INTO sample VALUES (1)"))
            await Promise.resolve()
          }),
        ).rejects.toBeInstanceOf(StorageConflictError)
        expect(
          await f.storage.read((s) => s.query(sql("SELECT * FROM sample"))),
        ).toEqual([])
      } finally {
        await f.close()
      }
    })
  })
  describe(`${backend} session admission regressions`, () => {
    test("automatic rollback poisons the session before its queued write can autocommit", async () => {
      const f = fixture(backend)
      try {
        await f.storage.atomicBatch([
          sql("CREATE TABLE sample(id INTEGER PRIMARY KEY)"),
        ])
        const outcomes = await f.storage
          .transaction(async (s) => {
            const queued = [
              s.execute(sql("INSERT INTO sample VALUES (1)")),
              s.execute(sql("INSERT OR ROLLBACK INTO sample VALUES (1)")),
              s.execute(sql("INSERT INTO sample VALUES (2)")),
            ]
            const settled = await Promise.allSettled(queued)
            expect(settled[1].status).toBe("rejected")
            expect(settled[2].status).toBe("rejected")
          })
          .catch((error: unknown) => error)
        expect(outcomes).toBeInstanceOf(StorageConflictError)
        expect(
          await f.storage.read((s) => s.query(sql("SELECT * FROM sample"))),
        ).toEqual([])
      } finally {
        await f.close()
      }
    })
    test("mutating queued statement SQL cannot commit before callback rollback", async () => {
      const f = fixture(backend)
      try {
        await f.storage.atomicBatch([sql("CREATE TABLE sample(id)")])
        await expect(
          f.storage.transaction(async (s) => {
            await s.execute(sql("INSERT INTO sample VALUES (1)"))
            const statement = sql("SELECT 1")
            const queued = s.query(statement)
            statement.sql = "COMMIT"
            await queued
            throw new Error("callback rollback")
          }),
        ).rejects.toThrow("callback rollback")
        expect(
          await f.storage.read((s) => s.query(sql("SELECT * FROM sample"))),
        ).toEqual([])
      } finally {
        await f.close()
      }
    })
    test("queued parameter arrays and binary values are copied at admission", async () => {
      const f = fixture(backend)
      try {
        const rows = await f.storage.read(async (s) => {
          const bytes = new Uint8Array([1, 2, 255])
          const args: Array<SqlValue> = ["before", bytes]
          const statement: SqlStatement = {
            sql: "SELECT ? AS text, ? AS blob",
            args,
          }
          const queued = s.query(statement)
          args[0] = "after"
          bytes[0] = 9
          statement.args = ["replacement", new Uint8Array([8])]
          return queued
        })
        expect(rows).toEqual([
          { text: "before", blob: new Uint8Array([1, 2, 255]) },
        ])
      } finally {
        await f.close()
      }
    })
    test("atomic batch copies statements and bound bytes before queueing", async () => {
      const f = fixture(backend)
      try {
        await f.storage.atomicBatch([sql("CREATE TABLE sample(value BLOB)")])
        const bytes = new Uint8Array([1, 2])
        const statement: SqlStatement = {
          sql: "INSERT INTO sample VALUES (?)",
          args: [bytes],
        }
        const batch = [statement]
        const pending = f.storage.atomicBatch(batch)
        bytes[0] = 9
        statement.sql = "COMMIT"
        batch.length = 0
        await pending
        expect(
          await f.storage.read((s) => s.query(sql("SELECT * FROM sample"))),
        ).toEqual([{ value: new Uint8Array([1, 2]) }])
      } finally {
        await f.close()
      }
    })
  })
}
