import { expect, test } from "bun:test"
import { unzipSync } from "fflate"
import fs from "node:fs/promises"
import path from "node:path"

import type { Storage } from "../src/lib/storage/types"

import { createConfigExportZip } from "../src/lib/config-export"
import {
  settingsFixture,
  withTransferStorage,
} from "./helpers/transfer-storage"
test("one SQL export snapshot stays consistent across a concurrent edit and ignores source files", async () => {
  await withTransferStorage(async (source, directory) => {
    await settingsFixture(source, { smallModel: "before" })
    await fs.writeFile(
      path.join(directory, "config.json"),
      '{"smallModel":"disk-sentinel"}',
    )
    let edited = false
    const storage: Storage = {
      read: (work) => source.read(work),
      transaction: (work) => source.transaction(work),
      atomicBatch: (statements) => source.atomicBatch(statements),
      close: () => Promise.resolve(),
      readSnapshot: (work, options) => {
        if (!source.readSnapshot) throw new Error("snapshot required")
        return source.readSnapshot(
          (session) =>
            work({
              execute: (statement) => session.execute(statement),
              query: async (statement) => {
                const result = await session.query(statement)
                if (!edited) {
                  edited = true
                  await source.atomicBatch([
                    {
                      sql: 'UPDATE capi_settings SET value_json=\'{"smallModel":"after"}\'',
                      args: [],
                    },
                    {
                      sql: "UPDATE capi_metadata SET value='2' WHERE key='config_revision'",
                      args: [],
                    },
                  ])
                }
                return result
              },
            }),
          options,
        )
      },
    }
    const entries = unzipSync((await createConfigExportZip({ storage })).zip)
    expect(new TextDecoder().decode(entries["config.json"])).toContain("before")
    expect(new TextDecoder().decode(entries["config.json"])).not.toContain(
      "disk-sentinel",
    )
    const manifest = JSON.parse(
      new TextDecoder().decode(entries["manifest.json"]),
    ) as { revision: number }
    expect(manifest.revision).toBe(0)
  })
})

test("cold-start exports retain every established filename without creating stored namespaces", async () => {
  await withTransferStorage(async (storage) => {
    await settingsFixture(storage, { smallModel: "cold-model" })
    const before = await storage.read((session) =>
      session.query({
        sql: "SELECT namespace,value_json,revision FROM capi_settings",
        args: [],
      }),
    )
    const entries = unzipSync((await createConfigExportZip({ storage })).zip)
    for (const name of [
      "config.json",
      "feature_flags.json",
      "statsig_overrides.json",
      "model_redirects.json",
      "model_settings.json",
      "model_routing.json",
      "model_fallbacks.json",
      "replacements.json",
      "ip_allowlist.json",
    ])
      expect(Object.hasOwn(entries, name)).toBe(true)
    expect(
      JSON.parse(new TextDecoder().decode(entries["statsig_overrides.json"])),
    ).toEqual({ featureGates: {}, dynamicConfigs: {} })
    expect(
      JSON.parse(new TextDecoder().decode(entries["model_fallbacks.json"])),
    ).toMatchObject({ enabled: false, rules: [] })
    expect(
      await storage.read((session) =>
        session.query({
          sql: "SELECT namespace,value_json,revision FROM capi_settings",
          args: [],
        }),
      ),
    ).toEqual(before)
  })
})

test("export defaults ignore an older ambient request snapshot", async () => {
  const { withRequestSnapshot } = await import(
    "../src/lib/storage/request-snapshot"
  )
  await withTransferStorage(async (storage) => {
    const archive = await withRequestSnapshot(
      {
        revision: 0,
        documents: new Map([
          [
            "feature_flags",
            {
              namespace: "feature_flags",
              value: { tengu_bridge_repl_v2: false },
              revision: 0,
            },
          ],
        ]),
      },
      () => createConfigExportZip({ storage }),
    )
    const entries = unzipSync(archive.zip)
    expect(
      JSON.parse(new TextDecoder().decode(entries["feature_flags.json"])),
    ).toMatchObject({ tengu_bridge_repl_v2: true })
  })
})
