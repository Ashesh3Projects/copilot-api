/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun asynchronous rejection matchers are awaited at runtime. */
import { expect, test } from "bun:test"

import { createBackupStream } from "../src/lib/config-backup"
import { restoreBackup } from "../src/lib/storage/restore"
import {
  bytesStream,
  settingsFixture,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"
test("encrypted backup round trips stable IDs, credentials, settings and old usage", async () => {
  await withTransferStorage(async (source) => {
    await settingsFixture(source)
    await source.atomicBatch([
      {
        sql: "INSERT INTO capi_accounts(id,domain,created_at,updated_at) VALUES(0,'github.com',0,0)",
        args: [],
      },
      {
        sql: "INSERT INTO capi_account_credentials(account_id,oauth_value,updated_at) VALUES(0,'fixture-token',0)",
        args: [],
      },
      {
        sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(0,'old-model',5,7,1)",
        args: [],
      },
    ])
    const bytes = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    expect(new TextDecoder().decode(bytes)).not.toContain("fixture-token")
    await withTransferStorage(async (target) => {
      const result = await restoreBackup(
        bytesStream(bytes),
        "fixture-password",
        target,
      )
      expect(result.phase).toBe("complete")
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT account_id,oauth_value FROM capi_account_credentials",
            args: [],
          }),
        ),
      ).toEqual([{ account_id: 0, oauth_value: "fixture-token" }])
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT value FROM capi_metadata WHERE key='transfer_incomplete'",
            args: [],
          }),
        ),
      ).toEqual([])
      await expect(
        restoreBackup(bytesStream(bytes), "fixture-password", target),
      ).rejects.toThrow()
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT account_id FROM capi_account_credentials",
            args: [],
          }),
        ),
      ).toEqual([{ account_id: 0 }])
    })
  })
})
test("wrong password, modified header/ciphertext/tag and truncation leave replacements incomplete", async () => {
  await withTransferStorage(async (source) => {
    await settingsFixture(source)
    const bytes = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    for (const variant of [
      "password",
      "version",
      "ciphertext",
      "tag",
      "truncated",
    ] as const) {
      let corrupted = bytes.slice()
      if (variant === "version") corrupted[11] = 99
      if (variant === "ciphertext") corrupted[60] ^= 1
      if (variant === "tag") corrupted[corrupted.length - 1] ^= 1
      if (variant === "truncated") corrupted = corrupted.subarray(0, -17)
      await withTransferStorage(async (target) => {
        await expect(
          restoreBackup(
            bytesStream(corrupted),
            variant === "password" ? "incorrect" : "fixture-password",
            target,
          ),
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
    }
  })
}, 20_000)
test("large logical field uses continuation frames without truncation", async () => {
  await withTransferStorage(async (source) => {
    const payload = "long-unicode-🦉".repeat(600_000)
    await settingsFixture(source, {
      extraPrompts: { "fixture-model": payload },
    })
    const bytes = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      await restoreBackup(
        bytesStream(bytes, 64 * 1024),
        "fixture-password",
        target,
      )
      const rows = await target.read((session) =>
        session.query({
          sql: "SELECT value_json FROM capi_settings WHERE namespace='app'",
          args: [],
        }),
      )
      expect(
        (
          JSON.parse(String(rows[0].value_json)) as {
            extraPrompts: Record<string, string>
          }
        ).extraPrompts["fixture-model"],
      ).toBe(payload)
    })
  })
}, 20_000)
