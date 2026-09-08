import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SqlSession, Storage } from "~/lib/storage/types"

import { createStorage } from "~/lib/storage/client"

export async function createSchemaFixture() {
  const directory = await mkdtemp(join(tmpdir(), "capi-schema-"))
  const path = join(directory, "copilot-api.sqlite")
  const storage = createStorage({ kind: "sqlite", path })
  return {
    storage,
    path,
    async close() {
      await storage.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export function faultStorage(
  storage: Storage,
  faults: {
    beforeCommit?: (session: SqlSession) => Promise<void> | void
    afterCommit?: () => void
    beforeRead?: () => void
  },
): Storage {
  return {
    read: async (work) => {
      faults.beforeRead?.()
      return storage.read(work)
    },
    transaction: async (work) => {
      const value = await storage.transaction(async (session) => {
        const result = await work(session)
        await faults.beforeCommit?.(session)
        return result
      })
      faults.afterCommit?.()
      return value
    },
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: () => storage.close(),
  }
}
