import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import {
  getLoadedModelFallbackConfig,
  setModelFallbackConfigForTest,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = {
  apiKeyAuth: state.apiKeyAuth,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  models: state.models,
}
const requests: Array<Record<string, unknown>> = []
const responses: Array<Response> = []
const sourceModel = "gpt-5.4"
const targetModel = "gpt-5-mini"

beforeEach(() => {
  requests.length = 0
  responses.length = 0
  setConfigForTest({})
  setModelFallbackConfigForTest({
    enabled: true,
    conversationAffinity: true,
    notifyClient: false,
    nativeClientNotice: false,
    affinityTtlSeconds: 86400,
    affinityMaxEntries: 10000,
    rules: [{ id: "ws", sourceModel, targetModel, enabled: true }],
  })
  state.apiKeyAuth = "ws-client-secret"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.models = {
    object: "list",
    data: [sourceModel, targetModel].map((id) => ({
      id,
      name: id,
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    })),
  } satisfies ModelsResponse
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected JSON request body")
    requests.push(JSON.parse(init.body) as Record<string, unknown>)
    const response = responses.shift()
    if (!response) throw new Error("Unexpected upstream request")
    return Promise.resolve(response)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test("WebSocket fallback targets honor model redirects and effort overrides", async () => {
  const fast = "redirected-fast"
  const originalTarget = state.models?.data[1]
  if (!originalTarget) throw new Error("Missing fixture target model")
  state.models?.data.push({ ...originalTarget, id: fast, name: fast })
  setModelRedirectsForTest([
    {
      id: "ws-fast",
      sourceModel: targetModel,
      sourceEffort: "all",
      targetModel: fast,
      targetEffort: "high",
      targetVerbosity: "low",
      enabled: true,
    },
  ])
  const ws = await createSocket()
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_redirect"),
    completedResponse("resp_redirect_next"),
  )
  await sendTurn(ws, {
    input: "first",
    reasoning: { effort: "low" },
    text: { verbosity: "high" },
  })
  await sendTurn(ws, {
    previous_response_id: "resp_redirect",
    input: "next",
    reasoning: { effort: "low" },
    text: { verbosity: "high" },
  })
  expect(requests.map((request) => request.model)).toEqual([
    sourceModel,
    fast,
    fast,
  ])
  for (const request of requests.slice(1)) {
    expect(request.reasoning).toMatchObject({ effort: "high" })
    expect(request.text).toMatchObject({ verbosity: "low" })
  }
  expect(ws.sent.some((frame) => frame.type === "error")).toBe(false)
})

test("falls back after upstream 422 and keeps original-model continuations usable", async () => {
  const ws = await createSocket()
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_fallback"),
    completedResponse("resp_continuation"),
  )
  await sendTurn(ws, { input: "first" })
  expect(requests.map((request) => request.model)).toEqual([
    sourceModel,
    targetModel,
  ])
  expect(ws.data.responseSnapshots.get("resp_fallback")?.model).toBe(
    sourceModel,
  )
  await sendTurn(ws, {
    previous_response_id: "resp_fallback",
    input: "second",
  })
  expect(requests.map((request) => request.model)).toEqual([
    sourceModel,
    targetModel,
    targetModel,
  ])
  expect(
    ws.sent.filter((frame) => frame.type === "response.completed"),
  ).toHaveLength(2)
  expect(ws.sent.some((frame) => frame.type === "error")).toBe(false)
  for (const frame of ws.sent) {
    const response = frame.response as Record<string, unknown> | undefined
    if (response) expect(response.model).toBe(sourceModel)
  }
  expect(ws.data.activeTurns.size).toBe(0)
})

test("isolates sibling thread fallback state on one parent session", async () => {
  const ws = await createSocket({ "session-id": "parent-session" })
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_child_a"),
    completedResponse("resp_child_b"),
    completedResponse("resp_child_a_again"),
  )
  await sendTurn(ws, {
    input: "first",
    client_metadata: { thread_id: "child-a" },
  })
  await sendTurn(ws, {
    input: "other",
    client_metadata: { thread_id: "child-b" },
  })
  await sendTurn(ws, {
    input: "again",
    client_metadata: { thread_id: "child-a" },
  })
  expect(requests.map((request) => request.model)).toEqual([
    sourceModel,
    targetModel,
    sourceModel,
    targetModel,
  ])
})

test("preserves original model when continuation omits its model", async () => {
  const ws = await createSocket()
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_implicit_model"),
    completedResponse("resp_implicit_continuation"),
  )
  await sendTurn(ws, { input: "first" })
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      previous_response_id: "resp_implicit_model",
      input: "second",
    }),
  )
  const completed = ws.sent.filter(
    (frame) => frame.type === "response.completed",
  )
  expect(completed).toHaveLength(2)
  expect(completed[1].response).toMatchObject({ model: sourceModel })
})

test("adds optional diagnostic metadata without a native model-reroute notice", async () => {
  setModelFallbackConfigForTest({
    ...getLoadedModelFallbackConfig(),
    notifyClient: true,
  })
  const ws = await createSocket()
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_notice"),
  )
  await sendTurn(ws, { input: "first" })
  const completed = ws.sent.find((frame) => frame.type === "response.completed")
  expect(completed?.headers).toMatchObject({
    "x-copilot-api-fallback-from": sourceModel,
    "x-copilot-api-fallback-to": targetModel,
    "x-copilot-api-fallback-reason": "http_422",
    "x-copilot-api-fallback-cached": "false",
  })
  expect(completed?.headers).not.toHaveProperty("openai-model")
})

test("scopes frame thread headers to the authenticated connection credential", async () => {
  const first = await createSocket({ "session-id": "shared-parent" })
  state.apiKeyAuth = "second-client-secret"
  const second = await createSocket({
    authorization: "Bearer second-client-secret",
    "session-id": "shared-parent",
  })
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_first_client"),
    completedResponse("resp_second_client"),
    completedResponse("resp_first_client_cached"),
  )
  const headers = {
    "thread-id": "shared-thread",
    authorization: "Bearer spoofed",
  }
  await sendTurn(first, { headers, input: "first" })
  await sendTurn(second, { headers, input: "second" })
  await sendTurn(first, { headers, input: "again" })
  expect(requests.map((request) => request.model)).toEqual([
    sourceModel,
    targetModel,
    sourceModel,
    targetModel,
  ])
  expect(first.data.fallbackHeaders?.get("authorization")).toBeNull()
})

test("a configured fallback cycle is bypassed on every WebSocket turn", async () => {
  setModelFallbackConfigForTest({
    ...getLoadedModelFallbackConfig(),
    rules: [
      ...getLoadedModelFallbackConfig().rules,
      {
        id: "chain",
        sourceModel: targetModel,
        targetModel: sourceModel,
        enabled: true,
      },
    ],
  })
  const ws = await createSocket()
  responses.push(
    new Response("first rejected", { status: 422 }),
    completedResponse("resp_source_recovered"),
  )
  await sendTurn(ws, { input: "first" })
  await sendTurn(ws, { input: "again" })
  expect(requests.map((request) => request.model)).toEqual([
    sourceModel,
    sourceModel,
  ])
  expect(ws.sent.filter((frame) => frame.type === "error")).toHaveLength(1)
  expect(
    ws.sent.filter((frame) => frame.type === "response.completed"),
  ).toHaveLength(1)
})

test("anonymous WebSocket requests retry the original model on every turn", async () => {
  const ws = await createSocket({ "session-id": "" })
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_anon_a"),
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_anon_b"),
  )
  await sendTurn(ws, { input: "first" })
  await sendTurn(ws, { previous_response_id: "resp_anon_a", input: "second" })
  expect(requests.map((entry) => entry.model)).toEqual([
    sourceModel,
    targetModel,
    sourceModel,
    targetModel,
  ])
})

test("redirected source aliases still match fallback continuation snapshots", async () => {
  const alias = "gpt-client-alias"
  setModelRedirectsForTest([
    {
      id: "alias",
      sourceModel: alias,
      sourceEffort: "all",
      targetModel: sourceModel,
      enabled: true,
    },
  ])
  const ws = await createSocket()
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_alias"),
    completedResponse("resp_alias_next"),
  )
  await sendTurn(ws, { model: alias, input: "first" })
  await sendTurn(ws, {
    model: alias,
    previous_response_id: "resp_alias",
    input: "second",
  })
  expect(requests.map((entry) => entry.model)).toEqual([
    sourceModel,
    targetModel,
    targetModel,
  ])
  expect(ws.sent.filter((frame) => frame.type === "error")).toHaveLength(0)
  for (const frame of ws.sent.filter(
    (entry) => entry.type === "response.completed",
  )) {
    expect(frame.response).toMatchObject({ model: alias })
  }
})

test("optional Codex native notice uses its recognized model header independently", async () => {
  setModelFallbackConfigForTest({
    ...getLoadedModelFallbackConfig(),
    nativeClientNotice: true,
  })
  const ws = await createSocket()
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_codex_notice"),
  )
  await sendTurn(ws, { input: "first" })
  const completed = ws.sent.find((frame) => frame.type === "response.completed")
  expect(completed?.headers).toEqual({ "openai-model": targetModel })
})

test("recomputes reasoning effort for the alternate model", async () => {
  setModelSettingsForTest([
    {
      model: targetModel,
      supportedReasoningEfforts: ["low"],
      defaultReasoningEffort: "low",
    },
  ])
  const ws = await createSocket()
  responses.push(
    new Response("unprocessable", { status: 422 }),
    completedResponse("resp_effort"),
  )
  await sendTurn(ws, { input: "first", reasoning: { effort: "high" } })
  expect(requests[0].reasoning).toMatchObject({ effort: "high" })
  expect(requests[1].reasoning).toMatchObject({ effort: "low" })
})

test.each([undefined, "encrypted-only-target-signature"])(
  "routes a custom-provider alternate and keeps WebSocket signature %s",
  async (signature) => {
    setConfigForTest({
      customProviders: [
        {
          id: "ws-custom",
          name: "WS Custom",
          type: "openai-compatible",
          baseUrl: "https://custom.example/v1",
          apiKey: "test-provider-key",
          models: [{ id: "custom-target", kind: "chat" }],
        },
      ],
    })
    setModelFallbackConfigForTest({
      ...getLoadedModelFallbackConfig(),
      rules: [
        {
          id: "custom",
          sourceModel,
          targetModel: "custom-target",
          enabled: true,
        },
      ],
    })
    const ws = await createSocket()
    responses.push(
      new Response("unprocessable", { status: 422 }),
      chatResponse("chat_custom", signature),
      chatResponse("chat_custom_next"),
    )
    await sendTurn(ws, { input: "first" })
    const completed = ws.sent.find(
      (frame) => frame.type === "response.completed",
    )
    const result = completed?.response as Record<string, unknown> | undefined
    expect(result?.model).toBe(sourceModel)
    if (signature) {
      expect(result?.output).toContainEqual(
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: signature,
          summary: [],
        }),
      )
    }
    await sendTurn(ws, { input: "second", previous_response_id: result?.id })
    expect(requests.map((entry) => entry.model)).toEqual([
      sourceModel,
      "custom-target",
      "custom-target",
    ])
    expect(ws.sent.filter((frame) => frame.type === "error")).toHaveLength(0)
    if (signature) expect(JSON.stringify(requests[2])).toContain(signature)
  },
)

test("rebuilds a Messages-only alternate and retains its thinking on the next turn", async () => {
  if (!state.models) throw new Error("Expected test models")
  const fallback = state.models.data[1]
  fallback.supported_endpoints = ["/v1/messages"]
  fallback.vendor = "anthropic"
  const ws = await createSocket()
  responses.push(
    new Response("unprocessable", { status: 422 }),
    messageResponse("msg_fallback"),
    messageResponse("msg_continued"),
  )
  await sendTurn(ws, {
    max_output_tokens: 128,
    input: [
      {
        type: "reasoning",
        id: "rs_original",
        encrypted_content: "old-signature",
      },
      { type: "message", role: "user", content: "first" },
    ],
  })
  expect(requests.map((request) => request.model)).toEqual([
    sourceModel,
    targetModel,
  ])
  expect(JSON.stringify(requests[1])).not.toContain("old-signature")
  const completed = ws.sent.find((frame) => frame.type === "response.completed")
  const response = completed?.response as Record<string, unknown> | undefined
  expect(response?.model).toBe(sourceModel)
  await sendTurn(ws, { previous_response_id: response?.id, input: "second" })
  expect(requests[2].model).toBe(targetModel)
  expect(JSON.stringify(requests[2])).toContain("target-signature")
  expect(ws.sent.filter((frame) => frame.type === "error")).toHaveLength(0)
})

test.each([400, 403])(
  "does not change models after upstream %s",
  async (status) => {
    const ws = await createSocket()
    responses.push(new Response("upstream failure", { status }))
    await sendTurn(ws, { input: "first" })
    expect(requests.every((request) => request.model === sourceModel)).toBe(
      true,
    )
    expect(ws.sent.some((frame) => frame.type === "error")).toBe(true)
  },
)

async function createSocket(headers: Record<string, string> = {}) {
  let data: ResponsesWebSocketData | undefined
  await seedProtocolDatabase().then(() =>
    tryUpgradeResponsesWebSocket(
      new Request("http://localhost/responses", {
        headers: {
          authorization: "Bearer ws-client-secret",
          "session-id": crypto.randomUUID(),
          ...headers,
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
  if (!data) throw new Error("Expected authenticated WebSocket upgrade")
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

async function sendTurn(
  ws: Awaited<ReturnType<typeof createSocket>>,
  payload: Record<string, unknown>,
) {
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", model: sourceModel, ...payload }),
  )
}

function completedResponse(id: string): Response {
  const response = { id, model: targetModel, output: [], usage: null }
  return new Response(
    [
      {
        type: "response.created",
        response: { ...response, status: "in_progress" },
      },
      {
        type: "response.completed",
        response: { ...response, status: "completed" },
      },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function messageResponse(id: string): Response {
  return Response.json({
    id,
    type: "message",
    role: "assistant",
    model: targetModel,
    content: [
      {
        type: "thinking",
        thinking: "target thought",
        signature: "target-signature",
      },
      { type: "text", text: "answer" },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
}

function chatResponse(id: string, encryptedContent?: string): Response {
  return Response.json({
    id,
    object: "chat.completion",
    created: 1,
    model: "custom-target",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "custom answer",
          ...(encryptedContent ? { encrypted_content: encryptedContent } : {}),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}
