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
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
let streamMode:
  | "malformed-recover"
  | "malformed-terminal"
  | "received-direct"
  | "received-buffered"
  | "text"
  | "binary"
  | "unsigned-reasoning"
  | "terminal-first" = "received-direct"

const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "responses-model",
      name: "Responses Model",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        limits: { max_output_tokens: 4096 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

const responseSnapshot = {
  id: "resp_messages_lifecycle",
  object: "response",
  created_at: 1,
  model: "responses-model",
  output: [],
  output_text: "partial",
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
}

function prefixFrames(): string {
  return (
    [
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        sequence_number: 0,
        response: responseSnapshot,
      })}`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "partial",
      })}`,
    ].join("\n\n") + "\n\n"
  )
}

function receivedFailureResponse(): Response {
  const failed = {
    ...responseSnapshot,
    status: "failed",
    error: { message: "responses-private-failure" },
  }
  return new Response(
    `${prefixFrames()}event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      sequence_number: 2,
      response: failed,
    })}\n\nevent: response.completed\ndata: {invalid-json\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function thrownFailureResponse(): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(prefixFrames()))
        const body =
          streamMode === "text" ?
            new TextEncoder().encode("  exact responses text\r\n  ")
          : Uint8Array.from([0, 255, 128, 65])
        const contentType =
          streamMode === "text" ?
            "text/plain; charset=utf-8"
          : "application/octet-stream"
        setTimeout(
          () =>
            controller.error(
              new HTTPError(
                "responses private message",
                new Response(body, {
                  status: 429,
                  statusText: "Private Status",
                  headers: { "content-type": contentType },
                }),
                { private_request: "secret" },
              ),
            ),
          0,
        )
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function unsignedReasoningResponse(): Response {
  const completed = {
    ...responseSnapshot,
    status: "completed",
    output: [
      {
        id: "rs_unsigned",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "visible reasoning" }],
        encrypted_content: null,
      },
    ],
  }
  return new Response(
    [
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        sequence_number: 0,
        response: responseSnapshot,
      })}`,
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        sequence_number: 1,
        output_index: 0,
        item: completed.output[0],
      })}`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        sequence_number: 2,
        response: completed,
      })}`,
    ].join("\n\n") + "\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

function terminalFirstResponse(): Response {
  const completed = {
    ...responseSnapshot,
    status: "completed",
    usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 },
  }
  return new Response(
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 0,
      response: completed,
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function malformedRecoveryResponse(terminal: boolean): Response {
  const completed = {
    ...responseSnapshot,
    status: "completed",
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  }
  return new Response(
    `${prefixFrames()}event: ${terminal ? "response.completed" : "response.output_text.delta"}\ndata: {malformed\n\n${
      terminal ? "" : (
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          sequence_number: 3,
          response: completed,
        })}\n\n`
      )
    }`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

const fetchMock = mock(() => {
  if (streamMode === "malformed-recover")
    return malformedRecoveryResponse(false)
  if (streamMode === "malformed-terminal")
    return malformedRecoveryResponse(true)
  if (streamMode === "unsigned-reasoning") return unsignedReasoningResponse()
  if (streamMode === "terminal-first") return terminalFirstResponse()
  if (streamMode === "received-direct" || streamMode === "received-buffered") {
    return receivedFailureResponse()
  }
  return thrownFailureResponse()
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
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = models
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

afterEach(() => {
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test.each([false, true])(
  "closes direct/buffered Responses text before one received failure (buffered=%s)",
  async (buffered) => {
    streamMode = buffered ? "received-buffered" : "received-direct"
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", createRequest(buffered)),
    )
    const body = await response.text()
    expect(eventTypes(body)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "error",
    ])
    expect(body).toContain('"message":"responses-private-failure"')
    expect(body).not.toContain("message_delta")
    expect(body).not.toContain("message_stop")
  },
)

test("mounts unsigned Responses reasoning as one balanced thinking block", async () => {
  streamMode = "unsigned-reasoning"
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", createRequest(false)),
  )
  const body = await response.text()

  expect(eventTypes(body)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ])
  expect(body).toContain('"thinking":"visible reasoning"')
  expect(body).not.toContain("signature_delta")
  expect(body).not.toContain("@rs_unsigned")
})

test("mounts a terminal-first Responses stream with one complete lifecycle", async () => {
  streamMode = "terminal-first"
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", createRequest(false)),
  )
  const body = await response.text()

  expect(eventTypes(body)).toEqual([
    "message_start",
    "message_delta",
    "message_stop",
  ])
  expect(body).toContain('"id":"resp_messages_lifecycle"')
})

test("skips a malformed Responses delta before one Messages terminal", async () => {
  streamMode = "malformed-recover"
  const body = await (
    await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", createRequest(false)),
    )
  ).text()

  expect(eventTypes(body).at(-2)).toBe("message_delta")
  expect(eventTypes(body).at(-1)).toBe("message_stop")
  expect(eventTypes(body).filter((type) => type === "error")).toHaveLength(0)
  expect(body).not.toContain("{malformed")
})

test("fails once for malformed Responses terminal JSON", async () => {
  streamMode = "malformed-terminal"
  const body = await (
    await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", createRequest(false)),
    )
  ).text()

  expect(eventTypes(body).filter((type) => type === "error")).toHaveLength(1)
  expect(eventTypes(body)).not.toContain("message_stop")
  expect(body).not.toContain("{malformed")
})

test.each([
  {
    mode: "text",
    expected: { message: "  exact responses text\r\n  " },
  },
  {
    mode: "binary",
    expected: {
      message: "The Copilot Messages request failed.",
      body_bytes: [0, 255, 128, 65],
    },
  },
] as const)(
  "reports one exact mounted Responses $mode failure",
  async (fixture) => {
    streamMode = fixture.mode
    const errorSpy = spyOn(consola, "error")
    const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
      () => "event-id",
    )
    try {
      const response = await seedProtocolDatabase().then(() =>
        server.request("/v1/messages", createRequest(false)),
      )
      const body = await response.text()
      const payload = JSON.parse(
        Array.from(body.matchAll(/^data: (\{.*\})$/gm)).at(-1)?.[1] ?? "{}",
      ) as { error?: Record<string, unknown> }
      expect(eventTypes(body).slice(-2)).toEqual([
        "content_block_stop",
        "error",
      ])
      expect(payload.error).toMatchObject({
        type: "api_error",
        status: 429,
        content_type:
          fixture.mode === "text" ?
            "text/plain; charset=utf-8"
          : "application/octet-stream",
        ...fixture.expected,
      })
      expect(countReports(errorSpy.mock.calls)).toBe(1)
      expect(
        sentrySpy.mock.calls.filter((call) => hasUpstreamBytes(call[1])),
      ).toHaveLength(1)
      expect(JSON.stringify([body, errorSpy.mock.calls])).not.toContain(
        "Private Status",
      )
      expect(JSON.stringify([body, errorSpy.mock.calls])).not.toContain(
        "private_request",
      )
    } finally {
      errorSpy.mockRestore()
      sentrySpy.mockRestore()
    }
  },
)

function createRequest(buffered: boolean): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "responses-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 64,
      stream: true,
      ...(buffered ?
        { tools: [{ type: "web_search_20250305", name: "web_search" }] }
      : {}),
    }),
  }
}

function eventTypes(body: string): Array<string> {
  return Array.from(body.matchAll(/^event: (.+)$/gm), (match) => match[1])
}

function countReports(calls: Array<Array<unknown>>): number {
  return calls.filter(
    (call) =>
      typeof call[0] === "object"
      && call[0] !== null
      && "upstreamResponseBodyBytes" in call[0],
  ).length
}

function hasUpstreamBytes(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const extra = (value as Record<string, unknown>).extra
  return (
    typeof extra === "object"
    && extra !== null
    && "upstreamResponseBodyBytes" in extra
  )
}
