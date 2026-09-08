import type { DecipherGCM } from "node:crypto"

import { createDecipheriv, createHash, randomUUID } from "node:crypto"

import type {
  TransferManifest,
  TransferProgress,
  TransferRecord,
} from "~/lib/storage/transfer-records"
import type { JsonValue, SqlSession, Storage } from "~/lib/storage/types"

import {
  BACKUP_HEADER_BYTES,
  BACKUP_MAGIC,
  BACKUP_VERSION,
  deriveBackupKey,
} from "~/lib/config-backup"
import { StorageSchemaError } from "~/lib/storage/errors"
import { parseStorageCounter } from "~/lib/storage/migrations"
import { initialTables } from "~/lib/storage/migrations/001-initial"
import {
  assertEmptyTransferTarget,
  insertTransferRecords,
  MAX_FRAME_BYTES,
  REQUIRED_TRANSFER_METADATA_KEYS,
  sha256,
  TRANSFER_MARKER,
  TRANSFER_TABLES,
  TRANSFER_TIMEOUT_MS,
  transferColumns,
  validateTransferRecord,
} from "~/lib/storage/transfer-records"
import { validateTransferDomains } from "~/lib/storage/transfer-validation"

function invalid(): never {
  throw new StorageSchemaError("Invalid or incomplete encrypted backup")
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid()
  return value as Record<string, unknown>
}
export async function validateTransferredState(
  session: SqlSession,
): Promise<void> {
  const rows = await session.query({
    sql: "SELECT key,value FROM capi_metadata",
    args: [],
  })
  const metadata = new Map(rows.map((row) => [row.key, row.value]))
  if (
    metadata.get("schema_version") !== "1"
    || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(
      String(metadata.get("store_id")),
    )
  )
    invalid()
  for (const key of [
    "config_revision",
    "history_activity_generation",
    "history_debug_generation",
  ])
    parseStorageCounter(metadata.get(key))
  await validateTransferDomains(session)
  // All inserts enforce the schema's foreign keys. Routing JSON has an additional stable-ID reference.
  const routing = await session.query({
    sql: "SELECT value_json FROM capi_settings WHERE namespace='model_routing'",
    args: [],
  })
  const accounts = await session.query({
    sql: "SELECT id FROM capi_accounts",
    args: [],
  })
  const ids = new Set(accounts.map((row) => row.id))
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      if (key === "accountId" && child !== null && !ids.has(child))
        throw new StorageSchemaError(
          "Imported routing references a missing account",
        )
      walk(child)
    }
  }
  for (const row of routing) {
    const decoded: unknown = JSON.parse(String(row.value_json))
    walk(decoded)
    for (const accountMap of Object.values(object(decoded))) {
      for (const id of Object.keys(object(accountMap)))
        if (!/^\d+$/.test(id) || !ids.has(Number(id)))
          throw new StorageSchemaError(
            "Imported routing references a missing account",
          )
    }
  }
}

interface PendingField {
  name: string
  length: number
  sha256: string
  chunks: Array<Buffer>
  received: number
}
interface PendingRecord {
  record: TransferRecord
  fields: Array<PendingField>
  index: number
}

class RecordDecoder {
  private buffer = Buffer.alloc(0)
  private sequence = 0
  private tableIndex = -1
  private previousKey?: Array<string | number>
  private pending?: PendingRecord
  private readonly singletonKeys = new Set<string>()
  private readonly digest = createHash("sha256")
  readonly counts: Record<string, number> = {}
  manifest?: TransferManifest
  records = 0
  private batch: Array<TransferRecord> = []
  private batchBytes = 0
  private readonly target: Storage
  private readonly operationId: string
  private readonly signal: AbortSignal
  constructor(target: Storage, operationId: string, signal: AbortSignal) {
    this.target = target
    this.operationId = operationId
    this.signal = signal
  }

  async write(bytes: Uint8Array): Promise<void> {
    let position = 0
    while (position < bytes.length) {
      this.signal.throwIfAborted()
      const newline = bytes.indexOf(10, position)
      const end = newline === -1 ? bytes.length : newline + 1
      const part = bytes.subarray(position, end)
      if (this.buffer.length + part.length > MAX_FRAME_BYTES) invalid()
      this.buffer = Buffer.concat([this.buffer, part])
      position = end
      if (newline === -1) break
      const frame = this.buffer
      this.buffer = Buffer.alloc(0)
      await this.frame(frame)
    }
  }
  // eslint-disable-next-line max-lines-per-function, complexity -- Exhaustive framing state machine rejects invalid transitions before record insertion.
  private async frame(bytes: Buffer): Promise<void> {
    const decoded = object(
      // eslint-disable-next-line unicorn/text-encoding-identifier-case -- Bun's TextDecoder Encoding type requires the canonical WHATWG label.
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    )
    const frameKeys: Record<string, string> = {
      record: "kind,record,seq",
      start: "fields,kind,record,seq",
      chunk: "data,field,kind,offset,seq",
      end: "kind,seq",
      manifest: "kind,manifest,seq",
    }
    if (
      typeof decoded.kind !== "string"
      || !Object.hasOwn(frameKeys, decoded.kind)
      || Object.keys(decoded).sort().join(",") !== frameKeys[decoded.kind]
    )
      invalid()
    if (decoded.seq !== this.sequence++ || this.manifest) invalid()
    if (decoded.kind === "manifest") {
      if (this.pending) invalid()
      const manifest = object(decoded.manifest)
      if (
        Object.keys(manifest).sort().join(",")
        !== "formatVersion,recordCounts,recordsSha256,schemaVersion,sourceStoreId"
      )
        invalid()
      if (
        manifest.formatVersion !== 1
        || manifest.schemaVersion !== 1
        || typeof manifest.sourceStoreId !== "string"
        || manifest.recordsSha256 !== this.digest.digest("hex")
      )
        invalid()
      const counts = object(manifest.recordCounts)
      if (
        JSON.stringify(Object.entries(counts).sort())
        !== JSON.stringify(Object.entries(this.counts).sort())
      )
        invalid()
      this.manifest = manifest as unknown as TransferManifest
      await this.flush()
      return
    }
    this.digest.update(bytes)
    switch (decoded.kind) {
      case "record": {
        if (this.pending) invalid()
        await this.record(decoded.record as TransferRecord)

        break
      }
      case "start": {
        if (
          this.pending
          || !Array.isArray(decoded.fields)
          || decoded.fields.length === 0
        )
          invalid()
        const record = object(decoded.record) as unknown as TransferRecord
        const value = object(record.value)
        const names = new Set<string>()
        const fields = decoded.fields.map((raw): PendingField => {
          const field = object(raw)
          if (Object.keys(field).sort().join(",") !== "length,name,sha256")
            invalid()
          if (
            typeof field.name !== "string"
            || names.has(field.name)
            || !transferColumns(record.table).some(
              (column) => column.name === field.name && column.type === "TEXT",
            )
            || value[field.name] !== null
            || !Number.isSafeInteger(field.length)
            || Number(field.length) < 1
            || typeof field.sha256 !== "string"
            || !/^[a-f\d]{64}$/.test(field.sha256)
          )
            invalid()
          names.add(field.name)
          return {
            name: field.name,
            length: Number(field.length),
            sha256: field.sha256,
            received: 0,
            chunks: [],
          }
        })
        this.pending = { record, fields, index: 0 }

        break
      }
      case "chunk": {
        const pending = this.pending
        const field = pending?.fields[pending.index]
        if (
          !pending
          || !field
          || decoded.field !== field.name
          || decoded.offset !== field.received
          || typeof decoded.data !== "string"
          || !/^[A-Z\d+/]*={0,2}$/i.test(decoded.data)
        )
          invalid()
        const data = Buffer.from(decoded.data, "base64")
        if (
          data.length === 0
          || data.toString("base64") !== decoded.data
          || field.received + data.length > field.length
        )
          invalid()
        field.chunks.push(data)
        field.received += data.length
        if (field.received === field.length) {
          const bytes = Buffer.concat(field.chunks)
          if (sha256(bytes) !== field.sha256) invalid()
          ;(pending.record.value as Record<string, JsonValue>)[field.name] =
            // eslint-disable-next-line unicorn/text-encoding-identifier-case -- Bun's TextDecoder Encoding type requires the canonical WHATWG label.
            new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          field.chunks = []
          pending.index++
        }

        break
      }
      case "end": {
        if (!this.pending || this.pending.index !== this.pending.fields.length)
          invalid()
        const record = this.pending.record
        this.pending = undefined
        await this.record(record)

        break
      }
      default: {
        invalid()
      }
    }
  }
  private async record(record: TransferRecord): Promise<void> {
    validateTransferRecord(record)
    const index = TRANSFER_TABLES.indexOf(record.table)
    if (index < this.tableIndex) invalid()
    const key = JSON.parse(record.key) as Array<string | number>
    if (index === this.tableIndex && this.previousKey) {
      let order = 0
      for (let position = 0; position < key.length && order === 0; position++) {
        const left = this.previousKey[position],
          right = key[position]
        order =
          typeof left === "number" && typeof right === "number" ?
            Math.sign(left - right)
          : Buffer.compare(
              Buffer.from(String(left)),
              Buffer.from(String(right)),
            )
      }
      if (order >= 0) invalid()
    }
    this.previousKey = key
    this.tableIndex = index
    if (
      record.table === "capi_metadata"
      || record.table === "capi_usage_lifetime"
    ) {
      const id = `${record.table}:${record.key}`
      if (this.singletonKeys.has(id)) invalid()
      this.singletonKeys.add(id)
    }
    const bytes = Buffer.byteLength(JSON.stringify(record))
    if (this.batchBytes + bytes > 1024 * 1024) await this.flush()
    this.batch.push(record)
    this.batchBytes += bytes
    this.counts[record.table] = (this.counts[record.table] ?? 0) + 1
    this.records++
    // Single large fields may exceed the bounded batch budget: flush immediately.
    if (this.batch.length >= 100 || this.batchBytes >= 1024 * 1024)
      await this.flush()
  }
  private async flush(): Promise<void> {
    if (this.batch.length === 0) return
    this.signal.throwIfAborted()
    await this.target.transaction(async (session) => {
      await requireMarker(session, this.operationId)
      await insertTransferRecords(session, this.batch)
    })
    this.batch = []
    this.batchBytes = 0
  }
  finish(): void {
    if (this.buffer.length > 0 || this.pending || !this.manifest) invalid()
    for (const key of REQUIRED_TRANSFER_METADATA_KEYS) {
      if (!this.singletonKeys.has(`capi_metadata:${JSON.stringify([key])}`))
        invalid()
    }
  }
}

async function requireMarker(
  session: SqlSession,
  operationId: string,
): Promise<void> {
  const marker = await session.query({
    sql: "SELECT value FROM capi_metadata WHERE key=?",
    args: [TRANSFER_MARKER],
  })
  if (marker[0]?.value !== operationId)
    throw new StorageSchemaError("Transfer ownership changed")
}

/** This database was empty when its marker was committed; every transferred row belongs to that marker. */
export async function discardIncompleteTransfer(
  target: Storage,
  operationId: string,
): Promise<void> {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(operationId))
    throw new StorageSchemaError("An exact incomplete transfer ID is required")
  await target.transaction(async (session) => {
    await requireMarker(session, operationId)
    for (const table of Object.keys(initialTables).reverse()) {
      if (table === "capi_metadata" || table === "capi_schema_migrations")
        continue
      await session.execute({ sql: `DELETE FROM ${table}`, args: [] })
    }
    await session.execute({
      sql: "INSERT INTO capi_usage_lifetime(id) VALUES(1)",
      args: [],
    })
    await session.execute({
      sql: "UPDATE capi_metadata SET value='0' WHERE key IN ('config_revision','history_activity_generation','history_debug_generation')",
      args: [],
    })
    await session.execute({
      sql: "UPDATE capi_metadata SET value=? WHERE key='store_id'",
      args: [randomUUID()],
    })
    await session.execute({
      sql: "DELETE FROM capi_metadata WHERE key IN ('history_routing_lifetime','history_routing_started_at')",
      args: [],
    })
    await session.execute({
      sql: "DELETE FROM capi_metadata WHERE key=? AND value=?",
      args: [TRANSFER_MARKER, operationId],
    })
  })
}

// eslint-disable-next-line max-params, max-lines-per-function -- One authenticated restore lifecycle binds the stream to its exclusive replacement target.
export async function restoreBackup(
  stream: ReadableStream<Uint8Array>,
  password: string,
  target: Storage,
  signal?: AbortSignal,
): Promise<TransferProgress> {
  const operationId = randomUUID()
  const cancellation = new AbortController()
  const timeout = setTimeout(() => cancellation.abort(), TRANSFER_TIMEOUT_MS)
  const operationSignal =
    signal ?
      AbortSignal.any([signal, cancellation.signal])
    : cancellation.signal
  const reader = stream.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  operationSignal.addEventListener("abort", abort, { once: true })
  try {
    operationSignal.throwIfAborted()
    await target.transaction(async (session) => {
      await assertEmptyTransferTarget(session)
      await session.execute({
        sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
        args: [TRANSFER_MARKER, operationId],
      })
    })
    const decoder = new RecordDecoder(target, operationId, operationSignal)
    let header = Buffer.alloc(0)
    let tail = Buffer.alloc(0)
    let decipher: DecipherGCM | undefined
    while (true) {
      operationSignal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      let bytes = Buffer.from(next.value)
      if (!decipher) {
        const needed = BACKUP_HEADER_BYTES - header.length
        header = Buffer.concat([header, bytes.subarray(0, needed)])
        bytes = bytes.subarray(needed)
        if (header.length < BACKUP_HEADER_BYTES) continue
        if (
          !header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)
          || header[BACKUP_MAGIC.length] !== BACKUP_VERSION
        )
          invalid()
        const key = await deriveBackupKey(
          password,
          header.subarray(BACKUP_MAGIC.length + 1, BACKUP_MAGIC.length + 17),
        )
        decipher = createDecipheriv("aes-256-gcm", key, header.subarray(-12))
        key.fill(0)
        decipher.setAAD(header)
      }
      const joined = Buffer.concat([tail, bytes])
      const length = Math.max(0, joined.length - 16)
      if (length)
        await decoder.write(decipher.update(joined.subarray(0, length)))
      tail = Buffer.from(joined.subarray(length))
    }
    operationSignal.throwIfAborted()
    if (!decipher || tail.length !== 16) invalid()
    decipher.setAuthTag(tail)
    await decoder.write(decipher.final())
    decoder.finish()
    await target.transaction(async (session) => {
      operationSignal.throwIfAborted()
      await requireMarker(session, operationId)
      await validateTransferredState(session)
      const store = await session.query({
        sql: "SELECT value FROM capi_metadata WHERE key='store_id'",
        args: [],
      })
      if (
        !decoder.manifest
        || store[0]?.value !== decoder.manifest.sourceStoreId
        || decoder.counts.capi_usage_lifetime !== 1
      )
        invalid()
      for (const table of TRANSFER_TABLES) {
        const count = decoder.counts[table] ?? 0
        const rows = await session.query({
          sql: `SELECT COUNT(*) AS count FROM ${table}${table === "capi_metadata" ? " WHERE key != 'transfer_incomplete'" : ""}`,
          args: [],
        })
        if (rows[0]?.count !== count) invalid()
      }
      await session.execute({
        sql: "DELETE FROM capi_admin_sessions",
        args: [],
      })
      await session.execute({ sql: "DELETE FROM capi_setup_codes", args: [] })
      await session.execute({
        sql: "DELETE FROM capi_metadata WHERE key=? AND value=?",
        args: [TRANSFER_MARKER, operationId],
      })
    })
    return { operationId, phase: "complete", records: decoder.records }
  } catch {
    throw new StorageSchemaError(
      `Encrypted restore failed; replacement remains incomplete (restore ID ${operationId})`,
    )
  } finally {
    clearTimeout(timeout)
    operationSignal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
