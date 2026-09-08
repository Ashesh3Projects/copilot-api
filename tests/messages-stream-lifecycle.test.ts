/* eslint-disable max-lines */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { HTTPError, LocalHTTPError } from "../src/lib/error"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { setSsePreflushDeadlineForTest } from "../src/lib/sse-lifecycle"
import { state } from "../src/lib/state"
import { emitAnthropicStreamError } from "../src/routes/messages/stream-translation"
import { server } from "../src/server"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
let delayedStreamController:
  | ReadableStreamDefaultController<Uint8Array>
  | undefined
let delayedUpstreamAborted = false
let lastUpstreamPath: string | undefined
let streamMode:
  | "chat-error-null"
  | "chat-eof"
  | "chat-malformed-recover"
  | "chat-received-error"
  | "native-late-http-error"
  | "native-open-error-throw"
  | "native-open-eof"
  | "native-open-success"
  | "immediate"
  | "native-metadata"
  | "stall-body"
  | "stall-fetch" = "stall-body"
let nativeLateErrorStatus = 429

const nativeMessagesModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/v1/messages", "/chat/completions"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 64_000 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

function parseRequestBody(init?: RequestInit): ChatCompletionsPayload {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected a JSON request body")
  }
  return JSON.parse(init.body) as ChatCompletionsPayload
}

function createImmediateStream(): Response {
  const contentChunk = {
    id: "chatcmpl-stream-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "hello" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const stopChunk = {
    ...contentChunk,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }
  return new Response(
    `data: ${JSON.stringify(contentChunk)}\n\ndata: ${JSON.stringify(stopChunk)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function createChatEofStream(): Response {
  const contentChunk = {
    id: "chatcmpl-eof",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "partial" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  return new Response(`data: ${JSON.stringify(contentChunk)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function createChatRecoveryStream(options: { errorNull?: boolean }): Response {
  const contentChunk = {
    id: "chatcmpl-recover",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    ...(options.errorNull ? { error: null } : {}),
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "recovered" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const terminalChunk = {
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
  const malformed = options.errorNull ? "" : "data: {malformed\n\n"
  return new Response(
    `${malformed}data: ${JSON.stringify(contentChunk)}\n\ndata: ${JSON.stringify(terminalChunk)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function createChatReceivedErrorStream(): Response {
  const contentChunk = {
    id: "chatcmpl-received-error",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "partial" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  return new Response(
    `data: ${JSON.stringify(contentChunk)}\n\ndata: ${JSON.stringify({
      error: { message: "chat received private marker" },
    })}\n\ndata: {invalid-json\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function createNativeOpenStream(options: {
  terminal: "eof" | "error-throw" | "success"
}): Response {
  const frames = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_open",
          type: "message",
          role: "assistant",
          model: "claude-current",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 3,
        content_block: { type: "future_block", future: true },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 3,
        delta: { type: "future_delta", future: "kept" },
      },
    },
  ]
  const prefix = frames
    .map(
      (frame) =>
        `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`,
    )
    .join("")
  if (options.terminal === "eof") {
    return new Response(prefix, {
      headers: { "content-type": "text/event-stream" },
    })
  }
  if (options.terminal === "success") {
    return new Response(
      `${prefix}event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(prefix))
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "api_error", message: "received-safe-error" },
            })}\n\n`,
          ),
        )
        setTimeout(
          () =>
            controller.error(new Error("iterator throw after received error")),
          0,
        )
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function createNativeMetadataStream(): Response {
  const messageStart = {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-current",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
      recommended_auto_tier: "eco",
      future_message_field: { preserved: true },
    },
    future_event_field: "start-metadata",
  }
  const messageDelta = {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: {
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 1 },
      future_usage_field: true,
    },
    copilot_usage: { total_nano_aiu: 123 },
    future_event_field: "delta-metadata",
  }
  return new Response(
    [
      `event: message_start\ndata: ${JSON.stringify(messageStart)}`,
      `event: message_delta\ndata: ${JSON.stringify(messageDelta)}`,
      'event: message_stop\ndata: {"type":"message_stop"}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function createStalledStream(signal?: AbortSignal | null): Response {
  signal?.addEventListener(
    "abort",
    () => {
      delayedUpstreamAborted = true
    },
    { once: true },
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        delayedStreamController = controller
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const payload = parseRequestBody(init)
  if (!payload.stream) throw new Error("Expected a streaming upstream request")
  let url: string
  if (typeof _url === "string") url = _url
  else if (_url instanceof URL) url = _url.href
  else url = _url.url
  lastUpstreamPath = new URL(url).pathname
  if (streamMode === "stall-fetch") {
    return new Promise<Response>((_resolve, reject) => {
      const rejectAsAborted = (): void => {
        delayedUpstreamAborted = true
        reject(new DOMException("The request was aborted", "AbortError"))
      }
      if (init?.signal?.aborted) {
        rejectAsAborted()
        return
      }
      init?.signal?.addEventListener("abort", rejectAsAborted, { once: true })
    })
  }
  if (streamMode === "immediate") return createImmediateStream()
  if (streamMode === "chat-eof") return createChatEofStream()
  if (streamMode === "chat-malformed-recover") {
    return createChatRecoveryStream({})
  }
  if (streamMode === "chat-error-null") {
    return createChatRecoveryStream({ errorNull: true })
  }
  if (streamMode === "chat-received-error") {
    return createChatReceivedErrorStream()
  }
  if (streamMode === "native-metadata") return createNativeMetadataStream()
  if (streamMode === "native-open-eof") {
    return createNativeOpenStream({ terminal: "eof" })
  }
  if (streamMode === "native-open-error-throw") {
    return createNativeOpenStream({ terminal: "error-throw" })
  }
  if (streamMode === "native-open-success") {
    return createNativeOpenStream({ terminal: "success" })
  }
  if (streamMode === "native-late-http-error") {
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: message_start\ndata: ${JSON.stringify({
                type: "message_start",
                message: {
                  id: "msg_late_error",
                  type: "message",
                  role: "assistant",
                  model: "claude-current",
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              })}\n\n`,
            ),
          )
          setTimeout(
            () =>
              controller.error(
                new HTTPError(
                  "native stream private marker",
                  Response.json({}, { status: nativeLateErrorStatus }),
                ),
              ),
            0,
          )
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  return createStalledStream(init?.signal)
})

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("Expected an SSE response body")
  return response.body
}

function closeDelayedStream(): void {
  try {
    delayedStreamController?.close()
  } catch {
    // The stream may already have been cancelled by the route under test.
  }
  delayedStreamController = undefined
}

async function waitForUpstreamAbort(): Promise<boolean> {
  for (let index = 0; index < 100; index += 1) {
    if (delayedUpstreamAborted) return true
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return false
}

function createMessagesRequest(): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Write a very long plan." }],
      max_tokens: 32000,
      stream: true,
    }),
  }
}

function createNativeMessagesRequest(): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4.8",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: Buffer.from("%PDF-1.4 lifecycle test").toString("base64"),
              },
            },
          ],
        },
      ],
      max_tokens: 32_000,
      stream: true,
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
  closeDelayedStream()
  delayedUpstreamAborted = false
  lastUpstreamPath = undefined
  streamMode = "stall-body"
  nativeLateErrorStatus = 429
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

afterEach(() => {
  closeDelayedStream()
  setSsePreflushDeadlineForTest()
})

test("commits a keepalive before the upstream first SSE event", async () => {
  setSsePreflushDeadlineForTest(20)
  // Fixture persistence is setup, not part of the SSE preflush deadline.
  await seedProtocolDatabase()
  const responsePromise = Promise.resolve(
    server.request("/v1/messages", createMessagesRequest()),
  )
  const outcome = await Promise.race([
    responsePromise.then(() => "response" as const),
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 250),
    ),
  ])

  expect(outcome).toBe("response")
  const response = await responsePromise
  const reader = requireBody(response).getReader()
  const first = await reader.read()
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(first.done).toBe(false)
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")
  await reader.cancel()
})

test("aborts the pending upstream request when the downstream stream is cancelled", async () => {
  setSsePreflushDeadlineForTest(20)
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", createMessagesRequest()),
  )
  const reader = requireBody(response).getReader()

  await reader.read()
  await reader.cancel()

  expect(await waitForUpstreamAbort()).toBe(true)
})

test("keeps the Anthropic event order unchanged when the first event is immediate", async () => {
  streamMode = "immediate"
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", createMessagesRequest()),
  )
  const body = await response.text()

  expect(body).not.toContain(": keepalive")
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
})

test("closes Chat text and emits one error on EOF without finish", async () => {
  streamMode = "chat-eof"
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", createMessagesRequest()),
  )
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
})

test("skips a malformed Chat delta before one Messages terminal", async () => {
  streamMode = "chat-malformed-recover"
  const body = await (
    await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", createMessagesRequest()),
    )
  ).text()

  expect(body).toContain("recovered")
  expect(body.match(/event: message_stop/g) ?? []).toHaveLength(1)
  expect(body).not.toContain("event: error")
  expect(body).not.toContain("{malformed")
})

test("treats Chat error null as a normal Messages chunk", async () => {
  streamMode = "chat-error-null"
  const body = await (
    await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", createMessagesRequest()),
    )
  ).text()

  expect(body).toContain("recovered")
  expect(body.match(/event: message_stop/g) ?? []).toHaveLength(1)
  expect(body).not.toContain("event: error")
})

test("preserves one Chat received error and ignores later malformed data", async () => {
  streamMode = "chat-received-error"
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", createMessagesRequest()),
  )
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
  expect(body).toContain("Upstream Chat stream failed.")
  expect(body).not.toContain("chat received private marker")
})

test.each([
  ["native-open-eof", "The Copilot Messages request failed."],
  ["native-open-error-throw", "received-safe-error"],
] as const)(
  "closes native blocks before one error for %s",
  async (mode, message) => {
    streamMode = mode
    state.models = nativeMessagesModels
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", createNativeMessagesRequest()),
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
      "error",
    ])
    expect(payloads[1]).toMatchObject({
      content_block: { type: "future_block", future: true },
    })
    expect(payloads.at(-1)).toMatchObject({ error: { message } })
  },
)

test("closes a native open block before the successful message_stop", async () => {
  streamMode = "native-open-success"
  state.models = nativeMessagesModels
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", createNativeMessagesRequest()),
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
})

test.each([
  [400, "invalid_request_error"],
  [401, "authentication_error"],
  [403, "permission_error"],
  [404, "not_found_error"],
  [413, "request_too_large"],
  [429, "rate_limit_error"],
  [500, "api_error"],
] as const)(
  "mounted native Messages stream maps late HTTP %s to %s",
  async (status, _type) => {
    streamMode = "native-late-http-error"
    nativeLateErrorStatus = status
    state.models = nativeMessagesModels

    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", createNativeMessagesRequest()),
    )
    const body = await response.text()
    const events = Array.from(
      body.matchAll(/^event: (.+)$/gm),
      (match) => match[1],
    )
    const payloads = Array.from(
      body.matchAll(/^data: (\{.*\})$/gm),
      (match) =>
        JSON.parse(match[1]) as {
          error?: { type?: unknown }
          type?: unknown
        },
    )

    expect(response.status).toBe(200)
    expect(events).toEqual(["message_start", "error"])
    expect(payloads.map((payload) => payload.type)).toEqual([
      "message_start",
      "error",
    ])
    expect(payloads.at(-1)?.error?.type).toBe("api_error")
    expect(payloads.at(-1)?.error).toMatchObject({
      message: "{}",
      status,
      content_type: "application/json;charset=utf-8",
    })
    expect(body).not.toContain("native stream private marker")
  },
)

test.each([
  [
    "local",
    new LocalHTTPError(
      "safe local validation",
      Response.json({}, { status: 400 }),
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "safe local validation",
        },
      },
    ),
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "safe local validation",
      },
    },
  ],
  [
    "upstream",
    new HTTPError(
      "stream-runtime-private-marker",
      Response.json(
        { error: { message: "stream-body-private-marker" } },
        { status: 429, statusText: "stream-status-private-marker" },
      ),
    ),
    {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Copilot rate limit exceeded.",
      },
    },
  ],
] as const)(
  "emits a safe Anthropic %s error after headers are committed",
  async (_kind, error, expected) => {
    const app = new Hono()
    app.get("/stream", (c) =>
      streamSSE(c, async (stream) => {
        await stream.write(": keepalive\n\n")
        await emitAnthropicStreamError(stream, error)
      }),
    )

    const response = await app.request("/stream")
    const body = await response.text()
    const data = body.match(/^data: (\{.*\})$/m)?.[1]

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(body).toContain("event: error")
    expect(data).toBeDefined()
    expect(JSON.parse(data ?? "null")).toEqual(expected)
    expect(body).not.toContain("private-marker")
  },
)

test("does not invoke hostile local body getters in an emitted stream error", async () => {
  let getterCalls = 0
  const hostileBody = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("stream-hostile-local-private-marker")
    },
  })
  const error = new LocalHTTPError(
    "local stream validation",
    Response.json({}, { status: 400 }),
    hostileBody,
  )
  const app = new Hono()
  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.write(": keepalive\n\n")
      await emitAnthropicStreamError(stream, error)
    }),
  )

  const response = await app.request("/stream")
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(body).toContain('"type":"invalid_request_error"')
  expect(body).toContain("The Copilot Messages request was rejected.")
  expect(getterCalls).toBe(0)
  expect(body).not.toContain("stream-hostile-local-private-marker")
})

test("rejects dangerous local JSON keys in an emitted stream error", async () => {
  const clientBody = JSON.parse(
    '{"type":"error","error":{"type":"invalid_request_error","message":"safe"},"__proto__":{"polluted":"stream-json-private-marker"}}',
  ) as Record<string, unknown>
  const error = new LocalHTTPError(
    "local stream validation",
    Response.json({}, { status: 400 }),
    clientBody,
  )
  const app = new Hono()
  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      await emitAnthropicStreamError(stream, error)
    }),
  )

  const response = await app.request("/stream")
  const body = await response.text()

  expect(body).toContain("The Copilot Messages request was rejected.")
  expect(body).not.toContain("stream-json-private-marker")
  expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
})

test("commits a keepalive while native Anthropic waits for upstream headers", async () => {
  setSsePreflushDeadlineForTest(20)
  streamMode = "stall-fetch"
  state.models = nativeMessagesModels
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", createNativeMessagesRequest()),
  )
  const reader = requireBody(response).getReader()
  const first = await reader.read()

  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(first.done).toBe(false)
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")
  await reader.cancel()
  expect(await waitForUpstreamAbort()).toBe(true)
})

test("forwards native Messages metadata verbatim except for the requested model", async () => {
  streamMode = "native-metadata"
  state.models = nativeMessagesModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", createNativeMessagesRequest()),
  )
  const body = await response.text()
  const payloads = Array.from(
    body.matchAll(/^data: (\{.*\})$/gm),
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  )

  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(payloads).toEqual([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4.8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
        recommended_auto_tier: "eco",
        future_message_field: { preserved: true },
      },
      future_event_field: "start-metadata",
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
        cache_creation: { ephemeral_5m_input_tokens: 1 },
        future_usage_field: true,
      },
      copilot_usage: { total_nano_aiu: 123 },
      future_event_field: "delta-metadata",
    },
    { type: "message_stop" },
  ])
  expect(body).not.toContain("[DONE]")
})
