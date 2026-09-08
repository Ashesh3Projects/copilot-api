import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  getLoadedModelFallbackConfig,
  getModelFallbackConfig,
  getModelFallbackConfigRevision,
  setModelFallbackConfig,
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { PATHS } from "~/lib/paths"

afterEach(() => setModelFallbackConfigForTest(null))

const rule = {
  id: "primary",
  sourceModel: "gpt-6-astra",
  targetModel: "claude-opus-4.6",
  enabled: true,
}

describe("model fallback configuration", () => {
  test("defaults to disabled fallbacks with bounded in-memory conversation routing", () => {
    expect(validateModelFallbackConfig({})).toEqual({
      enabled: false,
      conversationAffinity: true,
      notifyClient: false,
      nativeClientNotice: false,
      affinityTtlSeconds: 86400,
      affinityMaxEntries: 10000,
      rules: [],
    })
  })

  test("validates explicit models and prevents ambiguous active rules", () => {
    const invalid = [
      { ...rule, sourceModel: " " },
      { ...rule, targetModel: rule.sourceModel },
      { ...rule, id: "" },
      { ...rule, targetModel: "target\nmodel" },
      { ...rule, targetModel: "target model" },
    ]
    for (const entry of invalid) {
      expect(() => validateModelFallbackConfig({ rules: [entry] })).toThrow()
    }
    expect(() =>
      validateModelFallbackConfig({ rules: [rule, { ...rule, id: "second" }] }),
    ).toThrow()
    expect(() =>
      validateModelFallbackConfig({
        rules: [rule, { ...rule, enabled: false }],
      }),
    ).toThrow()
    expect(
      validateModelFallbackConfig({
        rules: [rule, { ...rule, id: "disabled", enabled: false }],
      }).rules,
    ).toHaveLength(2)
  })

  test("rejects unknown options and invalid memory limits", () => {
    for (const value of [
      { affinityTtlSeconds: 59 },
      { affinityTtlSeconds: 604801 },
      { affinityMaxEntries: 0 },
      { affinityMaxEntries: 100001 },
      { affinityMaxEntries: 1.5 },
      { statusCodes: [500] },
      { enabled: "true" },
    ]) {
      expect(() => validateModelFallbackConfig(value)).toThrow()
    }
  })

  test("publishes isolated config snapshots only after a valid update", async () => {
    setModelFallbackConfigForTest(validateModelFallbackConfig({}))
    const revision = getModelFallbackConfigRevision()
    const next = await setModelFallbackConfig({ enabled: true, rules: [rule] })
    expect(getModelFallbackConfigRevision()).toBeGreaterThan(revision)
    next.rules[0].targetModel = "mutated"
    expect(getLoadedModelFallbackConfig().rules[0].targetModel).toBe(
      rule.targetModel,
    )
    const rejected = await setModelFallbackConfig({ rules: [{}] }).then(
      () => false,
      () => true,
    )
    expect(rejected).toBe(true)
    expect((await getModelFallbackConfig()).enabled).toBe(true)
  })

  // PATHS is restored in finally; Bun runs these filesystem fixtures serially.
  /* eslint-disable require-atomic-updates */
  test("persists configuration atomically and retains the last good state after a storage failure", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "model-fallback-config-"),
    )
    const originalDir = PATHS.APP_DIR
    const originalPath = PATHS.MODEL_FALLBACKS_CONFIG_PATH
    try {
      PATHS.APP_DIR = directory
      PATHS.MODEL_FALLBACKS_CONFIG_PATH = path.join(
        directory,
        "model_fallbacks.json",
      )
      setModelFallbackConfigForTest(null)
      expect((await getModelFallbackConfig()).enabled).toBe(false)
      await Promise.all([
        setModelFallbackConfig({ enabled: false, rules: [rule] }),
        setModelFallbackConfig({ enabled: true, rules: [rule] }),
      ])
      const persisted = JSON.parse(
        (await fs.readFile(PATHS.MODEL_FALLBACKS_CONFIG_PATH)).toString(),
      ) as unknown
      expect(validateModelFallbackConfig(persisted).enabled).toBe(true)
      setModelFallbackConfigForTest(null)
      expect((await getModelFallbackConfig()).rules).toEqual([rule])
      PATHS.MODEL_FALLBACKS_CONFIG_PATH = directory
      const rejected = await setModelFallbackConfig({ enabled: false }).then(
        () => false,
        () => true,
      )
      expect(rejected).toBe(true)
      expect(getLoadedModelFallbackConfig().enabled).toBe(true)
      expect(await fs.readdir(directory)).toEqual(["model_fallbacks.json"])
    } finally {
      PATHS.APP_DIR = originalDir
      PATHS.MODEL_FALLBACKS_CONFIG_PATH = originalPath
      setModelFallbackConfigForTest(null)
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
  /* eslint-enable require-atomic-updates */
})
