import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  initializeStorageRuntime,
  getStorageRuntime,
} from "~/lib/storage/runtime"
import {
  createStatsigOverrideStore,
  statsigOverrideStore,
  StatsigOverrideValidationError,
} from "~/routes/statsig-overrides/store"

import { createRuntimeStorage } from "./helpers/runtime-storage"

let fixture: Awaited<ReturnType<typeof createRuntimeStorage>>
beforeEach(async () => {
  fixture = await createRuntimeStorage()
  await initializeStorageRuntime(fixture)
  statsigOverrideStore.resetAfterTest()
})
afterEach(async () => {
  await fixture.close()
})

async function expectValidationError(
  action: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  let rejected: unknown
  try {
    await action()
  } catch (error) {
    rejected = error
  }
  expect(rejected).toBeInstanceOf(StatsigOverrideValidationError)
  expect((rejected as Error).message).toBe(expectedMessage)
}

test("stores feature gates and dynamic configs independently with detached snapshots", async () => {
  const store = createStatsigOverrideStore()
  await store.set("featureGate", "  gate-enabled  ", true)
  await store.set("dynamicConfig", "config-values", {
    rollout: 50,
    nested: { enabled: true },
  })
  const snapshot = store.get()
  snapshot.featureGates["gate-enabled"] = false
  ;(
    snapshot.dynamicConfigs["config-values"] as { nested: { enabled: boolean } }
  ).nested.enabled = false
  expect(store.get()).toEqual({
    featureGates: { "gate-enabled": true },
    dynamicConfigs: {
      "config-values": { rollout: 50, nested: { enabled: true } },
    },
  })
  expect(store.count()).toBe(2)
})

test("persists overrides across service instances in SQLite", async () => {
  await statsigOverrideStore.set("featureGate", "copilot_gate", true)
  await statsigOverrideStore.set("dynamicConfig", "assistant_config", {
    mode: "shadow",
    sampleRate: 0.1,
  })
  const rows = await fixture.storage.read((session) =>
    session.query({
      sql: "SELECT value_json FROM capi_settings WHERE namespace = ?",
      args: ["statsig_overrides"],
    }),
  )
  expect(rows).toHaveLength(1)
  expect(JSON.parse(String(rows[0]?.value_json))).toEqual({
    featureGates: { copilot_gate: true },
    dynamicConfigs: { assistant_config: { mode: "shadow", sampleRate: 0.1 } },
  })
  expect(createStatsigOverrideStore().get()).toEqual(statsigOverrideStore.get())
})

test("defaults only when the database record is absent", () => {
  expect(statsigOverrideStore.get()).toEqual({
    featureGates: {},
    dynamicConfigs: {},
  })
  expect(statsigOverrideStore.count()).toBe(0)
})

test("rejects invalid JSON in a persisted database record", async () => {
  await fixture.storage.transaction(async (session) => {
    await session.execute({
      sql: "INSERT INTO capi_settings(namespace, value_json, revision) VALUES (?, ?, ?)",
      args: ["statsig_overrides", "{ invalid json", 0],
    })
  })
  expect(
    await getStorageRuntime()
      .settings.loadSnapshot()
      .then(
        () => false,
        () => true,
      ),
  ).toBe(true)
})

test.each([
  { featureGates: "not-an-object", dynamicConfigs: {} },
  { featureGates: { gate: "true" }, dynamicConfigs: {} },
  { featureGates: {}, dynamicConfigs: [] },
  { featureGates: {}, dynamicConfigs: { config: [] } },
])("rejects invalid persisted override maps and values", async (value) => {
  await fixture.storage.transaction(async (session) => {
    await session.execute({
      sql: "INSERT INTO capi_settings(namespace, value_json, revision) VALUES (?, ?, ?)",
      args: ["statsig_overrides", JSON.stringify(value), 0],
    })
  })
  expect(
    await getStorageRuntime()
      .settings.loadSnapshot()
      .then(
        () => false,
        () => true,
      ),
  ).toBe(true)
})

test("rejects invalid feature gate values", async () => {
  const store = createStatsigOverrideStore()

  for (const value of [0, "true", null, { enabled: true }]) {
    await expectValidationError(
      () => store.set("featureGate", "gate", value),
      "feature gate value must be boolean",
    )
  }
})

test("rejects invalid dynamic config values", async () => {
  const store = createStatsigOverrideStore()

  for (const value of [true, null, [], "config", new Date()]) {
    await expectValidationError(
      () => store.set("dynamicConfig", "config", value),
      "dynamic config value must be a JSON object",
    )
  }
})

test("rejects nested non-JSON dynamic config values", async () => {
  const store = createStatsigOverrideStore()
  const cyclicValue: Record<string, unknown> = { nested: { enabled: true } }
  cyclicValue.self = cyclicValue
  const sparseArray: Array<unknown> = Array(2)
  sparseArray[1] = 1

  for (const value of [
    { nested: { updatedAt: new Date() } },
    { nested: { missing: undefined } },
    { nested: { sampleRate: Number.POSITIVE_INFINITY } },
    { nested: sparseArray },
    cyclicValue,
  ]) {
    await expectValidationError(
      () => store.set("dynamicConfig", "config", value),
      "dynamic config value must be a JSON object",
    )
  }
})

test("rejects unsafe override names", async () => {
  const store = createStatsigOverrideStore()

  for (const name of ["__proto__", "prototype", "constructor"]) {
    await expectValidationError(
      () => store.set("featureGate", name, true),
      "name is not allowed",
    )
    await expectValidationError(
      () => store.set("dynamicConfig", name, { enabled: true }),
      "name is not allowed",
    )
  }
})

test("rejects blank override names", async () => {
  const store = createStatsigOverrideStore()

  for (const name of ["", " ", "\n\t "]) {
    await expectValidationError(
      () => store.set("featureGate", name, true),
      "name is required",
    )
    await expectValidationError(
      () => store.remove("dynamicConfig", name),
      "name is required",
    )
  }
})

test("removal persists only the selected override kind", async () => {
  const store = createStatsigOverrideStore()
  await store.set("featureGate", "shared-name", true)
  await store.set("dynamicConfig", "shared-name", { enabled: true })
  expect(await store.remove("featureGate", "shared-name")).toBe(true)
  expect(createStatsigOverrideStore().get()).toEqual({
    featureGates: {},
    dynamicConfigs: { "shared-name": { enabled: true } },
  })
  expect(store.count()).toBe(1)
  expect(await store.remove("dynamicConfig", "shared-name")).toBe(true)
  expect(store.count()).toBe(0)
  expect(await store.remove("dynamicConfig", "missing")).toBe(false)
})

test("explicit test overrides do not persist and reset restores the database value", async () => {
  const store = createStatsigOverrideStore()
  await store.set("featureGate", "persisted", true)
  store.replaceForTest({
    featureGates: { ephemeral: false },
    dynamicConfigs: {},
  })
  await store.set("dynamicConfig", "runtime-only", { cohort: "beta" })
  expect(store.get().dynamicConfigs["runtime-only"]).toEqual({ cohort: "beta" })
  expect(createStatsigOverrideStore().get()).toEqual({
    featureGates: { persisted: true },
    dynamicConfigs: {},
  })
  store.resetAfterTest()
  expect(store.get()).toEqual({
    featureGates: { persisted: true },
    dynamicConfigs: {},
  })
  await store.set("dynamicConfig", "after-reset", { enabled: true })
  expect(
    createStatsigOverrideStore().get().dynamicConfigs["after-reset"],
  ).toEqual({ enabled: true })
})

test.each(["set", "remove"] as const)(
  "%s preserves committed state when SQLite rolls back",
  async (kind) => {
    const store = createStatsigOverrideStore()
    await store.set("featureGate", "persisted", true)
    fixture.failCommits()
    const operation =
      kind === "set" ?
        store.set("featureGate", "next-value", false)
      : store.remove("featureGate", "persisted")
    expect(
      await operation.then(
        () => false,
        () => true,
      ),
    ).toBe(true)
    expect(store.get()).toEqual({
      featureGates: { persisted: true },
      dynamicConfigs: {},
    })
    expect(createStatsigOverrideStore().get()).toEqual(store.get())
  },
)
