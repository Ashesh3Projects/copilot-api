/* eslint-disable max-lines -- discovery fixture and route contracts stay together */
import { afterAll, beforeEach, expect, mock, test } from "bun:test"

import type { Model, ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import {
  buildModelDiscoveryListings,
  modelRoutes,
} from "../src/routes/models/route"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalModels = state.models
const originalFetch = globalThis.fetch

test("serves model discovery at the Google v1beta collection route", async () => {
  state.models = { object: "list", data: [currentModel] }
  state.copilotToken = "copilot-token"

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1beta/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    object: "list",
    data: [{ id: "gpt-current" }],
    models: [
      {
        name: "models/gpt-current",
        displayName: "GPT Current",
        supportedGenerationMethods: [
          "generateContent",
          "streamGenerateContent",
          "countTokens",
        ],
      },
    ],
  })
})

function restoreCopilotToken(token: string | undefined): void {
  state.copilotToken = token
}

const currentCapabilities = {
  family: "gpt",
  limits: {},
  object: "model_capabilities",
  supports: {},
  tokenizer: "cl100k_base",
  type: "chat",
} satisfies Model["capabilities"]

const currentModel = {
  id: "gpt-current",
  name: "GPT Current",
  object: "model",
  version: "2026-08-01",
  vendor: "OpenAI",
  model_picker_enabled: true,
  auto: true,
  is_chat_default: true,
  is_chat_fallback: false,
  info_messages: [{ type: "info", message: "current" }],
  billing: {
    auto_discount: 0.5,
    token_prices: {
      batch_size: 1_000_000,
      default: {
        input_price: 17.5,
        output_price: 90.25,
        cache_read_price: 1.75,
        cache_write_price: 21.875,
        cache_write_1h_price: 35.5,
        max_prompt_tokens: 128_000,
      },
    },
  },
  capabilities: currentCapabilities,
  supported_endpoints: ["/responses"],
} satisfies Model

const implicitPickerModel = {
  id: "gpt-picker-implicit-visible",
  name: "GPT Picker Implicit Visible",
  object: "model",
  preview: false,
  vendor: "openai",
  version: "1",
  capabilities: {
    family: "gpt",
    limits: {},
    object: "model_capabilities",
    supports: {},
    tokenizer: "cl100k_base",
    type: "chat",
  },
  supported_endpoints: ["/responses"],
} satisfies Model

interface ModelsRouteEntry {
  id: string
  alias?: boolean
  billing?: {
    token_prices?: {
      long_context?: {
        context_max?: number
      }
    }
  }
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number
      max_output_tokens?: number
      max_prompt_tokens?: number
    }
  }
  canonical_id?: string
  model_picker_category?: string
  model_picker_price_category?: string
  name?: string
  preview?: boolean
  supports_1m_context?: boolean
  thinking?: {
    effort_options?: Array<{
      id: string
      name: string
      recommended?: boolean
    }>
  }
  vendor?: string
  version?: string
}

async function getModelsRouteEntries(): Promise<Array<ModelsRouteEntry>> {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  const body = (await response.json()) as {
    data: Array<ModelsRouteEntry>
  }
  return body.data
}

function requireModel(
  models: Array<ModelsRouteEntry>,
  id: string,
): ModelsRouteEntry {
  const model = models.find((entry) => entry.id === id)
  expect(model).toBeDefined()
  if (!model) {
    throw new Error(`Expected model ${id} in /v1/models response`)
  }
  return model
}

function expectLongContextMetadata(model: ModelsRouteEntry): void {
  expect(model.capabilities?.limits).toEqual({
    max_context_window_tokens: 1_000_000,
    max_output_tokens: 32_000,
    max_prompt_tokens: 968_000,
  })
  expect(model.billing?.token_prices?.long_context?.context_max).toBe(968_000)
  expect(model.vendor).toBe("anthropic")
  expect(model.model_picker_category).toBe("powerful")
  expect(model.model_picker_price_category).toBe("high")
}

beforeEach(() => {
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: {
            max_context_window_tokens: 1_000_000,
            max_output_tokens: 32_000,
            max_prompt_tokens: 968_000,
          },
          object: "model_capabilities",
          supports: {
            reasoning_effort: ["low", "medium", "high", "max"],
          },
          tokenizer: "cl100k_base",
          type: "chat",
        },
        billing: {
          token_prices: {
            batch_size: 1000,
            default: {
              context_max: 168_000,
              input_price: 3,
              output_price: 15,
            },
            long_context: {
              context_max: 968_000,
              input_price: 6,
              output_price: 22.5,
            },
          },
        },
        model_picker_category: "powerful",
        model_picker_price_category: "high",
        supported_endpoints: ["/responses"],
      },
      {
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: {
            max_context_window_tokens: 1_000_000,
            max_output_tokens: 32_000,
            max_prompt_tokens: 968_000,
          },
          object: "model_capabilities",
          supports: {
            reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
          },
          tokenizer: "cl100k_base",
          type: "chat",
        },
        supported_endpoints: ["/responses"],
      },
      {
        id: "claude-opus-4.7-1m-internal",
        name: "Claude Opus 4.7 1M Internal",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: false,
        capabilities: {
          family: "claude",
          limits: {
            max_context_window_tokens: 1_000_000,
            max_output_tokens: 32_000,
            max_prompt_tokens: 968_000,
          },
          object: "model_capabilities",
          supports: {
            reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
          },
          tokenizer: "cl100k_base",
          type: "chat",
        },
        supported_endpoints: ["/chat/completions"],
      },
      {
        id: "claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
      {
        id: "gpt-5.2",
        name: "GPT-5.2",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: false,
        policy: {
          state: "enabled",
          terms: "allowed",
        },
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
        supported_endpoints: ["/responses", "ws:/responses"],
      },
      {
        id: "claude-implicit-medium",
        name: "Claude Implicit Medium",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
        supported_endpoints: ["/chat/completions"],
      },
      {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: false,
        policy: {
          state: "disabled",
          terms: "blocked",
        },
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
      structuredClone(implicitPickerModel),
      structuredClone(currentModel),
    ],
  } satisfies ModelsResponse
  setModelSettingsForTest([])
  setModelRedirectsForTest([])
})

afterAll(() => {
  state.models = originalModels
  setModelRedirectsForTest([])
})

test("shows models unless picker metadata explicitly disables them without enabled policy", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )

  expect(response.status).toBe(200)

  const body = (await response.json()) as {
    data: Array<{ id: string }>
  }
  const ids = body.data.map((model) => model.id)

  expect(ids).toContain("claude-sonnet-4.6")
  expect(ids).toContain("claude-sonnet-4.6:high")
  expect(ids).toContain("claude-sonnet-4.6:max")
  expect(ids).toContain("gpt-5.2")
  expect(ids).toContain("gpt-5.2:medium")
  expect(ids).toContain("gpt-picker-implicit-visible")
  expect(ids).not.toContain("claude-opus-4.7-1m-internal")
  expect(ids).not.toContain("claude-opus-4.7-1m-internal:high")
  expect(ids).not.toContain("gpt-5-mini")
  expect(ids).not.toContain("gpt-5-mini:high")
})

test("handles visible Copilot models without limits metadata", async () => {
  state.models?.data.push({
    id: "gpt-no-limits",
    name: "GPT No Limits",
    object: "model",
    preview: false,
    vendor: "openai",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: "gpt",
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  })

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  const body = (await response.json()) as {
    data: Array<{ id: string; supports_1m_context?: boolean }>
  }
  const model = body.data.find((entry) => entry.id === "gpt-no-limits")

  expect(response.status).toBe(200)
  expect(model).toBeDefined()
  expect(model?.supports_1m_context).toBeUndefined()
})

test("uses model settings to hide virtual variants for implicit reasoning defaults", async () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  const body = (await response.json()) as {
    data: Array<{ id: string }>
  }
  const ids = body.data.map((model) => model.id)

  expect(ids).toContain("claude-implicit-medium")
  expect(ids).not.toContain("claude-implicit-medium:medium")
})

test("advertises ws:/responses only for native Responses models", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  const body = (await response.json()) as {
    data: Array<{ id: string; supported_endpoints?: Array<string> }>
  }

  const claude = body.data.find((model) => model.id === "claude-sonnet-4.6")
  const claudeHigh = body.data.find(
    (model) => model.id === "claude-sonnet-4.6:high",
  )
  const gpt = body.data.find((model) => model.id === "gpt-5.2")
  const gptMedium = body.data.find((model) => model.id === "gpt-5.2:medium")
  const chatOnly = body.data.find(
    (model) => model.id === "claude-implicit-medium",
  )

  expect(claude?.supported_endpoints).toEqual(["/responses", "ws:/responses"])
  expect(claudeHigh?.supported_endpoints).toEqual([
    "/responses",
    "ws:/responses",
  ])
  expect(gpt?.supported_endpoints).toEqual(["/responses", "ws:/responses"])
  expect(gptMedium?.supported_endpoints).toEqual([
    "/responses",
    "ws:/responses",
  ])
  expect(chatOnly?.supported_endpoints).toEqual(["/chat/completions"])
})

test("isolates chat-only endpoint arrays from upstream model state", async () => {
  const listings = await buildModelDiscoveryListings()
  const listing = listings.find(
    (model) => model.id === "claude-implicit-medium",
  )
  const upstream = state.models?.data.find(
    (model) => model.id === "claude-implicit-medium",
  )

  expect(listing?.supported_endpoints).toEqual(["/chat/completions"])
  listing?.supported_endpoints?.push("/mutated")

  expect(upstream?.supported_endpoints).toEqual(["/chat/completions"])
})

test("isolates virtual model nested metadata from upstream model state", async () => {
  const listings = await buildModelDiscoveryListings()
  const virtual = listings.find(
    (model) => model.id === "claude-sonnet-4.6:high",
  )
  const upstream = state.models?.data.find(
    (model) => model.id === "claude-sonnet-4.6",
  )

  virtual?.capabilities?.supports.reasoning_effort?.push("mutated")
  const virtualBilling = virtual?.billing as {
    token_prices: { default: { input_price: number } }
  }
  virtualBilling.token_prices.default.input_price = 999

  expect(upstream?.capabilities.supports.reasoning_effort).toEqual([
    "low",
    "medium",
    "high",
    "max",
  ])
  expect(
    (
      upstream?.billing as {
        token_prices: { default: { input_price: number } }
      }
    ).token_prices.default.input_price,
  ).toBe(3)
})

test("preserves cumulative upstream model metadata", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  const body = (await response.json()) as {
    data: Array<Record<string, unknown>>
  }
  const model = body.data.find((entry) => entry.id === "gpt-current")

  expect(model).toMatchObject({
    auto: true,
    is_chat_default: true,
    is_chat_fallback: false,
    info_messages: [{ type: "info", message: "current" }],
    billing: {
      auto_discount: 0.5,
      token_prices: {
        default: {
          input_price: 17.5,
          cache_write_1h_price: 35.5,
        },
      },
    },
  })
})

test("serves the same normalized row from single-model discovery", async () => {
  const list = await seedProtocolDatabase().then(() =>
    server.request("/v1/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  const listBody = (await list.json()) as {
    data: Array<Record<string, unknown>>
  }
  const single = await seedProtocolDatabase().then(() =>
    server.request("/v1/models/gpt-current", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )

  expect(single.status).toBe(200)
  expect(await single.json()).toEqual(
    listBody.data.find((entry) => entry.id === "gpt-current"),
  )
})

test("keeps list and detail visibility consistent for omitted and explicit picker metadata", async () => {
  const listResponse = await seedProtocolDatabase().then(() =>
    server.request("/v1/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  const listBody = (await listResponse.json()) as {
    data: Array<Record<string, unknown>>
  }
  const implicit = listBody.data.find(
    (entry) => entry.id === "gpt-picker-implicit-visible",
  )
  expect(implicit).toBeDefined()

  const implicitDetail = await seedProtocolDatabase().then(() =>
    server.request("/v1/models/gpt-picker-implicit-visible", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  expect(implicitDetail.status).toBe(200)
  expect(await implicitDetail.json()).toEqual(implicit)

  expect(
    (
      await seedProtocolDatabase().then(() =>
        server.request("/v1/models/gpt-5.2", {
          headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
        }),
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await seedProtocolDatabase().then(() =>
        server.request("/v1/models/claude-opus-4.7-1m-internal", {
          headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
        }),
      )
    ).status,
  ).toBe(404)
  expect(
    (
      await seedProtocolDatabase().then(() =>
        server.request("/v1/models/gpt-5-mini", {
          headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
        }),
      )
    ).status,
  ).toBe(404)
})

test("returns a safe not-found error for an unknown single model", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/models/not-real", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: { message: "Model not found", type: "not_found_error" },
  })
})

test("adapts single-model discovery failures through the safe gateway error boundary", async () => {
  const privateMarker = "single-model-upstream-private-marker"
  const originalCopilotToken = state.copilotToken
  state.models = undefined
  state.copilotToken = "test-copilot-token"
  const fetchMock = mock(() =>
    Promise.resolve(
      Response.json(
        { error: { message: privateMarker } },
        { status: 400, statusText: "Bad Request" },
      ),
    ),
  )
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  })

  try {
    const response = await modelRoutes.request("/gpt-current")
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).toContain(privateMarker)
    expect(JSON.parse(body)).toEqual({
      error: { message: privateMarker },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  } finally {
    globalThis.fetch = originalFetch
    restoreCopilotToken(originalCopilotToken)
  }
})

test("preserves Copilot model limits and long-context billing metadata", async () => {
  const models = await getModelsRouteEntries()
  const claude = requireModel(models, "claude-sonnet-4.6")

  expectLongContextMetadata(claude)
  expect(claude.version).toBe("1")
  expect(claude.preview).toBe(false)
  expect(claude.name).toBe("Claude Sonnet 4.6")
})

test("preserves Copilot metadata on virtual reasoning models", async () => {
  const models = await getModelsRouteEntries()
  const claudeHigh = requireModel(models, "claude-sonnet-4.6:high")

  expectLongContextMetadata(claudeHigh)
})

test("advertises Cowork 1M and reasoning metadata for Claude models", async () => {
  const models = await getModelsRouteEntries()
  const sonnet = requireModel(models, "claude-sonnet-4.6")
  const sonnet1m = requireModel(models, "claude-sonnet-4.6[1m]")
  const opus = requireModel(models, "claude-opus-4.8")
  const opusDash = requireModel(models, "claude-opus-4-8")
  const opusDash1m = requireModel(models, "claude-opus-4-8[1m]")
  const haiku = requireModel(models, "claude-haiku-4.5")

  expect(sonnet.supports_1m_context).toBe(true)
  expect(sonnet1m).toMatchObject({
    canonical_id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6 (1M context)",
  })
  expect(sonnet1m.alias).toBeUndefined()
  expect(sonnet1m.supports_1m_context).toBeUndefined()
  expect(sonnet.thinking?.effort_options).toContainEqual({
    id: "medium",
    name: "medium",
    recommended: true,
  })
  expect(opus.supports_1m_context).toBe(true)
  expect(opus.thinking?.effort_options?.map((option) => option.id)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
  expect(opus.thinking?.effort_options).toContainEqual({
    id: "high",
    name: "high",
    recommended: true,
  })
  expect(opusDash).toMatchObject({
    alias: true,
    canonical_id: "claude-opus-4.8",
    supports_1m_context: true,
    thinking: opus.thinking,
  })
  expect(opusDash1m).toMatchObject({
    canonical_id: "claude-opus-4-8",
    name: "Claude Opus 4.8 (1M context)",
  })
  expect(opusDash1m.alias).toBeUndefined()
  expect(opusDash1m.supports_1m_context).toBeUndefined()
  expect(haiku.supports_1m_context).toBeUndefined()
})

test("advertises enabled redirect source models using resolved target metadata", async () => {
  setModelRedirectsForTest([
    {
      id: "gpet-to-alias",
      sourceModel: "claude-gpet-5.5",
      sourceEffort: "all",
      targetModel: "gpt-5.5-alias",
      enabled: true,
    },
    {
      id: "alias-to-gpt",
      sourceModel: "gpt-5.5-alias",
      sourceEffort: "all",
      targetModel: "gpt-5.5",
      enabled: true,
    },
    {
      id: "fallback-to-opus",
      sourceModel: "fallback-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.8",
      targetEffort: "max",
      enabled: true,
    },
    {
      id: "disabled-custom",
      sourceModel: "disabled-custom-model",
      sourceEffort: "all",
      targetModel: "gpt-5.5",
      enabled: false,
    },
  ])

  const models = await getModelsRouteEntries()
  const ids = models.map((model) => model.id)
  const gpet = requireModel(models, "claude-gpet-5.5")
  const fallback = requireModel(models, "fallback-opus-4.7")

  expect(gpet).toMatchObject({
    alias: true,
    canonical_id: "gpt-5.5",
    name: "GPT-5.5",
    vendor: "openai",
  })
  expect(fallback).toMatchObject({
    alias: true,
    canonical_id: "claude-opus-4.8:max",
    name: "Claude Opus 4.8 (max thinking)",
    vendor: "anthropic",
  })
  expect(ids).not.toContain("disabled-custom-model")
})

test("advertises redirect sources that resolve to hidden Copilot target models", async () => {
  setModelRedirectsForTest([
    {
      id: "fallback-to-hidden",
      sourceModel: "fallback-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
  ])

  const models = await getModelsRouteEntries()
  const ids = models.map((model) => model.id)
  const fallback = requireModel(models, "fallback-opus-4.7")

  expect(fallback).toMatchObject({
    alias: true,
    canonical_id: "claude-opus-4.7-1m-internal",
    name: "Claude Opus 4.7 1M Internal",
    supports_1m_context: true,
    vendor: "anthropic",
  })
  expect(fallback.thinking?.effort_options?.map((option) => option.id)).toEqual(
    ["low", "medium", "high", "xhigh", "max"],
  )
  expect(ids).not.toContain("claude-opus-4.7-1m-internal")
  expect(ids).not.toContain("fallback-opus-4.7[1m]")
})

test("advertises Claude dash aliases for dotted Claude model IDs", async () => {
  const models = await getModelsRouteEntries()
  const sonnet = requireModel(models, "claude-sonnet-4-6")
  const sonnetHigh = requireModel(models, "claude-sonnet-4-6:high")
  const opus = requireModel(models, "claude-opus-4-8")
  const haiku = requireModel(models, "claude-haiku-4-5")

  expect(sonnet).toMatchObject({
    alias: true,
    canonical_id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
  })
  expect(sonnetHigh).toMatchObject({
    alias: true,
    canonical_id: "claude-sonnet-4.6:high",
    name: "Claude Sonnet 4.6 (high thinking)",
  })
  expect(opus).toMatchObject({
    alias: true,
    canonical_id: "claude-opus-4.8",
    name: "Claude Opus 4.8",
  })
  expect(haiku).toMatchObject({
    alias: true,
    canonical_id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
  })
})
