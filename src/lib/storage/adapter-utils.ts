import { AsyncLocalStorage } from "node:async_hooks"

import type { SqlSession, SqlStatement, SqlValue } from "~/lib/storage/types"

import {
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"

export const operationContext = new AsyncLocalStorage<object>()

export function assertNotNested(owner: object): void {
  if (operationContext.getStore() === owner)
    throw new StorageSchemaError("Nested storage operations are not allowed")
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }
}

export function snapshotStatement(statement: SqlStatement): SqlStatement {
  return Object.freeze({
    sql: statement.sql,
    args: Object.freeze(
      statement.args.map((value) =>
        value instanceof Uint8Array ? new Uint8Array(value) : value,
      ),
    ),
  })
}

export function validateStatement(
  statement: SqlStatement,
  readOnly = false,
): void {
  const bare = statement.sql
    .replaceAll(
      /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,
      " ",
    )
    .trim()
    .replace(/;\s*$/, "")
    .trim()
  if (
    !bare
    || bare.includes(";")
    || /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM)\b/i.test(
      bare,
    )
  )
    throw new StorageSchemaError(
      "Transaction control and multiple SQL statements are not allowed",
    )
  if (
    /^PRAGMA\b/i.test(bare)
    && !/^PRAGMA\s+(?:foreign_keys|journal_mode|synchronous|busy_timeout|query_only)\s*$/i.test(
      bare,
    )
  )
    throw new StorageSchemaError("Connection settings are owned by the adapter")
  if (readOnly && !/^(?:SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(bare))
    throw new StorageSchemaError("Read sessions cannot mutate storage")
  if (
    readOnly
    && /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(bare)
  )
    throw new StorageSchemaError("Read sessions cannot mutate storage")
  validateBindings(statement.args)
}

function validateBindings(args: ReadonlyArray<SqlValue>): void {
  for (const value of args) {
    if (
      value === null
      || typeof value === "string"
      || value instanceof Uint8Array
    )
      continue
    if (
      typeof value === "bigint"
      && value >= -9223372036854775808n
      && value <= 9223372036854775807n
    )
      continue
    if (
      typeof value === "number"
      && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))
    )
      continue
    throw new StorageSchemaError("Invalid SQL parameter type or range")
  }
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint")
    return (
        value >= BigInt(Number.MIN_SAFE_INTEGER)
          && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ) ?
        Number(value)
      : value
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (
    value === null
    || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))
  )
    return value
  throw new StorageUnavailableError()
}

export function normalizeRows(
  value: unknown,
): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new StorageUnavailableError()
  return value.map((row: unknown) => {
    if (row === null || typeof row !== "object")
      throw new StorageUnavailableError()
    return Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => !Array.isArray(row) || !/^\d+$/.test(key))
        .map(([key, cell]) => [key, normalizeValue(cell)]),
    )
  })
}

export function rowsAffected(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new StorageUnavailableError()
  return value
}

export function scopedSession(driver: SqlSession, readOnly: boolean) {
  let active = true
  let revoked = false
  const pending: Array<Promise<unknown>> = []
  const queue = new SerialQueue()
  function run<T>(
    statement: SqlStatement,
    work: (snapshot: SqlStatement) => Promise<T>,
  ): Promise<T> {
    if (!active)
      return Promise.reject(new StorageSchemaError("Storage session is closed"))
    let snapshot: SqlStatement
    try {
      snapshot = snapshotStatement(statement)
      validateStatement(snapshot, readOnly)
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new StorageSchemaError(),
      )
    }
    const result = queue.run(async () => {
      if (revoked) throw new StorageSchemaError("Storage session is closed")
      try {
        return await work(snapshot)
      } catch (error) {
        // SQLite conflict algorithms may already have rolled back the whole
        // transaction. Revoke before the queue can admit another statement.
        active = false
        revoked = true
        throw error
      }
    })
    pending.push(result)
    // Track a rejected unawaited call until finish without an unhandled rejection.
    void result.catch(() => {})
    return result
  }
  return {
    session: {
      query: (statement: SqlStatement) =>
        run(statement, (snapshot) => driver.query(snapshot)),
      execute: (statement: SqlStatement) =>
        run(statement, (snapshot) => driver.execute(snapshot)),
    } satisfies SqlSession,
    async finish() {
      active = false
      const outcomes = await Promise.allSettled(pending)
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason
      }
    },
    revoke() {
      active = false
      revoked = true
    },
  }
}
