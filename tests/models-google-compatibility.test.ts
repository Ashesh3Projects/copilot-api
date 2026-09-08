import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { setConfigForTest } from "../src/lib/config"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalModels = state.models
const originalFetch = globalThis.fetch
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
  version: "1",
  vendor: "openai",
  model_picker_enabled: true,
  capabilities: currentCapabilities,
  supported_endpoints: ["/responses"],
} satisfies Model

beforeEach(() => {
  state.models = {
    object: "list",
    data: [
      currentModel,
      { ...currentModel, id: "gpt-5-mini", model_picker_enabled: false },
    ],
  }
  setModelRedirectsForTest([])
})
afterEach(() => {
  globalThis.fetch = originalFetch
  setConfigForTest(null)
  state.models = originalModels
  setModelRedirectsForTest([])
})
test("Google model resource names round-trip through detail and countTokens", async () => {
  state.models = { object: "list", data: [currentModel] }
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1beta/models/gpt-current", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  expect(response.status).toBe(200)
  const model = (await response.json()) as { name: string }
  expect(model.name).toBe("models/gpt-current")
  const count = await seedProtocolDatabase().then(() =>
    server.request(`/v1beta/${model.name}:countTokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    }),
  )
  expect(count.status).toBe(200)
  expect(await count.json()).toHaveProperty("totalTokens")
  const generic = await seedProtocolDatabase().then(() =>
    server.request("/v1/models/gpt-current", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  expect(await generic.json()).toHaveProperty("name", "GPT Current")
})

test("Google collection names round-trip namespaced model identifiers", async () => {
  const rawId = "vendor/model-name"
  state.models = { object: "list", data: [{ ...currentModel, id: rawId }] }
  const collection = await seedProtocolDatabase().then(() =>
    server.request("/v1beta/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  const listing = (await collection.json()) as {
    models: Array<{ name: string }>
    data: Array<{ id: string }>
  }
  expect(listing.data[0].id).toBe(rawId)
  const name = listing.models[0].name
  const detail = await seedProtocolDatabase().then(() =>
    server.request(`/v1beta/${name}`, {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  expect(detail.status).toBe(200)
  expect(await detail.json()).toHaveProperty("id", rawId)
  const count = await seedProtocolDatabase().then(() =>
    server.request(`/v1beta/${name}:countTokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    }),
  )
  expect(count.status).toBe(200)
})

test("Google SDK namespaced custom model names reach the configured generation provider", async () => {
  state.models = { object: "list", data: [] }
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "google-namespaced",
        name: "Namespaced",
        type: "openai-compatible",
        baseUrl: "https://model-provider.invalid/v1",
        apiKey: "fake-key",
        models: [{ id: "vendor/model-name", kind: "chat" }],
      },
    ],
  })
  let sentModel: unknown
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected JSON request body")
    sentModel = (JSON.parse(init.body) as { model: unknown }).model
    return await Promise.resolve(
      Response.json({
        id: "call",
        object: "chat.completion",
        created: 1,
        model: sentModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
      }),
    )
  }) as typeof fetch
  const collection = await seedProtocolDatabase().then(() =>
    server.request("/v1beta/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  const listing = (await collection.json()) as {
    models: Array<{ name: string }>
  }
  const result = await seedProtocolDatabase().then(() =>
    server.request(`/v1beta/${listing.models[0].name}:generateContent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    }),
  )
  expect(result.status).toBe(200)
  expect(sentModel).toBe("vendor/model-name")
  expect(await result.json()).toHaveProperty("candidates")
})

test.each(["embedding", "embeddings"])(
  "Google discovery does not advertise generation for %s models",
  async (type) => {
    state.models = {
      object: "list",
      data: [
        {
          ...currentModel,
          capabilities: { ...currentCapabilities, type },
          supported_endpoints: ["/embeddings"],
        },
      ],
    }
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1beta/models", {
        headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
      }),
    )
    expect(await response.json()).toMatchObject({
      models: [{ name: "models/gpt-current", supportedGenerationMethods: [] }],
    })
  },
)

test("Google discovery exposes available limits without promising unadvertised inference", async () => {
  state.models = {
    object: "list",
    data: [
      {
        ...currentModel,
        capabilities: {
          ...currentCapabilities,
          limits: { max_prompt_tokens: 128000, max_output_tokens: 4096 },
        },
        supported_endpoints: [],
      },
    ],
  }
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1beta/models", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
  )
  expect(await response.json()).toMatchObject({
    models: [
      {
        inputTokenLimit: 128000,
        outputTokenLimit: 4096,
        supportedGenerationMethods: [],
      },
    ],
  })
})

test.each(["Copilot-Integration-Id", "Copilot-Harness-Id"])(
  "Copilot catalog preserves hidden utility models using %s",
  async (header) => {
    const headers = {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      [header]: "copilot-developer-cli",
    }
    const response = await seedProtocolDatabase().then(() =>
      server.request("/models", { headers }),
    )
    const body = (await response.json()) as {
      data: Array<{ id: string; model_picker_enabled?: boolean }>
    }
    expect(body.data.find((model) => model.id === "gpt-5-mini")).toMatchObject({
      model_picker_enabled: false,
    })
    const detail = await seedProtocolDatabase().then(() =>
      server.request("/models/gpt-5-mini", { headers }),
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      id: "gpt-5-mini",
      model_picker_enabled: false,
    })
    expect(
      (
        await seedProtocolDatabase().then(() =>
          server.request("/models/gpt-5-mini", {
            headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
          }),
        )
      ).status,
    ).toBe(404)
  },
)
