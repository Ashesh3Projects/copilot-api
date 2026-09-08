import { afterEach, beforeEach, expect, test } from "bun:test"

import type { SettingsNamespace } from "~/lib/storage/types"

import {
  addReplacement,
  getUserReplacements,
  loadReplacements,
  updateReplacement,
  removeReplacement,
} from "~/lib/auto-replace"
import {
  getCapturedModelFallbackConfigRevision,
  getLoadedModelFallbackConfig,
  getModelFallbackConfig,
  getModelFallbackConfigRevision,
  setModelFallbackConfig,
  setModelFallbackConfigForTest,
} from "~/lib/model-fallback-config"
import {
  addModelRedirect,
  getAllModelRedirects,
  loadModelRedirects,
  moveModelRedirect,
  updateModelRedirect,
} from "~/lib/model-redirect"
import {
  getAllModelRoutingOverrides,
  loadModelRoutingOverrides,
  setModelRoutingOverride,
} from "~/lib/model-routing"
import {
  getAllModelSettings,
  loadModelSettings,
  setModelSettings,
} from "~/lib/model-settings"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import {
  closeStorageRuntime,
  getStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"
import {
  getFeatureFlags,
  setFeatureFlag,
  setFeatureFlagsForTest,
} from "~/routes/feature-flags/store"
import { statsigOverrideStore } from "~/routes/statsig-overrides/store"

import { createRuntimeStorage } from "./helpers/runtime-storage"

let fixture: Awaited<ReturnType<typeof createRuntimeStorage>>

beforeEach(async () => {
  fixture = await createRuntimeStorage()
  await initializeStorageRuntime(fixture)
  await loadReplacements()
  await loadModelRedirects()
  await loadModelSettings()
  await loadModelRoutingOverrides()
  setModelFallbackConfigForTest(null)
  setFeatureFlagsForTest(null)
  statsigOverrideStore.resetAfterTest()
})

afterEach(async () => {
  await fixture.close()
})

const cases: Array<{
  namespace: SettingsNamespace
  save: () => Promise<unknown>
  get: () => unknown
}> = [
  {
    namespace: "replacements",
    save: () => addReplacement("before", "after"),
    get: getUserReplacements,
  },
  {
    namespace: "model_redirects",
    save: () => addModelRedirect("source", "target"),
    get: getAllModelRedirects,
  },
  {
    namespace: "model_settings",
    save: () => setModelSettings(" source ", { sentryModelName: " target " }),
    get: getAllModelSettings,
  },
  {
    namespace: "model_routing",
    save: () => setModelRoutingOverride("source", 2, false),
    get: getAllModelRoutingOverrides,
  },
  {
    namespace: "model_fallbacks",
    save: () =>
      setModelFallbackConfig({
        enabled: true,
        rules: [
          { id: "fallback", sourceModel: "source", targetModel: "target" },
        ],
      }),
    get: getLoadedModelFallbackConfig,
  },
  {
    namespace: "feature_flags",
    save: () => setFeatureFlag("sample", { nested: { enabled: true } }),
    get: getFeatureFlags,
  },
  {
    namespace: "statsig_overrides",
    save: () =>
      statsigOverrideStore.set("dynamicConfig", "sample", {
        nested: { enabled: true },
      }),
    get: () => statsigOverrideStore.get(),
  },
]

test.each(cases)(
  "$namespace commits into SQLite and reloads without private caches",
  async ({ namespace, save, get }) => {
    await save()
    const expected = await get()
    const rows = await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT value_json FROM capi_settings WHERE namespace = ?",
        args: [namespace],
      }),
    )
    expect(rows).toHaveLength(1)
    await closeStorageRuntime()
    await initializeStorageRuntime({ config: fixture.config })
    expect(await get()).toEqual(expected)
  },
)

test.each([
  {
    namespace: "model_settings",
    value: [{ model: "source", sentryModelName: 5 }],
  },
  {
    namespace: "model_settings",
    value: [{ model: "source", supportsAssistantPrefill: "false" }],
  },
  {
    namespace: "model_settings",
    value: [{ model: "source", supportedReasoningEfforts: ["wrong"] }],
  },
  {
    namespace: "model_redirects",
    value: [
      {
        id: "r",
        sourceModel: "source",
        targetModel: "target",
        enabled: "false",
      },
    ],
  },
  {
    namespace: "model_redirects",
    value: [
      {
        id: "r",
        sourceModel: "source",
        targetModel: "target",
        sourceEffort: "wrong",
      },
    ],
  },
])(
  "invalid stored $namespace fields cannot silently become defaults",
  async ({ namespace, value }) => {
    await fixture.storage.transaction((session) =>
      session.execute({
        sql: "INSERT INTO capi_settings(namespace, value_json, revision) VALUES (?, ?, ?)",
        args: [namespace, JSON.stringify(value), 0],
      }),
    )
    const failed = await getStorageRuntime()
      .settings.loadSnapshot()
      .then(
        () => false,
        () => true,
      )
    expect(failed).toBe(true)
  },
)

test.each(cases)(
  "$namespace preserves the published value and revision after a failed commit",
  async ({ save, get }) => {
    const before = await get()
    const revision = getModelFallbackConfigRevision()
    fixture.failCommits()
    const failed = await save().then(
      () => false,
      () => true,
    )
    expect(failed).toBe(true)
    expect(await get()).toEqual(before)
    expect(getModelFallbackConfigRevision()).toBe(revision)
  },
)

test("unrelated configuration changes never advance the fallback policy revision", async () => {
  await setModelFallbackConfig({ enabled: true })
  const revision = getModelFallbackConfigRevision()
  await setFeatureFlag("unrelated", true)
  await setModelRoutingOverride("source", 0, false)
  expect(getModelFallbackConfigRevision()).toBe(revision)
})

test("serialized mutations preserve independently changed fields and ordered rules", async () => {
  const replacements = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      addReplacement(`before-${index}`, `after-${index}`),
    ),
  )
  expect((await getUserReplacements()).map((rule) => rule.id)).toEqual(
    replacements.map((rule) => rule.id),
  )
  await Promise.all([
    setModelSettings("source", { sentryModelName: "target" }),
    setModelSettings("source", { supportsAssistantPrefill: false }),
    setModelRoutingOverride("source", 1, false),
    setModelRoutingOverride("source", 2, true),
    setFeatureFlag("one", true),
    setFeatureFlag("two", false),
  ])
  expect(await getAllModelSettings()).toEqual([
    {
      model: "source",
      sentryModelName: "target",
      supportsAssistantPrefill: false,
    },
  ])
  expect(await getAllModelRoutingOverrides()).toEqual([
    { modelId: "source", accountId: 1, enabled: false },
    { modelId: "source", accountId: 2, enabled: true },
  ])
  expect(getFeatureFlags()).toMatchObject({ one: true, two: false })
  const first = await addModelRedirect("source", "first")
  const second = await addModelRedirect("source", "second")
  await moveModelRedirect(second.id, "up")
  expect((await getAllModelRedirects()).map((rule) => rule.id)).toEqual([
    second.id,
    first.id,
  ])
})

test("a failed edit or removal cannot mutate committed nested rule objects", async () => {
  const replacement = await addReplacement("before", "after")
  const redirect = await addModelRedirect("source", "target")
  fixture.failCommits()
  for (const mutation of [
    () => updateReplacement(replacement.id, { pattern: "failed" }),
    () => removeReplacement(replacement.id),
    () => updateModelRedirect(redirect.id, { targetModel: "failed" }),
  ]) {
    expect(
      await mutation().then(
        () => false,
        () => true,
      ),
    ).toBe(true)
  }
  expect(await getUserReplacements()).toEqual([replacement])
  expect((await getAllModelRedirects())[0].targetModel).toBe("target")
})

test("an admitted fallback attempt retains its policy while the live revision advances", async () => {
  await setModelFallbackConfig({ enabled: true })
  const captured = getStorageRuntime().snapshot.get()
  const revision = getModelFallbackConfigRevision()
  await setModelFallbackConfig({ enabled: false })
  await withRequestSnapshot(captured, async () => {
    expect((await getModelFallbackConfig()).enabled).toBe(true)
    expect(getLoadedModelFallbackConfig().enabled).toBe(true)
    expect(getCapturedModelFallbackConfigRevision()).toBe(revision)
    expect(getModelFallbackConfigRevision()).toBeGreaterThan(revision)
  })
  expect(getLoadedModelFallbackConfig().enabled).toBe(false)
})

test.each(cases)(
  "$namespace rejects a present null document instead of using defaults",
  async ({ namespace }) => {
    await fixture.storage.transaction((session) =>
      session.execute({
        sql: "INSERT INTO capi_settings(namespace, value_json, revision) VALUES (?, ?, ?)",
        args: [namespace, "null", 0],
      }),
    )
    expect(
      await getStorageRuntime()
        .settings.loadSnapshot()
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true)
  },
)
