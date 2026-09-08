import { afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join, resolve, sep } from "node:path"

// Synchronous side-effect preload: source imports must never see the user's data directory.
const root = resolve(import.meta.dir, "../../.superpowers/test-data/auth-misc")
mkdirSync(root, { recursive: true })
const directory = mkdtempSync(join(root, "suite-"))
process.env.DATA_DIR = directory
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN

afterAll(() => {
  const checked = resolve(directory)
  if (!checked.startsWith(`${root}${sep}`))
    throw new Error("Unsafe auth misc fixture cleanup path")
  rmSync(checked, { recursive: true, force: true })
})
