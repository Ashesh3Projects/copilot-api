import "./helpers/auth-misc-data-dir"

import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import { resetWebSearchSessionsForTest } from "../src/services/copilot/mcp-web-search"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const upstreamRequests: Array<Record<string, unknown>> = []
const mcpHeaders: Array<Headers> = []
let attachmentFetchCount = 0

const models: ModelsResponse = {
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
      supported_endpoints: ["/chat/completions", "/v1/messages"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: { tool_calls: true },
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
  })
}

const fetchMock = mock((url: string, init?: RequestInit) => {
  const parsedUrl = new URL(url)
  const path = parsedUrl.pathname
  const body =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : {}

  if (path === "/mcp/readonly") {
    mcpHeaders.push(new Headers(init?.headers))
    if (body.method === "initialize") {
      return new Response(
        'data: {"jsonrpc":"2.0","id":"init","result":{}}\n\n',
        {
          headers: {
            "content-type": "text/event-stream",
            "Mcp-Session-Id": "route-session",
          },
        },
      )
    }
    return new Response(
      'data: {"jsonrpc":"2.0","id":"search","result":{"content":[{"type":"text","text":"{\\"type\\":\\"output_text\\",\\"text\\":{\\"value\\":\\"July 14, 2026 [Source](https://example.com)\\",\\"annotations\\":[]}}"}]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )
  }

  if (parsedUrl.hostname === "assets.example") {
    attachmentFetchCount += 1
    return new Response(Uint8Array.from([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    })
  }

  if (path === "/v1/messages") {
    upstreamRequests.push(body)
    if (upstreamRequests.length === 1) {
      return jsonResponse({
        id: "msg-search",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [
          {
            type: "tool_use",
            id: "search-call",
            name: "web_search",
            input: { query: "today UTC date" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
    return jsonResponse({
      id: "msg-final",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4.6",
      content: [
        {
          type: "text",
          text: "Today is July 14, 2026 ([Source](https://example.com)).",
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    })
  }

  if (path === "/chat/completions") {
    upstreamRequests.push(body)
    if (upstreamRequests.length === 1) {
      return jsonResponse({
        id: "chat-search",
        object: "chat.completion",
        created: 1,
        model: "claude-sonnet-4.6",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "search-call",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: '{"query":"today UTC date"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
      })
    }
    return jsonResponse({
      id: "chat-final",
      object: "chat.completion",
      created: 2,
      model: "claude-sonnet-4.6",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Today is July 14, 2026 ([Source](https://example.com)).",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    })
  }

  return new Response("unexpected upstream path", { status: 500 })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  upstreamRequests.length = 0
  mcpHeaders.length = 0
  attachmentFetchCount = 0
  resetWebSearchSessionsForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = models
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  await seedProtocolDatabase()
})

test("Claude web search completes through Copilot MCP without leaking a tool call", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4.6",
      max_tokens: 512,
      messages: [{ role: "user", content: "What is today's UTC date?" }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 2,
        },
      ],
      tool_choice: { type: "tool", name: "web_search" },
    }),
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    content: Array<{ type: string; text?: string }>
    stop_reason: string
  }
  expect(body).toMatchObject({ stop_reason: "end_turn" })
  expect(body.content).toEqual([
    {
      type: "text",
      text: "Today is July 14, 2026 ([Source](https://example.com)).",
    },
  ])
  expect(upstreamRequests).toHaveLength(2)
  const tools = upstreamRequests[0]?.tools as
    | Array<{ type?: string; name?: string }>
    | undefined
  expect(tools?.[0]?.type).toBeUndefined()
  expect(tools?.[0]?.name).toBe("web_search")
  expect(upstreamRequests[0]?.tool_choice).toEqual({
    type: "tool",
    name: "web_search",
    disable_parallel_tool_use: true,
  })
  expect(upstreamRequests[1]?.tool_choice).toEqual({
    type: "auto",
    disable_parallel_tool_use: true,
  })
  const followUpMessages = upstreamRequests[1]?.messages as
    | Array<{ content?: unknown; role?: string }>
    | undefined
  expect(
    followUpMessages?.some(
      (message) =>
        message.role === "user"
        && Array.isArray(message.content)
        && message.content.some(
          (block: unknown) =>
            typeof block === "object"
            && block !== null
            && "type" in block
            && block.type === "tool_result"
            && "tool_use_id" in block
            && block.tool_use_id === "search-call",
        ),
    ),
  ).toBe(true)
  expect(mcpHeaders[0]?.get("x-mcp-tools")).toBe("web_search")
  expect(mcpHeaders[0]?.get("x-mcp-host")).toBe("copilot-cli")
})

test("Chat web-search follow-up retains the rewritten no-prefill history", async () => {
  setModelSettingsForTest([
    { model: "claude-sonnet-4.6", supportsAssistantPrefill: false },
  ])

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: "Use current facts." },
        { role: "assistant", content: "I will search now." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "auto",
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(upstreamRequests).toHaveLength(2)
  const firstMessages = upstreamRequests[0]?.messages as
    | Array<Record<string, unknown>>
    | undefined
  const followUpMessages = upstreamRequests[1]?.messages as
    | Array<Record<string, unknown>>
    | undefined
  expect(firstMessages?.[1]?.role).toBe("user")
  expect(followUpMessages?.[1]?.role).toBe("user")
  expect(followUpMessages?.at(-1)).toMatchObject({
    role: "tool",
    tool_call_id: "search-call",
  })
})

test("Chat web-search follow-up carries one fetched attachment forward", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4.6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Use the image and current facts." },
            {
              type: "image_url",
              image_url: { url: "https://assets.example/image.png" },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "auto",
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(1)
  expect(upstreamRequests).toHaveLength(2)
  for (const request of upstreamRequests) {
    const messages = request.messages as Array<{
      content: Array<{ image_url?: { url?: string } }>
    }>
    expect(messages[0]?.content[1]?.image_url?.url).toBe(
      "data:image/png;base64,AQID",
    )
  }
})

test("Chat web-search follow-up injects the generated JSON instruction once", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Search and return JSON." }],
      response_format: { type: "json_object" },
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "auto",
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(upstreamRequests).toHaveLength(2)
  const followUpMessages = upstreamRequests[1]?.messages as
    | Array<{ content?: unknown; role?: string; tool_call_id?: string }>
    | undefined
  const serialized = JSON.stringify(followUpMessages)
  expect(
    serialized.match(/IMPORTANT: You MUST respond with valid JSON only/g),
  ).toHaveLength(1)
  expect(followUpMessages?.at(-1)).toMatchObject({
    role: "tool",
    tool_call_id: "search-call",
  })
})
