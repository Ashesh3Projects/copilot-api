import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { clearModelFallbackCache } from "~/lib/model-fallback"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { setSsePreflushDeadlineForTest } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const calls: Array<{ path: string; body: Record<string, unknown> }> = []
const statuses = new Map<string, number>()
const delays = new Map<string, number>()
const errors = new Map<string, Error>()
const streams = new Map<string, Array<Record<string, unknown>>>()
const modelIds = [
  "chain-a",
  "chain-b",
  "chain-c",
  "chain-d",
  "chain-e",
  "chain-f",
]

function model(id: string, endpoint = "/responses"): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: endpoint === "/v1/messages" ? "anthropic" : "openai",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: [endpoint],
    capabilities: {
      family: endpoint === "/v1/messages" ? "claude" : "gpt",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function configure(edges: Array<[string, string]>): void {
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: edges.map(([sourceModel, targetModel], index) => ({
        id: `chain-${index}`,
        sourceModel,
        targetModel,
        enabled: true,
      })),
    }),
  )
}

function success(body: Record<string, unknown>, path: string): Response {
  if (path === "/v1/messages") {
    const message = {
      id: `msg_chain_${calls.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "chain answer" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    }
    if (!body.stream) return Response.json(message)
    const events = [
      { type: "message_start", message: { ...message, content: [] } },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]
    return sse(events)
  }
  const response = {
    id: `resp_chain_${calls.length}`,
    object: "response",
    created_at: 1,
    model: body.model,
    status: "completed",
    output: [
      reasoning(`${String(body.model)}-signature`),
      {
        type: "message",
        id: `msg_chain_${calls.length}`,
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "chain answer", annotations: [] },
        ],
      },
    ],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    error: null,
  }
  if (!body.stream) return Response.json(response)
  return sse([
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    { type: "response.completed", response },
  ])
}

function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function reasoning(signature: string) {
  return {
    type: "reasoning",
    id: `rs_${signature}`,
    encrypted_content: signature,
    summary: [],
  }
}

function post(
  extra: Record<string, unknown> = {},
  threadId?: string,
  path = "/v1/responses",
) {
  return seedProtocolDatabase().then(() =>
    server.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        ...(threadId ? { "thread-id": threadId } : {}),
      },
      body: JSON.stringify({ model: "chain-a", input: "hello", ...extra }),
    }),
  )
}

beforeEach(() => {
  calls.length = 0
  statuses.clear()
  delays.clear()
  errors.clear()
  streams.clear()
  statuses.set("chain-a", 422)
  statuses.set("chain-b", 422)
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "chain-test-token",
    githubToken: "chain-test-github-token",
    isMultiToken: false,
    manualApprove: false,
    apiKeyAuth: undefined,
    models: { object: "list", data: modelIds.map((id) => model(id)) },
  })
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  clearModelFallbackCache()
  configure([
    ["chain-a", "chain-b"],
    ["chain-b", "chain-c"],
    ["chain-c", "chain-d"],
    ["chain-d", "chain-e"],
    ["chain-e", "chain-f"],
  ])
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected serialized inference body")
    const path = new URL(input instanceof Request ? input.url : String(input))
      .pathname
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path, body })
    const id = String(body.model)
    const delay = delays.get(id)
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    const error = errors.get(id)
    if (error) throw error
    const stream = streams.get(id)
    if (stream) return sse(stream)
    const status = statuses.get(id) ?? 200
    if (status !== 200)
      return Response.json(
        { error: { code: "chain_rejected", message: `${id} rejected` } },
        { status, headers: { "retry-after": "0" } },
      )
    return success(body, path)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
  setSsePreflushDeadlineForTest()
  clearModelFallbackCache()
})

test("Responses follows consecutive 422 rules and remembers the final model under the original source", async () => {
  const first = await post({}, "final-model")
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({
    model: "chain-a",
    status: "completed",
  })
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-c",
  ])

  expect((await post({}, "final-model")).status).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-c",
    "chain-c",
  ])
})

test("Responses allows the third fallback hop to succeed", async () => {
  statuses.set("chain-c", 422)
  const response = await post()
  expect(response.status).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-c",
    "chain-d",
  ])
})

test("Responses stops after three fallback hops and never tries a fifth model", async () => {
  statuses.set("chain-c", 422)
  statuses.set("chain-d", 422)
  const response = await post()
  expect(response.status).toBe(422)
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-c",
    "chain-d",
  ])
})

test("Responses stops a cycle before attempting the original model twice", async () => {
  configure([
    ["chain-a", "chain-b"],
    ["chain-b", "chain-a"],
  ])
  for (let index = 0; index < 2; index++) {
    const response = await post({}, "cycle")
    expect(response.status).toBe(422)
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-a",
    "chain-b",
  ])
})

test("Responses stops an intermediate cycle before attempting B twice", async () => {
  configure([
    ["chain-a", "chain-b"],
    ["chain-b", "chain-c"],
    ["chain-c", "chain-b"],
  ])
  statuses.set("chain-c", 422)
  expect((await post()).status).toBe(422)
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-c",
  ])
})

test.each([200, 422])(
  "a cached target gets at most three additional fallback hops when the fourth attempt returns %i",
  async (status) => {
    statuses.delete("chain-b")
    expect((await post({}, "cached-hop-bound")).status).toBe(200)
    calls.length = 0
    statuses.set("chain-b", 422)
    statuses.set("chain-c", 422)
    statuses.set("chain-d", 422)
    statuses.set("chain-e", status)

    expect((await post({}, "cached-hop-bound")).status).toBe(status)
    expect(calls.map((call) => call.body.model)).toEqual([
      "chain-b",
      "chain-c",
      "chain-d",
      "chain-e",
    ])
  },
)

test("a cached B cycle cannot return to the original A", async () => {
  configure([
    ["chain-a", "chain-b"],
    ["chain-b", "chain-a"],
  ])
  statuses.delete("chain-b")
  expect((await post({}, "cached-source-cycle")).status).toBe(200)
  calls.length = 0
  statuses.set("chain-b", 422)

  expect((await post({}, "cached-source-cycle")).status).toBe(422)
  expect(calls.map((call) => call.body.model)).toEqual(["chain-b"])
})

test("cached B can advance to C while full history retains only C signatures on later turns", async () => {
  statuses.delete("chain-b")
  const originalInput = [
    reasoning("old-a-signature"),
    { role: "user", content: "hello" },
  ]
  const first = await post({ input: originalInput }, "signature-chain")
  expect(first.status).toBe(200)
  const firstBody = (await first.json()) as {
    output: Array<Record<string, unknown>>
  }
  expect(JSON.stringify(firstBody.output)).toContain("chain-b-signature")

  statuses.set("chain-b", 422)
  const secondInput = [
    ...originalInput,
    ...firstBody.output,
    { role: "user", content: "continue" },
  ]
  const second = await post({ input: secondInput }, "signature-chain")
  expect(second.status).toBe(200)
  const secondBody = (await second.json()) as {
    output: Array<Record<string, unknown>>
  }
  expect(JSON.stringify(secondBody.output)).toContain("chain-c-signature")
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-b",
    "chain-c",
  ])
  expect(JSON.stringify(calls[2].body)).not.toContain("old-a-signature")
  expect(JSON.stringify(calls[2].body)).toContain("chain-b-signature")
  expect(JSON.stringify(calls[3].body)).not.toContain("old-a-signature")
  expect(JSON.stringify(calls[3].body)).not.toContain("chain-b-signature")

  const third = await post(
    {
      input: [
        ...secondInput,
        ...secondBody.output,
        { role: "user", content: "again" },
      ],
    },
    "signature-chain",
  )
  expect(third.status).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-b",
    "chain-c",
    "chain-c",
  ])
  expect(JSON.stringify(calls[4].body)).not.toContain("old-a-signature")
  expect(JSON.stringify(calls[4].body)).not.toContain("chain-b-signature")
  expect(JSON.stringify(calls[4].body)).toContain("chain-c-signature")
  expect(JSON.stringify(calls[4].body)).toContain("chain answer")
})

test("anonymous Responses repeats the chain independently on every request", async () => {
  for (let index = 0; index < 2; index++) {
    expect(
      (await post({ prompt_cache_key: "not-a-conversation" })).status,
    ).toBe(200)
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-c",
    "chain-a",
    "chain-b",
    "chain-c",
  ])
})

test.each([400, 401, 403, 404, 429, 500, 502, 503])(
  "B HTTP %i ends model fallback chaining",
  async (status) => {
    statuses.set("chain-b", status)
    expect((await post()).status).not.toBe(200)
    expect(calls[0].body.model).toBe("chain-a")
    expect(calls[1].body.model).toBe("chain-b")
    expect(calls.slice(1).every((call) => call.body.model === "chain-b")).toBe(
      true,
    )
  },
)

test.each([
  new TypeError("network unavailable"),
  new DOMException("request timed out", "TimeoutError"),
  new DOMException("request aborted", "AbortError"),
])("B transport error %s ends model fallback chaining", async (error) => {
  errors.set("chain-b", error)
  expect((await post()).status).not.toBe(200)
  expect(calls[0].body.model).toBe("chain-a")
  expect(calls[1].body.model).toBe("chain-b")
  expect(calls.slice(1).every((call) => call.body.model === "chain-b")).toBe(
    true,
  )
})

test.each([false, true])(
  "Messages waits for a delayed intermediate 422 before preflush, cached=%s",
  async (cached) => {
    state.models = {
      object: "list",
      data: modelIds.map((id) => model(id, "/v1/messages")),
    }
    const payload = {
      stream: true,
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }
    if (cached) {
      statuses.delete("chain-b")
      const first = await post(payload, "messages-chain", "/v1/messages")
      expect(first.status).toBe(200)
      await first.text()
      statuses.set("chain-b", 422)
      calls.length = 0
    }
    delays.set("chain-b", 25)
    setSsePreflushDeadlineForTest(1)
    const response = await post(payload, "messages-chain", "/v1/messages")
    const wire = await response.text()
    expect(response.status).toBe(200)
    expect(wire).toContain('"model":"chain-a"')
    expect(wire).toContain("event: message_stop")
    expect(wire).not.toContain("event: error")
    expect(wire).not.toContain("chain_rejected")
    expect(calls.map((call) => call.body.model)).toEqual(
      cached ? ["chain-b", "chain-c"] : ["chain-a", "chain-b", "chain-c"],
    )
  },
)

test("accepted B streaming output is never replayed after an in-stream 422 error", async () => {
  streams.set("chain-b", [
    {
      type: "response.output_text.delta",
      sequence_number: 1,
      item_id: "msg_partial",
      output_index: 0,
      content_index: 0,
      delta: "partial answer",
    },
    {
      type: "response.failed",
      sequence_number: 2,
      response: {
        id: "resp_partial",
        model: "chain-b",
        status: "failed",
        output: [],
        error: { code: "422", message: "late rejection" },
      },
    },
  ])
  const response = await post({ stream: true })
  const wire = await response.text()
  expect(response.status).toBe(200)
  expect(wire).toContain("partial answer")
  expect(wire).toContain("response.failed")
  expect(calls.map((call) => call.body.model)).toEqual(["chain-a", "chain-b"])
})

test("compaction chains across two rejected models and reuses the final model", async () => {
  const payload = { input: [{ role: "user", content: "history" }] }
  for (let index = 0; index < 2; index++) {
    const response = await post(
      payload,
      "compact-chain",
      "/v1/responses/compact",
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      object: string
      output: Array<{ type: string; encrypted_content: string }>
    }
    expect(body.object).toBe("response.compaction")
    expect(body.output[0].type).toBe("compaction")
    expect(
      Buffer.from(body.output[0].encrypted_content, "base64").toString(),
    ).toBe("chain answer")
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-c",
    "chain-c",
  ])
})

test("WebSocket chaining preserves original-model continuation and caches the final model", async () => {
  state.apiKeyAuth = "chain-client-secret"
  const ws = await createSocket()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model: "chain-a",
      input: "first",
    }),
  )
  const completed = ws.sent.find((frame) => frame.type === "response.completed")
  expect(completed?.response).toMatchObject({
    model: "chain-a",
    status: "completed",
  })
  const firstResponse = completed?.response as { id: string }
  expect(ws.data.responseSnapshots.get(firstResponse.id)?.model).toBe("chain-a")

  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      previous_response_id: firstResponse.id,
      input: "continue",
    }),
  )
  expect(calls.map((call) => call.body.model)).toEqual([
    "chain-a",
    "chain-b",
    "chain-c",
    "chain-c",
  ])
  expect(
    ws.sent.filter((frame) => frame.type === "response.completed"),
  ).toHaveLength(2)
  expect(ws.sent.filter((frame) => frame.type === "error")).toHaveLength(0)
  expect(ws.data.activeTurns.size).toBe(0)
})

async function createSocket() {
  let data: ResponsesWebSocketData | undefined
  await seedProtocolDatabase().then(() =>
    tryUpgradeResponsesWebSocket(
      new Request("http://localhost/responses", {
        headers: {
          authorization: "Bearer chain-client-secret",
          "thread-id": "websocket-chain",
        },
      }),
      {
        upgrade(_request, options) {
          data = (options as { data: ResponsesWebSocketData }).data
          return true
        },
      },
    ),
  )
  if (!data) throw new Error("Expected WebSocket upgrade")
  const sent: Array<Record<string, unknown>> = []
  return {
    data,
    sent,
    send(frame: string) {
      sent.push(JSON.parse(frame) as Record<string, unknown>)
    },
    close() {},
  }
}
