import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { createBackupStream } from "../src/lib/config-backup"
import { createCredentialsRepository } from "../src/lib/storage/credentials-repository"
import { createHistoryRepository } from "../src/lib/storage/history-repository"
import {
  applyLegacyImport,
  previewLegacyImport,
} from "../src/lib/storage/legacy-import"
import { restoreBackup } from "../src/lib/storage/restore"
import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex")

test("backup preserves optional routing lifetime and first collection timestamp", async () => {
  await withTransferStorage(async (source) => {
    const lifetime = JSON.stringify({ requests: 23, fallbackRequests: 4 })
    await source.atomicBatch([
      {
        sql: "INSERT INTO capi_metadata(key,value) VALUES('history_routing_lifetime',?)",
        args: [lifetime],
      },
      {
        sql: "INSERT INTO capi_metadata(key,value) VALUES('history_routing_started_at','123456')",
        args: [],
      },
    ])
    const before = await createHistoryRepository(source).readRouting(0)
    expect(before).toEqual({
      buckets: [],
      lifetime: { requests: 23, fallbackRequests: 4 },
      startedAt: 123456,
    })
    const backup = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      expect(
        (await restoreBackup(bytesStream(backup), "fixture-password", target))
          .phase,
      ).toBe("complete")
      expect(await createHistoryRepository(target).readRouting(0)).toEqual(
        before,
      )
    })
  })
})

test("explicit legacy env imports inference-only digests with stable principals and managed precedence", async () => {
  await withTransferStorage(async (target, directory) => {
    const raw = "fixture-inference",
      managedRaw = "fixture-managed",
      disabledRaw = "fixture-disabled"
    const managedId = "11111111-1111-4111-8111-111111111111",
      disabledId = "22222222-2222-4222-8222-222222222222"
    await fs.writeFile(
      path.join(directory, "trusted_jwt_digests.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: managedId,
            digest: digest(managedRaw),
            label: "Managed",
            enabled: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: disabledId,
            digest: digest(disabledRaw),
            label: "Disabled",
            enabled: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    )
    const input = {
      directory,
      includeEnvironment: true,
      environment: {
        COPILOT_INFERENCE_CREDENTIAL_SHA256S: ` ${digest(raw).toUpperCase()} ,${digest(raw)}, ${digest(managedRaw)}, ${digest(disabledRaw)} `,
      },
    }
    await applyLegacyImport(
      input,
      await previewLegacyImport(input, target),
      target,
    )
    const repository = createCredentialsRepository(target)
    expect(await repository.inference(raw)).toEqual({
      principalId: `inference-env:${digest(raw).slice(0, 16)}`,
      scopes: ["user:inference"],
    })
    expect(await repository.gateway(raw)).toBeNull()
    expect(await repository.inference(managedRaw)).toEqual({
      principalId: `inference-managed:${managedId}`,
      scopes: ["user:inference"],
    })
    expect(await repository.inference(disabledRaw)).toBeNull()
    expect(
      await target.read((session) =>
        session.query({
          sql: "SELECT COUNT(*) AS count FROM capi_inference_credentials",
          args: [],
        }),
      ),
    ).toEqual([{ count: 3 }])
  })
})

test("selected startup gateway key overrides stale JSON keys and JSON fallback trims duplicates", async () => {
  for (const includeEnvironment of [false, true]) {
    await withTransferStorage(async (target, directory) => {
      await fs.writeFile(
        path.join(directory, "config.json"),
        JSON.stringify({
          auth: { apiKeys: ["  fixture-json-key  ", "fixture-json-key", " "] },
        }),
      )
      const input = {
        directory,
        includeEnvironment,
        environment: { COPILOT_API_KEY_AUTH: " fixture-startup-key " },
      }
      await applyLegacyImport(
        input,
        await previewLegacyImport(input, target),
        target,
      )
      const repository = createCredentialsRepository(target)
      expect(Boolean(await repository.gateway("fixture-startup-key"))).toBe(
        includeEnvironment,
      )
      expect(Boolean(await repository.gateway("fixture-json-key"))).toBe(
        !includeEnvironment,
      )
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT COUNT(*) AS count FROM capi_gateway_credentials",
            args: [],
          }),
        ),
      ).toEqual([{ count: 1 }])
    })
  }
})

test("manifest binds selected legacy credential environment and ignores unselected environment", async () => {
  await withTransferStorage(async (target, directory) => {
    const first = {
      COPILOT_API_KEY_AUTH: "first-gateway",
      COPILOT_INFERENCE_CREDENTIAL_SHA256S: digest("first-inference"),
    }
    const second = {
      COPILOT_API_KEY_AUTH: "second-gateway",
      COPILOT_INFERENCE_CREDENTIAL_SHA256S: digest("second-inference"),
    }
    const preview = (includeEnvironment: boolean, environment: typeof first) =>
      previewLegacyImport(
        { directory, includeEnvironment, environment },
        target,
      )
    expect((await preview(false, first)).sourceDigest).toBe(
      (await preview(false, second)).sourceDigest,
    )
    const selected = await preview(true, first)
    expect(selected.sourceDigest).not.toBe(
      (
        await preview(true, {
          ...first,
          COPILOT_INFERENCE_CREDENTIAL_SHA256S:
            second.COPILOT_INFERENCE_CREDENTIAL_SHA256S,
        })
      ).sourceDigest,
    )
    expect(selected.sourceDigest).not.toBe(
      (
        await preview(true, {
          ...first,
          COPILOT_API_KEY_AUTH: second.COPILOT_API_KEY_AUTH,
        })
      ).sourceDigest,
    )
  })
})
