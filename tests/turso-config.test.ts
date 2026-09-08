/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async rejection matchers have void type declarations. */
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createStorage } from "~/lib/storage/client"
import { resolveStorageConfig } from "~/lib/storage/config"
import { StorageUnavailableError } from "~/lib/storage/errors"

import { createFakeTursoFetch } from "./helpers/turso-transport"

test.each([401, 403, 429, 503])(
  "remote failure %s never creates local DATA_DIR",
  async (status) => {
    const dir = mkdtempSync(join(tmpdir(), "capi-selection-"))
    const path = join(dir, "must-not-exist")
    const remote = createFakeTursoFetch({ status })
    try {
      const storage = createStorage(
        resolveStorageConfig({
          DATA_DIR: path,
          TURSO_DATABASE_URL: "turso://unit.example",
          TURSO_AUTH_TOKEN: "test-only",
        }),
      )
      await expect(
        storage.read((s) => s.query({ sql: "SELECT 1", args: [] })),
      ).rejects.toBeInstanceOf(StorageUnavailableError)
      expect(existsSync(path)).toBe(false)
      await storage.close()
    } finally {
      remote.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
