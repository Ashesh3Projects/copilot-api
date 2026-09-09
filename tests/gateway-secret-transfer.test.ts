/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejection matchers are awaited at runtime. */
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { createBackupStream } from "~/lib/config-backup"
import {
  applyLegacyImport,
  previewLegacyImport,
} from "~/lib/storage/legacy-import"
import { restoreBackup, validateTransferredState } from "~/lib/storage/restore"

import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const rawKey = "fixture-recoverable-gateway-key"
const rawDigest = createHash("sha256").update(rawKey).digest("hex")

test("legacy raw-key import and encrypted transfer preserve recoverable gateway keys", async () => {
  await withTransferStorage(async (source, directory) => {
    await fs.writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({ auth: { apiKeys: [rawKey] } }),
    )
    const input = { directory, includeEnvironment: false }
    const preview = await previewLegacyImport(input, source)
    expect(preview.counts.capi_gateway_secrets).toBe(1)
    expect(JSON.stringify(preview)).not.toContain(rawKey)
    await applyLegacyImport(input, preview, source)
    const bytes = await streamBytes(
      createBackupStream("fixture-backup-password", undefined, source),
    )
    expect(new TextDecoder().decode(bytes)).not.toContain(rawKey)
    await withTransferStorage(async (target) => {
      await restoreBackup(bytesStream(bytes), "fixture-backup-password", target)
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT c.digest,s.secret_value FROM capi_gateway_credentials c JOIN capi_gateway_secrets s ON s.credential_id=c.id",
            args: [],
          }),
        ),
      ).toEqual([{ digest: rawDigest, secret_value: rawKey }])
    })
  })
})

test.each([null, "different-fixture-key"])(
  "transfer validation rejects missing or mismatched gateway secret %s",
  async (secret) => {
    await withTransferStorage(async (target) => {
      await target.transaction(async (session) => {
        await session.execute({
          sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES('fixture',?,'Fixture',0)",
          args: [rawDigest],
        })
        if (secret !== null)
          await session.execute({
            sql: "INSERT INTO capi_gateway_secrets(credential_id,secret_value,updated_at) VALUES('fixture',?,0)",
            args: [secret],
          })
      })
      await expect(target.read(validateTransferredState)).rejects.toThrow(
        "gateway",
      )
    })
  },
)

test("schema-one backups cannot reintroduce digest-only gateway credentials", async () => {
  await withTransferStorage(async (source) => {
    await source.atomicBatch([
      {
        sql: "UPDATE capi_metadata SET value='1' WHERE key='schema_version'",
        args: [],
      },
      {
        sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES('old',?,'Old',0)",
        args: [rawDigest],
      },
    ])
    const bytes = await streamBytes(
      createBackupStream("fixture-backup-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      await expect(
        restoreBackup(bytesStream(bytes), "fixture-backup-password", target),
      ).rejects.toThrow()
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT key FROM capi_metadata WHERE key='transfer_incomplete'",
            args: [],
          }),
        ),
      ).toHaveLength(1)
    })
  })
})
