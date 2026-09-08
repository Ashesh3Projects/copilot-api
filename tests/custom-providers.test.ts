import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
/* eslint-disable max-lines -- hotfix extends an existing integration matrix */
import consola from "consola"

import type { LlmDebugLogEntry } from "../src/lib/llm-debug-log"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setReplacementsForTest } from "../src/lib/auto-replace"
import { setConfigForTest } from "../src/lib/config"
import {
  createCustomProviderChatCompletions,
  createCustomProviderEmbeddings,
  resolveCustomProviderModel,
} from "../src/lib/custom-providers"
import { HTTPError } from "../src/lib/error"
import {
  clearLlmDebugLogs,
  getLlmDebugLog,
  listLlmDebugLogs,
} from "../src/lib/llm-debug-log"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelRoutingOverridesForTest } from "../src/lib/model-routing"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { createAnthropicStreamError } from "../src/routes/messages/error"
import { server } from "../src/server"
import { resetWebSearchSessionsForTest } from "../src/services/copilot/mcp-web-search"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  TEST_GATEWAY_KEY,
} from "./helpers/admin-session"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

const originalFetch = globalThis.fetch
const originalCustomApiKey = process.env.CUSTOM_PROVIDER_API_KEY
const originalModels = state.models
const originalAccountType = state.accountType
const originalGitHubToken = state.githubToken
const originalGitHubInstanceDomain = state.githubInstanceDomain
const originalCopilotToken = state.copilotToken
const originalCopilotApiBaseUrl = state.copilotApiBaseUrl
const originalApiKeyAuth = state.apiKeyAuth
const originalIsMultiToken = state.isMultiToken
const customFastCollisionAccountId = 24_001

let fetchMock: ReturnType<typeof mock>
interface CapturedRequest {
  url: string
  body: Record<string, unknown>
  headers: Headers
}

interface ListedModel {
  id: string
  owned_by: string
  dimensions?: number
  alias?: boolean
  kind?: string
  supported_endpoints?: Array<string>
}

function createCustomProviderStreamChunk(
  finishReason: null | "stop",
  content?: string,
) {
  return {
    id: "custom-stream",
    object: "chat.completion.chunk",
    created: 1,
    model: "custom-chat-model",
    choices: [
      {
        index: 0,
        delta: content ? { role: "assistant", content } : {},
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  }
}

function createLateCustomProviderStreamResponse(upstream: Response): Response {
  const encoder = new TextEncoder()
  let emitted = false
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!emitted) {
          emitted = true
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(
                createCustomProviderStreamChunk(null, "partial"),
              )}\n\n`,
            ),
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.error(new HTTPError("late provider failure", upstream))
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

type RequestBodyCheck = (body: Record<string, unknown>) => void

let requests: Array<CapturedRequest>

const CUSTOM_HEADER_VALUE = "private-custom-header-value"

const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-copilot",
      name: "GPT Copilot",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "gpt",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
    {
      id: "text-embedding-3-small",
      name: "Text Embedding 3 Small",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "embedding",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "embedding",
      },
    },
  ],
}

useProtocolDatabase()

beforeAll(() => {
  fetchMock = mock((url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    const headers = new Headers(init?.headers)
    requests.push({ url, body, headers })

    if (url.includes("/embeddings")) {
      return Response.json({
        object: "list",
        model: body.model,
        data: [
          { object: "embedding", index: 0, embedding: Array(4096).fill(0.1) },
          { object: "embedding", index: 1, embedding: Array(4096).fill(0.2) },
        ],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      })
    }

    return Response.json({
      id: "chatcmpl-custom",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "custom" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(async () => {
  tokenPool.removeAccountForTest(customFastCollisionAccountId)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  restoreEnv("CUSTOM_PROVIDER_API_KEY", originalCustomApiKey)
  setConfigForTest(null)
  state.models = originalModels
  state.accountType = originalAccountType
  state.githubToken = originalGitHubToken
  state.githubInstanceDomain = originalGitHubInstanceDomain
  state.copilotToken = originalCopilotToken
  state.copilotApiBaseUrl = originalCopilotApiBaseUrl
  state.apiKeyAuth = originalApiKeyAuth
  state.isMultiToken = originalIsMultiToken
  await resetTestAdminSession()
})

beforeEach(async () => {
  tokenPool.removeAccountForTest(customFastCollisionAccountId)
  fetchMock.mockClear()
  requests = []
  await clearLlmDebugLogs()
  resetWebSearchSessionsForTest()
  process.env.CUSTOM_PROVIDER_API_KEY = "custom-key"
  state.models = models
  state.accountType = "individual"
  state.githubToken = undefined
  state.githubInstanceDomain = "github.com"
  state.copilotToken = "copilot-token"
  state.copilotApiBaseUrl = undefined
  state.apiKeyAuth = undefined
  state.isMultiToken = false
  resetRoutingTelemetryForTest()
  setModelRedirectsForTest([])
  setModelRoutingOverridesForTest({})
  setReplacementsForTest([])
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "nebius",
        name: "Nebius",
        type: "openai-compatible",
        baseUrl: "https://api.studio.nebius.com/v1",
        apiKey: "nebius-key",
        headers: { "X-Provider": "nebius" },
        models: [
          {
            id: "Qwen/Qwen3-Embedding-8B",
            aliases: ["qwen3-embedding-8b"],
            kind: "embedding",
            dimensions: 4096,
          },
        ],
      },
      {
        id: "custom-chat",
        name: "Custom Chat",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "custom-key",
        headers: {
          "X-Custom-Provider": "provider-only",
          "X-Custom-Trace": CUSTOM_HEADER_VALUE,
        },
        models: [
          {
            id: "custom-chat-model",
            aliases: ["custom-chat-alias"],
            kind: "chat",
            supportsStreaming: true,
          },
          {
            id: "custom-chat-model-fast",
            kind: "chat",
            supportsStreaming: true,
          },
          {
            id: "glm-5.2",
            kind: "chat",
            supportsStreaming: true,
            passReasoningEffort: true,
          },
          {
            id: "gpt-copilot",
            aliases: ["custom-collision-alias"],
            kind: "chat",
            supportsStreaming: true,
          },
        ],
      },
      {
        id: "zenmux",
        name: "ZenMux",
        type: "openai-compatible",
        baseUrl: "https://zenmux.example/v1",
        apiKey: "zenmux-key",
        models: [{ id: "z-ai/glm-5.3-free", kind: "chat" }],
      },
    ],
  })
})

test("custom provider resolution preserves alias, exact, collision, and kind precedence", () => {
  const copilotModelIds = new Set(["gpt-copilot"])
  expect(
    resolveCustomProviderModel({
      model: "custom-collision-alias",
      kind: "chat",
      copilotModelIds,
    }),
  ).toMatchObject({ matchedAlias: true, upstreamModel: "gpt-copilot" })
  expect(
    resolveCustomProviderModel({
      model: "gpt-copilot",
      kind: "chat",
      copilotModelIds,
    }),
  ).toBeUndefined()
  expect(
    resolveCustomProviderModel({
      model: "custom-chat-model",
      kind: "chat",
      copilotModelIds,
    }),
  ).toMatchObject({ matchedAlias: false, upstreamModel: "custom-chat-model" })
  expect(
    resolveCustomProviderModel({
      model: "qwen3-embedding-8b",
      kind: "chat",
      copilotModelIds,
    }),
  ).toBeUndefined()
  expect(
    resolveCustomProviderModel({
      model: "unknown-task-19d-model",
      kind: "chat",
      copilotModelIds,
    }),
  ).toBeUndefined()
})

test.each([
  {
    name: "Responses",
    customPath: "/v1/responses",
    customBody: { model: "custom-collision-alias", input: "hello" },
    exactPath: "/v1/responses",
    exactBody: { model: "gpt-copilot", input: "hello" },
    unknownPath: "/v1/responses",
    unknownBody: { model: "unknown-task-19d-model", input: "hello" },
  },
  {
    name: "Google",
    customPath: "/v1beta/models/custom-collision-alias:generateContent",
    customBody: {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
    exactPath: "/v1beta/models/gpt-copilot:generateContent",
    exactBody: {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
    unknownPath: "/v1beta/models/unknown-task-19d-model:generateContent",
    unknownBody: {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
  },
])(
  "$name mounted collision and unknown precedence",
  async ({
    customPath,
    customBody,
    exactPath,
    exactBody,
    unknownPath,
    unknownBody,
  }) => {
    const alias = await protocolRequest(customPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(customBody),
    })
    expect(alias.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://custom.example/v1/chat/completions")
    expect(requests[0]?.body.model).toBe("gpt-copilot")

    requests = []
    const exact = await protocolRequest(exactPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exactBody),
    })
    expect(exact.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).not.toBe(
      "https://custom.example/v1/chat/completions",
    )

    requests = []
    const unknown = await protocolRequest(unknownPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unknownBody),
    })
    expect(unknown.status).not.toBe(200)
    expect(requests).toHaveLength(0)
  },
)

test("custom Google applies detached replacements exactly once", async () => {
  setReplacementsForTest([
    {
      id: "task-19d-google-replacement",
      pattern: "PRIVATE_GOOGLE_REPLACEMENT",
      replacement: "PUBLIC_GOOGLE_REPLACEMENT",
      isRegex: false,
      enabled: true,
    },
  ])

  const response = await protocolRequest(
    "/v1beta/models/custom-chat-alias:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: "PRIVATE_GOOGLE_REPLACEMENT" }],
          },
        ],
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]?.body)).not.toContain(
    "PRIVATE_GOOGLE_REPLACEMENT",
  )
  expect(JSON.stringify(requests[0]?.body)).toContain(
    "PUBLIC_GOOGLE_REPLACEMENT",
  )
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    clearEnv(name)
    return
  }
  process.env[name] = value
}

function clearEnv(name: string): void {
  if (name === "NEBIUS_API_KEY") {
    delete process.env.NEBIUS_API_KEY
    return
  }
  if (name === "CUSTOM_PROVIDER_API_KEY") {
    delete process.env.CUSTOM_PROVIDER_API_KEY
  }
}

function routingSnapshot() {
  return getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
}

async function latestDebugLog(): Promise<LlmDebugLogEntry | undefined> {
  return await getLlmDebugLog((await listLlmDebugLogs()).entries[0]?.id ?? "")
}

async function waitForLatestDebugStatus(
  status: LlmDebugLogEntry["status"],
): Promise<LlmDebugLogEntry | undefined> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const entry = await latestDebugLog()
    if (entry?.status === status) return entry
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return latestDebugLog()
}

function expectChatDispatch(
  response: Response,
  bodyCheck: RequestBodyCheck,
  options?: {
    url?: string
    requestCount?: number
  },
) {
  const url = options?.url ?? "https://custom.example/v1/chat/completions"
  const requestCount = options?.requestCount ?? 1
  expect(response.status).toBe(200)
  expect(requests).toHaveLength(requestCount)
  const dispatched = requests.at(-1)
  expect(dispatched?.url).toBe(url)
  bodyCheck(dispatched?.body ?? {})
}

test("custom models appear in /v1/models with aliases and metadata", async () => {
  const response = await protocolRequest("/v1/models")
  const body = (await response.json()) as {
    data: Array<ListedModel>
  }

  expect(response.status).toBe(200)
  const canonicalModel: ListedModel = {
    id: "Qwen/Qwen3-Embedding-8B",
    owned_by: "Nebius",
    dimensions: 4096,
  }
  const aliasModel: ListedModel = {
    id: "qwen3-embedding-8b",
    owned_by: "Nebius",
    dimensions: 4096,
    alias: true,
  }
  expect(body.data).toContainEqual(
    expect.objectContaining(canonicalModel) as ListedModel,
  )
  expect(body.data).toContainEqual(
    expect.objectContaining(aliasModel) as ListedModel,
  )
  const customChat = body.data.find((entry) => entry.id === "custom-chat-model")
  const customAlias = body.data.find(
    (entry) => entry.id === "custom-chat-alias",
  )
  expect(customChat?.kind).toBe("chat")
  expect(customAlias?.alias).toBe(true)
  expect(customChat?.supported_endpoints ?? []).not.toContain("ws:/responses")
  expect(customAlias?.supported_endpoints ?? []).not.toContain("ws:/responses")
})

test("chat request routes to custom provider by model id", async () => {
  const infoSpy = spyOn(consola, "info")
  const response = await protocolRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
    }),
  })
  const body = (await response.json()) as { model: string }

  try {
    expect(response.status).toBe(200)
    expect(body.model).toBe("custom-chat-model")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://custom.example/v1/chat/completions")
    expect(requests[0]?.body.model).toBe("custom-chat-model")
    expect(requests[0]?.body.temperature).toBe(0.2)
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer custom-key")

    const debug = await waitForLatestDebugStatus("complete")
    expect(debug).toMatchObject({
      status: "complete",
      request: {
        method: "POST",
        path: "/chat/completions",
        url: "https://custom.example/v1/chat/completions",
        headers: {
          Authorization: "[REDACTED]",
          "X-Custom-Trace": "[REDACTED]",
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(requests[0]?.body),
      },
      response: { status: 200, statusText: "" },
    })
    expect(debug?.response?.headers["content-type"]).toContain(
      "application/json",
    )
    expect(debug?.response?.body).toContain('"id":"chatcmpl-custom"')

    const terminal = JSON.stringify(infoSpy.mock.calls)
    expect(terminal).toContain(
      "Custom provider request: Custom Chat/custom-chat/custom-chat-model POST /chat/completions",
    )
    expect(terminal).not.toContain("custom-key")
    expect(terminal).not.toContain(CUSTOM_HEADER_VALUE)
    expect(terminal).not.toContain("custom.example")

    expect(routingSnapshot().models[0]).toMatchObject({
      accounts: [],
      model: "custom-chat-model",
      provider: "Custom Chat",
      requests: 1,
      upstreamCalls: 1,
    })
  } finally {
    infoSpy.mockRestore()
  }
})

test("redirected Responses and Google models resolve custom providers after redirect", async () => {
  setModelRedirectsForTest([
    {
      id: "task-19d-custom-redirect",
      enabled: true,
      sourceModel: "custom-redirect-source",
      targetModel: "custom-chat-alias",
      sourceEffort: "all",
    },
  ])

  for (const [path, body] of [
    ["/v1/responses", { model: "custom-redirect-source", input: "hello" }],
    [
      "/v1beta/models/custom-redirect-source:generateContent",
      { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    ],
  ] as const) {
    const response = await protocolRequest(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
  }

  expect(requests).toHaveLength(2)
  expect(requests.map((request) => request.body.model)).toEqual([
    "custom-chat-model",
    "custom-chat-model",
  ])
})

test("priority Responses requests use configured custom fast models", async () => {
  const response = await protocolRequest("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      input: "hello",
      service_tier: "priority",
    }),
  })

  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.body.model).toBe("custom-chat-model-fast")
  expect(requests[0]?.body).not.toHaveProperty("service_tier")
})

test("priority Responses aliases use the canonical custom fast model", async () => {
  const response = await protocolRequest("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-alias",
      input: "hello",
      service_tier: "priority",
    }),
  })

  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.body.model).toBe("custom-chat-model-fast")
})

test("priority Responses requests can use a custom fast model when Copilot routing disables the collision", async () => {
  const collidingModel = {
    ...models.data[0],
    id: "custom-chat-model-fast",
    name: "Disabled Copilot Fast Collision",
  }
  state.models = { object: "list", data: [...models.data, collidingModel] }
  const account = tokenPool.addAccount(
    "github-custom-fast-collision",
    "individual",
    customFastCollisionAccountId,
  )
  account.copilotToken = "custom-fast-collision-token"
  account.healthy = true
  account.models = new Set([collidingModel.id])
  account.modelsData = [collidingModel]
  setModelRoutingOverridesForTest({
    [collidingModel.id]: { "24001": false },
  })
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true

  try {
    const response = await protocolRequest("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-chat-model",
        input: "hello",
        service_tier: "priority",
      }),
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://custom.example/v1/chat/completions")
    expect(requests[0]?.body.model).toBe("custom-chat-model-fast")
  } finally {
    tokenPool.removeAccountForTest(customFastCollisionAccountId)
    state.isMultiToken = false
  }
})

test("priority Responses requests can move from a custom normal model to a Copilot fast model", async () => {
  const copilotFastModel = {
    ...models.data[0],
    id: "custom-chat-model-fast",
    name: "Copilot Fast Destination",
  }
  state.models = { object: "list", data: [...models.data, copilotFastModel] }

  const response = await protocolRequest("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      input: "hello",
      service_tier: "priority",
    }),
  })

  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).not.toBe(
    "https://custom.example/v1/chat/completions",
  )
  expect(requests[0]?.body.model).toBe("custom-chat-model-fast")
})

test("custom embedding aliases never dispatch chat through Responses or Google", async () => {
  const responses = await protocolRequest("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3-embedding-8b", input: "hello" }),
  })
  const google = await protocolRequest(
    "/v1beta/models/qwen3-embedding-8b:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    },
  )

  expect(responses.status).not.toBe(200)
  expect(google.status).not.toBe(200)
  expect(requests).toHaveLength(0)
})

test("custom Responses compaction remains excluded from provider dispatch", async () => {
  const response = await protocolRequest("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-alias",
      input: "compact this",
      client_metadata: JSON.stringify({
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "compaction",
        }),
      }),
    }),
  })

  expect(response.status).not.toBe(200)
  expect(requests).toHaveLength(0)
})

test("priority Responses compaction does not dispatch to a custom-only fast model", async () => {
  const response = await protocolRequest("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      input: "compact this",
      service_tier: "priority",
      client_metadata: JSON.stringify({
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "compaction",
        }),
      }),
    }),
  })

  expect(response.status).not.toBe(200)
  expect(requests).toHaveLength(0)
})

test("custom Google countTokens is local and never calls a provider", async () => {
  const response = await protocolRequest(
    "/v1beta/models/custom-chat-alias:countTokens",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    },
  )
  const body = (await response.json()) as { totalTokens: number }

  expect(response.status).toBe(200)
  expect(typeof body.totalTokens).toBe("number")
  expect(requests).toHaveLength(0)
})

test.each([
  {
    name: "Responses HTTP",
    path: "/v1/responses",
    payload: {
      model: "custom-chat-alias",
      input: "hello from Responses",
      temperature: 0.2,
    },
    expectedModel: "custom-chat-alias",
  },
  {
    name: "Google generateContent",
    path: "/v1beta/models/custom-chat-alias:generateContent",
    payload: {
      contents: [{ role: "user", parts: [{ text: "hello from Google" }] }],
      generationConfig: { temperature: 0.2 },
    },
    expectedModel: "custom-chat-alias",
  },
])(
  "$name routes the evaluated Chat candidate to the custom provider",
  async ({ path, payload, expectedModel }) => {
    const response = await protocolRequest(path, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-client-secret",
        "content-type": "application/json",
        "copilot-session-token": "copilot-session-secret",
      },
      body: JSON.stringify(payload),
    })
    const body = (await response.json()) as {
      error?: unknown
      model?: string
      modelVersion?: string
    }

    expect(response.status).toBe(200)
    expect(body.model ?? body.modelVersion).toBe(expectedModel)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://custom.example/v1/chat/completions")
    expect(requests[0]?.body).toMatchObject({
      model: "custom-chat-model",
      temperature: 0.2,
    })
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer custom-key")
    expect(JSON.stringify(requests[0]?.body)).not.toContain(
      "copilot-session-secret",
    )
    expect(JSON.stringify(requests[0]?.body)).not.toContain(
      "gateway-client-secret",
    )
  },
)

test("custom providers preserve public identity across Responses and Google streams", async () => {
  const providerStream = [
    ": keepalive",
    "event: provider.future\nx-provider-field: ignored",
    `data: ${JSON.stringify(createCustomProviderStreamChunk(null, "custom"))}`,
    `data: ${JSON.stringify(createCustomProviderStreamChunk("stop"))}`,
    `data: ${JSON.stringify({
      id: "custom-stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "custom-chat-model",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n")
  const streamResponse = (url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    requests.push({ url, body, headers: new Headers(init?.headers) })
    return new Response(providerStream, {
      headers: { "content-type": "text/event-stream" },
    })
  }
  fetchMock
    .mockImplementationOnce(streamResponse)
    .mockImplementationOnce(streamResponse)

  const responses = await protocolRequest("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-alias",
      input: "hello",
      stream: true,
    }),
  })
  const responsesText = await responses.text()
  expect(responses.status).toBe(200)
  expect(responsesText).toContain('"model":"custom-chat-alias"')
  expect(responsesText.match(/event: response\.completed/g) ?? []).toHaveLength(
    1,
  )
  expect(responsesText).not.toContain("response.failed")

  const google = await protocolRequest(
    "/v1beta/models/custom-chat-alias:streamGenerateContent?alt=sse",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    },
  )
  const googleText = await google.text()
  expect(google.status).toBe(200)
  expect(googleText).toContain('"modelVersion":"custom-chat-alias"')
  expect(googleText.match(/"finishReason":"STOP"/g) ?? []).toHaveLength(1)
  expect(requests).toHaveLength(2)
})

test("custom Google stream supports JSON-array mode with public identity", async () => {
  const providerStream = [
    `data: ${JSON.stringify(createCustomProviderStreamChunk(null, "custom"))}`,
    `data: ${JSON.stringify(createCustomProviderStreamChunk("stop"))}`,
    "data: [DONE]",
    "",
  ].join("\n\n")
  fetchMock.mockImplementationOnce(
    () =>
      new Response(providerStream, {
        headers: { "content-type": "text/event-stream" },
      }),
  )

  const response = await protocolRequest(
    "/v1beta/models/custom-chat-alias:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    },
  )
  const body = (await response.json()) as Array<{
    modelVersion: string
    candidates: Array<{ finishReason: string | null }>
  }>

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(body.some((chunk) => chunk.modelVersion === "custom-chat-alias")).toBe(
    true,
  )
  expect(
    body.filter((chunk) => chunk.candidates[0]?.finishReason === "STOP"),
  ).toHaveLength(1)
})

test("custom Google web-search continuations stay on the provider", async () => {
  const toolCall = (id: string, query: string) => ({
    id,
    object: "chat.completion",
    created: 1,
    model: "custom-chat-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: "web_search",
                arguments: JSON.stringify({ query }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
  const providerResponses = [
    toolCall("google-search-1", "first"),
    toolCall("google-search-2", "second"),
    {
      id: "google-search-final",
      object: "chat.completion",
      created: 2,
      model: "custom-chat-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "searched twice" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  ]
  for (const providerResponse of providerResponses) {
    fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
      const body =
        typeof init?.body === "string" ?
          (JSON.parse(init.body) as Record<string, unknown>)
        : {}
      requests.push({ url, body, headers: new Headers(init?.headers) })
      return Response.json(providerResponse)
    })
  }

  const response = await protocolRequest(
    "/v1beta/models/custom-chat-alias:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "search" }] }],
        tools: [{ googleSearch: { max_uses: 2 } }],
      }),
    },
  )
  const body = (await response.json()) as { modelVersion: string }

  expect(response.status).toBe(200)
  expect(body.modelVersion).toBe("custom-chat-alias")
  expect(requests).toHaveLength(3)
  expect(
    requests.every(
      (request) => request.url === "https://custom.example/v1/chat/completions",
    ),
  ).toBe(true)
  expect(JSON.stringify(requests[1]?.body)).toContain('"role":"tool"')
  expect(JSON.stringify(requests[2]?.body)).toContain("google-search-2")
})

test("custom provider web-search continuations never switch to Copilot", async () => {
  const assistantToolCall = {
    id: "chatcmpl-search",
    object: "chat.completion",
    created: 1,
    model: "custom-chat-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "search-1",
              type: "function",
              function: {
                name: "web_search",
                arguments: JSON.stringify({ query: "task 19d" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
  fetchMock
    .mockImplementationOnce((url: string, init?: RequestInit) => {
      requests.push({
        url,
        body:
          typeof init?.body === "string" ?
            (JSON.parse(init.body) as Record<string, unknown>)
          : {},
        headers: new Headers(init?.headers),
      })
      return Response.json(assistantToolCall)
    })
    .mockImplementationOnce((url: string, init?: RequestInit) => {
      const body =
        typeof init?.body === "string" ?
          (JSON.parse(init.body) as Record<string, unknown>)
        : {}
      requests.push({ url, body, headers: new Headers(init?.headers) })
      return Response.json({
        id: "chatcmpl-final",
        object: "chat.completion",
        created: 2,
        model: "custom-chat-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "searched" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      })
    })

  const response = await protocolRequest("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-alias",
      input: "search",
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          max_uses: 1,
        },
      ],
    }),
  })
  const body = (await response.json()) as { model: string; output_text: string }

  expect(response.status).toBe(200)
  expect(body.model).toBe("custom-chat-alias")
  expect(body.output_text).toBe("searched")
  expect(requests).toHaveLength(2)
  expect(requests.map((request) => request.url)).toEqual([
    "https://custom.example/v1/chat/completions",
    "https://custom.example/v1/chat/completions",
  ])
  expect(JSON.stringify(requests[1]?.body).includes('"role":"tool"')).toBe(true)
})

test.each([
  {
    name: "Responses",
    path: "/v1/responses",
    body: { model: "custom-chat-alias", input: "hello" },
  },
  {
    name: "Google",
    path: "/v1beta/models/custom-chat-alias:generateContent",
    body: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  },
])(
  "$name fails closed for binary custom provider failures",
  async ({ path, body }) => {
    const bytes = Uint8Array.from([0, 255, 13, 10, 65])
    fetchMock.mockImplementationOnce(
      () =>
        new Response(bytes.slice(), {
          status: 401,
          headers: { "content-type": "application/octet-stream" },
        }),
    )

    const response = await protocolRequest(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({
      error: {
        message: "Custom provider request failed",
        type: "error",
      },
    })
  },
)

test.each([
  {
    name: "Responses",
    path: "/v1/responses",
    body: { model: "custom-chat-alias", input: "hello" },
  },
  {
    name: "Google",
    path: "/v1beta/models/custom-chat-alias:generateContent",
    body: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  },
])(
  "$name fails closed for whitespace-sensitive custom provider text failures",
  async ({ path, body }) => {
    fetchMock.mockImplementationOnce(
      () =>
        new Response(" custom-private-body\r\n", {
          status: 401,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    )

    const response = await protocolRequest(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("application/json")
    const responseBody = await response.text()
    expect(JSON.parse(responseBody)).toEqual({
      error: {
        message: "Custom provider request failed",
        type: "error",
      },
    })
    expect(responseBody).not.toContain("custom-private-body")
  },
)

test.each([
  {
    name: "Responses",
    path: "/v1/responses",
    body: { model: "custom-chat-alias", input: "hello" },
  },
  {
    name: "Google",
    path: "/v1beta/models/custom-chat-alias:generateContent?key=gateway-private",
    body: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  },
])("$name isolates custom provider credentials", async ({ path, body }) => {
  const clientSecrets = [
    "gateway-private",
    "cookie-private",
    "native-api-private",
    "google-api-private",
    "session-private",
    "anthropic-beta-private",
    "anthropic-version-private",
    "client-provider-private",
    "query-private",
  ]
  const response = await protocolRequest(path, {
    method: "POST",
    headers: {
      authorization: "Bearer gateway-private",
      "content-type": "application/json",
      cookie: "session=cookie-private",
      "x-api-key": "gateway-private",
      "x-goog-api-key": "gateway-private",
      "copilot-session-token": "session-private",
      "anthropic-beta": "anthropic-beta-private",
      "anthropic-version": "anthropic-version-private",
      "x-provider-auth": "client-provider-private",
    },
    body: JSON.stringify(body),
  })

  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  const providerRequest = requests[0]
  expect(providerRequest.headers.get("authorization")).toBe("Bearer custom-key")
  expect(providerRequest.headers.get("x-custom-provider")).toBe("provider-only")
  const serialized = JSON.stringify({
    body: providerRequest.body,
    headers: Object.fromEntries(providerRequest.headers.entries()),
  })
  for (const secret of clientSecrets) expect(serialized).not.toContain(secret)
})

test.each([
  {
    name: "Responses",
    path: "/v1/responses",
    body: { model: "custom-chat-alias", input: "hello", stream: true },
    failurePattern: /event: response\.failed/g,
  },
  {
    name: "Google",
    path: "/v1beta/models/custom-chat-alias:streamGenerateContent?alt=sse",
    body: {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
    failurePattern: /"status":"INTERNAL"/g,
  },
])(
  "$name emits one late custom provider stream failure",
  async ({ path, body, failurePattern }) => {
    const upstream = new Response(" late-provider-body\r\n", {
      status: 503,
      headers: { "content-type": "text/plain" },
    })
    fetchMock.mockImplementationOnce(() =>
      createLateCustomProviderStreamResponse(upstream),
    )

    const response = await protocolRequest(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain("partial")
    expect(text.match(failurePattern) ?? []).toHaveLength(1)
  },
)

test.each([
  {
    name: "Responses",
    path: "/v1/responses",
    body: { model: "custom-chat-alias", input: "hello", stream: true },
  },
  {
    name: "Google",
    path: "/v1beta/models/custom-chat-alias:streamGenerateContent?alt=sse",
    body: {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
  },
])(
  "$name aborts custom provider streams without late output",
  async ({ path, body }) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    fetchMock.mockImplementationOnce(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(
                    createCustomProviderStreamChunk(null, "partial"),
                  )}\n\n`,
                ),
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    )

    const response = await protocolRequest(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    await reader?.read()
    await reader?.cancel()
    try {
      controller?.error(new Error("late-after-abort"))
    } catch {
      // The cancelled stream may already reject direct controller writes.
    }
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(response.status).toBe(200)
  },
)

test("custom Chat receives the tolerant native candidate without Copilot caching", async () => {
  const response = await protocolRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      messages: {
        role: "future-private-role",
        content: { type: "future-private-part", payload: true },
      },
      tools: { type: "future-private-tool", payload: true },
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(requests[0]?.body.messages).toEqual([
    {
      role: "future-private-role",
      content: [{ type: "future-private-part", payload: true }],
    },
  ])
  expect(requests[0]?.body.tools).toEqual([
    { type: "future-private-tool", payload: true },
  ])
  expect(JSON.stringify(requests[0]?.body)).not.toContain(
    "copilot_cache_control",
  )
})

test("Anthropic messages request routes to custom chat provider by model id", async () => {
  const response = await protocolRequest("/v1/messages?beta=true", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1,
      output_config: {
        effort: "high",
      },
    }),
  })
  const body = (await response.json()) as {
    content: Array<{ type: string; text?: string }>
    model: string
  }

  expect(response.status).toBe(200)
  expect(body.model).toBe("glm-5.2")
  expect(body.content).toEqual([{ type: "text", text: "custom" }])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe("https://custom.example/v1/chat/completions")
  expect(requests[0]?.body.model).toBe("glm-5.2")
  expect(requests[0]?.body.max_tokens).toBe(1)
  expect(requests[0]?.body.reasoning_effort).toBe("high")
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer custom-key")
  expect(requests[0]?.headers.get("x-custom-trace")).toBe(CUSTOM_HEADER_VALUE)

  const debug = await waitForLatestDebugStatus("complete")
  expect(debug).toMatchObject({
    status: "complete",
    request: {
      body: JSON.stringify(requests[0]?.body),
      headers: {
        Authorization: "[REDACTED]",
        "X-Custom-Trace": "[REDACTED]",
      },
      path: "/chat/completions",
      url: "https://custom.example/v1/chat/completions",
    },
  })
})

test("streams custom-provider data before raw debug capture completes", async () => {
  const chunk = JSON.stringify({
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 1,
    model: "custom-chat-model",
    choices: [
      {
        index: 0,
        delta: { content: "streamed immediately" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })
  const rawFrame = `data: ${chunk}\n\n`
  let upstreamController:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined
  let upstreamClosed = false
  fetchMock.mockImplementationOnce(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamController = controller
            controller.enqueue(new TextEncoder().encode(rawFrame))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )

  const closeUpstream = () => {
    if (!upstreamController || upstreamClosed) return
    upstreamClosed = true
    upstreamController.close()
  }
  const responsePromise = protocolRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  })

  try {
    const earlyResponse = await Promise.race([
      responsePromise,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), 100),
      ),
    ])
    expect(earlyResponse).toBeInstanceOf(Response)
    if (!earlyResponse) return

    const reader = earlyResponse.body?.getReader()
    if (!reader) throw new Error("Expected streaming response body")
    const firstRead = (await reader.read()) as {
      done: boolean
      value?: Uint8Array
    }
    expect(firstRead.done).toBe(false)
    expect(new TextDecoder().decode(firstRead.value)).toContain(
      "streamed immediately",
    )
    expect((await latestDebugLog())?.status).toBe("pending")

    closeUpstream()
    const complete = await waitForLatestDebugStatus("complete")
    expect(complete?.response?.body).toBe(rawFrame)
    await reader.cancel()
  } finally {
    closeUpstream()
    await responsePromise
  }
})

test("custom Messages stream closes partial text before one EOF error", async () => {
  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    requests.push({ url, body, headers: new Headers(init?.headers) })
    const chunk = {
      id: "chatcmpl-custom-stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "glm-5.2",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "partial" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  })

  const response = await protocolRequest("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
      stream: true,
    }),
  })
  const body = await response.text()

  expect(
    Array.from(body.matchAll(/^event: (.+)$/gm), (match) => match[1]),
  ).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "error",
  ])
  expect(body).not.toContain("message_delta")
  expect(body).not.toContain("message_stop")
})

test.each([
  {
    name: "root cache control",
    extra: { cache_control: { type: "ephemeral" } },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(body).not.toHaveProperty("cache_control")
    },
  },
  {
    name: "future root field",
    extra: { future_native_field: true },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(body).not.toHaveProperty("future_native_field")
    },
  },
  {
    name: "deferred native tool",
    extra: {
      tools: [{ type: "future_native_20270101", name: "future_native" }],
    },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(body).not.toHaveProperty("tools")
    },
  },
  {
    name: "document context",
    extra: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "text", data: "notes" },
              context: "must stay structural",
            },
          ],
        },
      ],
    },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content: "<document>\nmust stay structural\nnotes\n</document>",
          },
        ],
      })
    },
  },
  {
    name: "Responses thinking signature",
    extra: {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private", signature: "item@opaque" },
          ],
        },
      ],
    },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: null, reasoning_text: "private" },
        ],
      })
      const assistantMessage = (
        body.messages as Array<Record<string, unknown>> | undefined
      )?.[1]
      expect(assistantMessage).not.toHaveProperty("reasoning_opaque")
    },
  },
] as const)(
  "best-effort translates custom-provider Messages $name before Chat dispatch",
  async ({ extra, check }) => {
    const response = await protocolRequest("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-chat-model",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
        ...extra,
      }),
    })

    expectChatDispatch(response, check)
  },
)

test("custom Messages dispatches a versioned web-search schema after URL-image fallback", async () => {
  const marker = "PRIVATE_CUSTOM_WEB_SEARCH_SCHEMA"
  const response = await protocolRequest("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                url: "https://private.example/image.png",
              },
            },
          ],
        },
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string", description: marker },
            },
          },
        },
      ],
    }),
  })

  expectChatDispatch(
    response,
    (requestBody) => {
      expect(requestBody).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content:
              "[image attachment omitted: the URL could not be fetched by the proxy]",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
            },
          },
        ],
      })
      expect(JSON.stringify(requestBody)).not.toContain(marker)
      expect(JSON.stringify(requestBody)).not.toContain(
        "endpoint_translation_unsupported",
      )
    },
    { requestCount: 2 },
  )
})

test("custom Messages dispatches an unknown typed tool with a schema", async () => {
  const privateType = "PRIVATE_CUSTOM_NATIVE_TYPE"
  const privateName = "PRIVATE_CUSTOM_NATIVE_NAME"
  const response = await protocolRequest("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: privateType,
          name: privateName,
          input_schema: { type: "object", properties: {} },
        },
      ],
    }),
  })

  expectChatDispatch(response, (requestBody) => {
    expect(requestBody).toMatchObject({
      model: "custom-chat-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: privateName,
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    })
    expect(JSON.stringify(requestBody)).not.toContain(privateType)
  })
})

test.each([
  "web_searchfuture",
  "Web_search_20250305",
  "prefix_web_search_20250305",
  "web-search_20250305",
  "web_search_",
  "web_search__20250305",
])(
  "custom Messages dispatches web-search lookalike type %s as a function tool",
  async (type) => {
    const response = await protocolRequest("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type,
            name: "future_native",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    })

    expectChatDispatch(response, (requestBody) => {
      expect(requestBody).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "future_native",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      })
      expect(JSON.stringify(requestBody)).not.toContain(
        "endpoint_translation_unsupported",
      )
    })
  },
)

test("custom Messages flattens documents before attachment normalization", async () => {
  const document = {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: "custom notes" },
    title: "notes.txt",
    context: "custom context",
  }

  const response = await protocolRequest("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      messages: [{ role: "user", content: [document] }],
      max_tokens: 16,
    }),
  })

  expectChatDispatch(response, (requestBody) => {
    expect(requestBody).toMatchObject({
      model: "custom-chat-model",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content:
            '<document title="notes.txt">\ncustom context\ncustom notes\n</document>',
        },
      ],
    })
  })
})

test.each([
  {
    name: "image source extension",
    extra: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                url: "https://private.example/image.png",
                private_custom_source: true,
              },
            },
          ],
        },
      ],
    },
    param: "source_extension",
  },
  {
    name: "tool schema extension",
    extra: {
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: {},
            private_custom_schema: true,
          },
        },
      ],
    },
    param: "tool_extension",
  },
  {
    name: "format extension",
    extra: {
      output_config: {
        format: {
          type: "json_object",
          private_custom_format: true,
        },
      },
    },
    param: "format_extension",
  },
] as const)(
  "best-effort translates custom-provider nested $name without local rejection",
  async ({ extra, param }) => {
    const response = await protocolRequest("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-chat-model",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
        ...extra,
      }),
    })

    expectChatDispatch(
      response,
      (requestBody) => {
        if (param === "source_extension") {
          expect(requestBody).toMatchObject({
            model: "custom-chat-model",
            max_tokens: 16,
            messages: [
              {
                role: "user",
                content:
                  "[image attachment omitted: the URL could not be fetched by the proxy]",
              },
            ],
          })
          return
        }

        if (param === "tool_extension") {
          expect(requestBody).toMatchObject({
            model: "custom-chat-model",
            max_tokens: 16,
            messages: [{ role: "user", content: "hello" }],
            tools: [
              {
                type: "function",
                function: {
                  name: "lookup",
                  parameters: {
                    type: "object",
                    properties: {},
                    private_custom_schema: true,
                  },
                },
              },
            ],
          })
          return
        }

        expect(requestBody).toMatchObject({
          model: "custom-chat-model",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
          response_format: {
            type: "json_object",
            private_custom_format: true,
          },
        })
        expect(JSON.stringify(requestBody)).not.toContain(
          "endpoint_translation_unsupported",
        )
      },
      {
        requestCount: param === "source_extension" ? 2 : 1,
      },
    )
  },
)

test("Claude Code Messages cache-control routes to ZenMux custom provider", async () => {
  const response = await protocolRequest("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "z-ai/glm-5.3-free",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    }),
  })
  const body = (await response.json()) as { model: string }

  expect(body.model).toBe("z-ai/glm-5.3-free")
  expectChatDispatch(
    response,
    (requestBody) => {
      expect(requestBody).toMatchObject({
        model: "z-ai/glm-5.3-free",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(JSON.stringify(requestBody)).not.toContain("cache_control")
    },
    {
      url: "https://zenmux.example/v1/chat/completions",
    },
  )
  expect(routingSnapshot().models[0]).toMatchObject({
    accounts: [],
    model: "z-ai/glm-5.3-free",
    provider: "ZenMux",
    requests: 1,
    upstreamCalls: 1,
  })
})

test.each([
  {
    endpoint: "/v1/chat/completions",
    expected: {
      error: {
        code: "free_quota_exhausted",
        message: "The free model allowance has been exhausted.",
        type: "insufficient_balance",
      },
    },
    payload: {
      model: "z-ai/glm-5.3-free",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    },
  },
  {
    endpoint: "/v1/messages?beta=true",
    expected: {
      type: "error",
      request_id: "req-zenmux-quota",
      error: {
        code: "free_quota_exhausted",
        message: "The free model allowance has been exhausted.",
        type: "insufficient_balance",
      },
    },
    payload: {
      model: "z-ai/glm-5.3-free",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    },
  },
] as const)(
  "returns ZenMux's structured 402 error through $endpoint",
  async ({ endpoint, expected, payload }) => {
    fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
      const body =
        typeof init?.body === "string" ?
          (JSON.parse(init.body) as Record<string, unknown>)
        : {}
      requests.push({ url, body, headers: new Headers(init?.headers) })
      return Response.json(
        {
          error: {
            code: "free_quota_exhausted",
            message: "The free model allowance has been exhausted.",
            type: "insufficient_balance",
          },
        },
        { status: 402 },
      )
    })

    const response = await protocolRequest(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-zenmux-quota",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(402)
    expect(await response.json()).toEqual(expected)
    expect(requests.at(-1)?.url).toBe(
      "https://zenmux.example/v1/chat/completions",
    )
  },
)

test("preserves a custom-provider 402 in an Anthropic stream error event", async () => {
  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    requests.push({ url, body, headers: new Headers(init?.headers) })
    return Response.json(
      {
        error: {
          code: "free_quota_exhausted",
          message: "The free model allowance has been exhausted.",
          type: "api_error",
        },
      },
      { status: 402 },
    )
  })
  const reference = resolveCustomProviderModel({
    model: "z-ai/glm-5.3-free",
    kind: "chat",
  })
  if (!reference) throw new Error("ZenMux test provider was not resolved")

  let providerError: unknown
  try {
    await createCustomProviderChatCompletions(reference, {
      model: "z-ai/glm-5.3-free",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })
  } catch (error) {
    providerError = error
  }

  expect(createAnthropicStreamError(providerError)).toEqual({
    type: "error",
    error: {
      code: "free_quota_exhausted",
      message: "The free model allowance has been exhausted.",
      type: "api_error",
    },
  })
})

test.each([
  {
    body: {
      error: {
        code: "credential_error",
        message: "Bearer private-provider-token was rejected.",
        type: "authentication_error",
      },
    },
    name: "credential-bearing",
  },
  {
    body: {
      error: {
        code: "api_key_sk_live_private_provider_value",
        message: "Provider authentication failed.",
        type: "authentication_error",
      },
    },
    name: "secret-code",
  },
  {
    body: {
      error: {
        code: "api.key.sk_live.private_provider_value",
        message: "Provider authentication failed.",
        type: "authentication_error",
      },
    },
    name: "punctuated-secret-code",
  },
  {
    body: {
      error: {
        code: "credential_error",
        message: "Provider authentication failed.",
        type: "token_private_provider_value",
      },
    },
    name: "secret-type",
  },
  {
    body: {
      error: {
        code: "credential_error",
        message: "Bearer: private-provider-token was rejected.",
        type: "authentication_error",
      },
    },
    name: "punctuated-bearer-message",
  },
  {
    body: {
      error: {
        code: "credential_error",
        message: "Provider authentication failed.",
        type: "bearer:sk_live_private_provider_value",
      },
    },
    name: "punctuated-secret-type",
  },
  {
    body: { detail: { reason: "provider-private-detail" } },
    name: "malformed",
  },
] as const)(
  "fails closed for a $name custom-provider 402 body",
  async ({ body, name }) => {
    for (const endpoint of ["/v1/chat/completions", "/v1/messages?beta=true"]) {
      fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
        const requestBody =
          typeof init?.body === "string" ?
            (JSON.parse(init.body) as Record<string, unknown>)
          : {}
        requests.push({
          url,
          body: requestBody,
          headers: new Headers(init?.headers),
        })
        return Response.json(body, { status: 402 })
      })

      const isMessages = endpoint.startsWith("/v1/messages")
      const response = await protocolRequest(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": `req-zenmux-${name}`,
        },
        body: JSON.stringify({
          model: "z-ai/glm-5.3-free",
          ...(isMessages ? { max_tokens: 16 } : {}),
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      })
      const responseBody = await response.text()

      expect(response.status).toBe(402)
      expect(JSON.parse(responseBody)).toEqual(
        isMessages ?
          {
            type: "error",
            request_id: `req-zenmux-${name}`,
            error: {
              type: "api_error",
              message: "The custom provider request failed.",
            },
          }
        : {
            error: {
              message: "Custom provider request failed",
              type: "error",
            },
          },
      )
      expect(responseBody).not.toContain("Copilot quota exhausted")
      expect(responseBody).not.toContain("private-provider-token")
      expect(responseBody).not.toContain("private_provider_value")
      expect(responseBody).not.toContain("provider-private-detail")
    }
  },
)

test("embeddings request routes to Nebius config by alias", async () => {
  const response = await protocolRequest("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-embedding-8b",
      input: ["incident cpu saturation", "postgres connection timeout"],
    }),
  })
  const body = (await response.json()) as {
    model: string
    data: Array<{ index: number; embedding: Array<number> }>
  }

  expect(response.status).toBe(200)
  expect(body.model).toBe("qwen3-embedding-8b")
  expect(body.data).toHaveLength(2)
  expect(body.data.map((item) => item.index)).toEqual([0, 1])
  expect(body.data[0]?.embedding).toHaveLength(4096)
  expect(
    body.data[0]?.embedding.every((value) => typeof value === "number"),
  ).toBe(true)
  expect(requests[0]?.url).toBe("https://api.studio.nebius.com/v1/embeddings")
  expect(requests[0]?.body.model).toBe("Qwen/Qwen3-Embedding-8B")
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer nebius-key")
  expect(requests[0]?.headers.get("x-provider")).toBe("nebius")

  const debug = await waitForLatestDebugStatus("complete")
  expect(debug).toMatchObject({
    status: "complete",
    request: {
      body: JSON.stringify(requests[0]?.body),
      headers: {
        Authorization: "[REDACTED]",
        "X-Provider": "[REDACTED]",
      },
      path: "/embeddings",
      url: "[unavailable URL]",
    },
  })

  expect(routingSnapshot().models[0]).toMatchObject({
    accounts: [],
    model: "Qwen/Qwen3-Embedding-8B",
    provider: "Nebius",
    requests: 1,
    upstreamCalls: 1,
  })
})

test("records custom-provider transport failures without swallowing them", async () => {
  fetchMock.mockImplementationOnce(() => {
    throw new Error("custom provider connection failed")
  })

  const response = await protocolRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      model: "custom-chat-model",
    }),
  })

  expect(response.status).toBe(500)
  expect(routingSnapshot().models[0]).toMatchObject({
    accounts: [],
    model: "custom-chat-model",
    outcomes: { transportError: 1 },
    provider: "Custom Chat",
    upstreamCalls: 1,
  })
})

test("preserves custom-provider chat identity while sanitizing failures", async () => {
  const statusMarker = "custom-private-status"
  const bodyMarker = "custom-private-body"
  const body = new TextEncoder().encode(` ${bodyMarker}\r\n`)
  const upstream = new Response(body.slice(), {
    status: 400,
    statusText: statusMarker,
    headers: { "content-type": "application/problem+json" },
  })
  fetchMock.mockImplementationOnce(() => upstream)
  const errorSpy = spyOn(consola, "error")

  try {
    const reference = resolveCustomProviderModel({
      model: "custom-chat-model",
      kind: "chat",
      copilotModelIds: new Set(),
    })
    if (!reference) throw new TypeError("Expected custom chat reference")
    const error = await createCustomProviderChatCompletions(reference, {
      model: "custom-chat-model",
      messages: [{ role: "user", content: "hello" }],
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).response).toBe(upstream)
    expect(upstream.bodyUsed).toBe(false)

    const directOutput = JSON.stringify(errorSpy.mock.calls)
    expect(directOutput).not.toContain(statusMarker)
    expect(directOutput).not.toContain(bodyMarker)

    fetchMock.mockImplementationOnce(
      () =>
        new Response(body.slice(), {
          status: 400,
          statusText: statusMarker,
          headers: { "content-type": "application/problem+json" },
        }),
    )
    const response = await protocolRequest("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-chat-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    expect(response.status).toBe(400)
    const responseBody = await response.text()
    const output = JSON.stringify(errorSpy.mock.calls)
    expect(output).not.toContain(statusMarker)
    expect(output).not.toContain(bodyMarker)
    expect(JSON.parse(responseBody)).toEqual({
      error: {
        message: "Custom provider request failed",
        type: "error",
      },
    })
    expect(responseBody).not.toContain(bodyMarker)

    const debug = await waitForLatestDebugStatus("error")
    expect(debug).toMatchObject({
      status: "error",
      response: {
        status: 400,
        statusText: statusMarker,
      },
    })
    expect(debug?.response?.body).toBeNull()
    expect(debug?.response?.omittedReason).toBe("unsupported")
    expect(response.headers.get("content-type")).toContain("application/json")
  } finally {
    errorSpy.mockRestore()
  }
})

test("records custom-provider transport and aborted lifecycles in raw LLM Debug", async () => {
  const transportMarker = "custom-provider connection failed"
  fetchMock.mockImplementationOnce(() => {
    throw new Error(transportMarker)
  })

  const transportResponse = await protocolRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      model: "custom-chat-model",
    }),
  })
  expect(transportResponse.status).toBe(500)
  expect(
    await getLlmDebugLog((await listLlmDebugLogs()).entries[0]?.id ?? ""),
  ).toMatchObject({
    status: "error",
    error: { message: transportMarker },
  })

  fetchMock.mockImplementationOnce(() => {
    const error = new Error("custom provider request aborted")
    error.name = "AbortError"
    throw error
  })
  const abortedResponse = await protocolRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      model: "custom-chat-model",
    }),
  })
  expect(abortedResponse.status).toBe(499)
  expect(
    await getLlmDebugLog((await listLlmDebugLogs()).entries[0]?.id ?? ""),
  ).toMatchObject({
    status: "aborted",
  })
})

test("preserves custom-provider embedding identity while sanitizing failures", async () => {
  const body = Uint8Array.from([0, 255, 13, 10, 65])
  const upstream = new Response(body.slice(), {
    status: 422,
    headers: { "content-type": "application/octet-stream" },
  })
  fetchMock.mockImplementationOnce(() => upstream)
  const reference = resolveCustomProviderModel({
    model: "qwen3-embedding-8b",
    kind: "embedding",
    copilotModelIds: new Set(),
  })
  if (!reference) throw new TypeError("Expected custom embedding reference")

  const error = await createCustomProviderEmbeddings(reference, {
    model: "qwen3-embedding-8b",
    input: "hello",
  }).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).response).toBe(upstream)
  expect(upstream.bodyUsed).toBe(false)

  fetchMock.mockImplementationOnce(
    () =>
      new Response(body.slice(), {
        status: 422,
        headers: { "content-type": "application/octet-stream" },
      }),
  )
  const response = await protocolRequest("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3-embedding-8b", input: "hello" }),
  })
  expect(response.status).toBe(422)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(await response.json()).toEqual({
    error: {
      message: "Custom provider request failed",
      type: "error",
    },
  })
})

test("keeps future-named custom SSE data after comments and unknown fields", async () => {
  const chunk = {
    id: "chunk_future",
    object: "chat.completion.chunk",
    created: 1,
    model: "provider-model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "future" },
        finish_reason: null,
      },
    ],
  }
  fetchMock.mockImplementationOnce(
    () =>
      new Response(
        `: keepalive\nx-future: ignored\n\nevent: provider.future\ndata: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  )

  const response = await protocolRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  })
  const text = await response.text()

  expect(response.status).toBe(200)
  expect(text).toContain("event: provider.future")
  expect(text).toContain('"id":"chunk_future"')
  expect(text).toContain('"model":"custom-chat-model"')
  expect(text).toContain("data: [DONE]")
})

test("missing custom provider API key returns a clear error", async () => {
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "nebius",
        name: "Nebius",
        type: "openai-compatible",
        baseUrl: "https://api.studio.nebius.com/v1",
        apiKeyEnv: "NEBIUS_API_KEY",
        models: [
          {
            id: "Qwen/Qwen3-Embedding-8B",
            aliases: ["qwen3-embedding-8b"],
            kind: "embedding",
            dimensions: 4096,
          },
        ],
      },
    ],
  })
  clearEnv("NEBIUS_API_KEY")

  const response = await protocolRequest("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-embedding-8b",
      input: "hello",
    }),
  })
  const body = (await response.json()) as { error: { message: string } }

  expect(response.status).toBe(500)
  expect(body.error.message).toContain("stored API key")
  expect(requests).toHaveLength(0)
})

test("dashboard stores provider API key without returning it", async () => {
  const admin = await createTestAdminSession()
  const response = await protocolRequest("/dashboard/api/custom-providers", {
    method: "POST",
    headers: adminHeaders(admin),
    body: JSON.stringify({
      id: "dashboard-provider",
      name: "Dashboard Provider",
      type: "openai-compatible",
      baseUrl: "https://dashboard.example/v1",
      apiKey: "dashboard-key",
      models: [{ id: "dashboard-chat", kind: "chat" }],
    }),
  })
  const body = (await response.json()) as {
    apiKey?: string
    apiKeyConfigured?: boolean
    apiKeyEnv?: string
  }

  expect(response.status).toBe(200)
  expect(body.apiKey).toBeUndefined()
  expect(body.apiKeyConfigured).toBe(true)
  expect(body.apiKeyEnv).toBeUndefined()

  setConfigForTest(null)

  const chatResponse = await protocolRequest("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_GATEWAY_KEY}`,
    },
    body: JSON.stringify({
      model: "dashboard-chat",
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(chatResponse.status).toBe(200)
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer dashboard-key")
})

test("Nebius dashboard shortcut never returns the submitted API key", async () => {
  const admin = await createTestAdminSession()
  const response = await protocolRequest(
    "/dashboard/api/custom-providers/nebius-qwen3",
    {
      method: "POST",
      headers: adminHeaders(admin),
      body: JSON.stringify({ apiKey: "nebius-dashboard-secret" }),
    },
  )
  const body = (await response.json()) as {
    apiKey?: string
    apiKeyConfigured?: boolean
    headerNames?: Array<string>
  }

  expect(response.status).toBe(200)
  expect(body.apiKey).toBeUndefined()
  expect(body.apiKeyConfigured).toBe(true)
  expect(body.headerNames).toEqual([])
})

test("Copilot models still route through the existing path", async () => {
  const response = await protocolRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-copilot",
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe(
    "https://api.githubcopilot.com/chat/completions",
  )
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer copilot-token")
})

test("embedding dimension metadata is validated", async () => {
  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    requests.push({ url, body, headers: new Headers(init?.headers) })
    return Response.json({
      object: "list",
      model: body.model,
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })
  })

  const response = await protocolRequest("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-embedding-8b",
      input: "hello",
    }),
  })
  const body = (await response.json()) as { error: { message: string } }

  expect(response.status).toBe(502)
  expect(body.error.message).toContain("expected 4096")
})

async function protocolRequest(
  input: Parameters<typeof server.request>[0],
  init?: RequestInit,
) {
  await seedProtocolDatabase({
    gatewayKeys: [
      PROTOCOL_GATEWAY_KEY,
      "gateway-client-secret",
      "gateway-private",
      "native-api-private",
      "google-api-private",
      "query-private",
      ...(state.apiKeyAuth ? [state.apiKeyAuth] : []),
    ],
  })
  const headers = new Headers(init?.headers)
  if (
    !headers.has("authorization")
    && !headers.has("x-api-key")
    && !headers.has("x-goog-api-key")
  )
    headers.set("authorization", "Bearer " + PROTOCOL_GATEWAY_KEY)
  return server.request(input, { ...init, headers })
}
