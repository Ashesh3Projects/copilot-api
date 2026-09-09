/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited. */
import { expect, test } from "bun:test"
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomUUID,
} from "node:crypto"

import type { Storage } from "~/lib/storage/types"

import { createAccountMutationContext } from "~/lib/accounts-service"
import {
  BACKUP_HEADER_BYTES,
  BACKUP_MAGIC,
  createBackupStream,
  deriveBackupKey,
} from "~/lib/config-backup"
import { AccountsRepository } from "~/lib/storage/accounts-repository"
import { migrateStorage } from "~/lib/storage/migrations"
import { initialMigration } from "~/lib/storage/migrations/001-initial"
import { gatewaySecretsMigration } from "~/lib/storage/migrations/002-gateway-secrets"
import { getStoreRevision } from "~/lib/storage/operations"
import { restoreBackup } from "~/lib/storage/restore"
import { validateTransferDomains } from "~/lib/storage/transfer-validation"

import { createSchemaFixture } from "./helpers/storage-schema"
import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const password = "fixture-password"
const context = (storage: Storage, input: unknown) =>
  createAccountMutationContext(
    storage,
    "account.update",
    input,
    "admin:storage-test",
  )

async function seedAccount(storage: Storage) {
  const repository = new AccountsRepository(storage)
  return (
    await repository.create(
      {
        instanceDomain: "github.com",
        upstreamUserId: "123",
        login: "fixture-account",
        token: "fixture-oauth",
        label: "Personal",
        accountType: "individual",
        modelCount: 1,
      },
      await context(storage, {}),
    )
  ).value
}

async function rewriteBackup(
  bytes: Uint8Array,
  schemaVersion: number,
  integrationId?: string,
) {
  const header = bytes.subarray(0, BACKUP_HEADER_BYTES)
  const key = await deriveBackupKey(
    password,
    header.subarray(BACKUP_MAGIC.length + 1, BACKUP_MAGIC.length + 17),
  )
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(-12))
  decipher.setAAD(header)
  decipher.setAuthTag(bytes.subarray(-16))
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(BACKUP_HEADER_BYTES, -16)),
    decipher.final(),
  ]).toString("utf8")
  const frames = plain
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          seq: number
          kind: string
          record?: { table: string; value: Record<string, unknown> }
          manifest?: { schemaVersion: number; recordsSha256: string }
        },
    )
  const digest = createHash("sha256")
  const lines = frames.map((frame) => {
    if (frame.record?.table === "capi_accounts") {
      if (schemaVersion === 2) delete frame.record.value.integration_id
      else if (integrationId !== undefined)
        frame.record.value.integration_id = integrationId
    }
    if (
      frame.record?.table === "capi_metadata"
      && frame.record.value.key === "schema_version"
    )
      frame.record.value.value = String(schemaVersion)
    if (frame.manifest) {
      frame.manifest.schemaVersion = schemaVersion
      frame.manifest.recordsSha256 = digest.digest("hex")
    }
    const line = `${JSON.stringify(frame)}\n`
    if (!frame.manifest) digest.update(line)
    return line
  })
  const cipher = createCipheriv("aes-256-gcm", key, header.subarray(-12))
  cipher.setAAD(header)
  return Buffer.concat([
    header,
    cipher.update(lines.join("")),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}

test("version two databases migrate existing account identities and credentials with an empty override", async () => {
  const fixture = await createSchemaFixture()
  try {
    await fixture.storage.transaction(async (session) => {
      for (const migration of [initialMigration, gatewaySecretsMigration]) {
        for (const sql of migration.statements)
          await session.execute({ sql, args: [] })
        await session.execute({
          sql: "INSERT INTO capi_schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)",
          args: [
            migration.version,
            migration.name,
            createHash("sha256")
              .update(JSON.stringify(migration))
              .digest("hex"),
            1,
          ],
        })
      }
      for (const [key, value] of Object.entries({
        store_id: randomUUID(),
        schema_version: "2",
        config_revision: "7",
        history_activity_generation: "0",
        history_debug_generation: "0",
      }))
        await session.execute({
          sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
          args: [key, value],
        })
      await session.execute({
        sql: "INSERT INTO capi_accounts(id,domain,login,credential_revision,created_at,updated_at) VALUES(4,'github.com','previous',2,0,0)",
        args: [],
      })
      await session.execute({
        sql: "INSERT INTO capi_account_credentials(account_id,oauth_value,updated_at) VALUES(4,'fixture-old-oauth',0)",
        args: [],
      })
    })
    await migrateStorage(fixture.storage)
    expect(await new AccountsRepository(fixture.storage).get(4)).toMatchObject({
      token: "fixture-old-oauth",
      record: {
        id: 4,
        login: "previous",
        credentialRevision: 2,
        integrationId: null,
      },
    })
    expect(await getStoreRevision(fixture.storage)).toBe(7)
    await migrateStorage(fixture.storage)
    expect(
      (await new AccountsRepository(fixture.storage).get(4)).record
        .integrationId,
    ).toBeNull()
  } finally {
    await fixture.close()
  }
})

test("encrypted backup and restore preserve custom and cleared integration overrides", async () => {
  await withTransferStorage(async (source) => {
    const account = await seedAccount(source)
    const repository = new AccountsRepository(source)
    for (const integrationId of ["assigned-integration", null]) {
      await repository.update(
        account.id,
        { integrationId },
        await context(source, { integrationId }),
      )
      const bytes = await streamBytes(
        createBackupStream(password, undefined, source),
      )
      await withTransferStorage(async (target) => {
        expect(
          (await restoreBackup(bytesStream(bytes), password, target)).phase,
        ).toBe("complete")
        expect(
          await new AccountsRepository(target).get(account.id),
        ).toMatchObject({
          token: "fixture-oauth",
          record: { integrationId, id: account.id, label: "Personal" },
        })
        await migrateStorage(target)
        expect(
          (await new AccountsRepository(target).get(account.id)).record
            .integrationId,
        ).toBe(integrationId)
      })
    }
  })
})

test("version two encrypted backups restore with the default override under the current schema", async () => {
  await withTransferStorage(async (source) => {
    const account = await seedAccount(source)
    const bytes = await rewriteBackup(
      await streamBytes(createBackupStream(password, undefined, source)),
      2,
    )
    await withTransferStorage(async (target) => {
      expect(
        (await restoreBackup(bytesStream(bytes), password, target)).phase,
      ).toBe("complete")
      await migrateStorage(target)
      expect(
        (await new AccountsRepository(target).get(account.id)).record
          .integrationId,
      ).toBeNull()
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT value FROM capi_metadata WHERE key='schema_version'",
            args: [],
          }),
        ),
      ).toEqual([{ value: "4" }])
    })
  })
})

test("restore rejects a validly encrypted backup containing an unsafe integration header", async () => {
  await withTransferStorage(async (source) => {
    await seedAccount(source)
    const bytes = await rewriteBackup(
      await streamBytes(createBackupStream(password, undefined, source)),
      3,
      "good\r\nInjected: yes",
    )
    await withTransferStorage(async (target) => {
      await expect(
        restoreBackup(bytesStream(bytes), password, target),
      ).rejects.toThrow("Encrypted restore failed")
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT key FROM capi_metadata WHERE key='transfer_incomplete'",
            args: [],
          }),
        ),
      ).toHaveLength(1)
      await expect(target.read(validateTransferDomains)).rejects.toThrow(
        "Invalid imported account integration ID",
      )
    })
  })
})
