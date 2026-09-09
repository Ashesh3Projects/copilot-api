/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejection matchers must be awaited at runtime. */
import { expect, test } from "bun:test"
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

import type { TransferRecord } from "~/lib/storage/transfer-records"
import type { SqlSession, SqlStatement, Storage } from "~/lib/storage/types"

import {
  BACKUP_HEADER_BYTES,
  BACKUP_MAGIC,
  BACKUP_VERSION,
  createBackupStream,
  deriveBackupKey,
} from "~/lib/config-backup"
import { initialTables } from "~/lib/storage/migrations/001-initial"
import { gatewaySecretTables } from "~/lib/storage/migrations/002-gateway-secrets"
import { discardIncompleteTransfer, restoreBackup } from "~/lib/storage/restore"
import { transferRecords } from "~/lib/storage/transfer-records"

import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const password = "debug-backup-fixture-password"
const privatePayload = "legacy-private-debug-payload"
const gatewaySecret = "retained-v2-gateway-fixture-key"
const gatewayDigest = createHash("sha256").update(gatewaySecret).digest("hex")
type Frame = Record<string, unknown>

async function decrypt(bytes: Uint8Array): Promise<string> {
  const header = bytes.subarray(0, BACKUP_HEADER_BYTES)
  const key = await deriveBackupKey(
    password,
    header.subarray(BACKUP_MAGIC.length + 1, BACKUP_MAGIC.length + 17),
  )
  const cipher = createDecipheriv("aes-256-gcm", key, header.subarray(-12))
  key.fill(0)
  cipher.setAAD(header)
  cipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([
    cipher.update(bytes.subarray(BACKUP_HEADER_BYTES, -16)),
    cipher.final(),
  ]).toString("utf8")
}

async function encrypt(frames: Array<Frame>): Promise<Uint8Array> {
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
  const plain = `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`
  return Buffer.concat([
    header,
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}

async function legacyFrames(source: Storage, framed: boolean) {
  await source.atomicBatch([
    {
      sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app','{}',2)",
      args: [],
    },
    {
      sql: "UPDATE capi_metadata SET value='2' WHERE key='config_revision'",
      args: [],
    },
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=13,output_tokens=17,request_count=2,first_request_at=1",
      args: [],
    },
    {
      sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES('retained-gateway',?,'Retained',0)",
      args: [gatewayDigest],
    },
    {
      sql: "INSERT INTO capi_gateway_secrets(credential_id,secret_value,updated_at) VALUES('retained-gateway',?,0)",
      args: [gatewaySecret],
    },
  ])
  const records = await source.read(async (session) => {
    const rows: Array<TransferRecord> = []
    for await (const row of transferRecords(session)) rows.push(row)
    return rows
  })
  for (const record of records) {
    if (record.table === "capi_metadata" && record.key === '["schema_version"]')
      record.value = { key: "schema_version", value: "2" }
  }
  records.push(
    {
      table: "capi_metadata",
      key: '["history_debug_generation"]',
      value: { key: "history_debug_generation", value: "12" },
    },
    {
      table: "capi_metadata",
      key: '["history_activity_generation"]',
      value: { key: "history_activity_generation", value: "0" },
    },
    {
      table: "capi_activity",
      key: '["retained"]',
      value: {
        id: "retained",
        generation: 0,
        created_at: 1,
        expires_at: 9999999999999,
        kind: "info",
        account_id: null,
        payload_json: "{}",
        payload_bytes: 2,
      },
    },
  )
  const payload = JSON.stringify({
    request: privatePayload.repeat(framed ? 5000 : 1),
  })
  records.push({
    table: "capi_debug",
    key: '["retired"]',
    value: {
      id: "retired",
      generation: 12,
      created_at: 1,
      updated_at: 2,
      expires_at: 9999999999999,
      status: "complete",
      replayable: 1,
      account_id: null,
      provider_id: null,
      payload_json: payload,
      payload_bytes: Buffer.byteLength(payload),
    },
  })
  const tableOrder = Object.keys({ ...initialTables, ...gatewaySecretTables })
  records.sort(
    (a, b) =>
      tableOrder.indexOf(a.table) - tableOrder.indexOf(b.table)
      || Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)),
  )
  const frames: Array<Frame> = []
  const counts: Record<string, number> = {}
  for (const record of records) {
    counts[record.table] = (counts[record.table] ?? 0) + 1
    if (record.table !== "capi_debug" || !framed) {
      frames.push({ seq: frames.length, kind: "record", record })
      continue
    }
    const bytes = Buffer.from(payload)
    frames.push({
      seq: frames.length,
      kind: "start",
      record: {
        ...record,
        value: { ...(record.value as object), payload_json: null },
      },
      fields: [
        {
          name: "payload_json",
          length: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    })
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
      frames.push({
        seq: frames.length,
        kind: "chunk",
        field: "payload_json",
        offset,
        data: bytes.subarray(offset, offset + 64 * 1024).toString("base64"),
      })
    frames.push({ seq: frames.length, kind: "end" })
  }
  const identity = records.find(
    (record) =>
      record.table === "capi_metadata" && record.key === '["store_id"]',
  )?.value as { value: string }
  frames.push({
    seq: frames.length,
    kind: "manifest",
    manifest: {
      formatVersion: 1,
      schemaVersion: 2,
      sourceStoreId: identity.value,
      recordCounts: counts,
      recordsSha256: createHash("sha256")
        .update(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`)
        .digest("hex"),
    },
  })
  return frames
}

function observeStorage(storage: Storage) {
  const statements: Array<SqlStatement> = []
  const wrap = (session: SqlSession): SqlSession => ({
    query: (statement) => {
      statements.push(statement)
      return session.query(statement)
    },
    execute: (statement) => {
      statements.push(statement)
      return session.execute(statement)
    },
  })
  const observed: Storage = {
    read: (work) => storage.read((session) => work(wrap(session))),
    transaction: (work) =>
      storage.transaction((session) => work(wrap(session))),
    atomicBatch: (batch) => {
      statements.push(...batch)
      return storage.atomicBatch(batch)
    },
    close: async () => {},
  }
  return { storage: observed, statements }
}

test("new encrypted backups exclude retired debug data and metadata even if stale tables remain", async () => {
  await withTransferStorage(async (source) => {
    await source.atomicBatch([
      { sql: "CREATE TABLE capi_debug(payload_json TEXT)", args: [] },
      {
        sql: "INSERT INTO capi_debug(payload_json) VALUES(?)",
        args: [privatePayload],
      },
      {
        sql: "INSERT INTO capi_metadata(key,value) VALUES('history_debug_generation','12')",
        args: [],
      },
    ])
    const plain = await decrypt(
      await streamBytes(createBackupStream(password, undefined, source)),
    )
    expect(plain).not.toContain("capi_debug")
    expect(plain).not.toContain("history_debug_generation")
    expect(plain).not.toContain(privatePayload)
    expect(plain).toContain('"schemaVersion":5')
  })
})

test.each([false, true])(
  "schema-two restore consumes debug frames in memory and preserves durable state (framed=%s)",
  async (framed) => {
    await withTransferStorage(async (source) => {
      const bytes = await encrypt(await legacyFrames(source, framed))
      await withTransferStorage(async (target) => {
        const observed = observeStorage(target)
        expect(
          (
            await restoreBackup(
              bytesStream(bytes, 64 * 1024),
              password,
              observed.storage,
            )
          ).phase,
        ).toBe("complete")
        expect(JSON.stringify(observed.statements)).not.toContain("capi_debug")
        expect(JSON.stringify(observed.statements)).not.toContain(
          "history_debug_generation",
        )
        expect(JSON.stringify(observed.statements)).not.toContain(
          privatePayload,
        )
        const state = await target.read(async (session) => ({
          metadata: await session.query({
            sql: "SELECT key,value FROM capi_metadata WHERE key IN ('schema_version','config_revision','history_debug_generation') ORDER BY key",
            args: [],
          }),
          settings: await session.query({
            sql: "SELECT namespace,revision FROM capi_settings",
            args: [],
          }),
          activity: await session.query({
            sql: "SELECT name FROM sqlite_master WHERE name='capi_activity'",
            args: [],
          }),
          usage: await session.query({
            sql: "SELECT input_tokens,output_tokens,request_count FROM capi_usage_lifetime",
            args: [],
          }),
          gateway: await session.query({
            sql: "SELECT c.digest,s.secret_value FROM capi_gateway_credentials c JOIN capi_gateway_secrets s ON s.credential_id=c.id",
            args: [],
          }),
        }))
        expect(state.metadata).toEqual([
          { key: "config_revision", value: "2" },
          { key: "schema_version", value: "5" },
        ])
        expect(state.settings).toEqual([{ namespace: "app", revision: 2 }])
        expect(state.activity).toEqual([])
        expect(state.usage).toEqual([
          { input_tokens: 13, output_tokens: 17, request_count: 2 },
        ])
        expect(state.gateway).toEqual([
          { digest: gatewayDigest, secret_value: gatewaySecret },
        ])
        const output = await decrypt(
          await streamBytes(createBackupStream(password, undefined, target)),
        )
        expect(output).not.toContain("capi_debug")
        expect(output).not.toContain(privatePayload)
      })
    })
  },
)

test.each(["count", "digest", "chunk"])(
  "discarded legacy debug still participates in backup integrity checks: %s",
  async (corrupt) => {
    await withTransferStorage(async (source) => {
      const frames = await legacyFrames(source, true)
      const manifest = frames.at(-1)?.manifest as {
        recordCounts: Record<string, number>
        recordsSha256: string
      }
      if (corrupt === "count") manifest.recordCounts.capi_debug++
      if (corrupt === "digest") manifest.recordsSha256 = "0".repeat(64)
      if (corrupt === "chunk") {
        const chunk = frames.find((frame) => frame.kind === "chunk")
        if (!chunk) throw new Error("Expected framed fixture")
        chunk.data = Buffer.from("changed payload").toString("base64")
      }
      await withTransferStorage(async (target) => {
        const observed = observeStorage(target)
        await expect(
          restoreBackup(
            bytesStream(await encrypt(frames), 64 * 1024),
            password,
            observed.storage,
          ),
        ).rejects.toThrow("incomplete")
        expect(JSON.stringify(observed.statements)).not.toContain(
          privatePayload,
        )
        const rows = await target.read((session) =>
          session.query({
            sql: "SELECT value FROM capi_metadata WHERE key='transfer_incomplete'",
            args: [],
          }),
        )
        expect(rows).toHaveLength(1)
        await discardIncompleteTransfer(target, String(rows[0].value))
      })
    })
  },
)
