import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  JsonValue,
  MutationContext,
  SettingsNamespace,
  Storage,
} from "~/lib/storage/types"

import { createStorage } from "~/lib/storage/client"
import {
  StorageCommitUnknownError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { migrateStorage } from "~/lib/storage/migrations"
import { settingsInputDigest } from "~/lib/storage/settings-repository"

export async function createSettingsStorage() {
  const directory = await mkdtemp(join(tmpdir(), "capi-settings-"))
  const storage = createStorage({
    kind: "sqlite",
    path: join(directory, "copilot-api.sqlite"),
  })
  await migrateStorage(storage)
  return {
    storage,
    async close() {
      await storage.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

// eslint-disable-next-line max-params -- Mirrors a settings mutation plus optional replay ID.
export function settingsContext(
  namespace: SettingsNamespace,
  value: JsonValue,
  expectedRevision: number,
  operationId = crypto.randomUUID(),
): MutationContext {
  return {
    operationId,
    expectedRevision,
    actorId: "test-owner",
    kind: "settings.replace",
    inputDigest: settingsInputDigest(namespace, value),
  }
}

export function failTransaction(storage: Storage): Storage {
  return {
    read: (work) => storage.read(work),
    transaction: (work) =>
      storage.transaction(async (session) => {
        await work(session)
        throw new Error("commit failed")
      }),
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: () => storage.close(),
  }
}

/** Lose only the transport acknowledgement, after SQLite actually commits. */
export function loseCommitResponse(
  storage: Storage,
  reconciliationUnavailable = false,
): Storage {
  let loseNext = true
  return {
    read: (work) =>
      reconciliationUnavailable ?
        Promise.reject(new StorageUnavailableError())
      : storage.read(work),
    async transaction(work) {
      const result = await storage.transaction(work)
      if (loseNext) {
        loseNext = false
        throw new StorageCommitUnknownError()
      }
      return result
    },
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: () => storage.close(),
  }
}
