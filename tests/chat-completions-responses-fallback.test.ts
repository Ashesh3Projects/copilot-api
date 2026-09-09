/* eslint-disable max-lines -- focused Responses fallback integration matrix */
import * as Sentry from "@sentry/bun"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { HTTPError } from "../src/lib/error"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { setSsePreflushDeadlineForTest } from "../src/lib/sse-lifecycle"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch

let lastUpstreamPath: string | undefined
let lastUpstreamPayload: Record<string, unknown> | undefined
let lastUpstreamHeaders: Headers | undefined
let delayBufferedWebSearchResponse = false
let nextResponsesStreamError:
  | { kind: "error"; marker: string }
  | { kind: "failed"; marker: string }
  | undefined
let responsesStreamMode:
  | "complete"
  | "duplicate"
  | "eof"
  | "malformed"
  | "malformed-recover"
  | "malformed-terminal"
  | "received-error"
  | "received-failed"
  | "throw"
  | "http-text"
  | "http-binary" = "complete"
let delayedResponsesController:
  | ReadableStreamDefaultController<Uint8Array>
  | undefined
let responsesThrowController:
  | ReadableStreamDefaultController<Uint8Array>
  | undefined

const responsesOnlyModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-5.5",
      name: "gpt-5.5",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
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
      id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
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
}

const messagesOnlyModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-messages-only",
      name: "Claude Messages Only",
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

const responsesResult = {
  id: "resp_legacy",
  object: "response",
  created_at: 1,
  model: "gpt-5.5",
  output: [
    {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "encrypted-state",
      status: "completed",
    },
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "hello from responses",
          annotations: [],
        },
      ],
    },
  ],
  output_text: "hello from responses",
  status: "completed",
  usage: {
    input_tokens: 3,
    output_tokens: 4,
    total_tokens: 7,
    input_tokens_details: { cached_tokens: 1 },
    output_tokens_details: { reasoning_tokens: 2 },
  },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
}

const emptyOutputTextResponsesResult = {
  ...responsesResult,
  output: [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: '{"intent":"hybrid"}',
          annotations: [],
        },
      ],
    },
  ],
  output_text: "",
}

const responsesCreatedEvent = {
  type: "response.created",
  sequence_number: 0,
  response: {
    ...responsesResult,
    output: [],
    output_text: "",
    status: "in_progress",
    usage: null,
  },
}

const responsesTextDeltaEvent = {
  type: "response.output_text.delta",
  sequence_number: 1,
  item_id: "msg_1",
  output_index: 0,
  content_index: 0,
  delta: "hello streamed",
}

const responsesCompletedEvent = {
  type: "response.completed",
  sequence_number: 2,
  response: {
    ...responsesResult,
    output_text: "hello streamed",
    output: [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "hello streamed",
            annotations: [],
          },
        ],
      },
    ],
  },
}

function createResponsesSse(): Response {
  if (nextResponsesStreamError) {
    const current = nextResponsesStreamError
    const event =
      current.kind === "error" ?
        {
          type: "error",
          code: "upstream_error",
          message: current.marker,
          param: null,
          sequence_number: 1,
        }
      : {
          type: "response.failed",
          sequence_number: 1,
          response: {
            ...responsesResult,
            status: "failed",
            error: { message: current.marker },
          },
        }
    return new Response(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    )
  }
  const prefix =
    [
      `event: response.created\ndata: ${JSON.stringify(responsesCreatedEvent)}`,
      `event: response.output_text.delta\ndata: ${JSON.stringify(responsesTextDeltaEvent)}`,
    ].join("\n\n") + "\n\n"
  if (responsesStreamMode === "eof") return responsesStream(prefix)
  if (responsesStreamMode === "malformed") {
    return responsesStream(
      `${prefix}event: response.output_text.delta\ndata: {malformed\n\n`,
    )
  }
  if (responsesStreamMode === "received-error") {
    return responsesStream(
      `${prefix}event: error\ndata: ${JSON.stringify({
        type: "error",
        code: "upstream_error",
        message: "received Responses error",
        param: null,
        sequence_number: 2,
      })}\n\n`,
    )
  }
  if (responsesStreamMode === "received-failed") {
    return responsesStream(
      `${prefix}event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        sequence_number: 2,
        response: {
          ...responsesResult,
          status: "failed",
          error: { message: "received Responses failed" },
        },
      })}\n\n`,
    )
  }
  if (
    responsesStreamMode === "throw"
    || responsesStreamMode === "http-text"
    || responsesStreamMode === "http-binary"
  ) {
    const body =
      responsesStreamMode === "http-binary" ?
        Uint8Array.from([0x00, 0xff, 0x80, 0x41])
      : new TextEncoder().encode("  exact Responses text\r\n  ")
    const error = new HTTPError(
      "HTTPError marker must not leak",
      new Response(body.slice(), {
        headers: {
          "content-type":
            responsesStreamMode === "http-binary" ?
              "application/octet-stream"
            : "text/plain; charset=utf-8",
        },
        status: 429,
      }),
    )
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(prefix))
          if (responsesStreamMode === "throw") {
            responsesThrowController = controller
          } else {
            queueMicrotask(() => controller.error(error))
          }
        },
      }),
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    )
  }
  const terminal = `event: response.completed\ndata: ${JSON.stringify(responsesCompletedEvent)}\n\n`
  if (responsesStreamMode === "malformed-recover") {
    return responsesStream(
      `${prefix}event: response.output_text.delta\ndata: {malformed\n\n${terminal}`,
    )
  }
  if (responsesStreamMode === "malformed-terminal") {
    return responsesStream(
      `${prefix}event: response.completed\ndata: {malformed\n\n`,
    )
  }
  return responsesStream(
    responsesStreamMode === "duplicate" ?
      `${prefix}${terminal}${terminal}event: response.output_text.delta\ndata: ${JSON.stringify(
        {
          ...responsesTextDeltaEvent,
          sequence_number: 3,
          delta: "must-not-appear",
        },
      )}\n\n`
    : `${prefix}${terminal}`,
  )
}

function responsesStream(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const fetchMock = mock((url: string, init?: RequestInit) => {
  lastUpstreamPath = new URL(url).pathname
  lastUpstreamHeaders = new Headers(init?.headers)
  lastUpstreamPayload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined

  if (lastUpstreamPath.endsWith("/responses")) {
    if (
      delayBufferedWebSearchResponse
      && lastUpstreamPayload?.stream === false
    ) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            delayedResponsesController = controller
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    }
    if (lastUpstreamPayload?.stream === true) {
      return createResponsesSse()
    }

    return new Response(JSON.stringify(responsesResult), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  if (lastUpstreamPath.endsWith("/v1/messages")) {
    return Response.json({
      id: "msg_chat_bridge",
      type: "message",
      role: "assistant",
      model: "claude-messages-only",
      content: [{ type: "text", text: "hello from messages" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  return new Response(
    JSON.stringify({
      id: "chatcmpl-direct",
      object: "chat.completion",
      created: 1,
      model: "gpt-5.5",
      choices: [],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  lastUpstreamPath = undefined
  lastUpstreamPayload = undefined
  lastUpstreamHeaders = undefined
  delayBufferedWebSearchResponse = false
  nextResponsesStreamError = undefined
  responsesStreamMode = "complete"
  delayedResponsesController = undefined
  responsesThrowController = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = responsesOnlyModels
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

afterEach(() => {
  try {
    delayedResponsesController?.close()
  } catch {
    // The downstream may already have cancelled the request.
  }
  setSsePreflushDeadlineForTest()
})

test("routes legacy chat completions requests for responses-only models through /responses", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Say hello." },
        ],
        max_tokens: 32,
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.model).toBe("gpt-5.5")
  expect(lastUpstreamPayload?.instructions).toBe("Be concise.")
  expect(lastUpstreamPayload?.max_output_tokens).toBe(32)

  const body = (await response.json()) as {
    model: string
    choices: Array<{
      message: {
        content: string
        encrypted_content?: string
        reasoning_opaque?: string
        reasoning_text?: string
      }
    }>
    usage?: {
      completion_tokens: number
      completion_tokens_details?: { reasoning_tokens: number }
      prompt_tokens: number
      prompt_tokens_details?: { cached_tokens: number }
      total_tokens: number
    }
  }

  expect(body.model).toBe("gpt-5.5")
  expect(body.choices[0]?.message.content).toBe("hello from responses")
  expect(body.choices[0]?.message.reasoning_opaque).toBe("rs_1")
  expect(body.choices[0]?.message.reasoning_text).toBe("thinking")
  expect(body.choices[0]?.message.encrypted_content).toBe("encrypted-state")
  expect(body.usage).toEqual({
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
    prompt_tokens_details: { cached_tokens: 1 },
    completion_tokens_details: { reasoning_tokens: 2 },
  })
})

test("applies redirect verbosity only to the Responses candidate", async () => {
  setModelRedirectsForTest([
    {
      id: "chat-to-responses-verbosity",
      sourceModel: "gpt-5.5",
      sourceEffort: "all",
      targetModel: "gpt-5.5",
      targetVerbosity: "medium",
      enabled: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Say hello." }],
        response_format: { type: "json_object" },
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.text).toEqual({
    format: { type: "json_object" },
    verbosity: "medium",
  })
})

test("passes explicit native beta, version, and provider preference through Chat to Messages", async () => {
  state.models = messagesOnlyModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "anthropic-beta":
          "interleaved-thinking-2025-05-14, context-management-2025-06-27, interleaved-thinking-2025-05-14",
        "anthropic-version": "2023-06-01",
        "x-model-provider-preference": "anthropic",
      },
      body: JSON.stringify({
        model: "claude-messages-only",
        messages: [{ role: "user", content: "Say hello." }],
        max_tokens: 32,
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(lastUpstreamHeaders?.get("anthropic-beta")).toBe(
    "interleaved-thinking-2025-05-14,context-management-2025-06-27",
  )
  expect(lastUpstreamHeaders?.get("anthropic-version")).toBe("2023-06-01")
  expect(lastUpstreamHeaders?.get("x-model-provider-preference")).toBe(
    "anthropic",
  )
})

test("does not pass native Messages headers through Chat to Responses", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
        "anthropic-version": "2024-01-01",
        "x-model-provider-preference": "anthropic",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Say hello." }],
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamHeaders?.get("anthropic-beta")).toBeNull()
  expect(lastUpstreamHeaders?.get("anthropic-version")).toBeNull()
  expect(lastUpstreamHeaders?.get("x-model-provider-preference")).toBeNull()
})

test("records one endpoint fallback event for a translated Chat request", async () => {
  const infoSpy = spyOn(console, "info").mockImplementation(() => undefined)

  try {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Say hello." }],
          stream: false,
        }),
      }),
    )

    expect(response.status).toBe(200)
    const fallbackEvents = infoSpy.mock.calls.filter(
      ([message]) =>
        typeof message === "string"
        && message.includes("[NON-DEFAULT]")
        && message.includes("endpoint_fallback"),
    )
    expect(fallbackEvents).toHaveLength(1)
  } finally {
    infoSpy.mockRestore()
  }
})

test("degrades a lossy Chat to Responses fallback and dispatches", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [
          { role: "user", content: "Run the tool." },
          { role: "tool", content: "private" },
        ],
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
})

test("omits tool controls when a chat fallback request has no tools", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Reply without tools." }],
        tools: null,
        parallel_tool_calls: true,
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).not.toHaveProperty("tools")
  expect(lastUpstreamPayload).not.toHaveProperty("tool_choice")
  expect(lastUpstreamPayload).not.toHaveProperty("parallel_tool_calls")
})

test("preserves tool controls when a chat fallback request has tools", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Call the weather tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Read the weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  const tools = lastUpstreamPayload?.tools as
    | Array<Record<string, unknown>>
    | undefined
  expect(tools).toHaveLength(1)
  expect(tools?.[0]).toMatchObject({
    type: "function",
    name: "get_weather",
    description: "Read the weather",
    parameters: { type: "object", properties: {} },
    strict: false,
  })
  expect(lastUpstreamPayload?.tool_choice).toBe("auto")
  expect(lastUpstreamPayload?.parallel_tool_calls).toBe(false)
})

test("normalizes deprecated Chat controls before Responses fallback translation", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Call the legacy lookup." }],
        functions: [
          {
            name: "legacy_lookup",
            description: "Legacy lookup",
            parameters: {},
          },
        ],
        function_call: { name: "legacy_lookup" },
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.tools).toEqual([
    {
      type: "function",
      name: "legacy_lookup",
      description: "Legacy lookup",
      parameters: { type: "object", properties: {} },
      strict: false,
      copilot_cache_control: { type: "ephemeral" },
    },
  ])
  expect(lastUpstreamPayload?.tool_choice).toEqual({
    type: "function",
    name: "legacy_lookup",
  })
  expect(lastUpstreamPayload).not.toHaveProperty("functions")
  expect(lastUpstreamPayload).not.toHaveProperty("function_call")
})

test("omits unsupported sampling parameters for responses-only fallback models", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Return JSON." }],
        temperature: 0.3,
        top_p: 0.8,
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).not.toHaveProperty("temperature")
  expect(lastUpstreamPayload).not.toHaveProperty("top_p")
})

test("omits unsupported temperature for gpt-5.4-mini chat fallback", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        messages: [
          {
            role: "user",
            content:
              'Rewrite this memory recall query into up to 3 concise search queries. Return JSON only: {"queries":[...]}.',
          },
        ],
        temperature: 0,
        max_tokens: 512,
        response_format: { type: "json_object" },
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.model).toBe("gpt-5.4-mini")
  expect(lastUpstreamPayload?.max_output_tokens).toBe(512)
  expect(lastUpstreamPayload?.text).toEqual({
    format: { type: "json_object" },
  })
  expect(lastUpstreamPayload?.instructions).toContain("valid JSON only")
  expect(lastUpstreamPayload).not.toHaveProperty("temperature")
})

test("routes chat json_schema as json_object with schema instruction for responses fallback", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [
          { role: "system", content: "Return only JSON." },
          { role: "user", content: "Classify this." },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "RouteDecision",
            schema: {
              type: "object",
              properties: {
                intent: { type: "string" },
              },
              required: ["intent"],
            },
          },
        },
        stream: false,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.text).toEqual({
    format: { type: "json_object" },
  })
  expect(lastUpstreamPayload?.input).toEqual([
    {
      type: "message",
      role: "system",
      content: "Return only JSON.",
    },
    {
      type: "message",
      role: "user",
      content: "Classify this.",
    },
  ])
  expect(lastUpstreamPayload?.instructions).toContain("Return only JSON.")
  expect(lastUpstreamPayload?.instructions).toContain(
    "You MUST conform to this JSON schema",
  )
  expect(lastUpstreamPayload?.instructions).toContain('"intent"')
})

test("uses Responses output message text when output_text is empty", async () => {
  const originalResponsesResult = { ...responsesResult }
  Object.assign(responsesResult, emptyOutputTextResponsesResult)

  try {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Return JSON." }],
          stream: false,
        }),
      }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0]?.message.content).toBe('{"intent":"hybrid"}')
  } finally {
    Object.assign(responsesResult, originalResponsesResult)
  }
})

test("streams responses-only models back as chat completion chunks", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.stream).toBe(true)

  const text = await response.text()
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))

  expect(dataLines.at(-1)).toBe("[DONE]")
  const chunks = dataLines
    .filter((line) => line !== "[DONE]")
    .map(
      (line) =>
        JSON.parse(line) as {
          model: string
          choices: Array<{
            delta: { content?: string; role?: string }
            finish_reason: string | null
          }>
          usage?: unknown
        },
    )

  expect(chunks[0]?.model).toBe("gpt-5.5")
  expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant")
  expect(
    chunks.some(
      (chunk) => chunk.choices[0]?.delta.content === "hello streamed",
    ),
  ).toBe(true)
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop")
  expect(chunks.at(-1)?.usage).toEqual({
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
    prompt_tokens_details: { cached_tokens: 1 },
    completion_tokens_details: {
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
      reasoning_tokens: 2,
    },
  })
})

test.each(["error", "failed"] as const)(
  "preserves received Chat output for Responses %s events",
  async (kind) => {
    const marker = `chat-responses-${kind}-private-marker`
    nextResponsesStreamError = { kind, marker }

    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Fail safely." }],
          stream: true,
        }),
      }),
    )
    const body = await response.text()

    expect(body).toContain(marker)
    expect(chatErrorFrames(body)).toHaveLength(1)
    expect(doneCount(body)).toBe(1)
  },
)

test.each(["eof", "malformed"] as const)(
  "retains Responses partial output and fails once on %s",
  async (mode) => {
    responsesStreamMode = mode
    const response = await postStreamingResponsesChat()
    const body = await response.text()

    expect(body).toContain("hello streamed")
    expect(chatErrorFrames(body)).toHaveLength(1)
    expect(doneCount(body)).toBe(1)
    expect(body).not.toContain("private Responses transport marker")
    expect(chatFinishFrames(body)).toHaveLength(0)
  },
)

test("skips a malformed Responses delta before one valid Chat terminal", async () => {
  responsesStreamMode = "malformed-recover"
  const body = await (await postStreamingResponsesChat()).text()

  expect(body).toContain("hello streamed")
  expect(chatFinishFrames(body)).toHaveLength(1)
  expect(chatErrorFrames(body)).toEqual([])
  expect(doneCount(body)).toBe(1)
  expect(body).not.toContain("{malformed")
})

test("fails once for a malformed Responses terminal", async () => {
  responsesStreamMode = "malformed-terminal"
  const body = await (await postStreamingResponsesChat()).text()

  expect(chatFinishFrames(body)).toEqual([])
  expect(chatErrorFrames(body)).toHaveLength(1)
  expect(doneCount(body)).toBe(1)
  expect(body).not.toContain("{malformed")
})

test("retains Responses partial output before a transport throw", async () => {
  responsesStreamMode = "throw"
  const response = await postStreamingResponsesChat()
  const reader = requireResponseBody(response).getReader()
  const partial = await readUntil(reader, (body) =>
    body.includes("hello streamed"),
  )
  responsesThrowController?.error(
    new Error("private Responses transport marker"),
  )
  const body = partial + (await readRemaining(reader))

  expect(body).toContain("hello streamed")
  expect(chatErrorFrames(body)).toHaveLength(1)
  expect(doneCount(body)).toBe(1)
  expect(body).not.toContain("private Responses transport marker")
  expect(chatFinishFrames(body)).toHaveLength(0)
})

test.each(["received-error", "received-failed"] as const)(
  "preserves one received Responses terminal for %s without reporting it",
  async (mode) => {
    responsesStreamMode = mode
    const logSpy = spyOn(consola, "error")
    const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
      () => "event-id",
    )
    try {
      const body = await (await postStreamingResponsesChat()).text()
      expect(chatErrorFrames(body)).toHaveLength(1)
      expect(body).toContain(
        mode === "received-error" ?
          "received Responses error"
        : "received Responses failed",
      )
      expect(doneCount(body)).toBe(1)
      expect(logSpy).not.toHaveBeenCalled()
      expect(sentrySpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
      sentrySpy.mockRestore()
    }
  },
)

test("suppresses duplicate Responses terminals and post-terminal deltas", async () => {
  responsesStreamMode = "duplicate"
  const body = await (await postStreamingResponsesChat()).text()
  expect(chatFinishFrames(body)).toHaveLength(1)
  expect(doneCount(body)).toBe(1)
  expect(body).not.toContain("must-not-appear")
  expect(chatErrorFrames(body)).toEqual([])
})

test.each(["http-text", "http-binary"] as const)(
  "preserves and reports one winning Responses %s HTTPError",
  async (mode) => {
    responsesStreamMode = mode
    const logSpy = spyOn(consola, "error")
    const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
      () => "event-id",
    )
    try {
      const body = await (await postStreamingResponsesChat()).text()
      const error = chatErrorFrames(body)[0]?.error
      expect(error).toEqual({
        message:
          mode === "http-text" ?
            "  exact Responses text\r\n  "
          : [0, 255, 128, 65],
        type: "api_error",
        content_type:
          mode === "http-text" ?
            "text/plain; charset=utf-8"
          : "application/octet-stream",
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
    } finally {
      logSpy.mockRestore()
      sentrySpy.mockRestore()
    }
  },
)

async function postStreamingResponsesChat(): Promise<Response> {
  return await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      }),
    }),
  )
}

function chatDataFrames(body: string): Array<Record<string, unknown>> {
  return Array.from(
    body.matchAll(/^data: (\{.*\})$/gm),
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  )
}

function chatErrorFrames(
  body: string,
): Array<{ error: Record<string, unknown> }> {
  return chatDataFrames(body).filter(
    (frame): frame is { error: Record<string, unknown> } =>
      typeof frame.error === "object" && frame.error !== null,
  )
}

function chatFinishFrames(body: string): Array<Record<string, unknown>> {
  return chatDataFrames(body).filter((frame) => {
    const choices = frame.choices
    return (
      Array.isArray(choices)
      && choices.some(
        (choice) =>
          typeof choice === "object"
          && choice !== null
          && (choice as { finish_reason?: unknown }).finish_reason !== null
          && (choice as { finish_reason?: unknown }).finish_reason
            !== undefined,
      )
    )
  })
}

function doneCount(body: string): number {
  return Array.from(body.matchAll(/^data: \[DONE\]$/gm)).length
}

function requireResponseBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("Expected an SSE response body")
  return response.body
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

test("commits a keepalive while the buffered web-search fallback is pending", async () => {
  setSsePreflushDeadlineForTest(20)
  delayBufferedWebSearchResponse = true
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Search current news." }],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: {
                type: "object",
                properties: {
                  blocked_domains: {
                    type: "array",
                    items: { type: "string" },
                    default: ["example.com"],
                  },
                },
              },
            },
          },
        ],
        stream: true,
      }),
    }),
  )
  const body = response.body
  if (!body) throw new Error("Expected an SSE response body")
  const reader = body.getReader()
  const first = await reader.read()

  expect(lastUpstreamPayload?.stream).toBe(false)
  expect(first.done).toBe(false)
  const firstBytes: unknown = first.value
  if (!(firstBytes instanceof Uint8Array)) {
    throw new TypeError("Expected the initial keepalive bytes")
  }
  expect(new TextDecoder().decode(firstBytes)).toBe(": keepalive\n\n")
  await reader.cancel()
})
