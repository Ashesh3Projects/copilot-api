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

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { STREAM_BEHAVIOR_CONTRACT } from "~/lib/compatibility-contract-values"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { selectResponsesUpstreamEndpoint } from "~/routes/responses/handler"
import { readResponsesRequestJson } from "~/routes/responses/request-json"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

/* eslint-disable max-lines */

const originalFetch = globalThis.fetch
const originalModels = state.models
let lastUpstreamPath: string | undefined
let lastUpstreamPayload: Record<string, unknown> | undefined
let lastUpstreamHeaders: Headers | undefined
let attachmentFetchCount = 0
let delayedNativeResponsesController:
  | ReadableStreamDefaultController<Uint8Array>
  | undefined
let delayNativeResponsesStream = false

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
  lastUpstreamPath = new URL(rawUrl).pathname
  lastUpstreamHeaders = new Headers(init?.headers)
  if (new URL(rawUrl).hostname === "example.invalid") attachmentFetchCount += 1
  lastUpstreamPayload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined

  if (delayNativeResponsesStream && lastUpstreamPath === "/responses") {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          delayedNativeResponsesController = controller
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  }

  if (lastUpstreamPath === "/v1/messages") {
    return Response.json({
      id: "msg_route",
      type: "message",
      role: "assistant",
      model: "route-model",
      content: [{ type: "text", text: "routed" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        cache_read_input_tokens: 1,
      },
    })
  }

  if (lastUpstreamPath === "/chat/completions") {
    return Response.json({
      id: "chatcmpl_route",
      object: "chat.completion",
      created: 1,
      model: "route-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "routed" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }

  return Response.json({
    id: "resp_route",
    object: "response",
    created_at: 1,
    model: "route-model",
    output: [
      {
        id: "msg_route",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "routed", annotations: [] }],
      },
    ],
    output_text: "routed",
    status: "completed",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
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
  lastUpstreamPath = undefined
  lastUpstreamPayload = undefined
  lastUpstreamHeaders = undefined
  attachmentFetchCount = 0
  delayedNativeResponsesController = undefined
  delayNativeResponsesStream = false
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test.each([
  {
    name: "keeps a Responses-only model on native Responses",
    endpoints: ["/responses"],
    expected: "/responses",
  },
  {
    name: "keeps native Responses ahead of advertised Messages and Chat",
    endpoints: ["/responses", "/v1/messages", "/chat/completions"],
    expected: "/responses",
  },
  {
    name: "uses Chat when endpoint metadata is missing",
    endpoints: undefined,
    expected: "/chat/completions",
  },
  {
    name: "uses Chat for a Chat-only model",
    endpoints: ["/chat/completions"],
    expected: "/chat/completions",
  },
  {
    name: "uses Messages for a Messages-only model",
    endpoints: ["/v1/messages"],
    expected: "/v1/messages",
  },
])("$name", async ({ endpoints, expected }) => {
  installModel({
    supported_endpoints: endpoints ? [...endpoints] : undefined,
  })

  const response = await postResponses({ input: "hello" })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe(expected)
})

test("decodes zstd-compressed Codex HTTP continuations before routing", async () => {
  installModel({ supported_endpoints: ["/responses"] })

  const response = await postZstdResponses({ input: "continue" })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.input).toBe("continue")
})

test("rejects a plain JSON body mislabeled as zstd", async () => {
  installModel({ supported_endpoints: ["/responses"] })

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "route-model", input: "not compressed" }),
    }),
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      code: "invalid_json",
      message: "The request body must contain valid JSON.",
      param: "body",
      type: "invalid_request_error",
    },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("preserves client aborts while decoding zstd requests", async () => {
  const abortError = new DOMException("client disconnected", "AbortError")
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-encoding": "zstd",
      "content-type": "application/json",
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(abortError)
      },
    }),
  })

  let caught: unknown
  try {
    await readResponsesRequestJson(request)
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(abortError)
})

test("rejects unsupported Responses request content encodings", async () => {
  installModel({ supported_endpoints: ["/responses"] })

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "route-model", input: "hello" }),
    }),
  )

  expect(response.status).toBe(415)
  expect(await response.json()).toEqual({
    error: {
      code: "unsupported_value",
      message: "The request content encoding must be identity or zstd.",
      param: "content_encoding",
      type: "invalid_request_error",
    },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test(
  "rejects zstd request expansion beyond the inbound Responses limit",
  async () => {
    installModel({ supported_endpoints: ["/responses"] })
    const expandedBytes = 64 * 1024 * 1024 + 1
    const body = Bun.zstdCompressSync(Buffer.alloc(expandedBytes, 0x20))

    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-encoding": "zstd",
          "content-type": "application/json",
        },
        body,
      }),
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: {
        code: "request_too_large",
        message:
          "The decompressed request body exceeds the supported size limit.",
        param: "body",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  },
  { timeout: 15_000 },
)

test("passes explicit native beta, version, and provider preference through Responses to Messages", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses(
    { input: "hello" },
    {
      "anthropic-beta": "beta-one, beta-two, beta-one",
      "anthropic-version": "2023-06-01",
      "x-model-provider-preference": "anthropic",
    },
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(lastUpstreamHeaders?.get("anthropic-beta")).toBe("beta-one,beta-two")
  expect(lastUpstreamHeaders?.get("anthropic-version")).toBe("2023-06-01")
  expect(lastUpstreamHeaders?.get("x-model-provider-preference")).toBe(
    "anthropic",
  )
})

test("does not pass native Messages headers through Responses to native Responses", async () => {
  installModel({ supported_endpoints: ["/responses"] })

  const response = await postResponses(
    { input: "hello" },
    {
      "anthropic-beta": "beta-one",
      "anthropic-version": "2024-01-01",
      "x-model-provider-preference": "anthropic",
    },
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamHeaders?.get("anthropic-beta")).toBeNull()
  expect(lastUpstreamHeaders?.get("anthropic-version")).toBeNull()
  expect(lastUpstreamHeaders?.get("x-model-provider-preference")).toBeNull()
})

test.each([
  { endpoints: ["/responses"], target: "/responses" },
  { endpoints: ["/v1/messages"], target: "/v1/messages" },
  { endpoints: ["/chat/completions"], target: "/chat/completions" },
])(
  "routes one identical finalized Responses clone to $target",
  async ({ endpoints, target }) => {
    installModel({ supported_endpoints: [...endpoints] })

    const response = await postResponses({
      input: "Return JSON",
      max_output_tokens: 1,
      reasoning: { effort: "medium" },
      temperature: 0.4,
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      },
      tools: [],
      tool_choice: "auto",
    })

    expect(response.status).toBe(200)
    expect(lastUpstreamPath).toBe(target)
    if (target === "/responses") {
      expect(lastUpstreamPayload).not.toHaveProperty("tools")
      expect(lastUpstreamPayload).not.toHaveProperty("tool_choice")
      expect(lastUpstreamPayload?.max_output_tokens).toBe(16)
      expect(lastUpstreamPayload).not.toHaveProperty(
        "text.format.schema.additionalProperties",
      )
      expect(lastUpstreamPayload).not.toHaveProperty(
        "text.format.schema.required",
      )
    }
  },
)

test("emits one bounded Responses route event before dispatch", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  const debugSpy = spyOn(consola, "debug")

  try {
    const response = await postResponses({ input: "hello" })

    expect(response.status).toBe(200)
    const routeEvents = debugSpy.mock.calls.filter(
      (call) =>
        call[0] === "[copilot-contract]"
        && (call[1] as { kind?: string; source?: string }).kind
          === "endpoint_route"
        && (call[1] as { kind?: string; source?: string }).source
          === "responses",
    )
    expect(routeEvents).toHaveLength(1)
    expect(routeEvents[0]?.[1]).toEqual({
      kind: "endpoint_route",
      source: "responses",
      target: "/responses",
      translated: false,
      reason: "native",
    })
  } finally {
    debugSpy.mockRestore()
  }
})

test.each([
  { name: "null body", body: "null" },
  { name: "array body", body: "[]" },
  { name: "empty object", body: "{}" },
  { name: "numeric model", body: '{"model":7}' },
  { name: "blank model", body: '{"model":"   "}' },
])("rejects $name before Responses routing", async ({ body }) => {
  state.models = undefined

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body,
    }),
  )

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(JSON.stringify(await response.json())).not.toContain("private")
})

test.each([
  { name: "empty body", body: "" },
  {
    name: "malformed JSON",
    body: '{"model":"route-model","input":"json-private-marker"',
  },
])(
  "returns a fixed 400 for $name before Responses routing",
  async ({ body }) => {
    state.models = undefined
    const errorSpy = spyOn(consola, "error")

    try {
      const response = await seedProtocolDatabase().then(() =>
        server.request("/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
            "content-type": "application/json",
          },
          body,
        }),
      )
      const output = JSON.stringify([
        await response.clone().json(),
        errorSpy.mock.calls,
      ])

      expect(response.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(output).not.toContain("json-private-marker")
      expect(output).not.toContain("Unexpected end of JSON")
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_json",
          message: "The request body must contain valid JSON.",
          param: "body",
          type: "invalid_request_error",
        },
      })
    } finally {
      errorSpy.mockRestore()
    }
  },
)

test("prefers Messages over Chat for a PDF-capable fallback", async () => {
  installModel({ supported_endpoints: ["/v1/messages", "/chat/completions"] })

  const response = await postResponses({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Read this" },
          {
            type: "input_file",
            filename: "doc.pdf",
            file_data: "data:application/pdf;base64,AA==",
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(lastUpstreamPayload).toHaveProperty(
    "messages.0.content.1.source.data",
    "AA==",
  )
})

test("normalizes raw base64 attachments before Messages fallback", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "doc.pdf",
            file_data: "AA==",
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload).toHaveProperty(
    "messages.0.content.0.source.data",
    "AA==",
  )
})

test("applies the sanctioned apply_patch rewrite before Chat route selection", async () => {
  installModel({ supported_endpoints: ["/chat/completions"] })

  const response = await postResponses({
    input: "Edit the file.",
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ],
    tool_choice: "auto",
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
  expect(lastUpstreamPayload).toHaveProperty(
    "tools.0.function.name",
    "apply_patch",
  )
})

test.each(["web_search", "web_search_20250305", "web_search_preview"])(
  "applies the %s rewrite before Chat-only route selection",
  async (type) => {
    installModel({ supported_endpoints: ["/chat/completions"] })

    const response = await postResponses({
      input: "Search current information.",
      tools: [
        {
          type,
          external_web_access: true,
          filters: { allowed_domains: ["example.com"] },
        },
      ],
      tool_choice: "auto",
    })

    expect(response.status).toBe(200)
    expect(lastUpstreamPath).toBe("/chat/completions")
    expect(lastUpstreamPayload).toHaveProperty(
      "tools.0.function.name",
      "web_search",
    )
  },
)

test("keeps native Responses priority for hosted web search", async () => {
  installModel({
    supported_endpoints: ["/responses", "/chat/completions"],
  })

  const response = await postResponses({
    input: "Search current information.",
    tools: [{ type: "web_search", external_web_access: true }],
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).toHaveProperty("tools.0.type", "web_search")
})

test("preserves future native Responses data without fallback tool rewrites", async () => {
  installModel({
    supported_endpoints: ["/responses", "/v1/messages", "/chat/completions"],
  })

  const response = await postResponses({
    input: [{ type: "future_input", future: { nested: true } }],
    future_top_level: { retained: [1, 2] },
    background: { future: true },
    previous_response_id: "resp_previous",
    context_management: { future: "shape" },
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
      { type: "web_search", external_web_access: true },
      { type: "mcp", server_label: "native", future: { retained: true } },
    ],
    store: true,
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).toMatchObject({
    future_top_level: { retained: [1, 2] },
    background: { future: true },
    previous_response_id: "resp_previous",
    context_management: { future: "shape" },
    store: false,
    tools: [
      { type: "custom", name: "apply_patch" },
      { type: "web_search", external_web_access: true },
      { type: "mcp", server_label: "native", future: { retained: true } },
    ],
  })
  expect(lastUpstreamPayload).not.toHaveProperty("tools.0.parameters")
  expect(lastUpstreamPayload).not.toHaveProperty("tools.1.name", "web_search")
})

test("preserves future native Responses data on the streaming first wire", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  fetchMock.mockImplementationOnce((url, init) => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    lastUpstreamPath = new URL(rawUrl).pathname
    lastUpstreamPayload =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : undefined
    return createTerminalResponsesStream(
      "response.completed",
      "stream-future-marker",
    )
  })

  const response = await postResponses({
    input: "hello",
    stream: true,
    future_top_level: { retained: true },
    previous_response_id: "resp_stream_previous",
    tools: [{ type: "future_tool", config: { mode: "native" } }],
    store: true,
  })
  await response.text()

  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).toMatchObject({
    stream: true,
    future_top_level: { retained: true },
    previous_response_id: "resp_stream_previous",
    tools: [{ type: "future_tool", config: { mode: "native" } }],
    store: false,
  })
})

test("strips native HTTP warmup control before the Responses wire", async () => {
  installModel({ supported_endpoints: ["/responses"] })

  const response = await postResponses({
    input: "warmup",
    generate: false,
    future_top_level: { retained: true },
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).toMatchObject({
    input: "warmup",
    future_top_level: { retained: true },
    store: false,
  })
  expect(lastUpstreamPayload).not.toHaveProperty("generate")
})

test("omits future tools on the best-effort fallback boundary", async () => {
  installModel({ supported_endpoints: ["/chat/completions"] })

  const response = await postResponses({
    input: "hello",
    tools: [{ type: "mcp", server_label: "native" }],
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
  expect(lastUpstreamPayload?.tools).toBeUndefined()
})

test("normalizes Responses controls before Messages fallback conversion", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({
    input: "Return JSON.",
    max_output_tokens: 1,
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: { properties: { answer: { type: "string" } } },
      },
    },
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: null,
        strict: false,
      },
    ],
    tool_choice: "auto",
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload).toHaveProperty("max_tokens", 1)
  expect(lastUpstreamPayload).toHaveProperty("tools.0.input_schema", {
    type: "object",
    properties: {},
  })
  expect(lastUpstreamPayload).not.toHaveProperty(
    "output_config.format.schema.additionalProperties",
  )
})

test.each([
  {
    name: "temperature and effort",
    request: {
      temperature: 0.4,
      reasoning: { effort: "high", summary: "auto" },
    },
    wire: { temperature: 0.4, output_config: { effort: "high" } },
  },
  {
    name: "top_p and effort",
    request: {
      top_p: 0.8,
      reasoning: { effort: "high", summary: "auto" },
    },
    wire: { top_p: 0.8, output_config: { effort: "high" } },
  },
  {
    name: "integer reasoning",
    request: { reasoning: { effort: 2048, summary: "auto" } },
    wire: { thinking: { type: "enabled", budget_tokens: 2048 } },
  },
])(
  "preserves accepted $name on native Messages wire",
  async ({ request, wire }) => {
    installModel({ supported_endpoints: ["/v1/messages"] })

    const response = await postResponses({ input: "hello", ...request })

    expect(response.status).toBe(200)
    expect(lastUpstreamPayload).toMatchObject(wire)
  },
)

test("omits incompatible Messages sampling and dispatches", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({
    input: "hello",
    temperature: 0.4,
    top_p: 0.8,
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(lastUpstreamPayload).toHaveProperty("temperature", 0.4)
  expect(lastUpstreamPayload?.top_p).toBeUndefined()
})

test("dispatches unsupported Messages reasoning effort best effort", async () => {
  installModel({
    supported_endpoints: ["/v1/messages"],
    reasoning_effort: [],
  })

  const response = await postResponses({
    input: "hello",
    reasoning: { effort: "high", summary: "auto" },
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
})

test.each(["concise", "detailed", "future_private_summary"])(
  "dispatches Messages-only unmapped reasoning summary %s best effort",
  async (summary) => {
    installModel({ supported_endpoints: ["/v1/messages"] })

    const response = await postResponses({
      input: "hello",
      reasoning: { effort: "high", summary },
    })

    expect(response.status).toBe(200)
    expect(lastUpstreamPath).toBe("/v1/messages")
  },
)

test("returns a synthetic Responses stream for a Messages fallback", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({ input: "hello", stream: true })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(lastUpstreamPayload?.stream).toBe(false)
  const body = await response.text()
  expect(body).toContain("event: response.created")
  expect(body).toContain("event: response.output_text.delta")
  expect(body).toContain("event: response.completed")
})

test.each(["response.failed", "error"])(
  "preserves native %s events without losing partial output or future fields",
  async (terminalType) => {
    installModel({ supported_endpoints: ["/responses"] })
    const privateMarker = `native-${terminalType}-private-marker`
    fetchMock.mockImplementationOnce((url, init) => {
      const rawUrl =
        typeof url === "string" || url instanceof URL ? url : url.url
      lastUpstreamPath = new URL(rawUrl).pathname
      lastUpstreamPayload =
        typeof init?.body === "string" ?
          (JSON.parse(init.body) as Record<string, unknown>)
        : undefined
      return createPrivateTerminalResponsesStream(terminalType, privateMarker)
    })

    const response = await postResponses({ input: "hello", stream: true })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(lastUpstreamPath).toBe("/responses")
    expect(body).toContain("partial-output")
    expect(body).toContain(privateMarker)
    expect(body).not.toContain("[DONE]")
    const eventOrder = body
      .split("\n")
      .filter((line) => line.startsWith("event: "))
      .map((line) => line.slice(7))
    expect(eventOrder).toEqual([
      "response.created",
      "response.output_text.delta",
      terminalType,
    ])

    const dataFrames = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    const expectedTerminal: Record<string, unknown> =
      terminalType === "error" ?
        {
          type: "error",
          sequence_number: 2,
          code: "server_error",
          message: privateMarker,
          param: "input",
          status: 502,
        }
      : (JSON.parse(
          (
            await createPrivateTerminalResponsesStream(
              terminalType,
              privateMarker,
            ).text()
          )
            .split("\n")
            .findLast((line) => line.startsWith("data: "))
            ?.slice(6) ?? "{}",
        ) as Record<string, unknown>)
    expect(dataFrames.at(-1)).toEqual(expectedTerminal)
  },
)

test.each([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "error",
] as const)(
  "mounted native Responses preserves %s terminal framing and data",
  async (terminalType) => {
    installModel({ supported_endpoints: ["/responses"] })
    const privateMarker = `native-${terminalType}-matrix-private-marker`
    fetchMock.mockImplementationOnce(() =>
      createTerminalResponsesStream(terminalType, privateMarker),
    )

    const response = await postResponses({ input: "hello", stream: true })
    const body = await response.text()
    const eventOrder = Array.from(
      body.matchAll(/^event: (.+)$/gm),
      (match) => match[1],
    )
    const payloadTypes = Array.from(
      body.matchAll(/^data: (\{.*\})$/gm),
      (match) => (JSON.parse(match[1]) as { type?: unknown }).type,
    )

    expect(response.status).toBe(200)
    expect(eventOrder.at(-1)).toBe(terminalType)
    expect(payloadTypes.at(-1)).toBe(terminalType)
    expect(body).toContain(privateMarker)
  },
)

test("exported native Responses terminal contract matches mounted coverage", () => {
  expect(
    STREAM_BEHAVIOR_CONTRACT.find(
      (row) => row.surface === "Native Responses terminal families",
    )?.behavior,
  ).toBe(
    "preserve response.completed, response.incomplete, response.failed, and error terminal objects in their established protocol representation; exactly one terminal",
  )
})

test("uses the terminal SSE event name over a mismatched JSON type", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  const privateMarker = "mismatched-terminal-private-marker"
  fetchMock.mockImplementationOnce(() =>
    createPrivateTerminalResponsesStream(
      "response.failed",
      privateMarker,
      "response.output_text.delta",
    ),
  )

  const body = await (
    await postResponses({ input: "hello", stream: true })
  ).text()
  const terminal = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .at(-1)

  expect(terminal).toEqual({
    type: "response.failed",
    sequence_number: 2,
    response: {
      id: "resp_private_terminal",
      object: "response",
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    },
  })
  expect(body).not.toContain(privateMarker)
})

test("preserves terminal Responses partial and future fields", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  const privateMarker = "terminal-allowlist-private-marker"
  fetchMock.mockImplementationOnce(() =>
    createPrivateTerminalResponsesStream("response.incomplete", privateMarker),
  )

  const body = await (
    await postResponses({ input: "hello", stream: true })
  ).text()
  const terminal = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .at(-1) as { response?: Record<string, unknown> }

  expect(terminal.response).toMatchObject({
    id: "resp_private_terminal",
    object: "response",
    status: "incomplete",
    output_text: "partial-output",
    metadata: { private: privateMarker },
    incomplete_details: { reason: "max_output_tokens", private: privateMarker },
  })
  expect(body).toContain(privateMarker)
})

test.each([
  { data: "null", name: "null" },
  { data: '"http-terminal-private-string"', name: "string" },
  { data: "17", name: "number" },
  { data: '["http-terminal-private-array"]', name: "array" },
])("fails closed for HTTP terminal $name JSON", async ({ data }) => {
  installModel({ supported_endpoints: ["/responses"] })
  fetchMock.mockImplementationOnce(() => createRawTerminalResponsesStream(data))

  const body = await (
    await postResponses({ input: "hello", stream: true })
  ).text()
  const eventOrder = body
    .split("\n")
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice(7))
  const terminal = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as unknown)
    .at(-1)

  expect(eventOrder).toEqual([
    "response.created",
    "response.output_text.delta",
    "response.failed",
  ])
  expect(terminal).toEqual({
    type: "response.failed",
    sequence_number: 0,
    response: {
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    },
  })
  expect(body).toContain("partial-output")
  expect(body).not.toContain("http-terminal-private")
  expect(body).not.toContain("[DONE]")
})

test.each([
  { dataLine: "data:", eventType: "error" },
  { dataLine: undefined, eventType: "response.failed" },
  { dataLine: "data:", eventType: "response.incomplete" },
  { dataLine: undefined, eventType: "response.completed" },
])(
  "canonicalizes HTTP $eventType with empty or missing data",
  async ({ dataLine, eventType }) => {
    installModel({ supported_endpoints: ["/responses"] })
    fetchMock.mockImplementationOnce(() =>
      createEmptyTerminalResponsesStream(eventType, dataLine),
    )

    const body = await (
      await postResponses({ input: "hello", stream: true })
    ).text()
    const eventOrder = body
      .split("\n")
      .filter((line) => line.startsWith("event: "))
      .map((line) => line.slice(7))
    const terminal = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type?: string })
      .at(-1)

    expect(body).toContain("partial-output")
    expect(eventOrder.at(-1)).toBe(
      eventType === "response.completed" ? "response.failed" : eventType,
    )
    expect(terminal?.type).toBe(
      eventType === "response.completed" ? "response.failed" : eventType,
    )
    expect(body).toContain("Upstream Responses stream failed.")
    expect(body).not.toContain("[DONE]")
  },
)

test("preserves sparse HTTP response.completed without reconstructing it", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  fetchMock.mockImplementationOnce(() =>
    createRawTerminalResponsesStream(
      JSON.stringify({
        type: "response.completed",
        sequence_number: 2,
        response: {
          id: "resp_missing_status",
          object: "response",
          output: [],
          private: "http-missing-status-private-marker",
        },
      }),
    ),
  )

  const body = await (
    await postResponses({ input: "hello", stream: true })
  ).text()
  const terminal = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string })
    .at(-1)

  expect(terminal?.type).toBe("response.completed")
  expect(body).toContain("http-missing-status-private-marker")
  expect(body).not.toContain("[DONE]")
})

test("preserves native terminal events after the HTTP stream is committed", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  delayNativeResponsesStream = true
  const privateMarker = "native-preflush-private-marker"

  const responsePromise = postResponses({ input: "hello", stream: true })
  const responseOutcome = await Promise.race([
    responsePromise.then(() => "response" as const),
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 250),
    ),
  ])
  expect(responseOutcome).toBe("response")
  const response = await responsePromise
  const body = response.body
  if (!body) throw new Error("Expected an SSE response body")
  const reader = body.getReader()

  const encoder = new TextEncoder()
  delayedNativeResponsesController?.enqueue(
    encoder.encode(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_preflush",
        output_index: 0,
        content_index: 0,
        delta: "partial-output",
      })}\n\n`,
    ),
  )
  delayedNativeResponsesController?.enqueue(
    encoder.encode(
      `event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        sequence_number: 2,
        response: {
          id: "resp_preflush",
          object: "response",
          status: "failed",
          error: {
            code: "server_error",
            message: privateMarker,
            param: "input",
            status: 502,
          },
        },
      })}\n\n`,
    ),
  )
  delayedNativeResponsesController?.close()
  const rest = await readRemaining(reader)

  expect(rest).toContain("partial-output")
  expect(rest).toContain(privateMarker)
  expect(rest).not.toContain("[DONE]")
  const terminalData = rest
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { response?: unknown })
    .at(-1)
  expect(terminalData?.response).toMatchObject({
    id: "resp_preflush",
    status: "failed",
  })
})

test("fails closed for primitive terminal JSON after HTTP preflush", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  delayNativeResponsesStream = true

  const responsePromise = postResponses({ input: "hello", stream: true })
  const response = await responsePromise
  const body = response.body
  if (!body) throw new Error("Expected an SSE response body")
  const reader = body.getReader()
  const encoder = new TextEncoder()
  delayedNativeResponsesController?.enqueue(
    encoder.encode(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_preflush",
        output_index: 0,
        content_index: 0,
        delta: "partial-output",
      })}\n\n`,
    ),
  )
  delayedNativeResponsesController?.enqueue(
    encoder.encode(
      'event: response.completed\ndata: ["preflush-private-marker"]\n\n',
    ),
  )
  delayedNativeResponsesController?.close()
  const rest = await readRemaining(reader)

  expect(rest).toContain("partial-output")
  expect(rest).toContain("Upstream Responses stream failed.")
  expect(rest).not.toContain("preflush-private-marker")
  expect(rest).not.toContain("[DONE]")
})

test("canonicalizes an empty terminal after HTTP preflush", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  delayNativeResponsesStream = true

  const response = await postResponses({ input: "hello", stream: true })
  const body = response.body
  if (!body) throw new Error("Expected an SSE response body")
  const reader = body.getReader()
  const encoder = new TextEncoder()
  delayedNativeResponsesController?.enqueue(
    encoder.encode(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_preflush",
        output_index: 0,
        content_index: 0,
        delta: "partial-output",
      })}\n\n`,
    ),
  )
  delayedNativeResponsesController?.enqueue(
    encoder.encode("event: response.failed\ndata:\n\n"),
  )
  delayedNativeResponsesController?.close()
  const rest = await readRemaining(reader)

  expect(rest).toContain("partial-output")
  expect(rest).toContain("event: response.failed")
  expect(rest).toContain("Upstream Responses stream failed.")
  expect(rest).not.toContain("[DONE]")
})

test("keeps route retries private while preserving ECONNRESET recovery", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  const privateMarker = "route-transport-private-marker"
  fetchMock.mockImplementationOnce(() => {
    throw Object.assign(new Error(`socket reset ${privateMarker}`), {
      code: "ECONNRESET",
      path: `https://api.githubcopilot.com/responses?private=${privateMarker}`,
    })
  })
  fetchMock.mockImplementationOnce((url, init) => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    lastUpstreamPath = new URL(rawUrl).pathname
    lastUpstreamPayload =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : undefined
    return Response.json({
      id: "resp_retry",
      object: "response",
      created_at: 1,
      model: "route-model",
      output: [],
      output_text: "",
      status: "completed",
      usage: null,
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
  })
  const warnSpy = spyOn(consola, "warn")
  const breadcrumbSpy = spyOn(Sentry, "addBreadcrumb").mockImplementation(
    () => undefined,
  )
  const sentryLogSpy = spyOn(Sentry.logger, "info")

  try {
    const response = await postResponses({ input: "hello" })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(lastUpstreamPath).toBe("/responses")
    const diagnostics = JSON.stringify({
      breadcrumbs: breadcrumbSpy.mock.calls,
      logger: sentryLogSpy.mock.calls,
      warn: warnSpy.mock.calls,
    })
    expect(diagnostics).not.toContain(privateMarker)
    expect(diagnostics).not.toContain("api.githubcopilot.com")
    expect(diagnostics).toContain("ECONNRESET")
  } finally {
    sentryLogSpy.mockRestore()
    breadcrumbSpy.mockRestore()
    warnSpy.mockRestore()
  }
})

test("fails locally when the model advertises no supported inference endpoint", async () => {
  installModel({ supported_endpoints: [] })

  const response = await postResponses({ input: "hello" })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "request_shape",
    },
  })
})

test("contextualizes Messages-only opaque reasoning and dispatches", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({
    input: [
      {
        type: "reasoning",
        encrypted_content: "private-state",
        summary: [],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(JSON.stringify(lastUpstreamPayload)).toContain(
    "Assistant reasoning context",
  )
})

test.each([
  { name: "missing role", item: { type: "message", content: "hello" } },
  {
    name: "unknown role",
    item: { type: "message", role: "future_private_role", content: "hello" },
  },
  {
    name: "numeric role",
    item: { type: "message", role: 7, content: "hello" },
  },
])("maps Messages-only explicit message with $name", async ({ item }) => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({ input: [item] })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(JSON.stringify(lastUpstreamPayload)).toContain("Future role content")
})

test.each([
  {
    name: "orphan tool result",
    input: [{ type: "function_call_output", call_id: "call_1", output: "x" }],
    param: "tool_result_pairing",
  },
  {
    name: "non-object function arguments",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "[]",
      },
    ],
    param: "function_arguments",
  },
  {
    name: "unsupported image source",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:text/plain;base64,AA==",
            detail: "auto",
          },
        ],
      },
    ],
    param: "input_image",
  },
])("degrades Messages-only $name and dispatches", async ({ input }) => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  const response = await postResponses({ input })
  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
})

test.each([
  {
    name: "partial tool results at EOF",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "first" },
    ],
  },
  {
    name: "tool calls without results at EOF",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
    ],
  },
  {
    name: "partial tool results interrupted by a message",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "first" },
      { type: "message", role: "user", content: "continue" },
    ],
  },
])("degrades Messages-only $name", async ({ input }) => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({ input })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
})

test("fetches a Messages image URL once and degrades its failed normalization", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  fetchMock.mockImplementationOnce((url) => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    if (new URL(rawUrl).hostname === "example.invalid") {
      attachmentFetchCount += 1
    }
    return Response.json({}, { status: 404 })
  })

  const response = await postResponses({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.invalid/private.png",
            detail: "auto",
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(1)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(JSON.stringify(lastUpstreamPayload)).toContain(
    "Image attachment unavailable",
  )
})

test.each([
  {
    name: "image",
    content: {
      type: "input_image",
      image_url: "https://example.invalid/image.png",
      detail: "auto",
    },
    contentType: "image/png",
    expectedType: "image",
  },
  {
    name: "document",
    content: {
      type: "input_file",
      filename: "report.pdf",
      file_url: "https://example.invalid/report.pdf",
    },
    contentType: "application/pdf",
    expectedType: "document",
  },
])(
  "fetches a translated Responses URL $name once",
  async ({ content, contentType, expectedType }) => {
    installModel({ supported_endpoints: ["/v1/messages"] })
    fetchMock.mockImplementationOnce((url) => {
      const rawUrl =
        typeof url === "string" || url instanceof URL ? url : url.url
      if (new URL(rawUrl).hostname === "example.invalid") {
        attachmentFetchCount += 1
      }
      return new Response("attachment-bytes", {
        status: 200,
        headers: { "content-type": contentType },
      })
    })

    const response = await postResponses({
      input: [
        {
          type: "message",
          role: "user",
          content: [content],
        },
      ],
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(attachmentFetchCount).toBe(1)
    expect(lastUpstreamPath).toBe("/v1/messages")
    expect(JSON.stringify(lastUpstreamPayload)).toContain(
      `"type":"${expectedType}"`,
    )
  },
)

test("shares one translated attachment fetch before the selected native transform", async () => {
  installModel({
    supported_endpoints: ["/responses", "/chat/completions", "/v1/messages"],
  })
  fetchMock.mockImplementationOnce((url) => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    if (new URL(rawUrl).hostname === "example.invalid") {
      attachmentFetchCount += 1
    }
    return new Response("attachment-bytes", {
      status: 200,
      headers: { "content-type": "image/png" },
    })
  })

  const response = await postResponses({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.invalid/shared.png",
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(attachmentFetchCount).toBe(1)
})

test("routes Responses compaction through the existing Chat preservation path", async () => {
  installModel({ supported_endpoints: ["/v1/messages", "/chat/completions"] })

  const response = await postResponses({
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_compact",
        name: "exec",
        input: "run compact diagnostic",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_compact",
        output: "done",
      },
    ],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }),
    },
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
  expect(JSON.stringify(lastUpstreamPayload)).toContain("call_compact")
})

test("approves an adapted Responses translation before dispatch", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  state.manualApprove = true
  const promptSpy = spyOn(consola, "prompt").mockResolvedValue(true as never)

  try {
    const response = await postResponses({
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-state",
          summary: [],
        },
      ],
    })

    expect(response.status).toBe(200)
    expect(promptSpy).toHaveBeenCalledTimes(1)
    expect(lastUpstreamPath).toBe("/v1/messages")
  } finally {
    promptSpy.mockRestore()
    state.manualApprove = false
  }
})

test("does not fetch attachments for unadvertised fallbacks before native approval", async () => {
  installModel({ supported_endpoints: ["/responses"] })
  state.manualApprove = true
  const promptSpy = spyOn(consola, "prompt").mockResolvedValue(false as never)

  try {
    const response = await postResponses({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "inspect only after approval" },
            {
              type: "input_image",
              image_url: "https://example.invalid/native-only.png",
            },
          ],
        },
      ],
    })

    expect(response.status).toBe(403)
    expect(promptSpy).toHaveBeenCalledTimes(1)
    expect(attachmentFetchCount).toBe(0)
  } finally {
    promptSpy.mockRestore()
    state.manualApprove = false
  }
})

test("selects Responses then Messages then Chat without mutating inputs", () => {
  const payload = { model: "route-model", input: "hello" }
  const model = createModel({
    supported_endpoints: ["/responses", "/v1/messages", "/chat/completions"],
  })
  const payloadSnapshot = structuredClone(payload)
  const modelSnapshot = structuredClone(model)

  expect(
    selectResponsesUpstreamEndpoint({ payload, selectedModel: model }),
  ).toEqual({
    reason: "native",
    source: "responses",
    target: "/responses",
    translated: false,
  })
  expect(payload).toEqual(payloadSnapshot)
  expect(model).toEqual(modelSnapshot)
})

function postResponses(
  extra: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(
    seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ model: "route-model", ...extra }),
      }),
    ),
  )
}

function postZstdResponses(
  extra: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Response> {
  const body = Bun.zstdCompressSync(
    JSON.stringify({ model: "route-model", ...extra }),
  )
  return Promise.resolve(
    seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-encoding": "zstd",
          "content-type": "application/json",
          ...headers,
        },
        body,
      }),
    ),
  )
}

function installModel(options: {
  reasoning_effort?: Array<string>
  supported_endpoints?: Array<string>
}): void {
  state.models = {
    object: "list",
    data: [createModel(options)],
  } satisfies ModelsResponse
}

function createModel(options: {
  reasoning_effort?: Array<string>
  supported_endpoints?: Array<string>
}): Model {
  return {
    id: "route-model",
    name: "Route Model",
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 1024 },
      object: "model_capabilities",
      supports: {
        reasoning_effort: options.reasoning_effort ?? [
          "low",
          "medium",
          "high",
          "max",
        ],
      },
      tokenizer: "cl100k_base",
      type: "chat",
    },
    ...(options.supported_endpoints ?
      { supported_endpoints: [...options.supported_endpoints] }
    : {}),
  }
}

function createPrivateTerminalResponsesStream(
  terminalType: string,
  privateMarker: string,
  jsonType = terminalType,
): Response {
  const created = {
    type: "response.created",
    sequence_number: 0,
    response: {
      id: "resp_private_terminal",
      object: "response",
      created_at: 1,
      model: "route-model",
      output: [],
      output_text: "",
      status: "in_progress",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    },
  }
  const delta = {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_private_terminal",
    output_index: 0,
    content_index: 0,
    delta: "partial-output",
  }
  const terminal =
    terminalType === "error" ?
      {
        type: jsonType,
        sequence_number: 2,
        code: "server_error",
        message: privateMarker,
        param: "input",
        status: 502,
      }
    : {
        type: jsonType,
        sequence_number: 2,
        response: {
          ...created.response,
          status:
            terminalType === "response.incomplete" ? "incomplete" : "failed",
          output: [
            {
              id: "msg_private_terminal",
              type: "message",
              role: "assistant",
              status: "incomplete",
              content: [
                {
                  type: "output_text",
                  text: "partial-output",
                  annotations: [],
                },
              ],
            },
          ],
          output_text: "partial-output",
          message: privateMarker,
          metadata: { private: privateMarker },
          prompt_cache_key: privateMarker,
          safety_identifier: privateMarker,
          incomplete_details:
            terminalType === "response.incomplete" ?
              { reason: "max_output_tokens", private: privateMarker }
            : { private: privateMarker },
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
            private: privateMarker,
          },
          error: {
            code: "server_error",
            message: privateMarker,
            param: "input",
            status: 502,
            private: privateMarker,
          },
        },
        private: privateMarker,
      }

  return new Response(
    [
      `event: response.created\ndata: ${JSON.stringify(created)}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\n`,
      `event: ${terminalType}\ndata: ${JSON.stringify(terminal)}\n\n`,
    ].join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function createTerminalResponsesStream(
  terminalType:
    | "error"
    | "response.completed"
    | "response.failed"
    | "response.incomplete",
  privateMarker: string,
): Response {
  if (terminalType !== "response.completed") {
    return createPrivateTerminalResponsesStream(terminalType, privateMarker)
  }

  const completed = {
    type: "response.completed",
    sequence_number: 2,
    response: {
      id: "resp_completed_matrix",
      object: "response",
      status: "completed",
      output: [],
      output_text: "",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      error: null,
      incomplete_details: null,
      metadata: { private: privateMarker },
    },
    private: privateMarker,
  }
  return new Response(
    `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function createRawTerminalResponsesStream(data: string): Response {
  const created = JSON.stringify({
    type: "response.created",
    sequence_number: 0,
    response: {
      id: "resp_raw_terminal",
      object: "response",
      status: "in_progress",
      output: [],
      output_text: "",
      usage: null,
      error: null,
      incomplete_details: null,
    },
  })
  const delta = JSON.stringify({
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_raw_terminal",
    output_index: 0,
    content_index: 0,
    delta: "partial-output",
  })
  return new Response(
    `event: response.created\ndata: ${created}\n\n`
      + `event: response.output_text.delta\ndata: ${delta}\n\n`
      + `event: response.completed\ndata: ${data}\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function createEmptyTerminalResponsesStream(
  eventType: string,
  dataLine: string | undefined,
): Response {
  const delta = JSON.stringify({
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_empty_terminal",
    output_index: 0,
    content_index: 0,
    delta: "partial-output",
  })
  const terminal = [
    `event: ${eventType}`,
    ...(dataLine === undefined ? [] : [dataLine]),
    "",
    "",
  ].join("\n")
  return new Response(
    `event: response.output_text.delta\ndata: ${delta}\n\n${terminal}`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
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
