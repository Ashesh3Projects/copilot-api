import { zipSync } from "fflate"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"

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

export interface ConfigExportOptions {
  appDir?: string
  now?: Date
}

export interface ConfigExportArchive {
  filename: string
  zip: Uint8Array<ArrayBuffer>
}

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

function sanitizeExportFile(filename: string, data: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(data)
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

function padDatePart(value: number): string {
  return String(value).padStart(2, "0")
}

export function formatConfigExportTimestamp(date: Date): string {
  return [
    padDatePart(date.getDate()),
    padDatePart(date.getMonth() + 1),
    String(date.getFullYear()),
    padDatePart(date.getHours()),
    padDatePart(date.getMinutes()),
  ].join("-")
}

export function getConfigExportFilename(date = new Date()): string {
  return `copilot-api-config-${formatConfigExportTimestamp(date)}.zip`
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  )
}

export async function createConfigExportZip(
  options: ConfigExportOptions = {},
): Promise<ConfigExportArchive> {
  const appDir = options.appDir ?? PATHS.APP_DIR
  const files: Record<string, Uint8Array> = {}

  for (const filename of CONFIG_EXPORT_FILENAMES) {
    try {
      const data = await fs.readFile(path.join(appDir, filename))
      files[filename] = sanitizeExportFile(filename, data)
    } catch (error) {
      if (isMissingFileError(error)) continue
      throw error
    }
  }

  const zip = zipSync(files)
  return { filename: getConfigExportFilename(options.now), zip }
}
