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

import { HTTPError } from "~/lib/error"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const encoder = new TextEncoder()

let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined

const fetchMock = mock((url: string | URL | Request) => {
  const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
  const path = new URL(rawUrl).pathname
  if (path !== "/responses" && path !== "/chat/completions") {
    throw new Error(`Unexpected upstream path ${path}`)
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller
      },
    }),
    { headers: { "content-type": "text/event-stream" }, status: 200 },
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
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
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test.each([
  { name: "ordinary", tools: undefined },
  {
    name: "hosted web search",
    tools: [{ type: "web_search", external_web_access: true }],
  },
])(
  "forwards the first native $name delta before source completion",
  async ({ tools }) => {
    installModel("/responses")
    const response = await postResponses({
      input: "hello",
      stream: true,
      tools,
    })
    const reader = requireBody(response).getReader()
    const firstRead = reader.read()

    enqueueNative("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 4,
      item_id: "msg_immediate",
      output_index: 0,
      content_index: 0,
      delta: "first-delta",
    })
    const outcome = await Promise.race([
      firstRead.then((value) => ({ kind: "data" as const, value })),
      delay(80).then(() => ({ kind: "timeout" as const })),
    ])

    enqueueNativeTerminal({
      event: "response.completed",
      status: "completed",
      sequenceNumber: 5,
    })
    upstreamController?.close()
    await reader.cancel()

    expect(outcome.kind).toBe("data")
    if (outcome.kind === "data") {
      expect(new TextDecoder().decode(outcome.value.value)).toContain(
        "first-delta",
      )
    }
  },
)

test("buffers an explicitly emulated function web_search before iteration", async () => {
  installModel("/responses")
  const response = await postResponses({
    input: "search",
    stream: true,
    tools: [
      {
        type: "function",
        name: "web_search",
        description: "Search",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ],
  })
  const reader = requireBody(response).getReader()
  const firstRead = reader.read()

  enqueueNative("response.output_text.delta", {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_buffered",
    output_index: 0,
    content_index: 0,
    delta: "buffered-delta",
  })
  const early = await Promise.race([
    firstRead.then(() => "data" as const),
    delay(40).then(() => "timeout" as const),
  ])
  enqueueNativeTerminal({
    event: "response.completed",
    status: "completed",
    sequenceNumber: 2,
  })
  upstreamController?.close()

  const first = await firstRead
  const rest = await readRemaining(reader)
  expect(early).toBe("timeout")
  const body = new TextDecoder().decode(first.value) + rest
  expect(body).not.toContain("buffered-delta")
  expect(events(body).at(-1)).toBe("response.completed")
})

test.each([
  {
    name: "throws",
    finish: () => upstreamController?.error(new Error("late source failure")),
  },
  { name: "ends cleanly", finish: () => upstreamController?.close() },
])(
  "retains a native partial delta and fails when the source $name",
  async ({ finish }) => {
    installModel("/responses")
    const response = await postResponses({ input: "hello", stream: true })
    const reader = requireBody(response).getReader()
    enqueueNative("response.created", {
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_partial_native",
        object: "response",
        created_at: 17,
        model: "route-model",
        status: "in_progress",
        output: [],
        output_text: "",
        usage: null,
        error: null,
        incomplete_details: null,
      },
    })
    enqueueNative("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 1,
      item_id: "msg_partial_native",
      output_index: 0,
      content_index: 0,
      delta: "native-partial",
    })
    const partial = await reader.read()
    const partialText = new TextDecoder().decode(partial.value)
    finish()

    const body = partialText + (await readRemaining(reader))
    expect(events(body)).toEqual([
      "response.created",
      "response.output_text.delta",
      "error",
      "response.failed",
    ])
    const terminal = dataFrames(body).at(-1) as {
      response?: { id?: string; output_text?: string; output?: Array<unknown> }
    }
    expect(terminal.response).toMatchObject({
      id: "resp_partial_native",
      output_text: "native-partial",
    })
    expect(terminal.response?.output).toHaveLength(1)
    expect(body).not.toContain("[DONE]")
  },
)

test("suppresses duplicate and post-terminal native frames", async () => {
  installModel("/responses")
  const response = await postResponses({ input: "hello", stream: true })
  const reader = requireBody(response).getReader()
  enqueueNativeTerminal({
    event: "response.completed",
    status: "completed",
    sequenceNumber: 0,
    id: "resp_first",
  })
  enqueueNative("response.output_text.delta", {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_late",
    output_index: 0,
    content_index: 0,
    delta: "must-not-appear",
  })
  enqueueNativeTerminal({
    event: "response.completed",
    status: "completed",
    sequenceNumber: 2,
    id: "resp_second",
  })
  upstreamController?.error(new Error("must not become a late failure"))

  const body = await readRemaining(reader)
  expect(events(body)).toEqual(["response.completed"])
  expect(body).toContain("resp_first")
  expect(body).not.toContain("resp_second")
  expect(body).not.toContain("must-not-appear")
  expect(body).not.toContain("response.failed")
})

test("forwards native incomplete as the sole terminal without reconstruction", async () => {
  installModel("/responses")
  const futureTerminal = {
    type: "response.incomplete",
    sequence_number: 8,
    future_event: { retained: true },
    response: {
      id: "resp_incomplete",
      status: "incomplete",
      output: [{ type: "future_item", state: "partial" }],
      output_text: "partial",
      incomplete_details: { reason: "future_limit" },
      future_response: ["retained"],
    },
  }
  const response = await postResponses({ input: "hello", stream: true })
  const reader = requireBody(response).getReader()
  enqueueRaw("response.incomplete", JSON.stringify(futureTerminal))
  upstreamController?.close()

  const body = await readRemaining(reader)
  expect(events(body)).toEqual(["response.incomplete"])
  expect(dataFrames(body)).toEqual([futureTerminal])
})

test.each(["response.failed", "error"] as const)(
  "forwards a received native %s terminal once with future fields",
  async (terminalType) => {
    installModel("/responses")
    const terminal =
      terminalType === "error" ?
        {
          type: "error",
          sequence_number: 3,
          code: "future_error",
          message: "exact received detail",
          future_error: { retained: true },
        }
      : {
          type: "response.failed",
          sequence_number: 3,
          future_event: "retained",
          response: {
            id: "resp_received_failed",
            status: "failed",
            output: [{ type: "future_item", state: "partial" }],
            output_text: "partial",
            error: { code: "future_error", message: "exact received detail" },
            future_response: { retained: true },
          },
        }
    const response = await postResponses({ input: "hello", stream: true })
    const reader = requireBody(response).getReader()
    enqueueRaw(terminalType, JSON.stringify(terminal))
    upstreamController?.close()

    const body = await readRemaining(reader)
    expect(events(body)).toEqual([terminalType])
    expect(dataFrames(body)).toEqual([terminal])
    expect(body).not.toContain("Upstream request failed")
  },
)

test.each([
  {
    body: encoder.encode("  exact text\r\nbody  \r\n"),
    contentType: "text/plain; charset=utf-8",
    field: "message",
    name: "text",
  },
  {
    body: Uint8Array.from([0x00, 0xff, 0x80, 0x41]),
    contentType: "application/octet-stream",
    field: "body_bytes",
    name: "binary",
  },
] as const)(
  "encodes and reports one late native HTTPError with exact $name content",
  async (fixture) => {
    installModel("/responses")
    const logSpy = spyOn(consola, "error")
    const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
      () => "event-id",
    )
    try {
      const response = await postResponses({ input: "hello", stream: true })
      const reader = requireBody(response).getReader()
      enqueueNative("response.output_text.delta", {
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_http_error",
        output_index: 0,
        content_index: 0,
        delta: "partial-before-http-error",
      })
      upstreamController?.error(
        new HTTPError(
          "HTTPError message must not leak",
          new Response(fixture.body.slice(), {
            headers: { "content-type": fixture.contentType },
            status: 429,
            statusText: "Private Status Text",
          }),
          { private_request: "must-not-leak" },
        ),
      )
      const body = await readRemaining(reader)
      const frames = dataFrames(body) as Array<Record<string, unknown>>
      const expected =
        fixture.field === "message" ?
          new TextDecoder(undefined, { ignoreBOM: true }).decode(fixture.body)
        : Array.from(fixture.body)
      for (const frame of frames.slice(-2)) {
        const error = frameError(frame)
        expect(error[fixture.field]).toEqual(expected)
        expect(error.status).toBe(429)
        expect(error.content_type).toBe(fixture.contentType)
      }
      const structuredLogs = logSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === "object"
          && call[0] !== null
          && "upstreamResponseBodyBytes" in call[0],
      )
      expect(structuredLogs).toHaveLength(1)
      expect(
        sentrySpy.mock.calls.filter((call) => hasUpstreamBodyExtra(call[1])),
      ).toHaveLength(1)
      const diagnostics = JSON.stringify([
        body,
        logSpy.mock.calls,
        sentrySpy.mock.calls,
      ])
      expect(diagnostics).not.toContain("HTTPError message must not leak")
      expect(diagnostics).not.toContain("Private Status Text")
      expect(diagnostics).not.toContain("must-not-leak")
    } finally {
      logSpy.mockRestore()
      sentrySpy.mockRestore()
    }
  },
)

test("suppresses native failure and reporting after downstream abort", async () => {
  installModel("/responses")
  const logSpy = spyOn(consola, "error")
  const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )
  const unhandled: Array<unknown> = []
  const onUnhandled = (event: Event): void => {
    unhandled.push((event as unknown as { reason?: unknown }).reason)
  }
  globalThis.addEventListener("unhandledrejection", onUnhandled)
  try {
    const response = await postResponses({ input: "hello", stream: true })
    const reader = requireBody(response).getReader()
    const firstRead = reader.read()
    enqueueNative("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 1,
      item_id: "msg_abort",
      output_index: 0,
      content_index: 0,
      delta: "before-abort",
    })
    await firstRead
    await reader.cancel()
    upstreamController?.error(
      new HTTPError(
        "late abort error",
        new Response("exact late body", {
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
    expect(unhandled).toEqual([])
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled)
    logSpy.mockRestore()
    sentrySpy.mockRestore()
  }
})

test.each([
  {
    name: "throws",
    finish: () => upstreamController?.error(new Error("chat source failure")),
  },
  { name: "ends cleanly", finish: () => upstreamController?.close() },
])(
  "retains Chat fallback partial output and fails when the source $name",
  async ({ finish }) => {
    installModel("/chat/completions")
    const responsePromise = postResponses({ input: "hello", stream: true })
    await waitForUpstreamController()
    enqueueChat({ content: "chat-partial" })
    const response = await responsePromise
    const reader = requireBody(response).getReader()
    const partial = await reader.read()
    const partialText = new TextDecoder().decode(partial.value)
    finish()

    const body = partialText + (await readRemaining(reader))
    expect(events(body).slice(-2)).toEqual(["error", "response.failed"])
    const terminal = dataFrames(body).at(-1) as {
      response?: { output_text?: string; output?: Array<unknown> }
    }
    expect(terminal.response?.output_text).toBe("chat-partial")
    expect(terminal.response?.output).toHaveLength(1)
    expect(body).not.toContain("[DONE]")
  },
)

test("maps Chat finish_reason length to one response.incomplete terminal", async () => {
  installModel("/chat/completions")
  const responsePromise = postResponses({ input: "hello", stream: true })
  await waitForUpstreamController()
  enqueueChat({ content: "truncated" })
  const response = await responsePromise
  const reader = requireBody(response).getReader()
  enqueueChat({}, "length")
  enqueueRaw(undefined, "[DONE]")
  upstreamController?.close()

  const body = await readRemaining(reader)
  expect(
    events(body).filter((event) => event.startsWith("response.")),
  ).toContain("response.incomplete")
  expect(events(body)).not.toContain("response.completed")
  expect(events(body)).not.toContain("response.failed")
  const terminal = dataFrames(body).at(-1) as {
    response?: { status?: string; incomplete_details?: unknown }
  }
  expect(terminal.response).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  })
})

test("keeps the public requested model across Chat fallback stream events", async () => {
  installModel("/chat/completions")
  const responsePromise = postResponses({ input: "hello", stream: true })
  await waitForUpstreamController()
  enqueueChatWithModel("provider-canonical-model", { content: "hello" })
  const response = await responsePromise
  const reader = requireBody(response).getReader()
  enqueueChatWithModel("provider-canonical-model", {}, "stop")
  enqueueRaw(undefined, "[DONE]")
  upstreamController?.close()

  const body = await readRemaining(reader)
  const responseModels = dataFrames(body).flatMap((frame) => {
    if (typeof frame !== "object" || frame === null) return []
    const responseValue = (frame as { response?: unknown }).response
    if (typeof responseValue !== "object" || responseValue === null) return []
    const model = (responseValue as { model?: unknown }).model
    return typeof model === "string" ? [model] : []
  })
  expect(responseModels.length).toBeGreaterThan(0)
  expect(new Set(responseModels)).toEqual(new Set(["route-model"]))
  expect(body).not.toContain("provider-canonical-model")
})

function installModel(endpoint: "/responses" | "/chat/completions"): void {
  state.models = {
    object: "list",
    data: [
      {
        id: "route-model",
        name: "Route Model",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: [endpoint],
        capabilities: {
          family: "gpt",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  } satisfies ModelsResponse
}

function postResponses(extra: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(
    seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "route-model", ...extra }),
      }),
    ),
  )
}

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("Expected an SSE response body")
  return response.body
}

function enqueueRaw(event: string | undefined, data: string): void {
  const eventLine = event ? `event: ${event}\n` : ""
  upstreamController?.enqueue(encoder.encode(`${eventLine}data: ${data}\n\n`))
}

function enqueueNative(event: string, data: Record<string, unknown>): void {
  enqueueRaw(event, JSON.stringify(data))
}

function enqueueNativeTerminal(options: {
  event: "response.completed" | "response.incomplete"
  status: "completed" | "incomplete"
  sequenceNumber: number
  id?: string
}): void {
  enqueueNative(options.event, {
    type: options.event,
    sequence_number: options.sequenceNumber,
    response: {
      id: options.id ?? "resp_terminal",
      object: "response",
      created_at: 1,
      model: "route-model",
      status: options.status,
      output: [],
      output_text: "",
      usage: null,
      error: null,
      incomplete_details:
        options.status === "incomplete" ?
          { reason: "max_output_tokens" }
        : null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    },
  })
}

function enqueueChat(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): void {
  enqueueChatWithModel("route-model", delta, finishReason)
}

function enqueueChatWithModel(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): void {
  enqueueRaw(
    undefined,
    JSON.stringify({
      id: "chatcmpl_lifecycle",
      object: "chat.completion.chunk",
      created: 7,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }),
  )
}

function events(body: string): Array<string> {
  return Array.from(body.matchAll(/^event: (.+)$/gm), (match) => match[1])
}

function dataFrames(body: string): Array<unknown> {
  return Array.from(
    body.matchAll(/^data: (\{.*\})$/gm),
    (match) => JSON.parse(match[1]) as unknown,
  )
}

async function readRemaining(reader: {
  read: () => Promise<
    { done: false; value: Uint8Array } | { done: true; value?: Uint8Array }
  >
}): Promise<string> {
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const next = await reader.read()
    if (next.done) return output
    output += decoder.decode(next.value, { stream: true })
  }
}

function frameError(frame: Record<string, unknown>): Record<string, unknown> {
  const response = frame.response
  if (typeof response !== "object" || response === null) return frame
  const error = (response as Record<string, unknown>).error
  return typeof error === "object" && error !== null ?
      (error as Record<string, unknown>)
    : frame
}

function hasUpstreamBodyExtra(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const extra = (value as Record<string, unknown>).extra
  return (
    typeof extra === "object"
    && extra !== null
    && "upstreamResponseBodyBytes" in extra
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForUpstreamController(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (upstreamController) return
    await delay(1)
  }
  throw new Error("Upstream stream controller was not created")
}
