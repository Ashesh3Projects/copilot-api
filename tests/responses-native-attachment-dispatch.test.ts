import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { responsesWebSocket } from "~/routes/responses/websocket"
import { server } from "~/server"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const pdf = Buffer.from("%PDF-1.4\nsynthetic fixture\n%%EOF").toString("base64")
const pdfDataUri = `data:application/pdf;base64,${pdf}`
let upstreamBody: Record<string, unknown>
let attachmentCalls = 0
let inferenceCalls = 0

beforeEach(() => {
  state.copilotToken = "synthetic-attachment-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: "attachment-model",
        name: "attachment-model",
        object: "model",
        version: "test",
        vendor: "openai",
        preview: false,
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt",
          limits: { max_output_tokens: 8192 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  attachmentCalls = 0
  inferenceCalls = 0
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  globalThis.fetch = ((url, init) => {
    const requestUrl = url instanceof Request ? url.url : url.toString()
    if (requestUrl.startsWith("https://example.test/")) {
      attachmentCalls += 1
      return Promise.resolve(
        new Response(Buffer.from(pdf, "base64"), {
          headers: { "content-type": "application/pdf" },
        }),
      )
    }
    inferenceCalls += 1
    if (typeof init?.body !== "string")
      throw new TypeError("Expected JSON body")
    upstreamBody = JSON.parse(init.body) as Record<string, unknown>
    if (requestUrl.endsWith("/v1/messages")) {
      return Promise.resolve(
        Response.json({
          id: "msg_attachment",
          type: "message",
          role: "assistant",
          model: "attachment-model",
          content: [{ type: "text", text: "Read attachment." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
      )
    }
    const result = {
      id: "resp_attachment",
      object: "response",
      model: "attachment-model",
      status: "completed",
      created_at: 1,
      output: [],
      output_text: "",
      error: null,
      incomplete_details: null,
    }
    if (upstreamBody.stream) {
      return Promise.resolve(
        new Response(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    }
    return Promise.resolve(Response.json(result))
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
})

function contentRequestBody(content: Array<Record<string, unknown>>) {
  return {
    model: "attachment-model",
    stream: false,
    input: [
      {
        role: "user",
        content,
      },
    ],
  }
}

function requestBody(file: Record<string, unknown>) {
  return contentRequestBody([
    { type: "input_text", text: "Read the attachment." },
    { type: "input_file", filename: "fixture.pdf", ...file },
  ])
}

function setEndpoints(endpoints: Array<string>): void {
  const model = state.models?.data[0]
  if (!model) throw new TypeError("Expected test model")
  model.supported_endpoints = endpoints
}

function socket() {
  const sent: Array<string> = []
  const data: ResponsesWebSocketData = {
    authenticationRequest: new Request("http://localhost/responses", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
    activeTurns: new Map(),
    closed: false,
    nextTurnSequence: 0,
    type: "responses",
    requestId: "req_attachment",
    affinity: { key: "session_attachment", source: "copilot_session" },
    nativeMessagesOptions: {},
    effectiveNativeMessagesOptions: {},
    responseSnapshots: new Map(),
  }
  return {
    data,
    sent,
    send: (value: string) => {
      sent.push(value)
    },
    close() {},
  }
}

async function dispatch(
  transport: "http" | "http-stream" | "ws",
  body: ReturnType<typeof requestBody>,
) {
  if (transport === "ws") {
    const ws = socket()
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({ type: "response.create", ...body }),
      ),
    )
    expect(
      ws.sent.map((frame) => JSON.parse(frame) as { type: string }).at(-1)
        ?.type,
    ).toBe("response.completed")
    return
  }
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, stream: transport === "http-stream" }),
    }),
  )
  expect(response.status).toBe(200)
  await response.text()
}

test.each(["http", "http-stream", "ws"] as const)(
  "native %s normalizes raw PDF data before dispatch",
  async (transport) => {
    await dispatch(transport, requestBody({ file_data: pdf }))
    expect(inferenceCalls).toBe(1)
    expect(upstreamBody.input).toMatchObject([
      {
        content: [
          { type: "input_text" },
          { type: "input_file", file_data: pdfDataUri },
        ],
      },
    ])
  },
)

test.each(["http", "ws"] as const)(
  "native %s shares URL resolution with translated candidates",
  async (transport) => {
    setEndpoints(["/responses", "/v1/messages", "/chat/completions"])
    await dispatch(
      transport,
      requestBody({ file_url: "https://example.test/fixture.pdf" }),
    )
    expect(inferenceCalls).toBe(1)
    expect(attachmentCalls).toBe(1)
    expect(upstreamBody.input).toMatchObject([
      {
        content: [
          { type: "input_text" },
          { type: "input_file", file_data: pdfDataUri },
        ],
      },
    ])
    expect(JSON.stringify(upstreamBody)).not.toContain("file_url")
  },
)

test("translated PDF dispatch resolves each URL once", async () => {
  setEndpoints(["/v1/messages", "/chat/completions"])
  await dispatch(
    "http",
    requestBody({ file_url: "https://example.test/fixture.pdf" }),
  )
  expect(inferenceCalls).toBe(1)
  expect(attachmentCalls).toBe(1)
  expect(JSON.stringify(upstreamBody)).toContain(pdf)
})

test("native WebSocket warmup never fetches attachments or dispatches inference", async () => {
  setEndpoints(["/responses", "/v1/messages", "/chat/completions"])
  const ws = socket()
  await seedProtocolDatabase().then(() =>
    responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        ...requestBody({ file_url: "https://example.test/fixture.pdf" }),
        generate: false,
      }),
    ),
  )
  expect(
    ws.sent.map((frame) => JSON.parse(frame) as { type: string }).at(-1)?.type,
  ).toBe("response.completed")
  expect(inferenceCalls).toBe(0)
  expect(attachmentCalls).toBe(0)
})

test.skipIf(typeof Bun.Image !== "function")(
  "native HTTP converts a real WebP before dispatch",
  async () => {
    const webp =
      "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA="
    await dispatch(
      "http",
      contentRequestBody([
        { type: "input_image", image_url: `data:image/webp;base64,${webp}` },
      ]),
    )
    const input = upstreamBody.input as Array<{
      content: Array<{ image_url: string }>
    }>
    expect(input[0].content[0].image_url).toStartWith("data:image/jpeg;base64,")
    expect(inferenceCalls).toBe(1)
  },
)

test("native HTTP preserves an already normalized PDF without attachment I/O", async () => {
  await dispatch("http", requestBody({ file_data: pdfDataUri }))
  expect(upstreamBody.input).toMatchObject([
    {
      content: [
        { type: "input_text" },
        { type: "input_file", file_data: pdfDataUri },
      ],
    },
  ])
  expect(attachmentCalls).toBe(0)
})
