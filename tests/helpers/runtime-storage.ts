import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Storage } from "~/lib/storage/types"

import { createStorage } from "~/lib/storage/client"
import {
  StorageCommitUnknownError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { closeStorageRuntime } from "~/lib/storage/runtime"

export async function createRuntimeStorage() {
  const directory = await mkdtemp(join(tmpdir(), "capi-runtime-"))
  const config = {
    kind: "sqlite" as const,
    path: join(directory, "copilot-api.sqlite"),
  }
  const underlying = createStorage(config)
  let failCommit = false
  let loseCommit = false
  let readsUnavailable = false
  let holdRead: { entered: () => void; released: Promise<void> } | undefined
  const storage: Storage = {
    async read(work) {
      if (readsUnavailable) throw new StorageUnavailableError()
      if (holdRead) {
        const hold = holdRead
        holdRead = undefined
        hold.entered()
        await hold.released
      }
      return underlying.read(work)
    },
    async transaction(work) {
      const result = await underlying.transaction(async (session) => {
        const value = await work(session)
        if (failCommit) throw new Error("injected commit failure")
        return value
      })
      if (loseCommit) {
        loseCommit = false
        readsUnavailable = true
        throw new StorageCommitUnknownError()
      }
      return result
    },
    atomicBatch: (statements) => underlying.atomicBatch(statements),
    close: () => underlying.close(),
  }
  return {
    directory,
    config,
    storage,
    failCommits: () => {
      failCommit = true
    },
    loseNextCommitResponse: () => {
      loseCommit = true
    },
    restoreReads: () => {
      readsUnavailable = false
    },
    holdNextRead() {
      const entered = Promise.withResolvers<undefined>()
      const released = Promise.withResolvers<undefined>()
      holdRead = {
        entered: () => entered.resolve(undefined),
        released: released.promise,
      }
      return {
        entered: entered.promise,
        release: () => released.resolve(undefined),
      }
    },
    async close() {
      await closeStorageRuntime()
      await underlying.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
