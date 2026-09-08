import type { Storage } from "~/lib/storage/types"

import { validateModelFallbackConfig } from "~/lib/model-fallback-config"
import { withTransferSnapshot } from "~/lib/storage/transfer-records"
import { validateTransferSetting } from "~/lib/storage/transfer-validation"
import { getDefaultFeatureFlags } from "~/routes/feature-flags/store"

export const CONFIG_EXPORT_FILENAMES = [
  "config.json",
  "feature_flags.json",
  "statsig_overrides.json",
  "model_redirects.json",
  "model_settings.json",
  "model_routing.json",
  "model_fallbacks.json",
  "replacements.json",
  "ip_allowlist.json",
] as const

const SENSITIVE_KEY_PATTERN =
  /api[_-]?key|authorization|cookie|password|secret|token|credential/i

function sanitizeValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]"
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item))
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      output[nestedKey] = sanitizeValue(nestedValue, nestedKey)
    }
    return output
  }
  return value
}

function sanitizeExportFile(filename: string, text: string): Uint8Array {
  try {
    const sanitized = sanitizeValue(JSON.parse(text) as unknown)
    return new TextEncoder().encode(`${JSON.stringify(sanitized, null, 2)}\n`)
  } catch {
    // Non-JSON configuration is not expected, but do not export an unparsed
    // file because it could contain a secret with no reliable redaction path.
    throw new Error(
      `Refusing to export invalid JSON configuration: ${filename}`,
    )
  }
}

/* eslint-disable max-lines-per-function, require-atomic-updates -- One private export is assembled sequentially within one read snapshot. */
export async function readSanitizedConfigExportFiles(
  storage: Storage,
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  await withTransferSnapshot(storage, async (session) => {
    const metadata = await session.query({
      sql: "SELECT key,value FROM capi_metadata WHERE key IN ('store_id','schema_version','config_revision','transfer_incomplete')",
      args: [],
    })
    const values = new Map(metadata.map((row) => [row.key, row.value]))
    if (values.has("transfer_incomplete"))
      throw new Error("Cannot export an incomplete transfer")
    const settings = await session.query({
      sql: "SELECT namespace,value_json FROM capi_settings ORDER BY namespace",
      args: [],
    })
    for (const row of settings) {
      const filename =
        row.namespace === "app" ?
          "config.json"
        : `${String(row.namespace)}.json`
      if (
        !(CONFIG_EXPORT_FILENAMES as ReadonlyArray<string>).includes(filename)
        || typeof row.value_json !== "string"
      )
        throw new Error("Invalid stored configuration")
      let value: unknown = JSON.parse(row.value_json)
      if (row.namespace === "app") {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid app configuration")
        const app = value as Record<string, unknown>
        delete app.auth
        delete app.customProviders
        delete app.groqApiKey
        value = app
      }
      validateTransferSetting(String(row.namespace), value)
      files[filename] = sanitizeExportFile(filename, JSON.stringify(value))
    }
    const providers = await session.query({
      sql: "SELECT id,name,enabled,payload_json FROM capi_providers WHERE deleted_at IS NULL ORDER BY id",
      args: [],
    })
    if (providers.length > 0) {
      const sanitized = providers.map((row) => {
        const parsed: unknown = JSON.parse(String(row.payload_json))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Invalid provider metadata")
        const value = parsed as Record<string, unknown>
        const baseUrl = new URL(String(value.baseUrl))
        baseUrl.username = ""
        baseUrl.password = ""
        baseUrl.search = ""
        baseUrl.hash = ""
        return {
          id: row.id,
          name: row.name,
          enabled: row.enabled === 1,
          type: value.type,
          baseUrl: baseUrl.href,
          models: value.models,
          passReasoningEffort: value.passReasoningEffort,
        }
      })
      const app =
        Object.hasOwn(files, "config.json") ?
          (JSON.parse(new TextDecoder().decode(files["config.json"])) as Record<
            string,
            unknown
          >)
        : {}
      files["config.json"] = sanitizeExportFile(
        "config.json",
        JSON.stringify({ ...app, customProviders: sanitized }),
      )
    }
    const ips = await session.query({
      sql: "SELECT ip,enabled,source,created_at,updated_at,last_seen_at FROM capi_ip_allowlist ORDER BY ip",
      args: [],
    })
    files["ip_allowlist.json"] = sanitizeExportFile(
      "ip_allowlist.json",
      JSON.stringify(
        ips.map((row) => ({
          ip: row.ip,
          enabled: row.enabled === 1,
          source: row.source,
          createdAt: new Date(Number(row.created_at)).toISOString(),
          updatedAt: new Date(Number(row.updated_at)).toISOString(),
          ...(row.last_seen_at !== null ?
            { lastSeenAt: new Date(Number(row.last_seen_at)).toISOString() }
          : {}),
        })),
      ),
    )
    const accounts = await session.query({
      sql: "SELECT id,domain,login,label,enabled,deleted_at FROM capi_accounts ORDER BY id",
      args: [],
    })
    files["accounts.json"] = sanitizeExportFile(
      "accounts.json",
      JSON.stringify(
        accounts.map((row) => ({
          id: row.id,
          instanceDomain: row.domain,
          login: row.login,
          label: row.label,
          enabled: row.enabled === 1,
          removed: row.deleted_at !== null,
        })),
      ),
    )
    files["manifest.json"] = sanitizeExportFile(
      "manifest.json",
      JSON.stringify({
        formatVersion: 1,
        schemaVersion: Number(values.get("schema_version")),
        sourceStoreId: values.get("store_id"),
        revision: Number(values.get("config_revision")),
        sanitized: true,
        credentialComplete: false,
      }),
    )
  })

  const emptyFiles: Record<string, unknown> = {
    "config.json": {},
    "feature_flags.json": getDefaultFeatureFlags(),
    "statsig_overrides.json": { featureGates: {}, dynamicConfigs: {} },
    "model_redirects.json": [],
    "model_settings.json": [],
    "model_routing.json": {},
    "model_fallbacks.json": validateModelFallbackConfig({}),
    "replacements.json": [],
  }
  for (const [filename, value] of Object.entries(emptyFiles))
    if (!Object.hasOwn(files, filename))
      files[filename] = sanitizeExportFile(filename, JSON.stringify(value))

  return files
}
