import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { state } from "~/lib/state"
import {
  handleWithNativeMessages,
  resolveNativeWebSearch,
  trackMessageDelta,
} from "~/routes/messages/native-handler"
import { server } from "~/server"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const nativeHeaders: Array<Headers> = []
const nativeBodies: Array<Record<string, unknown>> = []
let nativeAttempt = 0
let repeatNativeSearch = false
let searchesBeforeFinal = 1
let callsPerSearchResponse = 1
let searchInvocationCount = 0

test("tracks cumulative native cache usage without rebuilding the frame", () => {
  const usage = { input: 5, output: 0, cached: 0, created: 0 }
  const frame = JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: {
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 1 },
    },
    copilot_usage: { total_nano_aiu: 123 },
  })
  trackMessageDelta(frame, usage)
  expect(usage).toEqual({ input: 5, output: 3, cached: 2, created: 1 })
  expect(JSON.parse(frame)).toMatchObject({
    usage: { cache_creation: { ephemeral_5m_input_tokens: 1 } },
    copilot_usage: { total_nano_aiu: 123 },
  })
})

function jsonResponse(body: unknown): Response {
  return Response.json(body)
}

const fetchMock = mock(
  (url: string | URL | Request, init?: RequestInit): Response => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    const path = new URL(rawUrl).pathname
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}

    if (path === "/mcp/readonly") {
      if (body.method === "initialize") {
        return new Response(
          'data: {"jsonrpc":"2.0","id":"init","result":{}}\n\n',
          {
            headers: {
              "content-type": "text/event-stream",
              "Mcp-Session-Id": "native-header-session",
            },
          },
        )
      }
      searchInvocationCount += 1
      return new Response(
        'data: {"jsonrpc":"2.0","id":"search","result":{"content":[{"type":"text","text":"{\\"type\\":\\"output_text\\",\\"text\\":{\\"value\\":\\"current result\\",\\"annotations\\":[]}}"}]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    }

    if (path !== "/v1/messages") {
      return new Response("unexpected upstream path", { status: 500 })
    }

    nativeHeaders.push(new Headers(init?.headers))
    nativeBodies.push(body)
    nativeAttempt += 1
    if (nativeAttempt <= searchesBeforeFinal || repeatNativeSearch) {
      return jsonResponse({
        id: "msg_search",
        type: "message",
        role: "assistant",
        model: "claude-current",
        content: Array.from({ length: callsPerSearchResponse }, (_, index) => ({
          type: "tool_use",
          id: `toolu_search_${nativeAttempt}_${index}`,
          name: "web_search",
          input: { query: "current facts" },
        })),
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }

    return jsonResponse({
      id: "msg_final",
      type: "message",
      role: "assistant",
      model: "claude-current",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    })
  },
)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  nativeHeaders.length = 0
  nativeBodies.length = 0
  nativeAttempt = 0
  repeatNativeSearch = false
  searchesBeforeFinal = 1
  callsPerSearchResponse = 1
  searchInvocationCount = 0
  resetWebSearchSessionsForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  await seedProtocolDatabase()
})

test("forwards native server tools without schemas and preserves the caller", async () => {
  const tools = [
    {
      type: "web_fetch_20250910",
      name: "web_fetch",
      max_uses: 2,
      allowed_domains: ["example.com"],
    },
    {
      type: "computer_20251124",
      name: "computer",
      display_width_px: 1280,
      display_height_px: 720,
    },
    {
      type: "future_native_20270101",
      name: "future_native",
      future_option: { enabled: true },
    },
  ]
  const payload = {
    model: "claude-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "Use native tools." }],
    tools,
  } as AnthropicMessagesPayload
  const snapshot = structuredClone(payload)
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-current",
        name: "claude-current",
        object: "model",
        version: "1",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  )

  expect(response.status).toBe(200)
  expect(nativeBodies[0]?.tools).toEqual(tools)
  expect(payload).toEqual(snapshot)
})

test("native handler does not mutate a direct caller while preparing tools", async () => {
  const payload = {
    model: "claude-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "Use native tools." }],
    tools: [
      {
        type: "future_native_20270101",
        name: "future_native",
        future_option: { enabled: true },
      },
    ],
  } as AnthropicMessagesPayload
  const snapshot = structuredClone(payload)
  await handleWithNativeMessages(createNativeContext(), payload)

  expect(nativeBodies[0]?.tools).toEqual(snapshot.tools)
  expect(payload).toEqual(snapshot)
})

test("native Messages preserves document metadata and tool-result error status", async () => {
  const payload = {
    model: "claude-current",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0=",
            },
            title: "report.pdf",
            context: "Read section two first.",
            citations: { enabled: true },
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "failed",
            is_error: true,
          },
        ],
      },
    ],
  } as AnthropicMessagesPayload

  await handleWithNativeMessages(createNativeContext(), payload)

  expect(nativeBodies[0]?.messages).toEqual(payload.messages)
})

function createNativeContext() {
  const request = new Request("http://localhost/v1/messages")
  const values = new Map<string, unknown>()
  return {
    req: { raw: request },
    json: (body: unknown) => Response.json(body),
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
  } as never
}

test("preserves explicit native header options across every web-search iteration", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "Search current facts." }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 2,
      },
    ],
  }

  const response = await resolveNativeWebSearch(payload, {
    anthropicBeta: " beta-one, beta-two, beta-one ",
    anthropicVersion: "2023-06-01",
    modelProviderPreference: "anthropic",
    requestedModel: "requested-alias",
    signal: new AbortController().signal,
  })

  expect(response.id).toBe("msg_final")
  expect(nativeHeaders).toHaveLength(2)
  for (const headers of nativeHeaders) {
    expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(headers.get("x-model-provider-preference")).toBe("anthropic")
  }
})

test.each([
  ["caller maximum", 2, 2],
  ["defensive maximum", undefined, 8],
] as const)(
  "stops native web search at the $name",
  async (_name, maxUses, expectedSearches) => {
    repeatNativeSearch = true
    const payload: AnthropicMessagesPayload = {
      model: "claude-current",
      max_tokens: 64,
      messages: [{ role: "user", content: "Keep searching." }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          ...(maxUses === undefined ? {} : { max_uses: maxUses }),
        },
      ],
    }

    try {
      await resolveNativeWebSearch(payload, {
        signal: new AbortController().signal,
      })
      throw new Error("Expected native web search to stop at its limit")
    } catch (error) {
      expect(error).toHaveProperty("response.status", 400)
    }
    expect(searchInvocationCount).toBe(expectedSearches)
    expect(nativeAttempt).toBe(expectedSearches + 1)
  },
)

test("allows the last permitted search and one final synthesis send", async () => {
  searchesBeforeFinal = 2
  const payload: AnthropicMessagesPayload = {
    model: "claude-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "Search twice, then answer." }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 2,
      },
    ],
  }

  const response = await resolveNativeWebSearch(payload, {
    signal: new AbortController().signal,
  })

  expect(response.id).toBe("msg_final")
  expect(searchInvocationCount).toBe(2)
  expect(nativeAttempt).toBe(3)
})

test("rejects an over-budget search batch before executing any call", async () => {
  callsPerSearchResponse = 2
  const payload: AnthropicMessagesPayload = {
    model: "claude-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "Search if the whole batch fits." }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 1,
      },
    ],
  }

  const error = await resolveNativeWebSearch(payload, {
    signal: new AbortController().signal,
  }).catch((caught: unknown) => caught)

  expect(error).toHaveProperty("response.status", 400)
  expect(searchInvocationCount).toBe(0)
  expect(nativeAttempt).toBe(1)
})

test("enforces the public native web-search limit after tool rewriting", async () => {
  repeatNativeSearch = true
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-current",
        name: "claude-current",
        object: "model",
        version: "1",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-current",
        max_tokens: 64,
        messages: [{ role: "user", content: "Keep searching." }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 1,
          },
        ],
      }),
    }),
  )

  const body = await response.json()

  expect(searchInvocationCount).toBe(1)
  expect(nativeAttempt).toBe(2)
  expect(response.status).toBe(400)
  expect(body).toMatchObject({
    type: "error",
    error: {
      code: "web_search_limit_exceeded",
      param: "web_search_limit",
      type: "invalid_request_error",
    },
  })
})
