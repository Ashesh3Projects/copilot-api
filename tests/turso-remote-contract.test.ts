/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async rejection matchers have void type declarations. */
import { expect, test } from "bun:test"

import { createStorage } from "~/lib/storage/client"
import { resolveStorageConfig } from "~/lib/storage/config"
import { StorageConflictError } from "~/lib/storage/errors"
import { probeStorage } from "~/lib/storage/readiness"

const enabled = process.env.CAP_STORAGE_REMOTE_TEST === "1"
const statement = (sql: string) => ({ sql, args: [] })
// The opt-in operator owns the endpoint. Only this invocation's exact names
// enter the cleanup allowlist; existing application tables are never touched.
test.skipIf(!enabled)(
  "live Turso constraints rollback fresh reads and reconnect",
  async () => {
    const config = resolveStorageConfig()
    if (config.kind !== "turso")
      throw new Error("Remote contract requires the complete Turso pair")
    const prefix = `test_${crypto.randomUUID().replaceAll("-", "")}`
    const tables = {
      parent: `${prefix}_parent`,
      child: `${prefix}_child`,
      rollback: `${prefix}_rollback`,
    }
    const allowlist = [tables.child, tables.parent, tables.rollback]
    const storage = createStorage(config)
    try {
      expect(
        (await probeStorage(storage, { requireSchema: false })).ready,
      ).toBe(true)
      await storage.atomicBatch([
        statement(`CREATE TABLE ${tables.parent}(id INTEGER PRIMARY KEY)`),
        statement(
          `CREATE TABLE ${tables.child}(id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES ${tables.parent}(id) ON DELETE CASCADE)`,
        ),
        statement(`INSERT INTO ${tables.parent} VALUES (1)`),
        statement(`INSERT INTO ${tables.child} VALUES (1, 1)`),
      ])
      await expect(
        storage.atomicBatch([
          statement(`INSERT INTO ${tables.child} VALUES (2, 999)`),
        ]),
      ).rejects.toBeInstanceOf(StorageConflictError)
      await expect(
        storage.atomicBatch([
          statement(`CREATE TABLE ${tables.rollback}(id)`),
          statement(`INSERT INTO ${tables.parent} VALUES (1)`),
        ]),
      ).rejects.toBeInstanceOf(StorageConflictError)
      const rows = await storage.read((s) =>
        s.query({
          sql: "SELECT name FROM sqlite_master WHERE name = ?",
          args: [tables.rollback],
        }),
      )
      expect(rows).toEqual([])
      const readers = await Promise.all([
        storage.read((s) =>
          s.query(statement(`SELECT id FROM ${tables.parent}`)),
        ),
        storage.read((s) =>
          s.query(statement(`SELECT id FROM ${tables.parent}`)),
        ),
      ])
      expect(readers).toEqual([[{ id: 1 }], [{ id: 1 }]])
      await storage.atomicBatch([
        statement(`DELETE FROM ${tables.parent} WHERE id = 1`),
      ])
      const fresh = createStorage(config)
      try {
        expect(
          await fresh.read((s) =>
            s.query(statement(`SELECT * FROM ${tables.child}`)),
          ),
        ).toEqual([])
      } finally {
        await fresh.close()
      }
    } finally {
      try {
        await storage.atomicBatch(
          allowlist.map((name) => statement(`DROP TABLE IF EXISTS ${name}`)),
        )
      } finally {
        await storage.close()
      }
    }
  },
  120_000,
)
