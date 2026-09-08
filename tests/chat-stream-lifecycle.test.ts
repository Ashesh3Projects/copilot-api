import * as Sentry from "@sentry/bun"
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const encoder = new TextEncoder()

let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined

const nativeModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "chat-lifecycle-model",
      name: "Chat Lifecycle Model",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/chat/completions"],
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
      id: "claude-lifecycle-model",
      name: "Claude Lifecycle Model",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
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

const fetchMock = mock(
  (_url: string | URL | Request) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller
        },
      }),
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    ),
)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  setConfigForTest(null)
  state.models = originalModels
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  upstreamController = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = nativeModels
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "lifecycle-custom",
        name: "Lifecycle Custom",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "custom-key",
        models: [
          {
            id: "custom-lifecycle-model",
            kind: "chat",
            supportsStreaming: true,
          },
        ],
      },
    ],
  })
})

test.each([
  { name: "native", model: "chat-lifecycle-model" },
  { name: "custom", model: "custom-lifecycle-model" },
])(
  "preserves one received $name Chat error without a generic duplicate or report",
  async ({ model }) => {
    const logSpy = spyOn(consola, "error")
    const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
      () => "event-id",
    )
    try {
      const receivedError = {
        type: "invalid_request_error",
        message: `${model}-received-error`,
        code: "invalid_value",
      }
      const responsePromise = postChat(model)
      await waitForUpstreamController()
      enqueueRaw(JSON.stringify({ error: receivedError }))
      enqueueRaw("[DONE]")
      upstreamController?.close()

      const body = await (await responsePromise).text()
      expect(errorFrames(body)).toEqual([{ error: receivedError }])
      expect(doneCount(body)).toBe(1)
      expect(body).not.toContain(
        "An unexpected error occurred during streaming.",
      )
      expect(logSpy).not.toHaveBeenCalled()
      expect(sentrySpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
      sentrySpy.mockRestore()
    }
  },
)

test.each([
  { name: "native", model: "chat-lifecycle-model" },
  { name: "custom", model: "custom-lifecycle-model" },
])("treats $name Chat error null as a normal chunk", async ({ model }) => {
  const responsePromise = postChat(model)
  await waitForUpstreamController()
  enqueueRaw(
    JSON.stringify({
      id: "chat_error_null",
      object: "chat.completion.chunk",
      created: 1,
      model,
      error: null,
      choices: [
        {
          index: 0,
          delta: { content: "kept" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }),
  )
  enqueueRaw("[DONE]")
  upstreamController?.close()

  const body = await (await responsePromise).text()
  expect(body).toContain("kept")
  expect(errorFrames(body)).toEqual([])
  expect(doneCount(body)).toBe(1)
})

test.each([
  { name: "native", model: "chat-lifecycle-model" },
  { name: "custom", model: "custom-lifecycle-model" },
])(
  "repairs a $name final chunk that lacks an upstream DONE sentinel",
  async ({ model }) => {
    const responsePromise = postChat(model)
    await waitForUpstreamController()
    enqueueChat({ content: "finished" }, "stop")
    upstreamController?.close()

    const body = await (await responsePromise).text()
    expect(
      chatFrames(body).filter((frame) => hasFinishReason(frame)),
    ).toHaveLength(1)
    expect(doneCount(body)).toBe(1)
    expect(errorFrames(body)).toEqual([])
  },
)

test.each([
  { name: "native", model: "chat-lifecycle-model" },
  { name: "custom", model: "custom-lifecycle-model" },
])(
  "fails a $name stream whose bare DONE arrives without a final chunk",
  async ({ model }) => {
    const responsePromise = postChat(model)
    await waitForUpstreamController()
    enqueueChat({ content: "partial" })
    enqueueRaw("[DONE]")
    upstreamController?.close()

    const body = await (await responsePromise).text()
    expect(chatContent(body)).toContain("partial")
    expect(
      chatFrames(body).filter((frame) => hasFinishReason(frame)),
    ).toHaveLength(0)
    expect(errorFrames(body)).toHaveLength(1)
    expect(doneCount(body)).toBe(1)
  },
)

test.each([
  { name: "native", model: "chat-lifecycle-model" },
  { name: "custom", model: "custom-lifecycle-model" },
])("fails a malformed $name success stream exactly once", async ({ model }) => {
  const responsePromise = postChat(model)
  await waitForUpstreamController()
  enqueueRaw("{malformed-json")
  upstreamController?.close()

  const body = await (await responsePromise).text()
  expect(errorFrames(body)).toHaveLength(1)
  expect(doneCount(body)).toBe(1)
  expect(body).not.toContain("malformed-json")
})

test.each([
  { name: "native", model: "chat-lifecycle-model" },
  { name: "custom", model: "custom-lifecycle-model" },
])(
  "retains a $name partial delta before a transport throw",
  async ({ model }) => {
    const responsePromise = postChat(model)
    await waitForUpstreamController()
    enqueueChat({ content: "partial-before-throw" })
    upstreamController?.error(new Error("private runtime marker"))

    const body = await (await responsePromise).text()
    expect(chatContent(body)).toContain("partial-before-throw")
    expect(errorFrames(body)).toHaveLength(1)
    expect(doneCount(body)).toBe(1)
    expect(body).not.toContain("private runtime marker")
  },
)

test.each([
  { name: "native", model: "chat-lifecycle-model" },
  { name: "custom", model: "custom-lifecycle-model" },
])("suppresses duplicate and post-terminal $name frames", async ({ model }) => {
  const responsePromise = postChat(model)
  await waitForUpstreamController()
  enqueueChat({ content: "kept" })
  enqueueChat({}, "stop")
  enqueueRaw("[DONE]")
  enqueueChat({ content: "must-not-appear" })
  enqueueChat({}, "length")
  enqueueRaw("[DONE]")
  const response = await responsePromise
  const reader = requireBody(response).getReader()
  const terminal = await readUntil(reader, (body) => body.includes("[DONE]"))
  upstreamController?.error(new Error("post-terminal throw"))

  const body = terminal + (await readRemaining(reader))
  expect(chatContent(body)).toContain("kept")
  expect(chatContent(body)).not.toContain("must-not-appear")
  expect(
    chatFrames(body).filter((frame) => hasFinishReason(frame)),
  ).toHaveLength(1)
  expect(errorFrames(body)).toEqual([])
  expect(doneCount(body)).toBe(1)
})

test.each([
  {
    name: "text",
    body: encoder.encode("  exact chat text\r\n  "),
    contentType: "text/plain; charset=utf-8",
  },
  {
    name: "binary",
    body: Uint8Array.from([0x00, 0xff, 0x80, 0x41]),
    contentType: "application/octet-stream",
  },
] as const)(
  "preserves and reports one winning native $name HTTPError",
  async (fixture) => {
    const logSpy = spyOn(consola, "error")
    const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
      () => "event-id",
    )
    try {
      const responsePromise = postChat("chat-lifecycle-model")
      await waitForUpstreamController()
      enqueueChat({ content: "partial" })
      upstreamController?.error(
        new HTTPError(
          "HTTPError marker must not leak",
          new Response(fixture.body.slice(), {
            headers: { "content-type": fixture.contentType },
            status: 429,
            statusText: "Private Status",
          }),
        ),
      )

      const body = await (await responsePromise).text()
      const error = errorFrames(body)[0]?.error
      const expected =
        fixture.name === "text" ?
          new TextDecoder(undefined, { ignoreBOM: true }).decode(fixture.body)
        : Array.from(fixture.body)
      expect(error).toEqual({
        message: expected,
        type: "api_error",
        content_type: fixture.contentType,
        status: 429,
      })
      expect(doneCount(body)).toBe(1)
      expect(
        logSpy.mock.calls.filter(
          (call) =>
            typeof call[0] === "object"
            && call[0] !== null
            && "upstreamResponseBodyBytes" in call[0],
        ),
      ).toHaveLength(1)
      expect(sentrySpy).toHaveBeenCalledTimes(1)
      expect(
        JSON.stringify([body, logSpy.mock.calls, sentrySpy.mock.calls]),
      ).not.toContain("HTTPError marker must not leak")
    } finally {
      logSpy.mockRestore()
      sentrySpy.mockRestore()
    }
  },
)

test("suppresses native failure and reporting after downstream abort", async () => {
  const logSpy = spyOn(consola, "error")
  const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )
  try {
    const responsePromise = postChat("chat-lifecycle-model")
    await waitForUpstreamController()
    enqueueChat({ content: "before-abort" })
    const response = await responsePromise
    const reader = requireBody(response).getReader()
    await reader.read()
    await reader.cancel()
    upstreamController?.error(
      new HTTPError(
        "late abort marker",
        new Response("late abort body", {
          headers: { "content-type": "text/plain" },
          status: 502,
        }),
      ),
    )
    await delay(0)

    expect(
      logSpy.mock.calls.filter(
        (call) => typeof call[0] === "object" && call[0] !== null,
      ),
    ).toEqual([])
    expect(sentrySpy).not.toHaveBeenCalled()
  } finally {
    logSpy.mockRestore()
    sentrySpy.mockRestore()
  }
})

test.each(["throw", "eof", "malformed"] as const)(
  "retains Messages-backed partial output and fails once on %s",
  async (mode) => {
    const responsePromise = postChat("claude-lifecycle-model")
    await waitForUpstreamController()
    enqueueAnthropic("message_start", {
      type: "message_start",
      message: {
        id: "msg_lifecycle",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })
    enqueueAnthropic("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "messages-partial" },
    })
    if (mode === "throw") {
      const response = await responsePromise
      const reader = requireBody(response).getReader()
      const partial = await readUntil(reader, (body) =>
        body.includes("messages-partial"),
      )
      upstreamController?.error(new Error("private Messages runtime marker"))
      const body = partial + (await readRemaining(reader))
      expect(chatContent(body)).toContain("messages-partial")
      expect(errorFrames(body)).toHaveLength(1)
      expect(doneCount(body)).toBe(1)
      expect(
        chatFrames(body).filter((frame) => hasFinishReason(frame)),
      ).toHaveLength(0)
      expect(body).not.toContain("private Messages runtime marker")
      return
    } else if (mode === "malformed") {
      enqueueRaw("{malformed-messages")
      upstreamController?.close()
    } else {
      upstreamController?.close()
    }

    const body = await (await responsePromise).text()
    expect(chatContent(body)).toContain("messages-partial")
    expect(errorFrames(body)).toHaveLength(1)
    expect(doneCount(body)).toBe(1)
    expect(
      chatFrames(body).filter((frame) => hasFinishReason(frame)),
    ).toHaveLength(0)
    expect(body).not.toContain("private Messages runtime marker")
  },
)

test("preserves split Messages tool arguments before EOF failure", async () => {
  const responsePromise = postChat("claude-lifecycle-model")
  await waitForUpstreamController()
  enqueueAnthropic("message_start", {
    type: "message_start",
    message: {
      id: "msg_tool_lifecycle",
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })
  enqueueAnthropic("content_block_start", {
    type: "content_block_start",
    index: 3,
    content_block: {
      type: "tool_use",
      id: "tool_1",
      name: "lookup",
      input: {},
    },
  })
  enqueueAnthropic("content_block_delta", {
    type: "content_block_delta",
    index: 3,
    delta: { type: "input_json_delta", partial_json: '{"city":' },
  })
  enqueueAnthropic("content_block_delta", {
    type: "content_block_delta",
    index: 3,
    delta: { type: "input_json_delta", partial_json: '"Paris"}' },
  })
  upstreamController?.close()

  const body = await (await responsePromise).text()
  const argumentsText = chatFrames(body)
    .flatMap(
      (frame) =>
        frame.choices as Array<{
          delta?: {
            tool_calls?: Array<{ function?: { arguments?: string } }>
          }
        }>,
    )
    .flatMap((choice) => choice.delta?.tool_calls ?? [])
    .map((tool) => tool.function?.arguments ?? "")
    .join("")
  expect(argumentsText).toBe('{"city":"Paris"}')
  expect(errorFrames(body)).toHaveLength(1)
  expect(doneCount(body)).toBe(1)
})

test("preserves one received Messages error without reporting it", async () => {
  const logSpy = spyOn(consola, "error")
  const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )
  try {
    const responsePromise = postChat("claude-lifecycle-model")
    await waitForUpstreamController()
    enqueueAnthropic("error", {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "received Messages failure",
      },
    })
    upstreamController?.close()

    const body = await (await responsePromise).text()
    expect(errorFrames(body)).toEqual([
      {
        error: {
          type: "invalid_request_error",
          message: "received Messages failure",
        },
      },
    ])
    expect(doneCount(body)).toBe(1)
    expect(logSpy).not.toHaveBeenCalled()
    expect(sentrySpy).not.toHaveBeenCalled()
  } finally {
    logSpy.mockRestore()
    sentrySpy.mockRestore()
  }
})

test.each([
  {
    stopReason: "pause_turn",
    finishReason: "length",
    copilotStopReason: "pause_turn",
  },
  {
    stopReason: "refusal",
    finishReason: "content_filter",
    copilotStopReason: undefined,
  },
] as const)(
  "maps Messages $stopReason to its distinct Chat terminal",
  async ({ stopReason, finishReason, copilotStopReason }) => {
    const responsePromise = postChat("claude-lifecycle-model")
    await waitForUpstreamController()
    enqueueAnthropic("message_start", {
      type: "message_start",
      message: {
        id: "msg_terminal_lifecycle",
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    })
    enqueueAnthropic("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: 3 },
    })
    enqueueAnthropic("message_stop", { type: "message_stop" })
    enqueueAnthropic("message_stop", { type: "message_stop" })
    upstreamController?.close()

    const body = await (await responsePromise).text()
    const finals = chatFrames(body).filter((frame) => hasFinishReason(frame))
    expect(finals).toHaveLength(1)
    const final = finals[0]
    const choice = (final.choices as Array<{ finish_reason?: unknown }>)[0]
    expect(choice.finish_reason).toBe(finishReason)
    expect(final.copilot_stop_reason).toBe(copilotStopReason)
    expect(doneCount(body)).toBe(1)
    expect(errorFrames(body)).toEqual([])
  },
)

function postChat(model: string): Promise<Response> {
  return Promise.resolve(
    seedProtocolDatabase().then(() =>
      server.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
    ),
  )
}

function enqueueRaw(data: string): void {
  upstreamController?.enqueue(encoder.encode(`data: ${data}\n\n`))
}

function enqueueAnthropic(event: string, data: Record<string, unknown>): void {
  upstreamController?.enqueue(
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
  )
}

function enqueueChat(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): void {
  enqueueRaw(
    JSON.stringify({
      id: "chatcmpl_lifecycle",
      object: "chat.completion.chunk",
      created: 1,
      model: "upstream-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }),
  )
}

function chatFrames(body: string): Array<Record<string, unknown>> {
  return dataLines(body)
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>)
    .filter((frame) => Array.isArray(frame.choices))
}

function errorFrames(body: string): Array<{ error: Record<string, unknown> }> {
  return dataLines(body)
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>)
    .filter(
      (frame): frame is { error: Record<string, unknown> } =>
        typeof frame.error === "object" && frame.error !== null,
    )
}

function dataLines(body: string): Array<string> {
  return Array.from(body.matchAll(/^data: (.*)$/gm), (match) => match[1])
}

function doneCount(body: string): number {
  return dataLines(body).filter((data) => data === "[DONE]").length
}

function chatContent(body: string): string {
  return chatFrames(body)
    .map((frame) => {
      const choices = frame.choices as Array<{
        delta?: { content?: unknown }
      }>
      return typeof choices[0]?.delta?.content === "string" ?
          choices[0].delta.content
        : ""
    })
    .join("")
}

function hasFinishReason(frame: Record<string, unknown>): boolean {
  const choices = frame.choices as Array<{ finish_reason?: unknown }>
  return choices.some(
    (choice) =>
      choice.finish_reason !== null && choice.finish_reason !== undefined,
  )
}

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("Expected an SSE response body")
  return response.body
}

async function waitForUpstreamController(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (upstreamController) return
    await delay(0)
  }
  throw new Error("Timed out waiting for upstream stream controller")
}

async function readUntil(
  reader: SseReader,
  predicate: (body: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder()
  let output = ""
  while (!predicate(output)) {
    const next = await reader.read()
    if (next.done) return output
    output += decoder.decode(next.value, { stream: true })
  }
  return output
}

async function readRemaining(reader: SseReader): Promise<string> {
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const next = await reader.read()
    if (next.done) return output
    output += decoder.decode(next.value, { stream: true })
  }
}

interface SseReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
