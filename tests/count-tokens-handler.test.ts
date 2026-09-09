import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { RoutingAffinity } from "../src/lib/routing-affinity"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { getAccountsService } from "../src/lib/accounts-service"
import { setConfigForTest } from "../src/lib/config"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { getRoutingAffinity } from "../src/lib/routing-affinity"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const originalGithubToken = state.githubToken
const originalApiKeyAuth = state.apiKeyAuth
const originalIsMultiToken = state.isMultiToken
const originalManualApprove = state.manualApprove

interface CapturedRequest {
  body: Record<string, unknown>
  headers: Headers
  path: string
  routingAffinity?: RoutingAffinity
  signal?: AbortSignal | null
}

let capturedRequests: Array<CapturedRequest>
let responseFactory: () => Response

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected native count-tokens JSON body")
  }
  capturedRequests.push({
    body: JSON.parse(init.body) as Record<string, unknown>,
    headers: new Headers(init.headers),
    path: new URL(url instanceof Request ? url.url : url).pathname,
    routingAffinity: getRoutingAffinity(),
    signal: init.signal,
  })
  return responseFactory()
})

const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-opus-4.7-1m-internal",
      name: "Claude Opus 4.7 1M Internal",
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
      name: "GPT 5.5",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "gpt-5.5",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    },
  ],
}

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  setConfigForTest(null)
  state.models = originalModels
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  state.githubToken = originalGithubToken
  state.apiKeyAuth = originalApiKeyAuth
  state.isMultiToken = originalIsMultiToken
  state.manualApprove = originalManualApprove
})

beforeEach(() => {
  fetchMock.mockClear()
  capturedRequests = []
  responseFactory = () => Response.json({ input_tokens: 42 })
  setModelRedirectsForTest([])
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "custom-count",
        name: "Custom Count",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "custom-key",
        models: [
          {
            id: "custom-count-model",
            aliases: ["custom-count-alias"],
            kind: "chat",
          },
        ],
      },
    ],
  })
  state.models = models
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.apiKeyAuth = undefined
  state.isMultiToken = false
  state.manualApprove = false
})

async function requestCountTokens(options?: {
  body?: Record<string, unknown>
  headers?: Record<string, string>
  model?: string
}): Promise<Response> {
  const catalogUnavailable = state.models === undefined
  await seedProtocolDatabase()
  await getAccountsService().refreshRuntime()
  // Populate persisted accounts first, then model the explicit discovery outage.
  // eslint-disable-next-line require-atomic-updates -- This isolated fixture deliberately replaces the discovery snapshot.
  if (catalogUnavailable) state.models = undefined
  return await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
      ...options?.headers,
    },
    body: JSON.stringify({
      model: options?.model ?? "claude-opus-4.7-1m-internal",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
      ...options?.body,
    }),
  })
}

test("count_tokens strips a reasoning suffix and returns the upstream count", async () => {
  responseFactory = () => Response.json({ input_tokens: 37 })

  const response = await requestCountTokens({
    model: "claude-opus-4.7-1m-internal:xhigh",
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 37 })
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.path).toBe("/v1/messages/count_tokens")
  expect(capturedRequests[0]?.body).toEqual({
    model: "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: "Hello" }],
  })
})

test.each([
  ["string", "32"],
  ["null", null],
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
] as const)(
  "count_tokens ignores present invalid max_tokens: %s",
  async (_name, maxTokens) => {
    const response = await requestCountTokens({
      body: { max_tokens: maxTokens },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 42 })
    expect(capturedRequests).toHaveLength(1)
    expect(capturedRequests[0]?.path).toBe("/v1/messages/count_tokens")
    expect(capturedRequests[0]?.body).toEqual({
      model: "claude-opus-4.7-1m-internal",
      messages: [{ role: "user", content: "Hello" }],
    })
  },
)

test("count_tokens preserves system and future roles plus unknown native structures", async () => {
  const futureBlock = {
    type: "future_native_block_20270101",
    future_payload: { enabled: true },
  }
  const futureTool = {
    name: "lookup",
    future_tool_field: { enabled: true },
  }

  const response = await requestCountTokens({
    body: {
      messages: [
        { role: "system", content: "bootstrap" },
        { role: "future-role", content: [futureBlock] },
      ],
      tools: [futureTool],
      future_native_field: { enabled: true },
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 42 })
  expect(capturedRequests[0]?.body).toEqual({
    model: "claude-opus-4.7-1m-internal",
    messages: [
      { role: "system", content: "bootstrap" },
      { role: "future-role", content: [futureBlock] },
    ],
    tools: [futureTool],
  })
})

test("count_tokens rejects an all-invalid message list after sanitization", async () => {
  const response = await requestCountTokens({ body: { messages: [null] } })

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    type: "error",
    error: {
      message: "messages is required for Messages requests.",
      param: "messages",
    },
  })
  expect(capturedRequests).toHaveLength(0)
})

test("count_tokens drops malformed optional controls and invalid optional headers", async () => {
  const response = await requestCountTokens({
    headers: {
      "anthropic-beta": "PRIVATE_COUNT_BETA value",
      "anthropic-version": "PRIVATE_COUNT_VERSION\u007f",
      "x-model-provider-preference": "PRIVATE_COUNT_PROVIDER\u007f",
    },
    body: {
      metadata: "private",
      tool_choice: null,
      thinking: true,
      output_config: "high",
      system: ["not-a-block"],
      stop_sequences: ["good", 3],
      top_p: "0.8",
      stream: "yes",
      fallback_credit_token: 42,
      max_tokens: "32",
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 42 })
  expect(capturedRequests[0]?.body).toEqual({
    model: "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: "Hello" }],
  })
  expect(capturedRequests[0]?.headers.get("anthropic-beta")).toBeNull()
  expect(capturedRequests[0]?.headers.get("anthropic-version")).toBe(
    "2023-06-01",
  )
  expect(
    capturedRequests[0]?.headers.get("x-model-provider-preference"),
  ).toBeNull()
})

test("count_tokens forwards prepared native headers", async () => {
  const response = await requestCountTokens({
    headers: {
      "anthropic-beta":
        " interleaved-thinking-2025-05-14, context-management-2025-06-27, interleaved-thinking-2025-05-14 ",
      "anthropic-version": "2024-01-01",
      "x-model-provider-preference": "anthropic",
    },
  })

  expect(response.status).toBe(200)
  const headers = capturedRequests[0]?.headers
  expect(headers.get("anthropic-beta")).toBe(
    "interleaved-thinking-2025-05-14,context-management-2025-06-27",
  )
  expect(headers.get("anthropic-version")).toBe("2024-01-01")
  expect(headers.get("x-model-provider-preference")).toBe("anthropic")
})

test("count_tokens filters unsupported beta flags before native dispatch", async () => {
  const response = await requestCountTokens({
    headers: {
      "anthropic-beta":
        "tool-search-tool-2025-10-19,context-1m-2025-08-07,interleaved-thinking-2025-05-14,files-api-2025-04-14,unknown-beta",
      "x-stainless-runtime": "node",
    },
  })

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.path).toBe("/v1/messages/count_tokens")
  expect(capturedRequests[0]?.headers.get("anthropic-beta")).toBe(
    "advanced-tool-use-2025-11-20,interleaved-thinking-2025-05-14",
  )
  expect(capturedRequests[0]?.headers.get("x-stainless-runtime")).toBeNull()
})

test("count_tokens uses the redirected target model upstream", async () => {
  setModelRedirectsForTest([
    {
      id: "claude-gpt-to-gpt",
      sourceModel: "claude-gpt-5.5",
      sourceEffort: "all",
      targetModel: "gpt-5.5",
      enabled: true,
    },
  ])
  responseFactory = () => Response.json({ input_tokens: 53 })

  const response = await requestCountTokens({
    model: "claude-gpt-5.5:xhigh",
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 53 })
  expect(capturedRequests[0]?.body).toHaveProperty("model", "gpt-5.5")
})

test("count_tokens installs metadata affinity unless a header wins", async () => {
  const body = {
    metadata: {
      user_id: JSON.stringify({ session_id: "count-body-session" }),
    },
  }

  await requestCountTokens({ body })
  await requestCountTokens({
    body,
    headers: { "x-client-session-id": "count-header-session" },
  })

  expect(capturedRequests.map((request) => request.routingAffinity)).toEqual([
    { key: "count-body-session", source: "claude_metadata" },
    { key: "count-header-session", source: "copilot_session" },
  ])
})

test("count_tokens forwards the request abort signal upstream", async () => {
  await requestCountTokens()

  expect(capturedRequests[0]?.signal).toBeInstanceOf(AbortSignal)
})

test("count_tokens returns an Anthropic model-not-found error", async () => {
  const response = await requestCountTokens({ model: "missing-model" })

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "not_found_error",
      code: "model_not_found",
      message: "The requested Copilot Messages model was not found.",
      param: "model",
    },
  })
  expect(capturedRequests).toHaveLength(0)
})

test("count_tokens uses the normalized requested model while the catalog is unavailable", async () => {
  state.models = undefined
  responseFactory = () => Response.json({ input_tokens: 61 })

  const response = await requestCountTokens({ model: "claude-opus-4-7" })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 61 })
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.path).toBe("/v1/messages/count_tokens")
  expect(capturedRequests[0]?.body).toEqual({
    model: "claude-opus-4.7",
    messages: [{ role: "user", content: "Hello" }],
  })
})

test("count_tokens preserves upstream failures while the catalog is unavailable", async () => {
  state.models = undefined
  const upstreamBody = '{"private":"catalog-outage-upstream"}\n'
  responseFactory = () =>
    new Response(upstreamBody, {
      status: 409,
      headers: { "content-type": "application/problem+json" },
    })

  const response = await requestCountTokens({ model: "claude-opus-4-7" })

  expect(response.status).toBe(409)
  expect(response.headers.get("content-type")).toBe("application/problem+json")
  expect(await response.text()).toBe(upstreamBody)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.body).toHaveProperty("model", "claude-opus-4.7")
})

test("count_tokens propagates an upstream HTTP status", async () => {
  responseFactory = () =>
    Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "private upstream" },
      },
      {
        status: 400,
        headers: {
          "retry-after": "17",
          "x-quota-snapshot-premium_interactions": "remaining=0;limit=100",
        },
      },
    )

  const response = await requestCountTokens({
    headers: { "x-request-id": "req-count-safe" },
  })
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(400)
  expect(body).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "private upstream",
    },
  })
  expect(response.headers.get("retry-after")).toBe("17")
  expect(response.headers.get("x-quota-snapshot-premium_interactions")).toBe(
    "remaining=0;limit=100",
  )
  expect(JSON.stringify(body)).toContain("private upstream")
})

test("count_tokens estimates configured custom-provider models locally", async () => {
  const response = await requestCountTokens({ model: "custom-count-alias" })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 8 })
  expect(capturedRequests).toHaveLength(0)
})

test("count_tokens best-effort estimates custom-provider nested extensions", async () => {
  const marker = "PRIVATE_CUSTOM_COUNT_SCHEMA"
  const response = await requestCountTokens({
    model: "custom-count-alias",
    body: {
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: {},
            [marker]: true,
          },
        },
      ],
    },
  })
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(200)
  expect(body.input_tokens).toEqual(expect.any(Number))
  expect(capturedRequests).toHaveLength(0)
})

test.each([
  {
    name: "root",
    body: null,
    code: "invalid_type",
    param: "body",
  },
  {
    name: "model",
    body: { model: "" },
    code: "invalid_value",
    param: "model",
  },
  {
    name: "messages",
    body: { model: "claude-opus-4.7-1m-internal", messages: [] },
    code: "invalid_value",
    param: "messages",
  },
] as const)(
  "count_tokens returns machine metadata for malformed $name input",
  async ({ body, code, param }) => {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages/count_tokens", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    )
    const responseBody = await response.text()

    expect(response.status).toBe(400)
    expect(JSON.parse(responseBody)).toMatchObject({
      type: "error",
      error: { code, param, type: "invalid_request_error" },
    })
    expect(responseBody).not.toContain("missing_schema")
    expect(capturedRequests).toHaveLength(0)
  },
)

test("count_tokens preserves future native tools without local schema policing", async () => {
  const body = {
    model: "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "missing_schema" }],
  }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 42 })
  expect(capturedRequests[0]?.body).toEqual(body)
})

test("count_tokens preserves unnamed future native tools with nested fields", async () => {
  const futureTool = {
    type: "future_server_tool_20270101",
    config: { enabled: true, nested: { mode: "opaque" } },
  }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.7-1m-internal",
        messages: [{ role: "user", content: "hello" }],
        tools: [futureTool],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 42 })
  expect(capturedRequests[0]?.body).toEqual({
    model: "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: "hello" }],
    tools: [futureTool],
  })
})

test.each([
  [
    "opaque native tool records without name or type",
    {
      opaque: {
        enabled: true,
        nested: { mode: "opaque" },
      },
    },
  ],
  [
    "future native tool records with numeric names",
    {
      type: "future_server_tool_20270101",
      name: 3,
      config: { enabled: true, nested: { mode: "opaque" } },
    },
  ],
  [
    "future native tool records with blank names",
    {
      type: "future_server_tool_20270101",
      name: "   ",
      config: { enabled: true, nested: { mode: "opaque" } },
    },
  ],
] as const)("count_tokens preserves %s", async (_label, futureTool) => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.7-1m-internal",
        messages: [{ role: "user", content: "hello" }],
        tools: [futureTool],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 42 })
  expect(capturedRequests[0]?.body).toEqual({
    model: "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: "hello" }],
    tools: [futureTool],
  })
})

test("count_tokens rejects malformed whole message entries when none survive", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.7-1m-internal",
        messages: [null],
      }),
    }),
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    type: "error",
    error: { message: "messages is required for Messages requests." },
  })
  expect(capturedRequests).toHaveLength(0)
})

test("count_tokens drops malformed nested content instead of rejecting the request", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.7-1m-internal",
        messages: [{ role: "user", content: [null] }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 42 })
  expect(capturedRequests[0]?.body).toEqual({
    model: "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: [] }],
  })
})

test("count_tokens returns invalid_json metadata without raw input", async () => {
  const marker = "PRIVATE_COUNT_INVALID_JSON"
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: `{"model":"${marker}",`,
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(JSON.parse(body)).toMatchObject({
    type: "error",
    error: {
      code: "invalid_json",
      param: "body",
      type: "invalid_request_error",
    },
  })
  expect(body).not.toContain(marker)
  expect(capturedRequests).toHaveLength(0)
})
