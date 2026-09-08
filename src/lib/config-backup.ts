import { createCipheriv, createHash, randomBytes, scrypt } from "node:crypto"

import type { TransferRecord } from "~/lib/storage/transfer-records"
import type { Storage } from "~/lib/storage/types"

import { getStorageRuntime } from "~/lib/storage/runtime"
import { readBackupManifestMetadata } from "~/lib/storage/runtime-status"
import {
  MAX_FRAME_BYTES,
  sha256,
  TRANSFER_TIMEOUT_MS,
  transferRecords,
  withTransferSnapshot,
} from "~/lib/storage/transfer-records"

export const BACKUP_MAGIC = Buffer.from("CAPI-BACKUP", "utf8")
export const BACKUP_HEADER_BYTES = BACKUP_MAGIC.length + 1 + 16 + 12
export const BACKUP_VERSION = 1
export function deriveBackupKey(
  password: string,
  salt: Uint8Array,
): Promise<Buffer> {
  if (!password) throw new Error("A backup password is required")
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    )
  })
}

function* frameRecord(
  record: TransferRecord,
): Generator<Record<string, unknown>> {
  if (Buffer.byteLength(JSON.stringify(record)) < MAX_FRAME_BYTES - 1024) {
    yield { kind: "record", record }
    return
  }
  const value = { ...(record.value as Record<string, unknown>) }
  const fields: Array<{ name: string; length: number; sha256: string }> = []
  for (const [name, field] of Object.entries(value)) {
    if (typeof field !== "string" || Buffer.byteLength(field) < 64 * 1024)
      continue
    fields.push({
      name,
      length: Buffer.byteLength(field),
      sha256: sha256(field),
    })
    value[name] = null
  }
  yield { kind: "start", record: { ...record, value }, fields }
  for (const field of fields) {
    const bytes = Buffer.from(
      (record.value as Record<string, string>)[field.name],
    )
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      yield {
        kind: "chunk",
        field: field.name,
        offset,
        data: bytes.subarray(offset, offset + 1024 * 1024).toString("base64"),
      }
    }
  }
  yield { kind: "end" }
}

/** Backpressure keeps history in the SQL snapshot; no spool or temporary file. */
export function createBackupStream(
  password: string,
  signal?: AbortSignal,
  storage: Storage = getStorageRuntime().storage,
): ReadableStream<Uint8Array> {
  signal?.throwIfAborted()
  if (!password) throw new Error("A backup password is required")
  const cancellation = new AbortController()
  const deadline = setTimeout(
    () => cancellation.abort(new Error("Backup transfer timed out")),
    TRANSFER_TIMEOUT_MS,
  )
  const operationSignal =
    signal ?
      AbortSignal.any([signal, cancellation.signal])
    : cancellation.signal
  const pipe = new TransformStream<Uint8Array, Uint8Array>()
  const writer = pipe.writable.getWriter()
  const abort = () => {
    void writer.abort(new Error("Backup transfer cancelled")).catch(() => {})
  }
  operationSignal.addEventListener("abort", abort, { once: true })
  const produce = async () => {
    const header = Buffer.concat([
      BACKUP_MAGIC,
      Buffer.from([BACKUP_VERSION]),
      randomBytes(16),
      randomBytes(12),
    ])
    const key = await deriveBackupKey(
      password,
      header.subarray(BACKUP_MAGIC.length + 1, BACKUP_MAGIC.length + 17),
    )
    const cipher = createCipheriv("aes-256-gcm", key, header.subarray(-12))
    key.fill(0)
    cipher.setAAD(header)
    await writer.write(header)
    await withTransferSnapshot(
      storage,
      async (session) => {
        const metadata = await readBackupManifestMetadata(session)
        const counts: Record<string, number> = {}
        const digest = createHash("sha256")
        let sequence = 0
        for await (const record of transferRecords(session, operationSignal)) {
          for (const frame of frameRecord(record)) {
            operationSignal.throwIfAborted()
            const bytes = Buffer.from(
              `${JSON.stringify({ seq: sequence++, ...frame })}\n`,
            )
            if (bytes.length > MAX_FRAME_BYTES)
              throw new Error("Transfer frame is too large")
            digest.update(bytes)
            await writer.write(cipher.update(bytes))
          }
          counts[record.table] = (counts[record.table] ?? 0) + 1
        }
        const manifest = {
          formatVersion: 1,
          ...metadata,
          recordCounts: counts,
          recordsSha256: digest.digest("hex"),
        }
        await writer.write(
          cipher.update(
            Buffer.from(
              `${JSON.stringify({ seq: sequence, kind: "manifest", manifest })}\n`,
            ),
          ),
        )
      },
      operationSignal,
    )
    operationSignal.throwIfAborted()
    await writer.write(cipher.final())
    await writer.write(cipher.getAuthTag())
    await writer.close()
  }
  void produce()
    .catch(async () => {
      await writer.abort(new Error("Encrypted backup failed")).catch(() => {})
    })
    .finally(() => {
      clearTimeout(deadline)
      operationSignal.removeEventListener("abort", abort)
    })
  return pipe.readable
}
