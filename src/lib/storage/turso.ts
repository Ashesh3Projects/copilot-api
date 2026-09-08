import { Session } from "@tursodatabase/serverless"

import type { StorageConfig } from "~/lib/storage/config"
import type { SqlSession, SqlStatement, Storage } from "~/lib/storage/types"

import {
  assertNotNested,
  normalizeRows,
  operationContext,
  rowsAffected,
  scopedSession,
  snapshotStatement,
  validateStatement,
} from "~/lib/storage/adapter-utils"
import { normalizeTursoUrl } from "~/lib/storage/config"
import {
  storageError,
  StorageCommitUnknownError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { getStorageDeadline } from "~/lib/storage/operation-budget"

export interface TursoStorageOptions {
  queryTimeoutMs?: number
  operationTimeoutMs?: number
}

function isInTransaction(session: Session): boolean {
  return session.inTransaction
}

function deadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new StorageUnavailableError("timeout")),
      milliseconds,
    )
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

async function executeChecked(
  connection: Session,
  statement: SqlStatement,
  timeout: number,
) {
  const raw = await connection.executeRaw(statement.sql, [...statement.args], {
    queryTimeout: timeout,
  })
  let began = false
  let ended = false
  async function* checkedEntries() {
    for await (const entry of raw.entries) {
      if (entry.type === "step_begin") began = true
      if (entry.type === "step_end") ended = true
      yield entry
    }
    if (!began || !ended) throw new StorageUnavailableError()
  }
  const value: unknown = await connection.processCursorEntries(
    checkedEntries(),
    true,
  )
  if (
    !value
    || typeof value !== "object"
    || !("columns" in value)
    || !Array.isArray(value.columns)
    || !("rows" in value)
    || !Array.isArray(value.rows)
    || !("rowsAffected" in value)
  )
    throw new StorageUnavailableError()
  const columns: Array<unknown> = value.columns
  if (
    !columns.every((column): column is string => typeof column === "string")
    || new Set(columns).size !== columns.length
  )
    throw new StorageUnavailableError()
  const rows = value.rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== columns.length)
      throw new StorageUnavailableError()
    return Object.fromEntries(
      columns.map((column, index) => [column, row[index]]),
    )
  })
  return {
    rows: normalizeRows(rows),
    rowsAffected: rowsAffected(value.rowsAffected),
  }
}

export class TursoStorage implements Storage {
  private readonly config: Extract<StorageConfig, { kind: "turso" }>
  private readonly queryTimeout: number
  private readonly operationTimeout: number
  private readonly active = new Set<Promise<unknown>>()
  private closed = false

  constructor(
    config: Extract<StorageConfig, { kind: "turso" }>,
    options: TursoStorageOptions = {},
  ) {
    this.config = Object.freeze({
      ...config,
      url: normalizeTursoUrl(config.url),
      authToken: config.authToken.trim(),
    })
    if (!this.config.authToken)
      throw new Error("Turso authentication token is required")
    this.queryTimeout = options.queryTimeoutMs ?? 10_000
    this.operationTimeout = options.operationTimeoutMs ?? 30_000
    for (const value of [this.queryTimeout, this.operationTimeout]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Invalid storage timeout")
    }
  }

  private async owned<T>(
    work: (connection: Session, expires: number) => Promise<T>,
  ): Promise<T> {
    assertNotNested(this)
    if (this.closed) throw new StorageUnavailableError()
    const connection = new Session({
      url: this.config.url,
      authToken: this.config.authToken,
      defaultQueryTimeout: this.queryTimeout,
    })
    const expires = Math.min(
      Date.now() + this.operationTimeout,
      getStorageDeadline() ?? Infinity,
    )
    if (expires <= Date.now()) throw new StorageUnavailableError("timeout")
    const operation = operationContext.run(this, async () => {
      try {
        await this.call(
          connection.sequence("PRAGMA foreign_keys=ON", {
            queryTimeout: this.queryTimeout,
          }),
          expires,
        ).catch((error: unknown) => {
          throw storageError(error)
        })
        const { rows } = await this.call(
          executeChecked(
            connection,
            { sql: "PRAGMA foreign_keys", args: [] },
            this.queryTimeout,
          ),
          expires,
        ).catch((error: unknown) => {
          throw storageError(error)
        })
        if (Object.values(rows[0] ?? {})[0] !== 1)
          throw new StorageUnavailableError("unsupported_engine")
        return await work(connection, expires)
      } finally {
        await deadline(
          connection.close(),
          Math.max(1, Math.min(this.queryTimeout, expires - Date.now())),
        ).catch(() => {})
      }
    })
    this.active.add(operation)
    try {
      return await operation
    } finally {
      this.active.delete(operation)
    }
  }

  private call<T>(work: Promise<T>, expires: number): Promise<T> {
    return deadline(
      work,
      Math.max(1, Math.min(this.queryTimeout, expires - Date.now())),
    )
  }

  private driver(connection: Session, expires: number): SqlSession {
    const queryTimeout = () => {
      if (Date.now() >= expires) throw new StorageUnavailableError("timeout")
      return Math.min(this.queryTimeout, expires - Date.now())
    }
    return {
      query: async (statement) => {
        try {
          return (
            await this.call(
              executeChecked(connection, statement, queryTimeout()),
              expires,
            )
          ).rows
        } catch (error) {
          throw storageError(error)
        }
      },
      execute: async (statement) => {
        try {
          const result = await this.call(
            executeChecked(connection, statement, queryTimeout()),
            expires,
          )
          return { rowsAffected: result.rowsAffected }
        } catch (error) {
          throw storageError(error)
        }
      },
    }
  }

  private operate<T>(
    work: (session: SqlSession) => Promise<T>,
    readOnly: boolean,
  ): Promise<T> {
    return this.owned(async (connection, expires) => {
      const scope = scopedSession(this.driver(connection, expires), readOnly)
      let committing = false
      let begun = false
      try {
        await this.call(
          connection.sequence(readOnly ? "BEGIN" : "BEGIN IMMEDIATE", {
            queryTimeout: this.queryTimeout,
          }),
          expires,
        )
        if (!connection.inTransaction) throw new StorageUnavailableError()
        begun = true
        const result = await deadline(
          Promise.resolve().then(() => work(scope.session)),
          Math.max(1, expires - Date.now()),
        )
        await this.call(scope.finish(), expires)
        if (Date.now() >= expires) throw new StorageUnavailableError("timeout")
        committing = true
        await this.call(
          connection.sequence("COMMIT", { queryTimeout: this.queryTimeout }),
          expires,
        )
        if (isInTransaction(connection)) throw new StorageCommitUnknownError()
        return result
      } catch (error) {
        scope.revoke()
        if (committing && !readOnly) throw new StorageCommitUnknownError()
        await this.call(scope.finish(), expires).catch(() => {})
        let rolledBack = false
        if (
          begun
          && Date.now() < expires
          && (!(error instanceof StorageUnavailableError)
            || error.reason !== "timeout")
        ) {
          try {
            await this.call(
              connection.sequence("ROLLBACK", {
                queryTimeout: this.queryTimeout,
              }),
              expires,
            )
            rolledBack = !connection.inTransaction
          } catch {
            /* Closing the owned connection disposes an uncertain session. */
          }
        }
        if (error instanceof Error && !("code" in error)) throw error
        throw storageError(error, rolledBack || !begun)
      } finally {
        scope.revoke()
      }
    })
  }

  read<T>(work: (session: SqlSession) => Promise<T>): Promise<T> {
    return this.operate(work, true)
  }
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T> {
    return this.operate(work, false)
  }
  async atomicBatch(statements: ReadonlyArray<SqlStatement>): Promise<void> {
    assertNotNested(this)
    const snapshots = statements.map((statement) =>
      snapshotStatement(statement),
    )
    for (const statement of snapshots) validateStatement(statement)
    if (snapshots.length === 0) return
    await this.transaction(async (session) => {
      for (const statement of snapshots) await session.execute(statement)
    })
  }
  async close(): Promise<void> {
    assertNotNested(this)
    this.closed = true
    await Promise.allSettled(this.active)
  }
}
