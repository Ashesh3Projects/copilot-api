import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
let streamMode: "received-error" | "throw" | "usage-error" = "throw"

function parseRequestBody(init?: RequestInit): ChatCompletionsPayload {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected a JSON request body")
  }
  return JSON.parse(init.body) as ChatCompletionsPayload
}

function createChatFinishTerminalStream(): Response {
  const encoder = new TextEncoder()
  const contentChunk = {
    id: "chatcmpl-finish-first",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "complete" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const finishChunk = {
    ...contentChunk,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  }
  const prefix = `data: ${JSON.stringify(contentChunk)}\n\ndata: ${JSON.stringify(finishChunk)}\n\n`
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(prefix))
        if (streamMode === "usage-error") {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                ...finishChunk,
                choices: [],
                usage: {
                  prompt_tokens: 11,
                  completion_tokens: 7,
                  total_tokens: 18,
                },
              })}\n\n`,
            ),
          )
        }
        if (streamMode !== "throw") {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: { message: "late received error" },
              })}\n\n`,
            ),
          )
          controller.close()
          return
        }
        setTimeout(
          () => controller.error(new Error("late iterator failure")),
          0,
        )
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const payload = parseRequestBody(init)
  if (!payload.stream) throw new Error("Expected a streaming upstream request")
  return createChatFinishTerminalStream()
})

function createMessagesRequest(buffered: boolean): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Search if needed." }],
      max_tokens: 32000,
      stream: true,
      ...(buffered ?
        {
          tools: [
            {
              name: "web_search",
              description: "Search the web",
              input_schema: { type: "object", properties: {} },
            },
          ],
        }
      : {}),
    }),
  }
}

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  streamMode = "throw"
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-4o",
        name: "gpt-4o",
        object: "model",
        version: "1",
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test.each([
  [false, "throw"],
  [false, "received-error"],
  [true, "throw"],
  [true, "received-error"],
] as const)(
  "buffered=%s keeps the first finish reason after %s",
  async (buffered, mode) => {
    streamMode = mode
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", createMessagesRequest(buffered)),
    )
    const body = await response.text()
    expect(
      Array.from(body.matchAll(/^event: (.+)$/gm), (match) => match[1]),
    ).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(body).not.toContain("late received error")
    expect(body).not.toContain("event: error")
  },
)

test.each([false, true])(
  "buffered=%s captures trailing usage after finish",
  async (buffered) => {
    streamMode = "usage-error"
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", createMessagesRequest(buffered)),
    )
    const body = await response.text()
    const payloads = Array.from(
      body.matchAll(/^data: (\{.*\})$/gm),
      (match) => JSON.parse(match[1]) as Record<string, unknown>,
    )
    expect(payloads.map((payload) => payload.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(payloads.at(-2)).toMatchObject({
      usage: { output_tokens: 7 },
    })
  },
)
