import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ModelFallbackConfig } from "~/lib/model-fallback-config"
import type { ModelRedirectRule } from "~/lib/model-redirect"
import type { ReasoningEffort } from "~/lib/model-suffix"
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { getModelFallbackIdentity } from "~/lib/model-fallback-identity"
import {
  applyModelRedirect,
  setModelRedirectsForTest,
} from "~/lib/model-redirect"
import {
  analyzeModelRoutingSafety,
  getModelRoutingSafety,
} from "~/lib/model-routing-safety"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { normalizeReasoningEffortForModel } from "~/lib/model-suffix"
import { state } from "~/lib/state"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const originalModels = state.models

function redirect(
  sourceModel: string,
  targetModel: string,
  extra: Partial<ModelRedirectRule> = {},
): ModelRedirectRule {
  return {
    id: `${sourceModel}-${targetModel}`,
    sourceModel,
    targetModel,
    sourceEffort: "all",
    enabled: true,
    ...extra,
  }
}

function fallbacks(edges: Array<[string, string]>): ModelFallbackConfig {
  return validateModelFallbackConfig({
    enabled: true,
    rules: edges.map(([sourceModel, targetModel]) => ({
      id: `${sourceModel}-${targetModel}`,
      sourceModel,
      targetModel,
    })),
  })
}

function configureNormalizationPath(target = "gpt-5.2") {
  const redirects = [
    redirect("b", target, {
      sourceEffort: "medium",
      targetEffort: "xhigh",
    }),
    redirect("d", "a", {
      sourceEffort: "medium",
      targetEffort: "medium",
    }),
  ]
  const config = fallbacks([
    ["a", "b"],
    [target, "d"],
  ])
  setModelRedirectsForTest(redirects)
  setModelFallbackConfigForTest(config)
  return { redirects, config }
}

function model(id: string, supportedEfforts: Array<ReasoningEffort>): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: {
      family: "gpt",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: { reasoning_effort: supportedEfforts },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

beforeEach(() => {
  state.models = { object: "list", data: [] }
  setConfigForTest({
    customProviders: [
      {
        id: "routing-aliases",
        name: "Routing aliases",
        type: "openai-compatible",
        baseUrl: "https://routing-fixture.invalid/v1",
        models: [
          { id: "shared", aliases: ["alias-a", "alias-b"], kind: "chat" },
        ],
      },
    ],
  })
  setModelSettingsForTest([])
  setModelRedirectsForTest([])
  setModelFallbackConfigForTest(validateModelFallbackConfig({}))
})

afterEach(() => {
  state.models = originalModels
  setConfigForTest(null)
  setModelSettingsForTest([])
  setModelRedirectsForTest([])
  setModelFallbackConfigForTest(null)
})

test.each([
  ["alias-a", false],
  ["alias-a", true],
  ["alias-b", false],
  ["alias-b", true],
] as const)(
  "detects a mixed return to %s with fallback order reversed=%j",
  (target, reversed) => {
    const config = fallbacks([
      ["alias-a", "terminal"],
      ["alias-b", "bridge"],
    ])
    if (reversed) config.rules.reverse()
    const redirects = [redirect("bridge", target)]
    expect(
      analyzeModelRoutingSafety(redirects, config, getModelFallbackIdentity),
    ).toMatchObject({ safe: false, loop: { kind: "combined" } })

    setModelRedirectsForTest(redirects)
    setModelFallbackConfigForTest(config)
    expect(getModelRoutingSafety()).toMatchObject({
      safe: false,
      loop: { kind: "combined" },
    })
  },
)

test("detects an alias revisit beyond a previously completed intermediate state", () => {
  const config = fallbacks([
    ["middle", "bridge"],
    ["alias-b", "middle"],
  ])
  expect(
    analyzeModelRoutingSafety(
      [redirect("bridge", "alias-a")],
      config,
      getModelFallbackIdentity,
    ),
  ).toMatchObject({ safe: false, loop: { kind: "combined" } })
})

test("allows alias paths that escape after changing effort", () => {
  const config = fallbacks([
    ["alias-a", "bridge"],
    ["alias-b", "terminal"],
  ])
  expect(
    analyzeModelRoutingSafety(
      [
        redirect("bridge", "alias-b", {
          sourceEffort: "low",
          targetEffort: "high",
        }),
      ],
      config,
      getModelFallbackIdentity,
    ),
  ).toEqual({ safe: true })
})

test("detects the medium/xhigh cycle only when effort normalization is supplied", () => {
  const { redirects, config } = configureNormalizationPath()
  expect(analyzeModelRoutingSafety(redirects, config)).toEqual({ safe: true })
  expect(
    analyzeModelRoutingSafety(redirects, config, {
      normalizeEffort: normalizeReasoningEffortForModel,
    }),
  ).toMatchObject({ safe: false, loop: { kind: "combined" } })
})

test("allows a normalized high-effort escape from the same rule graph", () => {
  const { redirects, config } = configureNormalizationPath()
  setModelSettingsForTest([
    { model: "gpt-5.2", defaultReasoningEffort: "high" },
  ])
  expect(
    analyzeModelRoutingSafety(redirects, config, {
      normalizeEffort: normalizeReasoningEffortForModel,
    }),
  ).toEqual({ safe: true })
  expect(getModelRoutingSafety()).toEqual({ safe: true })
})

test("normalizes after an ordered redirect chain instead of between its rules", () => {
  const redirects = [
    redirect("b", "gpt-5.2", {
      sourceEffort: "medium",
      targetEffort: "xhigh",
    }),
    redirect("gpt-5.2", "a", {
      sourceEffort: "medium",
      targetEffort: "medium",
    }),
  ]
  expect(
    analyzeModelRoutingSafety(redirects, fallbacks([["a", "b"]]), {
      normalizeEffort: normalizeReasoningEffortForModel,
    }),
  ).toEqual({ safe: true })
})

test("runtime normalization bypasses unrelated redirects when it closes a cycle", async () => {
  const { redirects } = configureNormalizationPath()
  setModelRedirectsForTest([...redirects, redirect("unrelated", "routed")])
  expect(getModelRoutingSafety()).toMatchObject({
    safe: false,
    loop: { kind: "combined" },
  })
  expect(await applyModelRedirect("unrelated")).toMatchObject({
    model: "unrelated",
    redirected: false,
  })
})

test("reasoning-default changes invalidate cached safety and restore valid routing", () => {
  configureNormalizationPath()
  setModelSettingsForTest([
    { model: "gpt-5.2", defaultReasoningEffort: "high" },
  ])
  expect(getModelRoutingSafety()).toEqual({ safe: true })
  setModelSettingsForTest([
    { model: "gpt-5.2", defaultReasoningEffort: "medium" },
  ])
  expect(getModelRoutingSafety()).toMatchObject({ safe: false })
  setModelSettingsForTest([
    { model: "gpt-5.2", defaultReasoningEffort: "high" },
  ])
  expect(getModelRoutingSafety()).toEqual({ safe: true })
})

test("supported-effort setting changes invalidate cached safety", () => {
  configureNormalizationPath("configured-target")
  setModelSettingsForTest([
    {
      model: "configured-target",
      supportedReasoningEfforts: ["medium", "xhigh"],
      defaultReasoningEffort: "medium",
    },
  ])
  expect(getModelRoutingSafety()).toEqual({ safe: true })
  setModelSettingsForTest([
    {
      model: "configured-target",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
    },
  ])
  expect(getModelRoutingSafety()).toMatchObject({ safe: false })
})

test("catalog reasoning changes invalidate cached safety without changing model IDs", () => {
  configureNormalizationPath("catalog-target")
  const target = model("catalog-target", ["medium", "xhigh"])
  state.models = { object: "list", data: [target] }
  expect(getModelRoutingSafety()).toEqual({ safe: true })
  target.capabilities.supports.reasoning_effort = ["medium"]
  expect(getModelRoutingSafety()).toMatchObject({ safe: false })
  target.capabilities.supports.reasoning_effort = ["medium", "xhigh"]
  expect(getModelRoutingSafety()).toEqual({ safe: true })
})
