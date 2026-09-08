/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejects assertions need awaiting despite their typings. */
import { afterEach, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"

import {
  getLiveSettingRevision,
  getLoadedSetting,
  readSetting,
  reconcilePendingSettingsMutation,
  updateSetting,
  withSettingsActor,
  writeSetting,
} from "~/lib/storage/domain-settings"
import { StorageSchemaError } from "~/lib/storage/errors"
import { withStorageDeadline } from "~/lib/storage/operation-budget"
import { runMutation } from "~/lib/storage/operations"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import {
  closeStorageRuntime,
  getStorageRuntime,
  initializeStorageRuntime,
  peekStorageRuntime,
} from "~/lib/storage/runtime"

import { createRuntimeStorage } from "./helpers/runtime-storage"

const fixtures: Array<Awaited<ReturnType<typeof createRuntimeStorage>>> = []

async function fixture() {
  const result = await createRuntimeStorage()
  fixtures.push(result)
  return result
}

afterEach(async () => {
  for (const entry of fixtures.splice(0)) await entry.close()
})

test("initialization migrates the selected SQLite store and creates no JSON", async () => {
  const db = await fixture()
  const runtime = await initializeStorageRuntime(db)
  expect(runtime.snapshot.get().revision).toBe(0)
  expect(getStorageRuntime()).toBe(runtime)
  const rows = await runtime.storage.read((session) =>
    session.query({
      sql: "SELECT value FROM capi_metadata WHERE key = ?",
      args: ["schema_version"],
    }),
  )
  expect(rows).toEqual([{ value: "1" }])
  expect(
    (await readdir(db.directory)).every((name) =>
      /^copilot-api\.sqlite(?:-(?:wal|shm))?$/.test(name),
    ),
  ).toBe(true)
  await closeStorageRuntime()
  expect(peekStorageRuntime()).toBeUndefined()
  expect(() => getLoadedSetting("app")).toThrow()
})

test("failed initialization does not publish a partially loaded runtime", async () => {
  const db = await fixture()
  db.failCommits()
  await expect(initializeStorageRuntime(db)).rejects.toThrow()
  expect(peekStorageRuntime()).toBeUndefined()
  expect(() => getStorageRuntime()).toThrow()
})

test("concurrent updates read the latest committed document", async () => {
  const db = await fixture()
  await initializeStorageRuntime(db)
  await writeSetting("feature_flags", { count: 0 })
  await Promise.all(
    Array.from({ length: 5 }, () =>
      updateSetting("feature_flags", (value) => {
        if (
          !value
          || typeof value !== "object"
          || Array.isArray(value)
          || typeof value.count !== "number"
        )
          throw new Error("invalid fixture")
        return { count: value.count + 1 }
      }),
    ),
  )
  expect(getLoadedSetting("feature_flags")).toEqual({ count: 5 })
})

test("captured settings stay fixed while live namespace revision changes", async () => {
  const db = await fixture()
  const runtime = await initializeStorageRuntime(db)
  await writeSetting("model_fallbacks", { enabled: false })
  const revision = getLiveSettingRevision("model_fallbacks")
  await withRequestSnapshot(runtime.snapshot.get(), async () => {
    await withSettingsActor("admin:verified", () =>
      writeSetting("model_fallbacks", { enabled: true }),
    )
    expect(getLoadedSetting("model_fallbacks")).toEqual({ enabled: false })
    expect(getLiveSettingRevision("model_fallbacks")).toBe(revision + 1)
    expect(await readSetting("model_fallbacks")).toEqual({ enabled: true })
  })
  await writeSetting("feature_flags", { other: true })
  expect(getLiveSettingRevision("model_fallbacks")).toBe(revision + 1)
})

test("request mutations require a verified actor and bind committed markers to it", async () => {
  const db = await fixture()
  const runtime = await initializeStorageRuntime(db)
  await withRequestSnapshot(runtime.snapshot.get(), async () => {
    await expect(writeSetting("feature_flags", {})).rejects.toThrow()
    await withSettingsActor("admin:verified", () =>
      writeSetting("feature_flags", { test: true }),
    )
  })
  const operations = await db.storage.read((session) =>
    session.query({
      sql: "SELECT actor_id FROM capi_applied_operations",
      args: [],
    }),
  )
  expect(operations).toEqual([{ actor_id: "admin:verified" }])
})

test("failed commit preserves values and both revision counters", async () => {
  const db = await fixture()
  const runtime = await initializeStorageRuntime(db)
  await writeSetting("model_fallbacks", { enabled: false })
  const before = runtime.snapshot.get()
  db.failCommits()
  await expect(
    writeSetting("model_fallbacks", { enabled: true }),
  ).rejects.toThrow()
  expect(runtime.snapshot.get()).toBe(before)
  expect(getLiveSettingRevision("model_fallbacks")).toBe(1)
  expect(await readSetting("model_fallbacks")).toEqual({ enabled: false })
})

test("a timed-out queued update cannot publish later after its predecessor finishes", async () => {
  const db = await fixture()
  await initializeStorageRuntime(db)
  const hold = db.holdNextRead()
  const first = writeSetting("feature_flags", { first: true })
  await hold.entered
  const late = withStorageDeadline(Date.now() + 20, () =>
    writeSetting("feature_flags", { late: true }),
  )
  let released = false
  const releaseTimer = setTimeout(() => {
    released = true
    hold.release()
  }, 200)
  try {
    await expect(late).rejects.toThrow()
    expect(released).toBe(false)
  } finally {
    clearTimeout(releaseTimer)
    hold.release()
  }
  await first
  await writeSetting("model_fallbacks", { enabled: false })
  expect(getLoadedSetting("feature_flags")).toEqual({ first: true })
})

test("a lost commit acknowledgement reconciles the same operation before dependent writes", async () => {
  const db = await fixture()
  const runtime = await initializeStorageRuntime(db)
  db.loseNextCommitResponse()
  await expect(writeSetting("feature_flags", { saved: true })).rejects.toThrow()
  expect(runtime.snapshot.get().revision).toBe(0)
  db.restoreReads()
  await writeSetting("model_fallbacks", { enabled: true })
  expect(getLoadedSetting("feature_flags")).toEqual({ saved: true })
  expect(getLoadedSetting("model_fallbacks")).toEqual({ enabled: true })
  const rows = await db.storage.read((session) =>
    session.query({
      sql: "SELECT COUNT(*) AS count FROM capi_applied_operations",
      args: [],
    }),
  )
  expect(rows).toEqual([{ count: 2 }])
})

test("another repository's unknown commit cannot enqueue a rejected settings write for replay", async () => {
  const db = await fixture()
  const runtime = await initializeStorageRuntime(db)
  const context = {
    operationId: crypto.randomUUID(),
    actorId: "owner:verified",
    kind: "policy.change",
    inputDigest: "policy-change-fixture",
    expectedRevision: runtime.snapshot.get().revision,
  }
  db.loseNextCommitResponse()
  await expect(
    runMutation(db.storage, context, () => Promise.resolve({ id: "policy-1" })),
  ).rejects.toThrow()
  db.restoreReads()
  await expect(
    writeSetting("feature_flags", { rejected: true }),
  ).rejects.toThrow()
  const recovered = await runMutation(db.storage, context, () => {
    throw new Error("A committed operation must never replay its callback")
  })
  expect(recovered.revision).toBe(1)
  await reconcilePendingSettingsMutation()
  expect(await readSetting("feature_flags")).toBeUndefined()
  const rows = await db.storage.read((session) =>
    session.query({
      sql: "SELECT COUNT(*) AS count FROM capi_applied_operations",
      args: [],
    }),
  )
  expect(rows).toEqual([{ count: 1 }])
})

test.each([
  "replacements",
  "model_redirects",
  "model_settings",
  "model_routing",
  "model_fallbacks",
  "feature_flags",
  "statsig_overrides",
])(
  "startup rejects malformed stored %s before publication",
  async (namespace) => {
    const db = await fixture()
    await initializeStorageRuntime(db)
    await db.storage.transaction((session) =>
      session.execute({
        sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES(?,?,?)",
        args: [namespace, '"malformed"', 0],
      }),
    )
    await closeStorageRuntime()
    await expect(
      initializeStorageRuntime({ config: db.config }),
    ).rejects.toBeInstanceOf(StorageSchemaError)
    expect(peekStorageRuntime()).toBeUndefined()
  },
)
