/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matcher typings return void; await still orders rejection assertions. */
import { afterEach, describe, expect, test } from "bun:test"

import type { Storage } from "~/lib/storage/types"

import {
  StorageCommitUnknownError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import {
  createSettingsRepository,
  settingsInputDigest,
} from "~/lib/storage/settings-repository"
import {
  initializeSnapshot,
  replaceSnapshotDocument,
} from "~/lib/storage/snapshot"

import {
  createSettingsStorage,
  failTransaction,
  loseCommitResponse,
  settingsContext,
} from "./helpers/settings-storage"

const fixtures: Array<Awaited<ReturnType<typeof createSettingsStorage>>> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
async function fixture() {
  const result = await createSettingsStorage()
  fixtures.push(result)
  return result
}

describe("settings repository", () => {
  test("absent documents stay absent and saved settings survive a fresh repository", async () => {
    const { storage } = await fixture()
    const repository = createSettingsRepository(storage)
    expect(await repository.loadAll()).toEqual([])
    const value = { smallModel: "model-one" }
    const result = await repository.replace(
      "app",
      value,
      settingsContext("app", value, 0),
    )
    expect(result).toEqual({
      revision: 1,
      value: { namespace: "app", revision: 1, value },
    })
    value.smallModel = "caller-changed"
    const fresh = createSettingsRepository(storage)
    expect(await fresh.loadAll()).toEqual([
      { namespace: "app", revision: 1, value: { smallModel: "model-one" } },
    ])
  })

  test("unchanged and unrelated writes do not advance fallback content revision", async () => {
    const { storage } = await fixture()
    const repository = createSettingsRepository(storage)
    const value = { enabled: true, rules: [] }
    await repository.replace(
      "model_fallbacks",
      value,
      settingsContext("model_fallbacks", value, 0),
    )
    const reordered = { rules: [], enabled: true }
    await repository.replace(
      "model_fallbacks",
      reordered,
      settingsContext("model_fallbacks", reordered, 1),
    )
    await repository.replace("app", {}, settingsContext("app", {}, 2))
    const loaded = await repository.loadSnapshot()
    expect(loaded.revision).toBe(3)
    expect(loaded.documents.get("model_fallbacks")?.revision).toBe(1)
  })

  test("operation replay is input-bound and markers contain only safe metadata", async () => {
    const { storage } = await fixture()
    const repository = createSettingsRepository(storage)
    const value = { syntheticSecret: "fixture-private-value" }
    const context = settingsContext("app", value, 0)
    const committed = await repository.replace("app", value, context)
    expect(await repository.replace("app", value, context)).toEqual(committed)
    await expect(
      repository.replace("app", { changed: true }, context),
    ).rejects.toThrow()
    const rows = await storage.read((session) =>
      session.query({
        sql: "SELECT result_json FROM capi_applied_operations",
        args: [],
      }),
    )
    expect(rows).toEqual([
      { result_json: '{"namespace":"app","documentRevision":1}' },
    ])
  })

  test("malformed persisted values and validators fail closed", async () => {
    const { storage } = await fixture()
    await storage.atomicBatch([
      {
        sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES ('app','{broken',0)",
        args: [],
      },
    ])
    const repository = createSettingsRepository(storage)
    await expect(repository.loadAll()).rejects.toThrow()
    await storage.atomicBatch([
      { sql: "UPDATE capi_settings SET value_json='null'", args: [] },
    ])
    const validated = createSettingsRepository(storage, {
      validators: {
        app: (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("object required")
          return value
        },
      },
    })
    await expect(validated.loadAll()).rejects.toThrow()
    await expect(
      validated.replace("app", null, settingsContext("app", null, 0)),
    ).rejects.toThrow()
  })

  test("a failed commit preserves runtime and durable value/revision", async () => {
    const { storage } = await fixture()
    const repository = createSettingsRepository(storage)
    await repository.replace(
      "app",
      { smallModel: "before" },
      settingsContext("app", { smallModel: "before" }, 0),
    )
    const manager = await initializeSnapshot(repository)
    const failing = createSettingsRepository(failTransaction(storage))
    const value = { smallModel: "after" }
    await expect(
      replaceSnapshotDocument(
        failing,
        manager,
        "app",
        value,
        settingsContext("app", value, 1),
      ),
    ).rejects.toThrow()
    expect(manager.get().revision).toBe(1)
    expect(manager.get().documents.get("app")?.value).toEqual({
      smallModel: "before",
    })
    expect((await repository.loadSnapshot()).revision).toBe(1)
  })

  test("stable input digest includes namespace and ignores object key order", () => {
    expect(settingsInputDigest("app", { b: 2, a: 1 })).toBe(
      settingsInputDigest("app", { a: 1, b: 2 }),
    )
    expect(settingsInputDigest("app", {})).not.toBe(
      settingsInputDigest("model_fallbacks", {}),
    )
  })

  test("an intentional validator default merge is persisted on replacement", async () => {
    const { storage } = await fixture()
    const plain = createSettingsRepository(storage)
    await plain.replace("app", {}, settingsContext("app", {}, 0))
    const repository = createSettingsRepository(storage, {
      validators: { app: () => ({ smallModel: "default-model" }) },
    })
    const value = { smallModel: "default-model" }
    const result = await repository.replace(
      "app",
      value,
      settingsContext("app", value, 1),
    )
    expect(result.value.revision).toBe(2)
    expect((await plain.loadAll())[0]?.value).toEqual(value)
  })
})

describe("settings transaction publication", () => {
  test("lost acknowledgement publishes only the reconciled committed input", async () => {
    const { storage } = await fixture()
    const manager = await initializeSnapshot(createSettingsRepository(storage))
    const repository = createSettingsRepository(loseCommitResponse(storage))
    const value = { smallModel: "committed-model" }
    const context = settingsContext("app", value, 0)
    const result = await replaceSnapshotDocument(
      repository,
      manager,
      "app",
      value,
      context,
    )
    expect(result.revision).toBe(1)
    expect(manager.get().documents.get("app")?.value).toEqual(value)
    expect(await repository.replace("app", value, context)).toEqual(result)
    expect(manager.get().revision).toBe(1)
  })

  test("unreconciled committed write rejects without publishing a guessed value", async () => {
    const { storage } = await fixture()
    const durable = createSettingsRepository(storage)
    const manager = await initializeSnapshot(durable)
    const repository = createSettingsRepository(
      loseCommitResponse(storage, true),
    )
    const value = { smallModel: "unconfirmed" }
    await expect(
      replaceSnapshotDocument(
        repository,
        manager,
        "app",
        value,
        settingsContext("app", value, 0),
      ),
    ).rejects.toBeInstanceOf(StorageCommitUnknownError)
    expect(manager.get().revision).toBe(0)
    expect(manager.get().documents.size).toBe(0)
    expect((await durable.loadSnapshot()).documents.get("app")?.value).toEqual(
      value,
    )
  })

  test("the complete snapshot uses one owned read transaction for metadata and documents", async () => {
    const { storage } = await fixture()
    await createSettingsRepository(storage).replace(
      "app",
      { saved: true },
      settingsContext("app", { saved: true }, 0),
    )
    let transactions = 0
    const consistentStorage: Storage = {
      read: (work) => {
        transactions++
        return storage.read(work)
      },
      transaction: () =>
        Promise.reject(
          new Error("Snapshot reads must not acquire a write transaction"),
        ),
      atomicBatch: (statements) => storage.atomicBatch(statements),
      close: () => storage.close(),
    }
    const loaded =
      await createSettingsRepository(consistentStorage).loadSnapshot()
    expect(loaded.revision).toBe(1)
    expect(loaded.documents.get("app")?.value).toEqual({ saved: true })
    expect(transactions).toBe(1)
  })

  test("unavailable storage is never interpreted as absent settings", async () => {
    const { storage } = await fixture()
    const unavailable: Storage = {
      ...failTransaction(storage),
      read: () => Promise.reject(new StorageUnavailableError()),
      transaction: () => Promise.reject(new StorageUnavailableError()),
    }
    await expect(
      createSettingsRepository(unavailable).loadAll(),
    ).rejects.toBeInstanceOf(StorageUnavailableError)
    await expect(
      initializeSnapshot(createSettingsRepository(unavailable)),
    ).rejects.toBeInstanceOf(StorageUnavailableError)
  })

  test("settings reject sparse arrays instead of silently converting holes to null", () => {
    expect(() =>
      settingsInputDigest("app", Array.from({ length: 1 })),
    ).toThrow()
  })
})
