import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import type { SqlSession, SqlStatement, Storage } from "~/lib/storage/types"

import {
  assertNotNested,
  normalizeRows,
  operationContext,
  rowsAffected,
  scopedSession,
  snapshotStatement,
  validateStatement,
  SerialQueue,
} from "~/lib/storage/adapter-utils"
import { storageError, StorageUnavailableError } from "~/lib/storage/errors"
import {
  deadlinePromise,
  getStorageDeadline,
} from "~/lib/storage/operation-budget"

export class LocalSqliteStorage implements Storage {
  private readonly db: Database
  private readonly queue = new SerialQueue()
  private closed = false

  constructor(path: string) {
    let db: Database | undefined
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      db = new Database(path, {
        create: true,
        strict: true,
        safeIntegers: true,
      })
      if (process.platform !== "win32") chmodSync(path, 0o600)
      db.run(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000",
      )
      for (const [name, wanted] of [
        ["journal_mode", "wal"],
        ["foreign_keys", 1n],
        ["synchronous", 2n],
        ["busy_timeout", 5000n],
      ] as const) {
        const row = db.query(`PRAGMA ${name}`).get() as Record<
          string,
          unknown
        > | null
        if (!row || Object.values(row)[0] !== wanted)
          throw new StorageUnavailableError()
      }
      this.db = db
    } catch (error) {
      db?.close()
      throw storageError(error)
    }
  }

  private driver(expires: number): SqlSession {
    return {
      query: (statement) => {
        try {
          if (Date.now() >= expires)
            throw new StorageUnavailableError("timeout")
          return Promise.resolve(
            normalizeRows(this.db.query(statement.sql).all(...statement.args)),
          )
        } catch (error) {
          return Promise.reject(storageError(error))
        }
      },
      execute: (statement) => {
        try {
          if (Date.now() >= expires)
            throw new StorageUnavailableError("timeout")
          return Promise.resolve({
            rowsAffected: rowsAffected(
              this.db.query(statement.sql).run(...statement.args).changes,
            ),
          })
        } catch (error) {
          return Promise.reject(storageError(error))
        }
      },
    }
  }

  private async operate<T>(
    work: (session: SqlSession) => Promise<T>,
    readOnly: boolean,
  ): Promise<T> {
    assertNotNested(this)
    const expires = Math.min(
      Date.now() + 30_000,
      getStorageDeadline() ?? Infinity,
    )
    return deadlinePromise(
      this.queue.run(() =>
        operationContext.run(this, async () => {
          if (expires <= Date.now())
            throw new StorageUnavailableError("timeout")
          if (this.closed) throw new StorageUnavailableError()
          const scope = scopedSession(this.driver(expires), readOnly)
          let begun = false
          try {
            this.db.run(readOnly ? "BEGIN" : "BEGIN IMMEDIATE")
            begun = true
            const result = await deadlinePromise(
              Promise.resolve().then(() => work(scope.session)),
              expires,
            )
            await scope.finish()
            if (Date.now() >= expires)
              throw new StorageUnavailableError("timeout")
            this.db.run("COMMIT")
            return result
          } catch (error) {
            scope.revoke()
            await scope.finish().catch(() => {})
            let rolledBack = begun && !this.db.inTransaction
            if (begun && this.db.inTransaction) {
              try {
                this.db.run("ROLLBACK")
                rolledBack = true
              } catch {
                this.closed = true
                this.db.close()
              }
            }
            if (error instanceof Error && !("code" in error)) throw error
            throw storageError(error, rolledBack || !begun)
          } finally {
            scope.revoke()
          }
        }),
      ),
      expires,
    )
  }

  read<T>(work: (session: SqlSession) => Promise<T>): Promise<T> {
    return this.operate(work, true)
  }
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T> {
    return this.operate(work, false)
  }
  async atomicBatch(statements: ReadonlyArray<SqlStatement>): Promise<void> {
    const snapshots = statements.map((statement) =>
      snapshotStatement(statement),
    )
    for (const statement of snapshots) validateStatement(statement)
    await this.transaction(async (session) => {
      for (const statement of snapshots) await session.execute(statement)
    })
  }
  async close(): Promise<void> {
    assertNotNested(this)
    await this.queue.run(() => {
      if (!this.closed) {
        this.closed = true
        this.db.close()
      }
      return Promise.resolve()
    })
  }
}
