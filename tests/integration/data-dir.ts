import { mkdirSync, mkdtempSync } from "node:fs"
import { join, resolve } from "node:path"

export const integrationDataRoot = resolve(
  import.meta.dir,
  "../../.superpowers/test-data/integration",
)
mkdirSync(integrationDataRoot, { recursive: true })
export const integrationDataDirectory = mkdtempSync(
  join(integrationDataRoot, "suite-"),
)
// This synchronous preload must run before application modules resolve paths.
process.env.DATA_DIR = integrationDataDirectory
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN
