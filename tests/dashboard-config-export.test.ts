import { expect, test } from "bun:test"
import { unzipSync } from "fflate"
import { Hono } from "hono"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createConfigExportZip,
  getConfigExportFilename,
} from "../src/lib/config-export"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import { createExportSettingsHandler } from "../src/routes/dashboard/settings-export"
import { server } from "../src/server"

const textDecoder = new TextDecoder()

async function withTempDir<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-export-"))
  try {
    return await callback(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function decodeEntry(entry: Uint8Array): string {
  return textDecoder.decode(entry)
}

test("config export zips only app config files that exist", async () => {
  await withTempDir(async (directory) => {
    await fs.mkdir(path.join(directory, "logs"))
    await fs.writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({ customProviders: [{ apiKey: "secret" }] }),
    )
    await fs.writeFile(
      path.join(directory, "statsig_overrides.json"),
      '{"featureGates":{},"dynamicConfigs":{}}\n',
    )
    await fs.writeFile(path.join(directory, "model_settings.json"), "[]\n")
    await fs.writeFile(
      path.join(directory, "model_fallbacks.json"),
      JSON.stringify({ enabled: true, rules: [] }),
    )
    await fs.writeFile(path.join(directory, "ip_allowlist.json"), "[]\n")
    const trustedJwtSentinel =
      "trusted-jwt-export-sentinel-86bb7cf9be3a4d8bbadad2579d959fad"
    await fs.writeFile(
      path.join(directory, "trusted_jwt_digests.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "4ca1053b-ee40-48b8-9180-40bfe56ba825",
            label: trustedJwtSentinel,
            digest:
              "d934d4e72ee1f3a3cff8eac158c6640d604e1e29ec82cdbfd795b250058e5c94",
            enabled: true,
            createdAt: "2026-08-29T00:00:00.000Z",
            updatedAt: "2026-08-29T00:00:00.000Z",
          },
        ],
      }),
    )
    await fs.writeFile(path.join(directory, "usage.json"), '{"records":[]}\n')
    await fs.writeFile(path.join(directory, "github_token"), "ghu_secret")
    await fs.writeFile(path.join(directory, "logs", "messages.log"), "skip")

    const archive = await createConfigExportZip({
      appDir: directory,
      now: new Date(2026, 4, 31, 18, 7),
    })
    const entries = unzipSync(archive.zip)

    expect(archive.filename).toBe("copilot-api-config-31-05-2026-18-07.zip")
    expect(Object.keys(entries).sort()).toEqual([
      "config.json",
      "ip_allowlist.json",
      "model_fallbacks.json",
      "model_settings.json",
      "statsig_overrides.json",
    ])
    expect(decodeEntry(entries["config.json"])).not.toContain('"secret"')
    expect(decodeEntry(entries["config.json"])).toContain("[REDACTED]")
    expect(decodeEntry(entries["statsig_overrides.json"])).toContain(
      '"featureGates"',
    )
    expect(entries["usage.json"]).toBeUndefined()
    expect(entries["trusted_jwt_digests.json"]).toBeUndefined()
    expect(entries["github_token"]).toBeUndefined()
    expect(entries["logs/messages.log"]).toBeUndefined()
    expect(
      Object.values(entries).some((entry) =>
        decodeEntry(entry).includes(trustedJwtSentinel),
      ),
    ).toBe(false)
    expect(
      Object.values(entries).some((entry) =>
        decodeEntry(entry).includes(
          "d934d4e72ee1f3a3cff8eac158c6640d604e1e29ec82cdbfd795b250058e5c94",
        ),
      ),
    ).toBe(false)
  })
})

test("config export filename uses zero-padded local date parts", () => {
  expect(getConfigExportFilename(new Date(2026, 0, 2, 3, 4))).toBe(
    "copilot-api-config-02-01-2026-03-04.zip",
  )
})

test("dashboard config export endpoint is authenticated and returns a zip", async () => {
  const unauthorizedResponse = await server.request(
    "/dashboard/api/settings/export",
  )
  expect(unauthorizedResponse.status).toBe(401)

  await withTempDir(async (directory) => {
    const app = new Hono()
    app.get(
      "/settings/export",
      createExportSettingsHandler(() =>
        createConfigExportZip({ appDir: directory }),
      ),
    )
    const response = await app.request("/settings/export")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/zip")
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="copilot-api-config-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.zip"$/,
    )
    const zipBytes = new Uint8Array(await response.arrayBuffer())
    expect(() => unzipSync(zipBytes)).not.toThrow()
  })
})

test("dashboard bundle ships the config export controls", () => {
  expect(DASHBOARD_HTML).toContain("Export sanitized config")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/settings/export")
})
