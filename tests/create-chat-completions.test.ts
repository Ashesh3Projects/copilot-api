import * as Sentry from "@sentry/bun"
/* eslint-disable max-lines -- route and transport coverage share singleton fetch fixtures */
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
import { Hono, type Context } from "hono"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { forwardError, HTTPError, LocalHTTPError } from "../src/lib/error"
import {
  clearLlmDebugLogs,
  getLlmDebugLog,
  listLlmDebugLogs,
} from "../src/lib/llm-debug-log"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { handleCompletion } from "../src/routes/chat-completions/handler"
import { server } from "../src/server"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "../src/services/copilot/compaction-payload"
import {
  createChatCompletions,
  createChatCompletionsWithProcessedPayload,
  type Message,
} from "../src/services/copilot/create-chat-completions"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

// Save and restore original fetch so integration tests aren't affected
useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalIsMultiToken = state.isMultiToken
const addedAccountIds = [2101, 2102]
const queuedResponses: Array<Response> = []
const capturedAffinities: Array<RoutingAffinity | undefined> = []
const capturedAuthorization: Array<string | undefined> = []
let metadataAffinityFetchCount = 0
let lastRequestBody: Record<string, unknown> | undefined
let requestBodies: Array<Record<string, unknown>> = []
let lastRequestHeaders: Headers | undefined

const sessionToken = (payload: Record<string, unknown>): string =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`

const binarySessionToken = (payload: Record<string, unknown>): string => {
  const opaque = Buffer.from([0xff, 0, 0x80]).toString("base64url")
  return `${opaque}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${opaque}`
}

function invalidSessionTokens(model: string): Array<string> {
  const payload = Buffer.from(
    JSON.stringify({ selected_model: model }),
  ).toString("base64url")
  const noncanonicalPayload = Buffer.from(
    JSON.stringify({ selected_model: model, padding: "x" }),
  ).toString("base64url")
  if (noncanonicalPayload.length % 4 === 0) {
    throw new Error("Expected unused terminal base64url bits")
  }
  const decoded = Buffer.from(noncanonicalPayload, "base64url")
  const noncanonical = Array.from(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  )
    .map((character) => `${noncanonicalPayload.slice(0, -1)}${character}`)
    .find(
      (candidate) =>
        candidate !== noncanonicalPayload
        && Buffer.from(candidate, "base64url").equals(decoded),
    )
  if (!noncanonical) throw new Error("Expected a noncanonical token payload")
  return [
    `e%0.${payload}.c2ln`,
    `e30=.${payload}.c2ln`,
    `A.${payload}.c2ln`,
    `Zh.${payload}.c2ln`,
    `e30.${payload}.Zh`,
    `e30.${noncanonical}.c2ln`,
    `e30.${"A".repeat(16 * 1024)}.c2ln`,
    sessionToken({
      selected_model: { model },
      available_models: { 0: model },
    }),
  ]
}

function createLegacyMessagesModel(
  model: string,
): ModelsResponse["data"][number] {
  return {
    id: model,
    name: model,
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 1024 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

const createDefaultResponse = () =>
  new Response(
    JSON.stringify({
      id: "123",
      object: "chat.completion",
      choices: [],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )

const createSSEStreamResponse = (messages: Array<string>) =>
  new Response(`${messages.join("\n\n")}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

// Mock state
state.copilotToken = "test-token"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { body?: string; headers: Record<string, string> }) => {
    const body =
      opts.body ? (JSON.parse(opts.body) as Record<string, unknown>) : undefined
    if (body?.model === "claude-metadata-routing-model") {
      capturedAffinities.push(getRoutingAffinity())
      capturedAuthorization.push(opts.headers.Authorization)
      metadataAffinityFetchCount += 1
    }
    lastRequestBody = body
    if (body) requestBodies.push(body)
    lastRequestHeaders = new Headers(opts.headers)
    void opts
    return queuedResponses.shift() ?? createDefaultResponse()
  },
)

beforeAll(() => {
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
})

afterAll(() => {
  for (const accountId of addedAccountIds)
    tokenPool.removeAccountForTest(accountId)
  state.isMultiToken = originalIsMultiToken
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  queuedResponses.length = 0
  capturedAffinities.length = 0
  lastRequestBody = undefined
  requestBodies = []
  lastRequestHeaders = undefined
  capturedAuthorization.length = 0
  metadataAffinityFetchCount = 0
  state.isMultiToken = originalIsMultiToken
  setModelSettingsForTest([])
  setModelRedirectsForTest([])
  await clearLlmDebugLogs()
  resetRoutingTelemetryForTest()
})

test("retries one exact unsupported Chat control on the finalized wire clone", async () => {
  queuedResponses.push(
    Response.json(
      {
        error: {
          code: "invalid_request_body",
          message:
            "Unsupported parameter: 'temperature' is not supported with this model.",
        },
      },
      { status: 400 },
    ),
    createDefaultResponse(),
  )
  const payload = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0,
    top_p: 0.7,
  } as ChatCompletionsPayload
  const source = structuredClone(payload)

  const result = await seedProtocolDatabase().then(() =>
    createChatCompletionsWithProcessedPayload(payload, {
      candidatePrepared: true,
      copilotSessionToken: "session-stays-fixed",
    }),
  )

  expect(payload).toEqual(source)
  expect(requestBodies).toHaveLength(2)
  expect(requestBodies[0]).toEqual(source as unknown as Record<string, unknown>)
  expect(requestBodies[1]).toEqual({
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    top_p: 0.7,
  })
  expect(result.processedPayload).toEqual(
    requestBodies[1] as unknown as ChatCompletionsPayload,
  )
  expect(
    fetchMock.mock.calls.map((call) =>
      new Headers(call[1].headers).get("copilot-session-token"),
    ),
  ).toEqual(["session-stays-fixed", "session-stays-fixed"])
})

test("uses one account selection and account token for a Chat compatibility retry", async () => {
  const model = "chat-compatibility-pin-model"
  const account = tokenPool.addAccount("github-compat-pin", "individual", 2101)
  account.copilotToken = "compatibility-pin-token"
  account.healthy = true
  account.models = new Set([model])
  account.modelsData = [createLegacyMessagesModel(model)]
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true
  state.models = { object: "list", data: [createLegacyMessagesModel(model)] }
  queuedResponses.push(
    Response.json(
      {
        error: {
          code: "invalid_request_body",
          message:
            "Unsupported parameter: 'temperature' is not supported with this model.",
        },
      },
      { status: 400 },
    ),
    createDefaultResponse(),
  )

  await seedProtocolDatabase().then(() =>
    createChatCompletions(
      {
        model,
        messages: [{ role: "user", content: "hello" }],
        temperature: 1,
      },
      { candidatePrepared: true },
    ),
  )

  const lastCalls = fetchMock.mock.calls.slice(-2)
  expect(
    lastCalls.map((call) => new Headers(call[1].headers).get("authorization")),
  ).toEqual([
    "Bearer compatibility-pin-token",
    "Bearer compatibility-pin-token",
  ])
  const usage = getRoutingTelemetrySnapshot({
    accounts: [{ id: 2101, accountType: "individual", healthy: true }],
    multiToken: true,
    window: "1h",
  })
  expect(usage.totals).toMatchObject({ retries: 1, upstreamCalls: 2 })
  expect(
    usage.selectionModes.sticky
      + usage.selectionModes.default
      + usage.selectionModes.single,
  ).toBe(1)
})

test("preserves only the final Chat compatibility failure response", async () => {
  queuedResponses.push(
    Response.json(
      {
        error: {
          code: "invalid_request_body",
          message:
            "Unsupported parameter: 'temperature' is not supported with this model.",
        },
      },
      { status: 400 },
    ),
    new Response("second failure\r\n  ", {
      status: 422,
      headers: { "content-type": "text/plain" },
    }),
  )

  let error: unknown
  try {
    await seedProtocolDatabase().then(() =>
      createChatCompletions(
        {
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
          temperature: 1,
        },
        { candidatePrepared: true },
      ),
    )
  } catch (caught: unknown) {
    error = caught
  }

  expect(error).toBeInstanceOf(HTTPError)
  if (!(error instanceof HTTPError)) throw new Error("Expected HTTPError")
  expect(error.response.status).toBe(422)
  expect(error.response.headers.get("content-type")).toBe("text/plain")
  expect(error.response.bodyUsed).toBe(false)
  expect(await error.response.text()).toBe("second failure\r\n  ")
})

test("forwards only matching model-scoped session tokens on Chat inference", async () => {
  state.models = {
    object: "list",
    data: [createLegacyMessagesModel("gpt-test")],
  }
  const matchingToken = sessionToken({ selected_model: "gpt-test" })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": matchingToken,
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )
  expect(lastRequestHeaders?.get("copilot-session-token")).toBe(matchingToken)
  const matchingDebug = await getLlmDebugLog(
    (await listLlmDebugLogs()).entries[0]?.id ?? "",
  )
  expect(matchingDebug?.request.headers["Copilot-Session-Token"]).toBe(
    matchingToken,
  )

  const longMatchingToken = sessionToken({
    selected_model: "gpt-test",
    padding: "x".repeat(2 * 1024),
  })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": longMatchingToken,
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )
  expect(lastRequestHeaders?.get("copilot-session-token")).toBe(
    longMatchingToken,
  )

  const binaryToken = binarySessionToken({ selected_model: "gpt-test" })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": binaryToken,
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "binary opaque segments" }],
      }),
    }),
  )
  expect(lastRequestHeaders?.get("copilot-session-token")).toBe(binaryToken)

  for (const token of [
    sessionToken({ selected_model: "different-model" }),
    "malformed-token",
    ...invalidSessionTokens("gpt-test"),
  ]) {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
          "copilot-session-token": token,
        },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(lastRequestHeaders?.get("copilot-session-token")).toBeNull()
    expect(lastRequestHeaders?.get("authorization")).toBe("Bearer test-token")
  }

  setModelRedirectsForTest([
    {
      id: "chat-session-token-redirect",
      sourceModel: "gpt-test",
      targetModel: "gpt-redirected",
      enabled: true,
    },
  ])
  state.models = {
    object: "list",
    data: [createLegacyMessagesModel("gpt-redirected")],
  }
  const redirectedToken = sessionToken({
    selected_model: "gpt-redirected",
    available_models: ["gpt-test", "gpt-redirected"],
  })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": redirectedToken,
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )
  expect(lastRequestBody?.model).toBe("gpt-redirected")
  expect(lastRequestHeaders?.get("copilot-session-token")).toBeNull()

  setModelRedirectsForTest([])
  state.models = {
    object: "list",
    data: [createLegacyMessagesModel("gpt-4.1")],
  }
  const aliasToken = sessionToken({ selected_model: "gpt-4.1" })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": aliasToken,
      },
      body: JSON.stringify({
        model: "gpt-4-1",
        messages: [{ role: "user", content: "ordinary alias" }],
      }),
    }),
  )
  expect(lastRequestBody?.model).toBe("gpt-4.1")
  expect(lastRequestHeaders?.get("copilot-session-token")).toBe(aliasToken)

  setModelRedirectsForTest([
    {
      id: "chat-alias-chain-1",
      sourceModel: "gpt-4.1",
      targetModel: "gpt-alias-middle",
      enabled: true,
    },
    {
      id: "chat-alias-chain-2",
      sourceModel: "gpt-alias-middle",
      targetModel: "gpt-4-1",
      enabled: true,
    },
  ])
  await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": aliasToken,
      },
      body: JSON.stringify({
        model: "gpt-4-1",
        messages: [{ role: "user", content: "configured alias redirect" }],
      }),
    }),
  )
  expect(lastRequestBody?.model).toBe("gpt-4.1")
  expect(lastRequestHeaders?.get("copilot-session-token")).toBeNull()
})

test("preserves an upstream body even when it contains request metadata", async () => {
  state.models = {
    object: "list",
    data: [createLegacyMessagesModel("gpt-test")],
  }
  const privateToken = sessionToken({ selected_model: "gpt-test" })
  queuedResponses.push(
    Response.json(
      { error: { code: "invalid_request_body", message: privateToken } },
      { status: 400 },
    ),
  )
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  try {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
          "copilot-session-token": privateToken,
        },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).toContain(privateToken)
    expect(JSON.stringify(errorSpy.mock.calls)).toContain(privateToken)
    expect(JSON.stringify(captureException.mock.calls)).toContain(privateToken)

    const rawDebug = await getLlmDebugLog(
      (await listLlmDebugLogs()).entries[0]?.id ?? "",
    )
    expect(rawDebug?.request.headers["Copilot-Session-Token"]).toBe(
      privateToken,
    )
    expect(rawDebug?.response?.body).toContain(privateToken)
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})

test("returns a safe local Chat error for a null JSON body", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: "null",
    }),
  )
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(400)
  expect(body).toEqual({
    error: {
      code: "invalid_type",
      message: "The request body must be a JSON object.",
      param: "body",
      type: "invalid_request_error",
    },
  })
  expect(JSON.stringify(body)).not.toContain("Cannot read properties")
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects direct BigInt payloads before upstream serialization", async () => {
  let thrown: unknown
  try {
    await seedProtocolDatabase().then(() =>
      createChatCompletions({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        metadata: { count: 1n },
      } as unknown as ChatCompletionsPayload),
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(LocalHTTPError)
  expect(thrown).toHaveProperty("response.status", 400)
  expect(thrown).toHaveProperty("clientBody.error", {
    code: "invalid_type",
    message: "The request body must be a JSON object.",
    param: "body",
    type: "invalid_request_error",
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects direct cyclic payloads before upstream serialization", async () => {
  const payload = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
  } as unknown as ChatCompletionsPayload & { self?: unknown }
  payload.self = payload
  let thrown: unknown

  try {
    await seedProtocolDatabase().then(() => createChatCompletions(payload))
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(LocalHTTPError)
  expect(thrown).toHaveProperty("response.status", 400)
  expect(thrown).toHaveProperty("clientBody.error", {
    code: "invalid_type",
    message: "The request body must be a JSON object.",
    param: "body",
    type: "invalid_request_error",
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("returns the fixed route error for programmatic BigInt and cyclic bodies", async () => {
  const payloads: Array<unknown> = [
    {
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      metadata: { count: 1n },
    },
  ]
  const cyclic = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
  } as Record<string, unknown>
  cyclic.self = cyclic
  payloads.push(cyclic)

  for (const payload of payloads) {
    const app = new Hono()
    app.post("/", async (c) => {
      const context = Object.create(c) as Context
      Object.defineProperty(context, "req", {
        value: { json: () => Promise.resolve(payload) },
      })
      try {
        return await handleCompletion(context)
      } catch (error) {
        return await forwardError(c, error)
      }
    })
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_type",
        message: "The request body must be a JSON object.",
        param: "body",
        type: "invalid_request_error",
      },
    })
  }
  expect(fetchMock).not.toHaveBeenCalled()
})

test("fits explicitly marked ChatCompletions compaction payloads", async () => {
  const oversizedOutput =
    "BEGIN-CHAT-TRANSPORT\n"
    + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
    + "\nEND-CHAT-TRANSPORT"

  await seedProtocolDatabase().then(() =>
    createChatCompletions(
      {
        model: "gpt-test",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_chat_transport",
                type: "function",
                function: {
                  name: "exec",
                  arguments: JSON.stringify({ input: "run chat diagnostic" }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_chat_transport",
            content: oversizedOutput,
          },
        ] as Array<Message>,
      },
      { compaction: true },
    ),
  )

  const serialized = JSON.stringify(lastRequestBody)
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    COMPACTION_PAYLOAD_MAX_BYTES,
  )
  expect(serialized).toContain("run chat diagnostic")
  expect(serialized).toContain("call_chat_transport")
  expect(serialized).toContain("BEGIN-CHAT-TRANSPORT")
  expect(serialized).toContain("END-CHAT-TRANSPORT")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
})

test("installs Claude metadata affinity before provider dispatch", async () => {
  const model = "claude-metadata-routing-model"
  for (const [id, token] of [
    [2101, "metadata-token-one"],
    [2102, "metadata-token-two"],
  ] as const) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = token
    account.healthy = true
    account.models = new Set([model])
    account.modelsData = [createLegacyMessagesModel(model)]
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true
  state.models = {
    object: "list",
    data: [createLegacyMessagesModel(model)],
  }
  const request = () =>
    seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 32,
          metadata: {
            user_id: JSON.stringify({ session_id: "claude-body-session" }),
          },
        }),
      }),
    )

  const first = await request()
  const second = await request()
  const authorization = capturedAuthorization.slice(-2)
  const affinities = capturedAffinities.slice(-2)

  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(metadataAffinityFetchCount).toBe(2)
  expect(affinities).toEqual([
    { key: "claude-body-session", source: "claude_metadata" },
    { key: "claude-body-session", source: "claude_metadata" },
  ])
  const expected = tokenPool.getAccountForModelBySession(
    model,
    "claude-body-session",
  )
  expect(authorization).toEqual([
    `Bearer ${expected?.copilotToken}`,
    `Bearer ${expected?.copilotToken}`,
  ])
})

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_agent",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_agent", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await seedProtocolDatabase().then(() => createChatCompletions(payload))
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls.at(-1)?.[1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
  expect(headers["X-Interaction-Type"]).toBe("conversation-agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await seedProtocolDatabase().then(() => createChatCompletions(payload))
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls.at(-1)?.[1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
  expect(headers["X-Interaction-Type"]).toBe("conversation-user")
})

test("skips non-function tools during payload normalization", async () => {
  const payload = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { type: "web_search" },
      { type: "function", function: { name: "get_weather" } },
    ],
  } as unknown as ChatCompletionsPayload

  await seedProtocolDatabase().then(() => createChatCompletions(payload))

  const lastCall = fetchMock.mock.calls.at(-1)?.[1] as unknown as {
    body: string
  }
  const sentBody = JSON.parse(lastCall.body) as {
    tools: Array<Record<string, unknown>>
  }

  expect(sentBody.tools[0]?.type).toBe("web_search")
  expect(sentBody.tools[1]?.type).toBe("function")
  expect(
    (sentBody.tools[1]?.function as { parameters?: Record<string, unknown> })
      .parameters,
  ).toEqual({ type: "object", properties: {} })
})

test("dispatches normalized deprecated Chat controls without mutating the caller", async () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    functions: [{ name: "legacy_lookup", parameters: {} }],
    function_call: { name: "legacy_lookup" },
    stream: true,
  }
  const original = structuredClone(payload)
  queuedResponses.push(createSSEStreamResponse(["data: [DONE]"]))

  await seedProtocolDatabase().then(() => createChatCompletions(payload))

  expect(payload).toEqual(original)
  expect(lastRequestBody).toMatchObject({
    tools: [
      {
        type: "function",
        function: {
          name: "legacy_lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: "legacy_lookup" },
    },
    stream_options: { include_usage: true },
  })
  expect(lastRequestBody).not.toHaveProperty("functions")
  expect(lastRequestBody).not.toHaveProperty("function_call")
})

test("exposes the processed clone without changing the direct response API", async () => {
  setModelSettingsForTest([
    { model: "claude-no-prefill", supportsAssistantPrefill: false },
  ])
  const payload: ChatCompletionsPayload = {
    model: "claude-no-prefill",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "prefill" },
    ],
  }
  const original = structuredClone(payload)
  const { processedPayload, response } = await seedProtocolDatabase().then(() =>
    createChatCompletionsWithProcessedPayload(payload),
  )

  expect(response).toHaveProperty("object", "chat.completion")
  expect(payload).toEqual(original)
  expect(processedPayload.messages[1]).toEqual({
    role: "user",
    content: "prefill",
  })
})

test("dispatches a prepared native candidate without semantic reprocessing", async () => {
  const payload = {
    model: "gpt-test",
    messages: [
      { role: "future-role", content: "future content" },
      { role: "assistant", content: "keep prefill" },
    ],
    stream: true,
    stream_options: { include_usage: false },
    response_format: {
      type: "json_schema",
      json_schema: { schema: { type: "object" } },
    },
    future_top_level: { preserved: true },
  } as unknown as ChatCompletionsPayload

  const result = await seedProtocolDatabase().then(() =>
    createChatCompletionsWithProcessedPayload(payload, {
      candidatePrepared: true,
    }),
  )
  expect(result.processedPayload).toEqual(payload)
  expect(fetchMock).toHaveBeenCalled()
  const sent = JSON.parse(
    (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string,
  ) as Record<string, unknown>
  expect(sent).toEqual(payload as unknown as Record<string, unknown>)
})

test("isolates the processed snapshot from stream retry state", async () => {
  const overloadEvent = 'data: {"error":{"message":"Overloaded"}}'
  queuedResponses.push(
    createSSEStreamResponse([overloadEvent]),
    createSSEStreamResponse(["data: [DONE]"]),
  )
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }

  const { processedPayload, response } = await seedProtocolDatabase().then(() =>
    createChatCompletionsWithProcessedPayload(payload),
  )
  processedPayload.model = "attacker-model"
  processedPayload.messages[0].content = "attacker-content"
  for await (const _event of response as AsyncIterable<unknown>) {
    // Drain so streamed retry handling completes.
  }

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(lastRequestBody?.model).toBe("gpt-test")
  expect(lastRequestBody?.messages).toEqual([
    { role: "user", content: "hello" },
  ])
})

test("ignores removed processed-payload hooks without changing responses", async () => {
  const response = await seedProtocolDatabase().then(() =>
    createChatCompletions(
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      },
      {
        onProcessedPayload: () => {
          throw new Error("hook failure")
        },
      } as unknown as Parameters<typeof createChatCompletions>[1],
    ),
  )

  expect(response).toHaveProperty("object", "chat.completion")
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("isolates processed snapshots from non-streaming response state", async () => {
  queuedResponses.push(
    new Response(
      JSON.stringify({
        id: "json-response",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: '```json\n{"ok":true}\n```',
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  )
  const { processedPayload, response } = await seedProtocolDatabase().then(() =>
    createChatCompletionsWithProcessedPayload({
      model: "gpt-test",
      messages: [{ role: "user", content: "return JSON" }],
      response_format: { type: "json_object" },
    }),
  )
  processedPayload.response_format = null

  expect(response).toHaveProperty("choices.0.message.content", '{"ok":true}')
})

test("retries streamed chat completions when the first SSE event is an overload error", async () => {
  const overloadEvent = 'data: {"error":{"message":"Overloaded"}}'
  const successChunk = JSON.stringify({
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        delta: { content: "hello" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })

  queuedResponses.push(
    createSSEStreamResponse([overloadEvent]),
    createSSEStreamResponse([`data: ${successChunk}`, "data: [DONE]"]),
  )

  const startCallCount = fetchMock.mock.calls.length
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }

  const response = await seedProtocolDatabase().then(() =>
    createChatCompletions(payload),
  )
  const receivedEvents: Array<string> = []

  for await (const chunk of response as AsyncIterable<{ data?: string }>) {
    if (chunk.data) {
      receivedEvents.push(chunk.data)
    }
  }

  expect(fetchMock.mock.calls.length - startCallCount).toBe(2)
  expect(receivedEvents).toEqual([successChunk, "[DONE]"])
  const usage = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(usage.totals).toMatchObject({
    retries: 1,
    upstreamCalls: 2,
  })
  expect(
    usage.selectionModes.sticky
      + usage.selectionModes.default
      + usage.selectionModes.single,
  ).toBe(1)
})

test("stream overload retry keeps the image-stripped compaction body", async () => {
  const overloadEvent = 'data: {"error":{"message":"Overloaded"}}'
  const successChunk = JSON.stringify({
    id: "chunk-image-retry",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        delta: { content: "ok" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  })
  const requestBodies: Array<string> = []
  const originalMock = globalThis.fetch
  let call = 0
  const chainedFetch = mock((_url: string, init?: RequestInit) => {
    requestBodies.push(typeof init?.body === "string" ? init.body : "")
    call += 1
    if (call === 1) return new Response("too large", { status: 413 })
    if (call === 2) return createSSEStreamResponse([overloadEvent])
    return createSSEStreamResponse([`data: ${successChunk}`, "data: [DONE]"])
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    chainedFetch as unknown as typeof fetch

  try {
    const response = await seedProtocolDatabase().then(() =>
      createChatCompletions(
        {
          model: "gpt-test",
          stream: true,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe" },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${"a".repeat(4096)}`,
                  },
                },
              ],
            },
          ],
        },
        { compaction: true },
      ),
    )
    for await (const _event of response as AsyncIterable<unknown>) {
      // Drain the stream so the overload retry executes.
    }
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalMock
  }

  expect(requestBodies).toHaveLength(3)
  expect(requestBodies[0]).toContain("data:image/png;base64")
  expect(requestBodies[1]).not.toContain("data:image/png;base64")
  expect(requestBodies[2]).toBe(requestBodies[1] ?? "")
})

test("defaults stream_options.include_usage for direct streaming chat completions", async () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }

  queuedResponses.push(createSSEStreamResponse(["data: [DONE]"]))

  await seedProtocolDatabase().then(() => createChatCompletions(payload))

  const lastCall = fetchMock.mock.calls.at(-1)?.[1] as unknown as {
    body: string
  }
  const sentBody = JSON.parse(lastCall.body) as ChatCompletionsPayload

  expect(sentBody.stream_options).toEqual({ include_usage: true })
})

test("rewrites final assistant messages for models without assistant prefill", async () => {
  setModelSettingsForTest([
    {
      model: "claude-no-prefill",
      supportsAssistantPrefill: false,
    },
  ])

  const payload: ChatCompletionsPayload = {
    model: "claude-no-prefill",
    stream: true,
    messages: [
      { role: "user", content: "Help me investigate an error." },
      {
        role: "assistant",
        content: "I have enough context to continue.",
        reasoning_text: "Private assistant reasoning",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{}",
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
      { role: "assistant", content: "I have enough context to continue." },
    ],
  }

  queuedResponses.push(createSSEStreamResponse(["data: [DONE]"]))

  await seedProtocolDatabase().then(() => createChatCompletions(payload))

  const lastCall = fetchMock.mock.calls.at(-1)?.[1] as unknown as {
    body: string
  }
  const sentBody = JSON.parse(lastCall.body) as ChatCompletionsPayload

  expect(sentBody.messages).toHaveLength(4)
  expect(sentBody.messages[0]).toEqual({
    role: "user",
    content: "Help me investigate an error.",
  })
  expect(sentBody.messages[1]).toMatchObject({
    role: "assistant",
    tool_calls: [{ id: "call_1" }],
  })
  expect(sentBody.messages[2]).toMatchObject({
    role: "tool",
    tool_call_id: "call_1",
    content: "done",
  })
  expect(sentBody.messages[3]).toEqual({
    role: "user",
    content: "I have enough context to continue.",
  })
})

test("rewrites final assistant messages for built-in no-prefill models", async () => {
  const payload: ChatCompletionsPayload = {
    model: "claude-opus-4.8",
    stream: true,
    messages: [
      { role: "user", content: "Help me investigate an error." },
      {
        role: "assistant",
        content: "I have enough context to continue.",
      },
    ],
  }

  queuedResponses.push(createSSEStreamResponse(["data: [DONE]"]))

  await seedProtocolDatabase().then(() => createChatCompletions(payload))

  const lastCall = fetchMock.mock.calls.at(-1)?.[1] as unknown as {
    body: string
  }
  const sentBody = JSON.parse(lastCall.body) as ChatCompletionsPayload

  expect(sentBody.messages).toEqual([
    { role: "user", content: "Help me investigate an error." },
    { role: "user", content: "I have enough context to continue." },
  ])
})

test("preserves final assistant messages when assistant prefill is unset", async () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    messages: [
      { role: "user", content: "Help me investigate an error." },
      { role: "assistant", content: "I have enough context to continue." },
    ],
  }

  await seedProtocolDatabase().then(() => createChatCompletions(payload))

  const lastCall = fetchMock.mock.calls.at(-1)?.[1] as unknown as {
    body: string
  }
  const sentBody = JSON.parse(lastCall.body) as ChatCompletionsPayload

  expect(sentBody.messages[0]).toEqual({
    role: "user",
    content: "Help me investigate an error.",
  })
  expect(sentBody.messages[1]?.role).toBe("assistant")
  expect(sentBody.messages[1]?.content).toBe(
    "I have enough context to continue.",
  )
})

test("preserves upstream chat 404 status, headers, and exact route bytes", async () => {
  const body = new TextEncoder().encode("model not found\r\n  ")
  const createUpstream = () =>
    new Response(body.slice(), {
      status: 404,
      headers: { "content-type": "text/plain" },
    })
  const upstream = createUpstream()
  queuedResponses.push(upstream)

  const error = await seedProtocolDatabase()
    .then(() =>
      createChatCompletions({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    )
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  const upstreamError = (error as HTTPError).response
  expect(upstreamError.status).toBe(404)
  expect(upstreamError.headers.get("content-type")).toBe("text/plain")
  expect(Array.from(new Uint8Array(await upstreamError.arrayBuffer()))).toEqual(
    Array.from(body),
  )

  state.models = {
    object: "list",
    data: [createLegacyMessagesModel("gpt-test")],
  }
  queuedResponses.push(createUpstream())
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )

  expect(response.status).toBe(404)
  expect(response.headers.get("content-type")).toBe("text/plain")
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
    Array.from(body),
  )
})

test("keeps malformed successful Chat JSON local and bodyless", async () => {
  const privateMarker = "chat-invalid-json-private-marker"
  const upstream = new Response(privateMarker, {
    status: 200,
    headers: { "content-type": "application/json" },
  })
  queuedResponses.push(upstream)
  const errorSpy = spyOn(consola, "error")

  try {
    let thrown: unknown
    try {
      await seedProtocolDatabase().then(() =>
        createChatCompletions({
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
        }),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HTTPError)
    expect((thrown as HTTPError).response.status).toBe(502)
    expect(
      new Uint8Array(await (thrown as HTTPError).response.arrayBuffer()),
    ).toEqual(new Uint8Array())
    expect(upstream.bodyUsed).toBe(true)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateMarker)
  } finally {
    errorSpy.mockRestore()
  }
})

test("does not log upstream ChatCompletions status text", async () => {
  const privateMarker = "chat-private-status-marker"
  queuedResponses.push(
    Response.json(
      { error: { code: "invalid_request_body", message: "invalid" } },
      { status: 400, statusText: privateMarker },
    ),
  )
  const errorSpy = spyOn(consola, "error")

  try {
    let thrown: unknown
    try {
      await seedProtocolDatabase().then(() =>
        createChatCompletions({
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
        }),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toHaveProperty("response.status", 400)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateMarker)
  } finally {
    errorSpy.mockRestore()
  }
})
