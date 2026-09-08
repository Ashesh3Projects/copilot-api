/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's asynchronous rejection matcher is awaited at runtime. */
import { expect, test } from "bun:test"
import { createCipheriv, createDecipheriv } from "node:crypto"

import {
  BACKUP_HEADER_BYTES,
  BACKUP_MAGIC,
  createBackupStream,
  deriveBackupKey,
} from "../src/lib/config-backup"
import {
  discardIncompleteTransfer,
  restoreBackup,
} from "../src/lib/storage/restore"
import { MAX_FRAME_BYTES } from "../src/lib/storage/transfer-records"
import {
  bytesStream,
  settingsFixture,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"
async function rewrite(
  bytes: Uint8Array,
  mutate: (lines: Array<Record<string, unknown>>) => string,
): Promise<Uint8Array> {
  const header = bytes.subarray(0, BACKUP_HEADER_BYTES)
  const key = await deriveBackupKey(
    "fixture-password",
    header.subarray(BACKUP_MAGIC.length + 1, BACKUP_MAGIC.length + 17),
  )
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(-12))
  decipher.setAAD(header)
  decipher.setAuthTag(bytes.subarray(-16))
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(BACKUP_HEADER_BYTES, -16)),
    decipher.final(),
  ]).toString("utf8")
  const lines = plain
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const cipher = createCipheriv("aes-256-gcm", key, header.subarray(-12))
  cipher.setAAD(header)
  return Buffer.concat([
    header,
    cipher.update(mutate(lines)),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}
const serialize = (lines: Array<Record<string, unknown>>) =>
  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
test("authenticated malformed frames fail closed: missing manifest, repeated sequence, unknown table, giant line", async () => {
  await withTransferStorage(async (source) => {
    await settingsFixture(source)
    const bytes = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    for (const mutate of [
      (lines: Array<Record<string, unknown>>) => serialize(lines.slice(0, -1)),
      (lines: Array<Record<string, unknown>>) =>
        serialize([lines[0], lines[0], ...lines.slice(1)]),
      (lines: Array<Record<string, unknown>>) => {
        ;(lines[0].record as Record<string, unknown>).table = "sqlite_master"
        return serialize(lines)
      },
      () => "x".repeat(MAX_FRAME_BYTES + 1),
    ]) {
      const malformed = await rewrite(bytes, mutate)
      await withTransferStorage(async (target) => {
        await expect(
          restoreBackup(
            bytesStream(malformed, 64 * 1024),
            "fixture-password",
            target,
          ),
        ).rejects.toThrow()
        const markers = await target.read((session) =>
          session.query({
            sql: "SELECT value FROM capi_metadata WHERE key='transfer_incomplete'",
            args: [],
          }),
        )
        expect(markers).toHaveLength(1)
        await expect(
          discardIncompleteTransfer(
            target,
            "00000000-0000-0000-0000-000000000000",
          ),
        ).rejects.toThrow("ownership")
        await discardIncompleteTransfer(target, String(markers[0].value))
        expect(
          (await restoreBackup(bytesStream(bytes), "fixture-password", target))
            .phase,
        ).toBe("complete")
        await expect(
          discardIncompleteTransfer(target, String(markers[0].value)),
        ).rejects.toThrow("ownership")
      })
    }
  })
}, 20_000)
test("cancelled restore after marker creation remains incomplete", async () => {
  await withTransferStorage(async (source) => {
    const bytes = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      const controller = new AbortController()
      let once = false
      const stream = new ReadableStream<Uint8Array>({
        pull(output) {
          if (!once) {
            once = true
            output.enqueue(bytes.subarray(0, 10))
          } else controller.abort()
        },
      })
      await expect(
        restoreBackup(stream, "fixture-password", target, controller.signal),
      ).rejects.toThrow("incomplete")
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT value FROM capi_metadata WHERE key='transfer_incomplete'",
            args: [],
          }),
        ),
      ).toHaveLength(1)
    })
  })
})
