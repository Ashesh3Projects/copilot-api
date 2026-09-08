import { zipSync } from "fflate"

import type { Storage } from "~/lib/storage/types"

import { readSanitizedConfigExportFiles } from "~/lib/storage/config-export-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"
export { CONFIG_EXPORT_FILENAMES } from "~/lib/storage/config-export-repository"

export interface ConfigExportOptions {
  storage?: Storage
  now?: Date
}

export interface ConfigExportArchive {
  filename: string
  zip: Uint8Array<ArrayBuffer>
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

export async function createConfigExportZip(
  options: ConfigExportOptions = {},
): Promise<ConfigExportArchive> {
  const files = await readSanitizedConfigExportFiles(
    options.storage ?? getStorageRuntime().storage,
  )
  const zip = zipSync(files)
  return { filename: getConfigExportFilename(options.now), zip }
}
