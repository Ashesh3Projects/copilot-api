import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { resolve, join, sep } from "node:path"

import type { Storage } from "~/lib/storage/types"

import {
  StorageCommitUnknownError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import {
  closeStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"

const root = resolve(import.meta.dir, "../../.superpowers/test-data/auth")

export async function createAuthStorageFixture() {
  await closeStorageRuntime()
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, "store-"))
  const config = {
    kind: "sqlite" as const,
    path: join(directory, "copilot-api.sqlite"),
  }
  let underlying = new LocalSqliteStorage(config.path)
  let failReads = false,
    failWrites = false
  let loseCommit = false
  let failReconciliation = false
  let nextTransaction: ((connection: Storage) => Promise<void>) | undefined
  const storage: Storage = {
    read: (work) => {
      if (failReads) return Promise.reject(new StorageUnavailableError())
      return underlying.read(work)
    },
    transaction: async (work) => {
      const before = nextTransaction
      nextTransaction = undefined
      if (before) await before(underlying)
      const value = await underlying.transaction(async (session) => {
        const result = await work(session)
        if (failWrites) throw new StorageUnavailableError()
        return result
      })
      if (loseCommit) {
        loseCommit = false
        failReads = failReconciliation
        throw new StorageCommitUnknownError()
      }
      return value
    },
    atomicBatch: (statements) => underlying.atomicBatch(statements),
    close: () => underlying.close(),
  }
  await initializeStorageRuntime({ storage, config })
  return {
    storage,
    config,
    failReads(value = true) {
      failReads = value
    },
    failWrites(value = true) {
      failWrites = value
    },
    loseNextCommitResponse(options: { failReads?: boolean } = {}) {
      loseCommit = true
      failReconciliation = options.failReads ?? false
    },
    beforeNextTransaction(work: (connection: Storage) => Promise<void>) {
      nextTransaction = work
    },
    async restart() {
      await closeStorageRuntime()
      underlying = new LocalSqliteStorage(config.path)
      await initializeStorageRuntime({ storage, config })
    },
    async close() {
      await closeStorageRuntime()
      await underlying.close()
      const checked = resolve(directory)
      if (!checked.startsWith(`${root}${sep}`))
        throw new Error("Unsafe auth test cleanup path")
      await rm(checked, { recursive: true, force: true })
    },
  }
}
