import { afterEach, beforeEach, expect, test } from "bun:test"

import { setConfigForTest } from "~/lib/config"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { setSsePreflushDeadlineForTest } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const previous = { ...state }
const previousFetch = globalThis.fetch
let slowTarget = false
const requests: Array<Record<string, unknown>> = []

beforeEach(() => {
  slowTarget = false
  requests.length = 0
  setConfigForTest({})
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      nativeClientNotice: true,
      rules: [
        {
          id: "notice",
          sourceModel: "notice-source",
          targetModel: "notice-target",
          enabled: true,
        },
      ],
    }),
  )
  Object.assign(state, {
    apiKeyAuth: undefined,
    isMultiToken: false,
    copilotToken: "test-token",
    githubToken: "test-token",
    models: {
      object: "list",
      data: ["notice-source", "notice-target"].map((id) => ({
        id,
        name: id,
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 1000 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      })),
    },
  })
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON body")
    const body = JSON.parse(init.body) as Record<string, unknown>
    requests.push(body)
    if (body.model === "notice-source")
      return Promise.resolve(new Response("rejected", { status: 422 }))
    const message = {
      type: "message",
      role: "assistant",
      id: "msg_target",
      model: "notice-target",
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    if (!body.stream)
      return slowTarget ?
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(Response.json(message)), 25),
          )
        : Promise.resolve(Response.json(message))
    const events = [
      { type: "message_start", message: { ...message, content: [] } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "answer" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]
    const response = new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
    return slowTarget ?
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(response), 25),
        )
      : Promise.resolve(response)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = previousFetch
  Object.assign(state, previous)
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
  setSsePreflushDeadlineForTest()
})

test.each([false, true])(
  "public Messages response emits opted-in native notice, stream=%s",
  async (stream) => {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model: "notice-source",
          max_tokens: 128,
          stream,
          messages: [{ role: "user", content: "hello" }],
          fallbacks: "default",
        }),
      }),
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"type":"fallback"')
    expect(text).toContain('"from":{"model":"notice-source"}')
    expect(text).toContain('"to":{"model":"notice-target"}')
    expect(text).toContain('"model":"notice-source"')
  },
)

test("slow fallback preserves SSE preflush and adds native notice after acceptance", async () => {
  slowTarget = true
  setSsePreflushDeadlineForTest(1)
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: "notice-source",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
        fallbacks: "default",
      }),
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('"type":"fallback"')
})

test("Claude fallback block round-trips through the next native Messages request", async () => {
  const headers = {
    authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
    "content-type": "application/json",
    "anthropic-beta": "server-side-fallback-2026-07-01",
    "x-claude-code-session-id": "native-roundtrip",
  }
  const payload = {
    model: "notice-source",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    fallbacks: "default",
  }
  const first = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }),
  )
  const body = (await first.json()) as {
    content: Array<Record<string, unknown>>
  }
  const second = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...payload,
        messages: [
          ...payload.messages,
          { role: "assistant", content: body.content },
          { role: "user", content: "continue" },
        ],
      }),
    }),
  )
  expect(second.status).toBe(200)
  expect(requests.map((request) => request.model)).toEqual([
    "notice-source",
    "notice-target",
    "notice-target",
  ])
  expect(requests[2].messages).toMatchObject([
    { role: "user" },
    {
      role: "assistant",
      content: [
        {
          type: "fallback",
          from: { model: "notice-source" },
          to: { model: "notice-target" },
        },
        { type: "text", text: "answer" },
      ],
    },
    { role: "user" },
  ])
})

test("slow Messages-backed Responses stream carries lazy Codex native metadata", async () => {
  slowTarget = true
  setSsePreflushDeadlineForTest(1)
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "notice-source",
        input: "hello",
        max_output_tokens: 128,
        stream: true,
      }),
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('"openai-model":"notice-target"')
})
