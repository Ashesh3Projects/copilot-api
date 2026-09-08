/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejects assertions need awaiting despite their typings. */
import { afterEach, expect, test } from "bun:test"

import {
  getConfig,
  mergeConfigWithDefaults,
  setConfigForTest,
  updateConfig,
  writeConfig,
} from "~/lib/config"
import { StorageSchemaError } from "~/lib/storage/errors"
import {
  closeStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"

import { createRuntimeStorage } from "./helpers/runtime-storage"

const fixtures: Array<Awaited<ReturnType<typeof createRuntimeStorage>>> = []
async function fixture() {
  const result = await createRuntimeStorage()
  fixtures.push(result)
  return result
}
afterEach(async () => {
  setConfigForTest(null)
  for (const entry of fixtures.splice(0)) await entry.close()
})

test("production config requires initialized storage and an app document", async () => {
  setConfigForTest(null)
  expect(() => getConfig()).toThrow()
  const db = await fixture()
  await initializeStorageRuntime(db)
  expect(() => getConfig()).toThrow()
  await mergeConfigWithDefaults()
  expect(getConfig().smallModel).toBe("gpt-5-mini")
})

test("app settings and deliberate empty fields survive close and reopen", async () => {
  const db = await fixture()
  await initializeStorageRuntime(db)
  await mergeConfigWithDefaults()
  await writeConfig({
    smallModel: "custom-model",
    extraPrompts: { "gpt-5-mini": "" },
    useFunctionApplyPatch: false,
  })
  await closeStorageRuntime()
  await initializeStorageRuntime({ config: db.config })
  await mergeConfigWithDefaults()
  expect(getConfig().smallModel).toBe("custom-model")
  expect(getConfig().extraPrompts?.["gpt-5-mini"]).toBe("")
  expect(getConfig().useFunctionApplyPatch).toBe(false)
  expect(getConfig().auth).toBeUndefined()
})

test("default initialization is persisted once and preserves explicit fields", async () => {
  const db = await fixture()
  const runtime = await initializeStorageRuntime(db)
  await mergeConfigWithDefaults()
  const revision = runtime.snapshot.get().revision
  await mergeConfigWithDefaults()
  expect(runtime.snapshot.get().revision).toBe(revision)
  expect(getConfig().extraPrompts?.["gpt-5.3-codex"]).toContain(
    "Working with the user",
  )
})

test("malformed persisted app fails startup instead of becoming defaults", async () => {
  const db = await fixture()
  await initializeStorageRuntime(db)
  await db.storage.transaction((session) =>
    session.execute({
      sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES(?,?,?)",
      args: ["app", '{"extraPrompts":[]}', 0],
    }),
  )
  await closeStorageRuntime()
  await expect(
    initializeStorageRuntime({ config: db.config }),
  ).rejects.toBeInstanceOf(StorageSchemaError)
  expect(() => getConfig()).toThrow()
})

test("failed app update does not change the published configuration", async () => {
  const db = await fixture()
  const runtime = await initializeStorageRuntime(db)
  await writeConfig({ smallModel: "before" })
  const before = runtime.snapshot.get()
  db.failCommits()
  await expect(
    updateConfig((config) => ({ ...config, smallModel: "after" })),
  ).rejects.toThrow()
  expect(getConfig().smallModel).toBe("before")
  expect(runtime.snapshot.get()).toBe(before)
})

test("invalid app writes reject but supported extension fields survive", async () => {
  const db = await fixture()
  await initializeStorageRuntime(db)
  const extended = { smallModel: "custom", extension: { enabled: true } }
  await writeConfig(extended)
  expect(getConfig()).toEqual(extended)
  await expect(
    writeConfig({ extraPrompts: [] as unknown as Record<string, string> }),
  ).rejects.toBeInstanceOf(StorageSchemaError)
  expect(getConfig()).toEqual(extended)
})

test("explicit test config remains isolated and clearing it restores storage authority", async () => {
  setConfigForTest({ smallModel: "test-only" })
  await updateConfig((config) => ({ ...config, smallModel: "test-next" }))
  expect(getConfig().smallModel).toBe("test-next")
  setConfigForTest(null)
  expect(() => getConfig()).toThrow()
})

test("optional undefined app fields are omitted while invalid array entries reject", async () => {
  const db = await fixture()
  await initializeStorageRuntime(db)
  await writeConfig({
    smallModel: "custom",
    codexCleanupModel: undefined,
    customProviders: [
      {
        id: "custom",
        name: "Custom",
        type: "openai-compatible",
        baseUrl: "https://example.com/v1",
        apiKey: undefined,
        models: [{ id: "model", kind: "chat", aliases: undefined }],
      },
    ],
  })
  expect(getConfig().customProviders?.[0]?.models).toEqual([
    { id: "model", kind: "chat" },
  ])
  expect(Object.hasOwn(getConfig(), "codexCleanupModel")).toBe(false)
  await expect(
    writeConfig({ customProviders: [undefined] as never }),
  ).rejects.toBeInstanceOf(StorageSchemaError)
})
