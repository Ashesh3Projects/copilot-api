import { createHash } from "node:crypto"

import type {
  JsonValue,
  SqlSession,
  SqlValue,
  Storage,
} from "~/lib/storage/types"

import { StorageSchemaError } from "~/lib/storage/errors"
import {
  currentSchemaVersion,
  currentTables,
  storageSchema,
} from "~/lib/storage/schema"
import { validateTransferScopes } from "~/lib/storage/transfer-validation"

export interface TransferManifest {
  formatVersion: 1
  schemaVersion: number
  sourceStoreId: string
  recordCounts: Readonly<Record<string, number>>
  recordsSha256: string
}
export interface TransferRecord {
  table: string
  key: string
  value: JsonValue
}
export interface TransferProgress {
  operationId: string
  phase: "reading" | "writing" | "verifying" | "complete" | "failed"
  records: number
}
export const TRANSFER_TIMEOUT_MS = 30 * 60_000
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export const TRANSFER_MARKER = "transfer_incomplete"
const excluded = new Set([
  "capi_schema_migrations",
  "capi_admin_sessions",
  "capi_setup_codes",
  "capi_device_login_intents",
])
export const TRANSFER_TABLES = Object.keys(currentTables).filter(
  (table) => !excluded.has(table),
)
export function transferTablesForSchema(version: number): Array<string> {
  return Object.keys(storageSchema(version).tables).filter(
    (table) => !excluded.has(table),
  )
}
export const REQUIRED_TRANSFER_METADATA_KEYS = [
  "store_id",
  "schema_version",
  "config_revision",
  "history_activity_generation",
]
const metadataKeys = [
  ...REQUIRED_TRANSFER_METADATA_KEYS,
  "history_routing_lifetime",
  "history_routing_started_at",
]

function definition(
  table: string,
  version: number = currentSchemaVersion,
): string {
  const tables: Readonly<Record<string, string>> = storageSchema(version).tables
  if (excluded.has(table) || !Object.hasOwn(tables, table))
    throw new StorageSchemaError("Unknown transfer table")
  return tables[table]
}
export function transferColumns(
  table: string,
  version: number = currentSchemaVersion,
): Array<{ name: string; type: string; declaration: string }> {
  return definition(table, version)
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\w+) (TEXT|INTEGER)\b(.*)/.exec(line)
      return match ?
          [{ name: match[1], type: match[2], declaration: match[3] }]
        : []
    })
}
export function transferKey(
  table: string,
  value: Record<string, unknown>,
  version: number = currentSchemaVersion,
): string {
  return JSON.stringify(
    transferKeyColumns(table, version).map((name) => value[name]),
  )
}
function transferKeyColumns(
  table: string,
  version: number = currentSchemaVersion,
): Array<string> {
  const composite = /PRIMARY KEY \(([^)]+)\)/.exec(definition(table, version))
  return composite ?
      composite[1].split(",").map((name) => name.trim())
    : transferColumns(table, version)
        .filter((column) => column.declaration.includes("PRIMARY KEY"))
        .map((column) => column.name)
}
export function completeTransferRecord(
  table: string,
  input: Record<string, unknown>,
): TransferRecord {
  const value: Record<string, JsonValue> = {}
  for (const column of transferColumns(table)) {
    let field = input[column.name]
    if (field === undefined) {
      const fallback = /DEFAULT ('[^']*'|\d+)/.exec(column.declaration)?.[1]
      if (fallback === undefined) field = null
      else
        field =
          fallback.startsWith("'") ? fallback.slice(1, -1) : Number(fallback)
    }
    value[column.name] = field as JsonValue
  }
  const record = { table, key: transferKey(table, value), value }
  validateTransferRecord(record)
  return record
}
// eslint-disable-next-line complexity -- Validate every field at the untrusted transfer boundary.
export function validateTransferRecord(
  record: TransferRecord,
  version: number = currentSchemaVersion,
): Record<string, SqlValue> {
  if (Object.keys(record).sort().join(",") !== "key,table,value")
    throw new StorageSchemaError("Invalid transfer record shape")
  const columns = transferColumns(record.table, version)
  if (
    !record.value
    || typeof record.value !== "object"
    || Array.isArray(record.value)
  )
    throw new StorageSchemaError("Invalid transfer record")
  const value = record.value
  if (
    Object.keys(value).length !== columns.length
    || columns.some((column) => !Object.hasOwn(value, column.name))
  )
    throw new StorageSchemaError("Invalid transfer columns")
  for (const column of columns) {
    const field = value[column.name]
    if (field === null && !column.declaration.includes("NOT NULL")) continue
    if (
      column.type === "TEXT" ?
        typeof field !== "string"
      : typeof field !== "number" || !Number.isSafeInteger(field)
    )
      throw new StorageSchemaError("Invalid transfer field")
    if (column.name.endsWith("_json")) {
      try {
        JSON.parse(field as string)
      } catch {
        throw new StorageSchemaError("Invalid transferred JSON")
      }
    }
  }
  if (
    record.table.startsWith("capi_oauth_")
    || record.table === "capi_inference_credentials"
  ) {
    if (record.table !== "capi_oauth_families")
      validateTransferScopes(JSON.parse(value.scopes_json as string))
    for (const column of columns.filter((candidate) =>
      candidate.name.endsWith("_at"),
    )) {
      const timestamp = value[column.name]
      if (typeof timestamp === "number" && timestamp < 0)
        throw new StorageSchemaError("Invalid transferred timestamp")
    }
  }
  if (record.key !== transferKey(record.table, value, version))
    throw new StorageSchemaError("Invalid transfer key")
  if (
    record.table === "capi_metadata"
    && (typeof value.key !== "string"
      || (!metadataKeys.includes(value.key)
        && (version !== 2 || value.key !== "history_debug_generation")))
  )
    throw new StorageSchemaError("Invalid transferred metadata")
  return value as Record<string, SqlValue>
}
export async function insertTransferRecord(
  session: SqlSession,
  record: TransferRecord,
): Promise<void> {
  const value = validateTransferRecord(record)
  const columns = transferColumns(record.table).map((column) => column.name)
  const replace =
    record.table === "capi_metadata" || record.table === "capi_usage_lifetime"
  await session.execute({
    sql: `INSERT ${replace ? "OR REPLACE " : ""}INTO ${record.table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    args: columns.map((column) => value[column]),
  })
}
/** Group only consecutive table rows; callers retain transaction/transfer ownership. */
export async function insertTransferRecords(
  session: SqlSession,
  records: ReadonlyArray<TransferRecord>,
): Promise<void> {
  let offset = 0
  while (offset < records.length) {
    const table = records[offset].table
    const columns = transferColumns(table).map((column) => column.name)
    const maximum = Math.max(1, Math.floor(900 / columns.length))
    const rows: Array<Array<SqlValue>> = []
    let bytes = 0
    while (
      offset < records.length
      && records[offset].table === table
      && rows.length < maximum
    ) {
      const value = validateTransferRecord(records[offset])
      const values = columns.map((column) => value[column])
      const size = values.reduce<number>(
        (sum, item) =>
          sum + (typeof item === "string" ? Buffer.byteLength(item) : 8),
        0,
      )
      if (rows.length > 0 && bytes + size > 1024 * 1024) break
      rows.push(values)
      bytes += size
      offset++
    }
    const replace = table === "capi_metadata" || table === "capi_usage_lifetime"
    const tuple = `(${columns.map(() => "?").join(",")})`
    await session.execute({
      sql: `INSERT ${replace ? "OR REPLACE " : ""}INTO ${table} (${columns.join(",")}) VALUES ${rows.map(() => tuple).join(",")}`,
      args: rows.flat(),
    })
  }
}
export async function assertEmptyTransferTarget(
  session: SqlSession,
): Promise<void> {
  for (const table of Object.keys(currentTables)) {
    if (table === "capi_metadata" || table === "capi_schema_migrations")
      continue
    const where =
      table === "capi_usage_lifetime" ?
        " WHERE input_tokens != 0 OR output_tokens != 0 OR request_count != 0 OR first_request_at IS NOT NULL"
      : ""
    const rows = await session.query({
      sql: `SELECT 1 FROM ${table}${where} LIMIT 1`,
      args: [],
    })
    if (rows.length > 0)
      throw new StorageSchemaError(
        "Transfer requires an empty replacement database",
      )
  }
  const marker = await session.query({
    sql: "SELECT key FROM capi_metadata WHERE key NOT IN ('store_id','schema_version','config_revision','history_activity_generation') OR (key IN ('config_revision','history_activity_generation') AND value != '0')",
    args: [],
  })
  if (marker.length > 0)
    throw new StorageSchemaError(
      "Transfer requires an empty replacement database",
    )
}
export async function withTransferSnapshot<T>(
  storage: Storage,
  work: (session: SqlSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const snapshot = storage as Storage & {
    readSnapshot?: (
      work: (session: SqlSession) => Promise<T>,
      options?: { timeoutMs: number; signal?: AbortSignal },
    ) => Promise<T>
  }
  return snapshot.readSnapshot ?
      snapshot.readSnapshot(work, { timeoutMs: TRANSFER_TIMEOUT_MS, signal })
    : storage.read(work)
}
function lastPageCandidate(candidates: ReadonlyArray<Record<string, unknown>>) {
  let pageBytes = 0
  let last = candidates[0]
  for (const candidate of candidates) {
    const bytes = Number(candidate.transfer_bytes)
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new StorageSchemaError("Invalid transfer page byte count")
    if (pageBytes > 0 && pageBytes + bytes > 1024 * 1024) break
    pageBytes += bytes
    last = candidate
  }
  return last
}

export async function* transferRecords(
  session: SqlSession,
  signal?: AbortSignal,
): AsyncGenerator<TransferRecord> {
  const marker = await session.query({
    sql: "SELECT key FROM capi_metadata WHERE key = ?",
    args: [TRANSFER_MARKER],
  })
  if (marker.length > 0)
    throw new StorageSchemaError("Cannot back up an incomplete transfer")
  for (const table of TRANSFER_TABLES) {
    const columns = transferColumns(table).map((column) => column.name)
    const keys = transferKeyColumns(table)
    let after: Array<SqlValue> = []
    // A single history payload can be large. Do not materialize a page of them.
    while (true) {
      signal?.throwIfAborted()
      const predicates: Array<string> = []
      const args: Array<SqlValue> = []
      if (table === "capi_metadata") {
        predicates.push(`key IN (${metadataKeys.map(() => "?").join(",")})`)
        args.push(...metadataKeys)
      }
      if (table === "capi_applied_operations") {
        // Promotion receipts reconcile this replacement operation only. Carrying
        // them into later replacements changes otherwise identical logical data.
        predicates.push("kind != ?")
        args.push("restore.complete")
      }
      if (after.length > 0) {
        predicates.push(
          keys.length === 1 ?
            `${keys[0]} > ?`
          : `(${keys.join(",")}) > (${keys.map(() => "?").join(",")})`,
        )
        args.push(...after)
      }
      const where =
        predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : ""
      // Probe only keys and byte counts; never fetch 100 potentially huge bodies.
      const estimatedBytes = transferColumns(table)
        .map((column) =>
          column.type === "TEXT" ?
            `COALESCE(length(CAST(${column.name} AS BLOB)),0)`
          : "8",
        )
        .join(" + ")
      const candidates = await session.query({
        sql: `SELECT ${keys.join(",")}, ${estimatedBytes} AS transfer_bytes FROM ${table}${where} ORDER BY ${keys.join(",")} LIMIT 100`,
        args,
      })
      if (candidates.length === 0) break
      const last = lastPageCandidate(candidates)
      const upper =
        keys.length === 1 ?
          `${keys[0]} <= ?`
        : `(${keys.join(",")}) <= (${keys.map(() => "?").join(",")})`
      const rows = await session.query({
        sql: `SELECT ${columns.join(",")} FROM ${table}${where}${where ? " AND " : " WHERE "}${upper} ORDER BY ${keys.join(",")}`,
        args: [...args, ...keys.map((key) => last[key] as SqlValue)],
      })
      for (const value of rows) {
        const record = {
          table,
          key: transferKey(table, value),
          value: value as JsonValue,
        }
        validateTransferRecord(record)
        after = keys.map((key) => value[key] as SqlValue)
        yield record
      }
      if (rows.length === 0) break
    }
  }
}
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
