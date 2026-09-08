import { expect, test } from "bun:test"
import { unzipSync } from "fflate"
import { Hono } from "hono"

import {
  createConfigExportZip,
  getConfigExportFilename,
} from "../src/lib/config-export"
import { createExportSettingsHandler } from "../src/routes/dashboard/settings-export"
import {
  settingsFixture,
  withTransferStorage,
} from "./helpers/transfer-storage"
test("config ZIP reads committed settings and redacts secrets", async () => {
  await withTransferStorage(async (storage) => {
    await settingsFixture(storage, {
      smallModel: "fixture-model",
      authorization: "fixture-upstream-secret",
    })
    await storage.atomicBatch([
      {
        sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('model_fallbacks','{\"enabled\":true,\"rules\":[]}',1)",
        args: [],
      },
    ])
    const archive = await createConfigExportZip({
      storage,
      now: new Date(2026, 4, 31, 18, 7),
    })
    const entries = unzipSync(archive.zip)
    expect(archive.filename).toBe("copilot-api-config-31-05-2026-18-07.zip")
    expect(Object.keys(entries).sort()).toEqual([
      "accounts.json",
      "config.json",
      "feature_flags.json",
      "ip_allowlist.json",
      "manifest.json",
      "model_fallbacks.json",
      "model_redirects.json",
      "model_routing.json",
      "model_settings.json",
      "replacements.json",
      "statsig_overrides.json",
    ])
    const text = Object.values(entries)
      .map((entry) => new TextDecoder().decode(entry))
      .join("\n")
    expect(text).not.toContain("fixture-upstream-secret")
    expect(text).toContain("[REDACTED]")
    expect(entries["oauth_tokens.json"]).toBeUndefined()
  })
})
test("export keeps attachment filename and disables caching", async () => {
  await withTransferStorage(async (storage) => {
    const app = new Hono()
    app.get(
      "/export",
      createExportSettingsHandler(() => createConfigExportZip({ storage })),
    )
    const response = await app.request("/export")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-type")).toBe("application/zip")
    expect(response.headers.get("content-disposition")).toMatch(
      /copilot-api-config-.*\.zip/,
    )
    expect(
      Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer()))),
    ).toContain("manifest.json")
  })
})
test("export filename zero pads local date components", () => {
  expect(getConfigExportFilename(new Date(2026, 0, 2, 3, 4))).toBe(
    "copilot-api-config-02-01-2026-03-04.zip",
  )
})
