import "./helpers/auth-misc-data-dir"

import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"
import type {
  ResponsesPayload,
  ResponsesResult,
} from "../src/services/copilot/create-responses"

import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { chatCompletionsToResponses } from "../src/routes/chat-completions/responses-fallback"
import { translateGoogleToOpenAI } from "../src/routes/google-ai/request-translation"
import { asAnthropicUnknownContentType } from "../src/routes/messages/anthropic-types"
import { translateToOpenAI } from "../src/routes/messages/non-stream-translation"
import {
  emitAnthropicResponseAsStream,
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "../src/routes/messages/web-search-helpers"
import { convertWebSearchTool } from "../src/routes/responses/handler"
import {
  buildWebSearchQuery,
  createWebSearchFunctionTool,
  executeWebSearch,
  resetWebSearchSessionsForTest,
} from "../src/services/copilot/mcp-web-search"
import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch

test("streams future Messages blocks as balanced bounded text blocks", async () => {
  const frames = new Array<{ event: string; data: string }>()

  await emitAnthropicResponseAsStream(
    {
      writeSSE(frame) {
        frames.push(frame)
        return Promise.resolve()
      },
    },
    {
      id: "msg_future",
      type: "message",
      role: "assistant",
      content: [
        {
          type: asAnthropicUnknownContentType("future_block_20270101"),
          payload: "x".repeat(20_000),
        },
      ],
      model: "test-model",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  )

  const blockFrames = frames.filter((frame) =>
    frame.event.startsWith("content_block_"),
  )
  expect(blockFrames.map((frame) => frame.event)).toEqual([
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
  ])
  expect(JSON.parse(blockFrames[0]?.data ?? "{}")).toMatchObject({
    index: 0,
    content_block: { type: "text", text: "" },
  })
  const delta = JSON.parse(blockFrames[1]?.data ?? "{}") as {
    delta?: { type?: string; text?: string }
  }
  expect(delta.delta?.type).toBe("text_delta")
  expect(delta.delta?.text).toContain('"type":"future_block_20270101"')
  expect(delta.delta?.text?.length).toBeLessThanOrEqual(16_384)
  expect(JSON.parse(blockFrames[2]?.data ?? "{}")).toEqual({
    type: "content_block_stop",
    index: 0,
  })
})

type BunTimeoutRequestInit = RequestInit & { timeout?: boolean | number }
const fetchMock = mock((_url: string, init?: RequestInit) => {
  const body = JSON.parse(
    typeof init?.body === "string" ? init.body : "{}",
  ) as { method?: string }
  if (body.method === "initialize") {
    return new Response(
      'data: {"jsonrpc":"2.0","id":"init","result":{"protocolVersion":"2025-03-26"}}\n\n',
      {
        headers: {
          "content-type": "text/event-stream",
          "Mcp-Session-Id": "session-1",
        },
      },
    )
  }

  return new Response(
    'data: {"jsonrpc":"2.0","id":"call","result":{"content":[{"type":"text","text":"{\\"type\\":\\"output_text\\",\\"text\\":{\\"value\\":\\"Grounded answer [Source](https://example.com)\\",\\"annotations\\":[]}}"}]}}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  )
})

const makeChatSearchResponse = (
  count: number,
  id = `chat-${count}`,
): ChatCompletionResponse => ({
  id,
  object: "chat.completion",
  created: 1,
  model: "test-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: count === 0 ? "Final grounded answer." : null,
        ...(count === 0 ?
          {}
        : {
            tool_calls: Array.from({ length: count }, (_, index) => ({
              id: `${id}-call-${index}`,
              type: "function" as const,
              function: {
                name: "web_search",
                arguments: `{"query":"query ${index}"}`,
              },
            })),
          }),
      },
      logprobs: null,
      finish_reason: count === 0 ? "stop" : "tool_calls",
    },
  ],
})

const makeResponsesSearchResult = (
  count: number,
  id = `response-${count}`,
): ResponsesResult => ({
  id,
  object: "response",
  created_at: 1,
  model: "test-model",
  output:
    count === 0 ?
      [
        {
          id: `${id}-message`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Final grounded answer.",
              annotations: [],
            },
          ],
        },
      ]
    : Array.from({ length: count }, (_, index) => ({
        id: `${id}-item-${index}`,
        type: "function_call" as const,
        call_id: `${id}-call-${index}`,
        name: "web_search",
        arguments: `{"query":"query ${index}"}`,
        status: "completed" as const,
      })),
  output_text: count === 0 ? "Final grounded answer." : "",
  status: "completed",
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
})

const chatSearchPayload = (maxUses?: number): ChatCompletionsPayload => ({
  model: "test-model",
  messages: [{ role: "user", content: "Answer with current facts." }],
  tools: [
    {
      type: "function",
      function: {
        name: "web_search",
        parameters: { type: "object", properties: {} },
        ...(maxUses === undefined ? {} : { max_uses: maxUses }),
      },
    },
  ],
})

const responsesSearchPayload = (maxUses?: number): ResponsesPayload => ({
  model: "test-model",
  input: "Answer with current facts.",
  tools: [
    {
      type: "web_search",
      ...(maxUses === undefined ? {} : { max_uses: maxUses }),
    },
  ],
})

const mcpSearchCallCount = (): number =>
  fetchMock.mock.calls.filter(([, init]) => {
    if (typeof init?.body !== "string") return false
    return (
      (JSON.parse(init.body) as { method?: string }).method === "tools/call"
    )
  }).length

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  resetWebSearchSessionsForTest()
  state.accountType = "individual"
  state.githubToken = undefined
  state.copilotToken = undefined
  state.isMultiToken = false
  const account = tokenPool.addAccount("github-token", "individual", 0)
  account.copilotToken = "copilot-token"
  account.healthy = true
  await seedProtocolDatabase({ singleAccount: false })
})

test("uses the current Copilot CLI MCP web-search contract and reuses its session", async () => {
  await executeWebSearch("first query")
  await executeWebSearch("second query")

  expect(fetchMock).toHaveBeenCalledTimes(3)
  const initialize = fetchMock.mock.calls[0]?.[1] as RequestInit
  const firstCall = fetchMock.mock.calls[1]?.[1] as RequestInit
  const secondCall = fetchMock.mock.calls[2]?.[1] as RequestInit
  const initializeHeaders = new Headers(initialize.headers)
  const firstHeaders = new Headers(firstCall.headers)
  const secondHeaders = new Headers(secondCall.headers)

  expect(initializeHeaders.get("x-mcp-host")).toBe("copilot-cli")
  expect(initializeHeaders.get("x-mcp-tools")).toBe("web_search")
  expect(initializeHeaders.get("x-mcp-toolsets")).toBeNull()
  expect(initializeHeaders.get("copilot-integration-id")).toBeNull()
  expect(firstHeaders.get("mcp-session-id")).toBe("session-1")
  expect(secondHeaders.get("mcp-session-id")).toBe("session-1")
  expect(initialize.keepalive).toBe(false)
  expect(firstCall.keepalive).toBe(false)
  expect(secondCall.keepalive).toBe(false)
  expect((initialize as BunTimeoutRequestInit).timeout).toBeUndefined()
  expect((firstCall as BunTimeoutRequestInit).timeout).toBeUndefined()
  expect((secondCall as BunTimeoutRequestInit).timeout).toBeUndefined()
})

test("replaces the MCP idle timeout only when caller cancellation exists", async () => {
  const controller = new AbortController()

  await executeWebSearch("signal query", controller.signal)

  const initialize = fetchMock.mock.calls[0]?.[1] as BunTimeoutRequestInit
  const toolCall = fetchMock.mock.calls[1]?.[1] as BunTimeoutRequestInit
  expect(initialize.keepalive).toBe(false)
  expect(initialize.timeout).toBeUndefined()
  expect(toolCall.keepalive).toBe(false)
  expect(toolCall.timeout).toBe(false)
})

test("converts Anthropic versioned web search and preserves domain constraints", () => {
  const translated = translateToOpenAI({
    model: "claude-sonnet-4.6",
    messages: [{ role: "user", content: "Search for current docs." }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        allowed_domains: ["docs.example.com"],
      } as never,
    ],
  })

  const tool = translated.tools?.[0]
  expect(tool?.type).toBe("function")
  expect(tool?.function.name).toBe("web_search")
  expect(tool?.function.description).toContain("docs.example.com")
  expect(buildWebSearchQuery('{"query":"latest release"}', tool)).toContain(
    "Only use sources from: docs.example.com",
  )
})

test("keeps native Responses web search but converts it on Chat fallback", () => {
  const payload = {
    model: "gpt-5.4",
    input: "Search the web",
    tools: [
      {
        type: "web_search",
        external_web_access: true,
        filters: { allowed_domains: ["example.com"] },
      },
    ],
  }

  expect(payload.tools[0]?.type).toBe("web_search")
  convertWebSearchTool(payload)
  expect(payload.tools[0]?.type).toBe("function")
  expect((payload.tools[0] as { name?: string }).name).toBe("web_search")
})

test("translates Gemini googleSearch into the shared web-search function", () => {
  const translated = translateGoogleToOpenAI(
    {
      contents: [{ role: "user", parts: [{ text: "What changed today?" }] }],
      tools: [{ googleSearch: {} }],
    },
    "gemini-test",
    false,
  )

  expect(translated.tools?.[0]?.function.name).toBe("web_search")
  expect(translated.parallel_tool_calls).toBe(false)
})

test("promotes supported search options to hosted Responses and keeps blocklists on MCP", () => {
  const basePayload = {
    model: "gpt-5.4",
    messages: [{ role: "user" as const, content: "Search." }],
  }
  const hosted = chatCompletionsToResponses({
    ...basePayload,
    tools: [createWebSearchFunctionTool({ allowed_domains: ["example.com"] })],
  })
  const fallback = chatCompletionsToResponses({
    ...basePayload,
    tools: [
      createWebSearchFunctionTool({ blocked_domains: ["blocked.example"] }),
    ],
  })

  expect(hosted.tools?.[0]).toEqual({
    type: "web_search",
    filters: { allowed_domains: ["example.com"] },
  })
  expect(fallback.tools?.[0]).toMatchObject({
    type: "function",
    name: "web_search",
  })
})

test("executes MCP web search and feeds the result back to the same model loop", async () => {
  const initial: ChatCompletionResponse = {
    id: "chat-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "web_search",
                arguments: '{"query":"current answer"}',
              },
            },
          ],
        },
        logprobs: null,
        finish_reason: "tool_calls",
      },
    ],
  }
  const final: ChatCompletionResponse = {
    ...initial,
    id: "chat-2",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Final grounded answer." },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
  }
  let continuedPayload: ChatCompletionsPayload | undefined
  const result = await resolveWebSearchCalls(
    initial,
    {
      model: "test-model",
      messages: [{ role: "user", content: "Answer with current facts." }],
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "web_search" },
      },
    },
    {
      createCompletion: (payload) => {
        continuedPayload = payload
        return Promise.resolve(final)
      },
    },
  )

  expect(result.choices[0]?.message.content).toBe("Final grounded answer.")
  expect(continuedPayload?.tool_choice).toBe("auto")
  expect(continuedPayload?.messages.at(-1)).toMatchObject({
    role: "tool",
    tool_call_id: "call-1",
  })
  const content = continuedPayload?.messages.at(-1)?.content
  expect(typeof content === "string" ? content : "").toContain(
    "https://example.com",
  )
})

test("bounds Chat web search at eight calls and permits final synthesis", async () => {
  let completions = 0
  const result = await resolveWebSearchCalls(
    makeChatSearchResponse(8),
    chatSearchPayload(),
    {
      createCompletion: () => {
        completions += 1
        return Promise.resolve(makeChatSearchResponse(0, "chat-final"))
      },
    },
  )

  expect(result.choices[0]?.message.content).toBe("Final grounded answer.")
  expect(mcpSearchCallCount()).toBe(8)
  expect(completions).toBe(1)
})

test("rejects an oversized first Chat web-search batch atomically", async () => {
  let completions = 0
  let caught: unknown
  try {
    await resolveWebSearchCalls(
      makeChatSearchResponse(9),
      chatSearchPayload(),
      {
        createCompletion: () => {
          completions += 1
          return Promise.resolve(makeChatSearchResponse(0))
        },
      },
    )
  } catch (error) {
    caught = error
  }

  expect(caught).toMatchObject({
    clientBody: { error: { code: "web_search_limit_exceeded" } },
  })
  expect(mcpSearchCallCount()).toBe(0)
  expect(completions).toBe(0)
})

test("rejects a later aggregate-oversized Chat batch without partial searches", async () => {
  let completions = 0
  let caught: unknown
  try {
    await resolveWebSearchCalls(
      makeChatSearchResponse(7),
      chatSearchPayload(),
      {
        createCompletion: () => {
          completions += 1
          return Promise.resolve(makeChatSearchResponse(2, "chat-later"))
        },
      },
    )
  } catch (error) {
    caught = error
  }

  expect(caught).toMatchObject({
    clientBody: { error: { code: "web_search_limit_exceeded" } },
  })
  expect(mcpSearchCallCount()).toBe(7)
  expect(completions).toBe(1)
})

test("lowers the Chat web-search budget from the initial source tool", async () => {
  let caught: unknown
  try {
    await resolveWebSearchCalls(
      makeChatSearchResponse(3),
      chatSearchPayload(2),
      { createCompletion: () => Promise.resolve(makeChatSearchResponse(0)) },
    )
  } catch (error) {
    caught = error
  }

  expect(caught).toMatchObject({
    clientBody: { error: { code: "web_search_limit_exceeded" } },
  })
  expect(mcpSearchCallCount()).toBe(0)
})

test("bounds Responses web search at eight calls and permits final synthesis", async () => {
  let completions = 0
  const result = await resolveResponsesWebSearchCalls(
    makeResponsesSearchResult(8),
    responsesSearchPayload(),
    {
      vision: false,
      initiator: "user",
      createResponse: () => {
        completions += 1
        return Promise.resolve(makeResponsesSearchResult(0, "response-final"))
      },
    },
  )

  expect(result.output_text).toBe("Final grounded answer.")
  expect(mcpSearchCallCount()).toBe(8)
  expect(completions).toBe(1)
})

test("rejects an oversized first Responses web-search batch atomically", async () => {
  let completions = 0
  let caught: unknown
  try {
    await resolveResponsesWebSearchCalls(
      makeResponsesSearchResult(9),
      responsesSearchPayload(),
      {
        vision: false,
        initiator: "user",
        createResponse: () => {
          completions += 1
          return Promise.resolve(makeResponsesSearchResult(0))
        },
      },
    )
  } catch (error) {
    caught = error
  }

  expect(caught).toMatchObject({
    clientBody: { error: { code: "web_search_limit_exceeded" } },
  })
  expect(mcpSearchCallCount()).toBe(0)
  expect(completions).toBe(0)
})

test("rejects a later aggregate-oversized Responses batch without partial searches", async () => {
  let completions = 0
  let caught: unknown
  try {
    await resolveResponsesWebSearchCalls(
      makeResponsesSearchResult(7),
      responsesSearchPayload(),
      {
        vision: false,
        initiator: "user",
        createResponse: () => {
          completions += 1
          return Promise.resolve(makeResponsesSearchResult(2, "response-later"))
        },
      },
    )
  } catch (error) {
    caught = error
  }

  expect(caught).toMatchObject({
    clientBody: { error: { code: "web_search_limit_exceeded" } },
  })
  expect(mcpSearchCallCount()).toBe(7)
  expect(completions).toBe(1)
})

test("lowers the Responses web-search budget from the initial source tool", async () => {
  let caught: unknown
  try {
    await resolveResponsesWebSearchCalls(
      makeResponsesSearchResult(3),
      responsesSearchPayload(2),
      {
        vision: false,
        initiator: "user",
        createResponse: () => Promise.resolve(makeResponsesSearchResult(0)),
      },
    )
  } catch (error) {
    caught = error
  }

  expect(caught).toMatchObject({
    clientBody: { error: { code: "web_search_limit_exceeded" } },
  })
  expect(mcpSearchCallCount()).toBe(0)
})
