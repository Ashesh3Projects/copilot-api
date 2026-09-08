import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"

import type { GoogleAIResponse } from "../src/routes/google-ai/google-ai-types"
import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { setReplacementsForTest } from "../src/lib/auto-replace"
import { setConfigForTest } from "../src/lib/config"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { state } from "../src/lib/state"
import { googleAIRoutes } from "../src/routes/google-ai/route"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const app = new Hono().route("/v1beta/models", googleAIRoutes)
let outbound: ChatCompletionsPayload
let upstreamBody: unknown
let upstreamStream: string | undefined
let upstreamResponse: Response | undefined
let providerSignal: AbortSignal | null | undefined

beforeEach(() => {
  state.models = { object: "list", data: [] }
  setModelRedirectsForTest([])
  setReplacementsForTest([])
  setConfigForTest({
    customProviders: [
      {
        id: "google-test",
        name: "Google test",
        type: "openai-compatible",
        baseUrl: "https://google-test.invalid/v1",
        apiKey: "synthetic-test-key",
        models: [{ id: "google-test-chat", kind: "chat" }],
      },
    ],
  })
  upstreamStream = undefined
  upstreamResponse = undefined
  providerSignal = undefined
  upstreamBody = {
    id: "completion",
    object: "chat.completion",
    created: 1,
    model: "google-test-chat",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
  }
  globalThis.fetch = ((_input, init) => {
    if (typeof init?.body !== "string")
      throw new Error("Missing provider request body")
    outbound = JSON.parse(init.body) as ChatCompletionsPayload
    providerSignal = init.signal
    if (upstreamResponse) return Promise.resolve(upstreamResponse)
    return Promise.resolve(
      upstreamStream === undefined ?
        Response.json(upstreamBody)
      : new Response(upstreamStream, {
          headers: { "content-type": "text/event-stream" },
        }),
    )
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setReplacementsForTest([])
})

async function request(
  body: unknown,
  action = "generateContent",
): Promise<Response> {
  return await seedProtocolDatabase().then(() =>
    app.request(`/v1beta/models/google-test-chat:${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

const contents = [{ role: "user", parts: [{ text: "Use this schema" }] }]

test("Google route preserves typeless unions, references, boolean schemas and required constraints", async () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { scalar: { type: "string" } },
    type: "object",
    properties: {
      nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
      referenced: { $ref: "#/$defs/scalar" },
      anything: true,
      forbidden: false,
      sequence: { type: "array", items: false },
    },
    required: ["nullable", "dynamic"],
  }
  const response = await request({
    contents,
    tools: [
      {
        functionDeclarations: [
          { name: "lookup", parametersJsonSchema: schema },
        ],
      },
    ],
  })
  expect(response.status).toBe(200)
  expect(outbound.tools?.[0].function.parameters).toEqual(schema)
})

test.each(["responseSchema", "responseJsonSchema"])(
  "Google route forwards %s with semantic constraints",
  async (key) => {
    const schema = {
      type: "object",
      properties: {
        answer: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
      required: ["answer"],
    }
    const response = await request({
      contents,
      generationConfig: { responseMimeType: "application/json", [key]: schema },
    })
    expect(response.status).toBe(200)
    expect(outbound.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema },
    })
    expect(outbound.response_format?.json_schema).toEqual({
      name: "google_response",
      schema,
      strict: false,
    })
  },
)

test("Google route keeps explicit same-name tool IDs through the returned next turn", async () => {
  upstreamBody = {
    id: "completion",
    object: "chat.completion",
    created: 1,
    model: "google-test-chat",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_A",
              type: "function",
              function: { name: "lookup", arguments: '{"key":"A"}' },
            },
            {
              id: "call_B",
              type: "function",
              function: { name: "lookup", arguments: '{"key":"B"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }
  const first = (await (await request({ contents })).json()) as GoogleAIResponse
  expect(first.candidates[0].content.parts).toEqual([
    { functionCall: { id: "call_A", name: "lookup", args: { key: "A" } } },
    { functionCall: { id: "call_B", name: "lookup", args: { key: "B" } } },
  ])
  const second = await request({
    contents: [
      ...contents,
      first.candidates[0].content,
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_B",
              name: "lookup",
              response: { value: "B-result" },
            },
          },
          {
            functionResponse: {
              name: "lookup",
              response: { value: "A-result" },
            },
          },
        ],
      },
    ],
  })
  expect(second.status).toBe(200)
  const calls = outbound.messages.filter(
    (message) => message.tool_calls?.length,
  )
  expect(calls).toHaveLength(1)
  expect(calls[0].tool_calls?.map((call) => call.id)).toEqual([
    "call_A",
    "call_B",
  ])
  expect(
    outbound.messages.filter((message) => message.role === "tool"),
  ).toEqual([
    { role: "tool", tool_call_id: "call_B", content: '{"value":"B-result"}' },
    { role: "tool", tool_call_id: "call_A", content: '{"value":"A-result"}' },
  ])
})

test("Google route honors explicit result IDs before same-name FIFO history", async () => {
  const response = await request({
    contents: [
      {
        role: "model",
        parts: [
          { functionCall: { id: "call_A", name: "lookup", args: {} } },
          { functionCall: { id: "call_B", name: "lookup", args: {} } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_B",
              name: "lookup",
              response: { value: "B" },
            },
          },
          {
            functionResponse: {
              id: "call_A",
              name: "lookup",
              response: { value: "A" },
            },
          },
        ],
      },
    ],
  })
  expect(response.status).toBe(200)
  expect(
    outbound.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id),
  ).toEqual(["call_B", "call_A"])
})

function chunk(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "stream", object: "chat.completion.chunk", created: 1, model: "google-test-chat", ...value })}\n\n`
}

test.each([true, false])(
  "Google custom stream retains trailing usage with DONE=%s",
  async (done) => {
    upstreamStream =
      chunk({
        choices: [
          { index: 0, delta: { content: "Hello" }, finish_reason: null },
        ],
      })
      + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
      + "data: {malformed-tail\n\n"
      + chunk({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })
      + (done ? "data: [DONE]\n\n" : "")
    const response = await request({ contents }, "streamGenerateContent")
    expect(response.status).toBe(200)
    const events = (await response.json()) as Array<GoogleAIResponse>
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        totalTokenCount: 12,
      },
    })
  },
)

test("Google custom stream preserves incremental function-call IDs", async () => {
  upstreamStream =
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_stream",
                type: "function",
                function: { name: "lookup", arguments: '{"key":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    + chunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"A"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
    + "data: [DONE]\n\n"
  const events = (await (
    await request({ contents }, "streamGenerateContent")
  ).json()) as Array<GoogleAIResponse>
  expect(events[0].candidates[0].content.parts).toEqual([
    { functionCall: { id: "call_stream", name: "lookup", args: { key: "A" } } },
  ])
})

test("Google custom stream stops on client abort while draining final usage", async () => {
  const abort = new AbortController()
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
  upstreamResponse = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        controller.enqueue(
          new TextEncoder().encode(
            chunk({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          ),
        )
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  const responsePromise = seedProtocolDatabase().then(() =>
    app.request("/v1beta/models/google-test-chat:streamGenerateContent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: abort.signal,
      body: JSON.stringify({ contents }),
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  abort.abort()
  bodyController?.error(new DOMException("Aborted", "AbortError"))
  const response = await responsePromise
  expect(providerSignal?.aborted).toBe(true)
  expect(await response.json()).toEqual([])
})

test("Google custom stream bounds a stalled tail after a valid finish", async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
  upstreamResponse = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        controller.enqueue(
          new TextEncoder().encode(
            chunk({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          ),
        )
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      request({ contents }, "streamGenerateContent"),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 5500)
      }),
    ])
    expect(response).toBeDefined()
    expect(providerSignal?.aborted).toBe(true)
    expect(await response?.json()).toMatchObject([
      { candidates: [{ finishReason: "STOP" }] },
    ])
  } finally {
    clearTimeout(timeout)
    bodyController?.close()
  }
}, 6500)
