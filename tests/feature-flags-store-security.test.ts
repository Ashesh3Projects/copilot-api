import { expect, test } from "bun:test"

import {
  FeatureFlagValidationError,
  getFeatureFlags,
  isValidFeatureFlagName,
  setFeatureFlag,
  setFeatureFlagsForTest,
} from "~/routes/feature-flags/store"

test("rejects prototype-polluting and malformed feature flag names", async () => {
  setFeatureFlagsForTest()
  for (const name of ["__proto__", "constructor", "prototype", "bad flag"]) {
    expect(isValidFeatureFlagName(name)).toBe(false)
    const error = await setFeatureFlag(name, true).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(FeatureFlagValidationError)
  }
  expect(Object.getPrototypeOf(getFeatureFlags())).toBeNull()
})

test("accepts safe feature flag names without a length cap", async () => {
  setFeatureFlagsForTest()
  const name = `security_safe_flag_${"x".repeat(256)}`
  expect(isValidFeatureFlagName(name)).toBe(true)
  expect((await setFeatureFlag(name, true))[name]).toBe(true)
})

test("accepts large feature flag collections and values", async () => {
  const flags = Object.fromEntries(
    Array.from({ length: 205 }, (_, index) => [`flag_${index}`, index]),
  )
  setFeatureFlagsForTest(flags)
  expect(Object.keys(getFeatureFlags()).length).toBeGreaterThanOrEqual(205)

  const largeValue = "x".repeat(70_000)
  expect((await setFeatureFlag("large_value", largeValue)).large_value).toBe(
    largeValue,
  )
})

test("does not expose the mutable feature flag store to callers", () => {
  setFeatureFlagsForTest()
  const snapshot = getFeatureFlags()
  snapshot.__proto__ = true
  snapshot.caller_mutation = true

  expect(Object.hasOwn(getFeatureFlags(), "__proto__")).toBe(false)
  expect(Object.hasOwn(getFeatureFlags(), "caller_mutation")).toBe(false)
})

test("disables Claude Code non-streaming fallback after a stream error", () => {
  setFeatureFlagsForTest()
  expect(
    getFeatureFlags().tengu_disable_streaming_to_non_streaming_fallback,
  ).toBe(true)
})
