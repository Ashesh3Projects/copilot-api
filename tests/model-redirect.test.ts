import { beforeEach, expect, test } from "bun:test"

import {
  applyModelRedirect,
  formatModelRedirectResult,
  getAllModelRedirects,
  moveModelRedirect,
  setModelRedirectsForTest,
} from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { parseModelSuffix } from "../src/lib/model-suffix"

beforeEach(() => {
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test("matches exact reasoning effort and applies target effort override", async () => {
  setModelRedirectsForTest([
    {
      id: "high-source",
      sourceModel: "claude-source-1m",
      sourceEffort: "high",
      targetModel: "claude-target-1m",
      targetEffort: "high",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "claude-source-1m",
    effort: "high",
  })

  expect(redirect).toMatchObject({
    model: "claude-target-1m",
    effort: "high",
    redirected: true,
    originalModel: "claude-source-1m",
    originalEffort: "high",
    ruleId: "high-source",
  })
})

test("all effort catch-all preserves requested effort", async () => {
  setModelRedirectsForTest([
    {
      id: "all-opus",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "claude-source",
    effort: "medium",
  })

  expect(redirect.model).toBe("claude-target")
  expect(redirect.effort).toBe("medium")
})

test("applies a verbosity-only redirect when the model and effort stay unchanged", async () => {
  setModelRedirectsForTest([
    {
      id: "sol-high-verbosity",
      sourceModel: "gpt-5.6-sol-fast",
      sourceEffort: "all",
      targetModel: "gpt-5.6-sol-fast",
      targetVerbosity: "high",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "gpt-5.6-sol-fast",
    effort: "max",
    verbosity: "low",
  })

  expect(redirect).toMatchObject({
    model: "gpt-5.6-sol-fast",
    effort: "max",
    verbosity: "high",
    redirected: true,
    originalVerbosity: "low",
    ruleIds: ["sol-high-verbosity"],
  })
  expect(formatModelRedirectResult(redirect)).toBe(
    "gpt-5.6-sol-fast:max [verbosity=low] -> gpt-5.6-sol-fast:max [verbosity=high]",
  )
})

test("uses the last explicit verbosity override in a redirect chain", async () => {
  setModelRedirectsForTest([
    {
      id: "source-to-middle",
      sourceModel: "source-model",
      sourceEffort: "all",
      targetModel: "middle-model",
      targetVerbosity: "medium",
      enabled: true,
    },
    {
      id: "middle-to-next",
      sourceModel: "middle-model",
      sourceEffort: "all",
      targetModel: "next-model",
      enabled: true,
    },
    {
      id: "next-to-final",
      sourceModel: "next-model",
      sourceEffort: "all",
      targetModel: "final-model",
      targetVerbosity: "high",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "source-model",
    effort: "medium",
    verbosity: "low",
  })

  expect(redirect).toMatchObject({
    model: "final-model",
    effort: "medium",
    verbosity: "high",
    ruleIds: ["source-to-middle", "middle-to-next", "next-to-final"],
  })
  expect(redirect.redirectChain?.map((step) => step.targetVerbosity)).toEqual([
    "medium",
    "medium",
    "high",
  ])
})

test("continues past an already satisfied verbosity-only rule", async () => {
  setModelRedirectsForTest([
    {
      id: "keep-high",
      sourceModel: "model-a",
      sourceEffort: "all",
      targetModel: "model-a",
      targetVerbosity: "high",
      enabled: true,
    },
    {
      id: "route-to-b",
      sourceModel: "model-a",
      sourceEffort: "all",
      targetModel: "model-b",
      targetVerbosity: "medium",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "model-a",
    effort: "high",
    verbosity: "high",
  })

  expect(redirect).toMatchObject({
    model: "model-b",
    effort: "high",
    verbosity: "medium",
    redirected: true,
    ruleIds: ["route-to-b"],
  })
})

test("follows chained redirects and applies final target effort", async () => {
  setModelRedirectsForTest([
    {
      id: "opus-to-1m",
      sourceModel: "claude-opus-4.6",
      sourceEffort: "all",
      targetModel: "claude-opus-4.6-1m",
      enabled: true,
    },
    {
      id: "1m-to-internal",
      sourceModel: "claude-opus-4.6-1m",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      targetEffort: "xhigh",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect("claude-opus-4.6")

  expect(redirect).toMatchObject({
    model: "claude-opus-4.7-1m-internal",
    effort: "xhigh",
    redirected: true,
    originalModel: "claude-opus-4.6",
    ruleId: "opus-to-1m",
    ruleIds: ["opus-to-1m", "1m-to-internal"],
  })
  expect(formatModelRedirectResult(redirect)).toBe(
    "claude-opus-4.6 -> claude-opus-4.6-1m -> claude-opus-4.7-1m-internal:xhigh",
  )
})

test("keeps numeric Responses redirects model-only across multiple hops", async () => {
  setModelRedirectsForTest([
    {
      id: "numeric-source-to-middle",
      sourceModel: "numeric-source",
      sourceEffort: "default",
      targetModel: "numeric-middle",
      targetEffort: "high",
      enabled: true,
    },
    {
      id: "numeric-middle-high-to-wrong",
      sourceModel: "numeric-middle",
      sourceEffort: "high",
      targetModel: "wrong-named-target",
      targetEffort: "max",
      enabled: true,
    },
    {
      id: "numeric-middle-default-to-final",
      sourceModel: "numeric-middle",
      sourceEffort: "default",
      targetModel: "numeric-final",
      targetEffort: "xhigh",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "numeric-source",
    effort: undefined,
    modelOnly: true,
  })

  expect(redirect).toMatchObject({
    model: "numeric-final",
    effort: undefined,
    ruleIds: ["numeric-source-to-middle", "numeric-middle-default-to-final"],
  })
  expect(redirect.redirectChain).toEqual([
    {
      ruleId: "numeric-source-to-middle",
      sourceModel: "numeric-source",
      targetModel: "numeric-middle",
    },
    {
      ruleId: "numeric-middle-default-to-final",
      sourceModel: "numeric-middle",
      targetModel: "numeric-final",
    },
  ])
  expect(formatModelRedirectResult(redirect)).toBe(
    "numeric-source -> numeric-middle -> numeric-final",
  )
})

test("continues chained redirects only through lower priority rules", async () => {
  setModelRedirectsForTest([
    {
      id: "opus-46-to-1m",
      sourceModel: "claude-opus-4.6",
      sourceEffort: "all",
      targetModel: "claude-opus-4.6-1m",
      enabled: true,
    },
    {
      id: "opus-46-1m-to-internal",
      sourceModel: "claude-opus-4.6-1m",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "opus-47-to-internal",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "claude-gpt-to-gpt",
      sourceModel: "claude-gpt-5.5",
      sourceEffort: "all",
      targetModel: "gpt-5.5",
      enabled: true,
    },
    {
      id: "internal-to-opus-48",
      sourceModel: "claude-opus-4.7-1m-internal",
      sourceEffort: "all",
      targetModel: "claude-opus-4.8",
      targetEffort: "max",
      enabled: true,
    },
    {
      id: "fallback-to-internal",
      sourceModel: "fallback-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "fallback-opus-4.7",
    effort: "max",
  })

  expect(redirect.model).toBe("claude-opus-4.7-1m-internal")
  expect(redirect.effort).toBe("max")
  expect(redirect.ruleIds).toEqual(["fallback-to-internal"])
  expect(formatModelRedirectResult(redirect)).toBe(
    "fallback-opus-4.7:max -> claude-opus-4.7-1m-internal:max",
  )
})

test("enforces final self-redirect target effort across exact opus chain", async () => {
  setModelRedirectsForTest([
    {
      id: "redirect-1777093942724-pakt7nd",
      sourceModel: "claude-opus-4.6",
      sourceEffort: "all",
      targetModel: "claude-opus-4.6-1m",
      enabled: true,
    },
    {
      id: "redirect-1778731468704-u0w3ipk",
      sourceModel: "claude-opus-4.6-1m",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "redirect-1777095881291-wrcxhk0",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "redirect-1780035339134-4mw4r33",
      sourceModel: "claude-opus-4.8",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "redirect-1780042585759-nay35pf",
      sourceModel: "claude-opus-4.7-1m-internal",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      targetEffort: "xhigh",
      enabled: true,
    },
  ])

  for (const input of [
    "claude-opus-4.6",
    "claude-opus-4.6-1m",
    "claude-opus-4.7",
    "claude-opus-4.8",
  ]) {
    const redirect = await applyModelRedirect(input)
    expect(redirect.model).toBe("claude-opus-4.7-1m-internal")
    expect(redirect.effort).toBe("xhigh")
    expect(redirect.ruleIds?.at(-1)).toBe("redirect-1780042585759-nay35pf")
  }

  const directLow = await applyModelRedirect({
    model: "claude-opus-4.7-1m-internal",
    effort: "low",
  })
  expect(directLow.model).toBe("claude-opus-4.7-1m-internal")
  expect(directLow.effort).toBe("xhigh")

  const directXhigh = await applyModelRedirect({
    model: "claude-opus-4.7-1m-internal",
    effort: "xhigh",
  })
  expect(directXhigh.model).toBe("claude-opus-4.7-1m-internal")
  expect(directXhigh.effort).toBe("xhigh")
})

test("bypasses chained redirects when a loop is configured", async () => {
  setModelRedirectsForTest([
    {
      id: "a-to-b",
      sourceModel: "model-a",
      sourceEffort: "all",
      targetModel: "model-b",
      enabled: true,
    },
    {
      id: "b-to-a",
      sourceModel: "model-b",
      sourceEffort: "all",
      targetModel: "model-a",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect("model-a")

  expect(redirect).toMatchObject({
    model: "model-a",
    redirected: false,
  })
})

test("default effort filter only matches requests without explicit effort", async () => {
  setModelRedirectsForTest([
    {
      id: "default-only",
      sourceModel: "gpt-new",
      sourceEffort: "default",
      targetModel: "gpt-known",
      enabled: true,
    },
  ])

  const defaultRedirect = await applyModelRedirect("gpt-new")
  expect(defaultRedirect).toMatchObject({
    model: "gpt-known",
    redirected: true,
  })
  const explicitEffortRedirect = await applyModelRedirect({
    model: "gpt-new",
    effort: "low",
  })
  expect(explicitEffortRedirect).toMatchObject({
    model: "gpt-new",
    redirected: false,
  })
})

test("max redirect filters match max as a first-class effort", async () => {
  setModelRedirectsForTest([
    {
      id: "max-opus",
      sourceModel: "claude-source-1m",
      sourceEffort: "max",
      targetModel: "claude-target-1m",
      targetEffort: "max",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "claude-source-1m",
    effort: "max",
  })

  expect(redirect.model).toBe("claude-target-1m")
  expect(redirect.effort).toBe("max")

  const xhighRedirect = await applyModelRedirect({
    model: "claude-source-1m",
    effort: "xhigh",
  })

  expect(xhighRedirect.redirected).toBe(false)
  expect(xhighRedirect.effort).toBe("xhigh")
})

test("first matching rule wins until precedence is changed", async () => {
  setModelRedirectsForTest([
    {
      id: "catch-all",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target-medium",
      targetEffort: "medium",
      enabled: true,
    },
    {
      id: "high-rule",
      sourceModel: "claude-source",
      sourceEffort: "high",
      targetModel: "claude-target-high",
      targetEffort: "high",
      enabled: true,
    },
  ])

  const initialRedirect = await applyModelRedirect({
    model: "claude-source",
    effort: "high",
  })
  expect(initialRedirect).toMatchObject({
    model: "claude-target-medium",
  })

  await moveModelRedirect("high-rule", "up")

  const reorderedRedirect = await applyModelRedirect({
    model: "claude-source",
    effort: "high",
  })
  expect(reorderedRedirect).toMatchObject({
    model: "claude-target-high",
  })
})

test("does not report conflicts when specific effort rules precede catch-all fallback", async () => {
  setModelRedirectsForTest([
    {
      id: "medium-rule",
      name: "Medium",
      sourceModel: "claude-source",
      sourceEffort: "medium",
      targetModel: "claude-implicit-medium",
      enabled: true,
    },
    {
      id: "all-rule",
      name: "All",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target-1m",
      enabled: true,
    },
    {
      id: "disabled-rule",
      sourceModel: "claude-source",
      sourceEffort: "medium",
      targetModel: "ignored",
      enabled: false,
    },
  ])

  const rules = await getAllModelRedirects()

  expect(rules.find((rule) => rule.id === "medium-rule")?.conflicts).toEqual([])
  expect(rules.find((rule) => rule.id === "all-rule")?.conflicts).toEqual([])
  expect(rules.find((rule) => rule.id === "disabled-rule")?.conflicts).toEqual(
    [],
  )
})

test("reports conflicts when earlier rules fully shadow a later rule", async () => {
  setModelRedirectsForTest([
    {
      id: "all-rule",
      name: "All",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target",
      enabled: true,
    },
    {
      id: "high-rule",
      name: "High",
      sourceModel: "claude-source",
      sourceEffort: "high",
      targetModel: "claude-target-high",
      enabled: true,
    },
  ])

  const rules = await getAllModelRedirects()

  expect(rules.find((rule) => rule.id === "all-rule")?.conflicts).toEqual([])
  expect(rules.find((rule) => rule.id === "high-rule")?.conflicts).toEqual([
    { id: "all-rule", name: "All" },
  ])
})

test("parses max suffixes for unknown models so redirects can match them", () => {
  expect(parseModelSuffix("claude-source-1m:max")).toEqual({
    baseModel: "claude-source-1m",
    reasoningEffort: "max",
  })
})

test("clamps configurable implicit-default model suffixes to medium", () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  expect(parseModelSuffix("claude-implicit-medium:high")).toEqual({
    baseModel: "claude-implicit-medium",
    reasoningEffort: "medium",
  })
})
