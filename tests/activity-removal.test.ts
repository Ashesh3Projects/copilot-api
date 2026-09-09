import { expect, test } from "bun:test"
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto"
import { readFile } from "node:fs/promises"

import type { TransferRecord } from "~/lib/storage/transfer-records"
import type { Storage } from "~/lib/storage/types"

import {
  BACKUP_MAGIC,
  BACKUP_VERSION,
  deriveBackupKey,
} from "~/lib/config-backup"
import { migrateStorage } from "~/lib/storage/migrations"
import { restoreBackup } from "~/lib/storage/restore"
import {
  currentSchemaVersion,
  schemaThreeTables,
  storageMigrations,
} from "~/lib/storage/schema"
import {
  transferTablesForSchema,
  transferColumns,
  transferKey,
} from "~/lib/storage/transfer-records"

import { createSchemaFixture } from "./helpers/storage-schema"
import { bytesStream, withTransferStorage } from "./helpers/transfer-storage"

async function seedLegacy(storage: Storage, version: number): Promise<void> {
  const now = Date.now()
  await storage.transaction(async (session) => {
    for (const migration of storageMigrations.slice(0, version)) {
      for (const sql of migration.statements)
        await session.execute({ sql, args: [] })
      await session.execute({
        sql: "INSERT INTO capi_schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)",
        args: [
          migration.version,
          migration.name,
          createHash("sha256").update(JSON.stringify(migration)).digest("hex"),
          now,
        ],
      })
    }
    for (const [key, value] of Object.entries({
      schema_version: String(version),
      store_id: randomUUID(),
      config_revision: "5",
      history_activity_generation: "2",
      ...(version < 3 ? { history_debug_generation: "1" } : {}),
    }))
      await session.execute({
        sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
        args: [key, value],
      })
    await session.execute({
      sql: "INSERT INTO capi_accounts(id,domain,upstream_user_id,login,created_at,updated_at) VALUES(1,'github.com','123','fixture',1,1)",
      args: [],
    })
    if (version >= 4)
      await session.execute({
        sql: "UPDATE capi_accounts SET integration_id='fixture-integration' WHERE id=1",
        args: [],
      })
    await session.execute({
      sql: "INSERT INTO capi_account_credentials(account_id,oauth_value,updated_at) VALUES(1,'fixture-oauth',1)",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app','{\"smallModel\":\"fixture-model\"}',2)",
      args: [],
    })
    await session.execute({
      sql: "UPDATE capi_usage_lifetime SET input_tokens=7,output_tokens=11,request_count=2,first_request_at=1 WHERE id=1",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(60000,'fixture-model',7,11,2)",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_routing_minutes(minute,dimension_key,payload_json) VALUES(60000,'aggregate','{\"requests\":2}')",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_activity(id,generation,created_at,expires_at,kind,payload_json,payload_bytes) VALUES('removed',2,?,?, 'info','{\"message\":\"obsolete fixture\"}',30)",
      args: [now, now + 10000],
    })
    if (version < 3)
      await session.execute({
        sql: "INSERT INTO capi_debug(id,generation,created_at,updated_at,expires_at,status,replayable,payload_json,payload_bytes) VALUES('keep-debug',1,?,?,?,'complete',1,?,100)",
        args: [
          now,
          now,
          now + 600000,
          JSON.stringify({
            status: "complete",
            request: { body: "raw request fixture" },
            response: { body: "raw response fixture" },
          }),
        ],
      })
    await session.execute({
      sql: "INSERT INTO capi_collection_gaps(id,started_at,kind,lost_records,lost_bytes,payload_json) VALUES('remove-gap',1,'known',3,30,'{\"historyKind\":\"activity\"}'),('keep-gap',1,'known',2,20,'{\"historyKind\":\"usage\"}')",
      args: [],
    })
  })
}

async function legacyBackup(
  storage: Storage,
  version: number,
): Promise<Uint8Array> {
  const records: Array<TransferRecord> = []
  await storage.read(async (session) => {
    for (const table of transferTablesForSchema(version)) {
      const columns = transferColumns(table, version).map(
        (column) => column.name,
      )

      const rows = await session.query({
        sql: `SELECT ${columns.join(",")} FROM ${table}`,
        args: [],
      })
      const entries = rows.map((row) => ({
        table,
        key: transferKey(table, row, version),
        value: row as TransferRecord["value"],
      }))
      entries.sort((a, b) =>
        Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)),
      )
      records.push(...entries)
    }
  })
  const digest = createHash("sha256")
  const counts: Record<string, number> = {}
  const frames = records.map((record, seq) => {
    counts[record.table] = (counts[record.table] ?? 0) + 1
    const frame = `${JSON.stringify({ kind: "record", seq, record })}\n`
    digest.update(frame)
    return frame
  })
  const store = records.find(
    (record) =>
      record.table === "capi_metadata"
      && (record.value as { key: string }).key === "store_id",
  )?.value as { value: string }
  frames.push(
    `${JSON.stringify({ kind: "manifest", seq: frames.length, manifest: { formatVersion: 1, schemaVersion: version, sourceStoreId: store.value, recordCounts: counts, recordsSha256: digest.digest("hex") } })}\n`,
  )
  const header = Buffer.concat([
    BACKUP_MAGIC,
    Buffer.from([BACKUP_VERSION]),
    randomBytes(16),
    randomBytes(12),
  ])
  const key = await deriveBackupKey(
    "fixture-password",
    header.subarray(BACKUP_MAGIC.length + 1, BACKUP_MAGIC.length + 17),
  )
  const cipher = createCipheriv("aes-256-gcm", key, header.subarray(-12))
  cipher.setAAD(header)
  key.fill(0)
  return Buffer.concat([
    header,
    cipher.update(frames.join("")),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}

async function assertRetained(
  storage: Storage,
  version: number,
): Promise<void> {
  await storage.read(async (session) => {
    expect(
      await session.query({
        sql: "SELECT name FROM sqlite_master WHERE name LIKE 'capi_activity%'",
        args: [],
      }),
    ).toEqual([])
    expect(
      await session.query({
        sql: "SELECT key FROM capi_metadata WHERE key LIKE 'history_activity%'",
        args: [],
      }),
    ).toEqual([])
    expect(
      await session.query({
        sql: "SELECT value FROM capi_metadata WHERE key='schema_version'",
        args: [],
      }),
    ).toEqual([{ value: String(currentSchemaVersion) }])
    expect(
      await session.query({
        sql: "SELECT a.id,a.integration_id,c.oauth_value FROM capi_accounts a JOIN capi_account_credentials c ON c.account_id=a.id",
        args: [],
      }),
    ).toEqual([
      {
        id: 1,
        integration_id: version < 4 ? null : "fixture-integration",
        oauth_value: "fixture-oauth",
      },
    ])
    expect(
      await session.query({
        sql: "SELECT input_tokens,output_tokens,request_count FROM capi_usage_lifetime",
        args: [],
      }),
    ).toEqual([{ input_tokens: 7, output_tokens: 11, request_count: 2 }])
    expect(
      await session.query({
        sql: "SELECT request_count FROM capi_usage_minutes",
        args: [],
      }),
    ).toEqual([{ request_count: 2 }])
    expect(
      await session.query({
        sql: "SELECT payload_json FROM capi_routing_minutes",
        args: [],
      }),
    ).toEqual([{ payload_json: '{"requests":2}' }])
    expect(
      await session.query({
        sql: "SELECT value_json FROM capi_settings",
        args: [],
      }),
    ).toEqual([{ value_json: '{"smallModel":"fixture-model"}' }])
    expect(
      await session.query({
        sql: "SELECT id,lost_records FROM capi_collection_gaps",
        args: [],
      }),
    ).toEqual([{ id: "keep-gap", lost_records: 2 }])
    expect(
      await session.query({
        sql: "SELECT name FROM sqlite_master WHERE name LIKE 'capi_debug%'",
        args: [],
      }),
    ).toEqual([])
  })
}

test.each([2, 3, 4])(
  "migration removes Activity from populated schema %d and preserves retained state",
  async (version) => {
    const fixture = await createSchemaFixture()
    try {
      await seedLegacy(fixture.storage, version)
      const before = await fixture.storage.read((session) =>
        session.query({
          sql: "SELECT checksum FROM capi_schema_migrations ORDER BY version",
          args: [],
        }),
      )
      await migrateStorage(fixture.storage)
      await assertRetained(fixture.storage, version)
      const after = await fixture.storage.read((session) =>
        session.query({
          sql: "SELECT checksum FROM capi_schema_migrations WHERE version <= ? ORDER BY version",
          args: [version],
        }),
      )
      expect(after).toEqual(before)
      await migrateStorage(fixture.storage)
    } finally {
      await fixture.close()
    }
  },
)

test.each([2, 3, 4])(
  "encrypted schema %d backup validates discarded Activity and restores every retained table",
  async (version) => {
    const fixture = await createSchemaFixture()
    try {
      await seedLegacy(fixture.storage, version)
      const bytes = await legacyBackup(fixture.storage, version)
      await withTransferStorage(async (target) => {
        expect(
          (await restoreBackup(bytesStream(bytes), "fixture-password", target))
            .phase,
        ).toBe("complete")
        await migrateStorage(target)
        await assertRetained(target, version)
      })
    } finally {
      await fixture.close()
    }
  },
)

test("dashboard navigation, screen registry, API mount, and logger no longer expose Activity", async () => {
  for (const [file, pattern] of [
    ["ui/src/Shell.tsx", /section: "activity"/],
    ["ui/src/screens/registry.tsx", /ActivityScreen|activity:/],
    ["src/routes/dashboard/route.ts", /dashboardActivityRoutes/],
    [
      "src/lib/logger.ts",
      /peekHistoryRuntime|writer\.enqueue|recordGatewayLifecycle/,
    ],
    ["src/lib/request-logger.ts", /recordHttpActivity|recordRequestActivity/],
  ] as const)
    expect(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8"),
    ).not.toMatch(pattern)
  expect(Object.hasOwn(schemaThreeTables, "capi_activity")).toBe(true)
})
