/* eslint-disable max-lines -- request logging security cases share one server fixture */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

import { HTTPError } from "../src/lib/error"
import {
  formatHandlerLogLine,
  sanitizeHandlerLogArguments,
} from "../src/lib/logger"
import {
  sanitizeRequestBodyForLog,
  startLogicalRequestLog,
} from "../src/lib/request-logger"
import { createRoutingTelemetryRequestState } from "../src/lib/request-session"
import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
let lastHeaders: Record<string, string> | undefined
let lastRoutingAffinity: RoutingAffinity | undefined
let upstreamResponseHeaders: Record<string, string>
let queuedResponses: Array<Response>

function createChatCompletionResponse(
  status = 200,
  headers: Record<string, string> = upstreamResponseHeaders,
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }),
    {
      status,
      headers,
    },
  )
}

const fetchMock = mock((_url: string, init?: RequestInit) => {
  lastHeaders = init?.headers as Record<string, string> | undefined
  lastRoutingAffinity = getRoutingAffinity()

  return queuedResponses.shift() ?? createChatCompletionResponse()
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
  lastHeaders = undefined
  lastRoutingAffinity = undefined
  upstreamResponseHeaders = { "content-type": "application/json" }
  queuedResponses = []
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        object: "model",
        version: "test",
        vendor: "openai",
        model_picker_enabled: true,
        supported_endpoints: ["/chat/completions"],
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
  resetRoutingTelemetryForTest()
})

test("reuses an inbound request ID for both upstream and client responses", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "x-request-id": "req-from-client",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastHeaders?.["X-Request-Id"]).toBe("req-from-client")
  expect(response.headers.get("x-request-id")).toBe("req-from-client")
})

test("generates a request ID when the client does not supply one", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    }),
  )

  const generatedRequestId = response.headers.get("x-request-id")

  expect(response.status).toBe(200)
  expect(generatedRequestId).toBeTruthy()
  if (!generatedRequestId) {
    throw new TypeError("Expected x-request-id header to be present")
  }
  expect(lastHeaders?.["X-Request-Id"]).toBe(generatedRequestId)
})

test("exposes Copilot client session affinity in the provider path", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "x-client-session-id": "copilot-conversation",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastRoutingAffinity).toEqual({
    key: "copilot-conversation",
    source: "copilot_session",
  })
})

test("redacts routing affinity headers from debug request logs", async () => {
  const rawAffinityIds = [
    "claude-affinity-private",
    "copilot-affinity-private",
    "codex-affinity-private",
    "thread-affinity-private",
  ]
  const consoleLog = spyOn(console, "log").mockImplementation(() => undefined)
  state.debug = true
  try {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
          "x-claude-code-session-id": rawAffinityIds[0] ?? "",
          "x-client-session-id": rawAffinityIds[1] ?? "",
          "session-id": rawAffinityIds[2] ?? "",
          "thread-id": rawAffinityIds[3] ?? "",
          "x-harmless-debug-header": "harmless-visible-value",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 32,
        }),
      }),
    )

    expect(response.status).toBe(200)
    const output = consoleLog.mock.calls.flat().join("\n")
    for (const rawAffinityId of rawAffinityIds) {
      expect(output).not.toContain(rawAffinityId)
    }
    expect(output).toContain("[REDACTED]")
    expect(output).toContain("x-harmless-debug-header")
    expect(output).toContain("harmless-visible-value")
  } finally {
    state.debug = false
    consoleLog.mockRestore()
  }
})

test("redacts routing affinity metadata from debug request bodies", async () => {
  const rawIds = [
    "client-session-private",
    "client-thread-private",
    "string-session-private",
    "claude-session-private",
    "root-session-private",
    "root-thread-private",
    "malformed-private",
  ]
  const consoleLog = spyOn(console, "log").mockImplementation(() => undefined)
  state.debug = true
  try {
    await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 32,
          harmless_root: "keep-root",
          session_id: rawIds[4],
          thread_id: rawIds[5],
          client_metadata: {
            session_id: rawIds[0],
            thread_id: rawIds[1],
            device_id: "keep-device",
          },
          metadata: {
            user_id: JSON.stringify({
              session_id: rawIds[3],
              account_uuid: "keep-account",
            }),
          },
          unrelated_tool_arguments: {
            session_id: "keep-unrelated-session",
            thread_id: "keep-unrelated-thread",
          },
        }),
      }),
    )
    await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 32,
          client_metadata: JSON.stringify({
            session_id: rawIds[2],
            device_id: "keep-string-device",
          }),
        }),
      }),
    )
    await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 32,
          client_metadata: `{"session_id":"${rawIds[6]}`,
        }),
      }),
    )
    await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 32,
          metadata: JSON.stringify({
            harmless_metadata: "keep-outer-metadata",
            user_id: JSON.stringify({
              session_id: "outer-metadata-session-private",
              account_uuid: "keep-outer-account",
            }),
          }),
        }),
      }),
    )
    await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 32,
          metadata: `{"user_id":"outer-malformed-private`,
        }),
      }),
    )

    const output = consoleLog.mock.calls.flat().join("\n")
    for (const rawId of rawIds) expect(output).not.toContain(rawId)
    expect(output).not.toContain("outer-metadata-session-private")
    expect(output).not.toContain("outer-malformed-private")
    for (const harmless of [
      "keep-root",
      "keep-device",
      "keep-account",
      "keep-string-device",
      "keep-unrelated-session",
      "keep-unrelated-thread",
      "keep-outer-metadata",
      "keep-outer-account",
    ]) {
      expect(output).toContain(harmless)
    }
    expect(output).toContain("[REDACTED]")
  } finally {
    state.debug = false
    consoleLog.mockRestore()
  }
})

test("sanitizes handler payload objects before verbose file logging", () => {
  const rawIds = [
    "handler-claude-session",
    "handler-response-session",
    "handler-response-thread",
    "handler-string-session",
    "handler-malformed-session",
  ]
  const sanitized = [
    sanitizeRequestBodyForLog({
      harmless: "keep-handler-field",
      metadata: {
        user_id: JSON.stringify({
          account_uuid: "keep-handler-account",
          session_id: rawIds[0],
        }),
      },
      client_metadata: {
        session_id: rawIds[1],
        thread_id: rawIds[2],
        device_id: "keep-handler-device",
      },
    }),
    sanitizeRequestBodyForLog({
      client_metadata: JSON.stringify({
        session_id: rawIds[3],
        device_id: "keep-string-handler-device",
      }),
    }),
    sanitizeRequestBodyForLog({
      client_metadata: `{"session_id":"${rawIds[4]}`,
    }),
  ]
  const output = JSON.stringify(sanitized)

  for (const rawId of rawIds) expect(output).not.toContain(rawId)
  for (const harmless of [
    "keep-handler-field",
    "keep-handler-account",
    "keep-handler-device",
    "keep-string-handler-device",
  ]) {
    expect(output).toContain(harmless)
  }
})

test("omits private nested payload data from ordinary diagnostics", () => {
  const privateMarkers = [
    "prompt-private-marker",
    "encrypted-private-marker",
    "cache-private-marker",
    "safety-private-marker",
    "tool-private-marker",
    "url-private-marker",
    "media-private-marker",
  ]
  const sanitized = sanitizeRequestBodyForLog({
    model: "gpt-current",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: privateMarkers[0] },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${privateMarkers[6]}`,
          },
        ],
      },
      {
        type: "reasoning",
        encrypted_content: privateMarkers[1],
      },
    ],
    prompt_cache_key: privateMarkers[2],
    safety_identifier: privateMarkers[3],
    tools: [
      {
        type: "function",
        name: privateMarkers[4],
        server_url: `https://example.invalid/${privateMarkers[5]}`,
      },
    ],
  })

  const output = JSON.stringify(sanitized)
  for (const marker of privateMarkers) expect(output).not.toContain(marker)
  expect(sanitized).toMatchObject({
    model: "gpt-current",
    input: "[2 items omitted]",
    tools: "[1 items omitted]",
  })
})

test("sanitizes non-leading ordinary handler log arguments", () => {
  const privateMarkers = [
    "handler-model-private",
    "handler-status-private",
    "handler-array-private",
    "handler-error-private",
  ]
  const sanitized = sanitizeHandlerLogArguments([
    "Prepared request",
    {
      model: privateMarkers[0],
      status: privateMarkers[1],
      nested: [privateMarkers[2]],
      error: new Error(privateMarkers[3]),
      stream: true,
    },
  ])
  const output = JSON.stringify(sanitized)

  for (const marker of privateMarkers) expect(output).not.toContain(marker)
  expect(sanitized).toEqual([
    "Prepared request",
    {
      model: "[REDACTED]",
      status: "[REDACTED]",
      nested: "[1 items omitted]",
      error: { name: "Error" },
      stream: true,
    },
  ])
})

test("truncates dynamic text from ordinary handler log messages", () => {
  const privateMarker = "handler-inline-private-marker"

  expect(
    sanitizeHandlerLogArguments([
      `Compact request for model: ${privateMarker}`,
    ]),
  ).toEqual(["Compact request for model"])
  expect(
    sanitizeHandlerLogArguments([
      `Routing custom model ${privateMarker} to private/provider`,
    ]),
  ).toEqual(["Routing custom model"])
  expect(sanitizeHandlerLogArguments(["Detected Subagent marker"])).toEqual([
    "Detected Subagent marker",
  ])
})

test("defensively sanitizes hostile and free-form handler log data", () => {
  const privateMarkers = [
    "throwing-getter-private-marker",
    "proxy-private-marker",
    "plain-secret-sentence-private-marker",
    "array-private-marker",
    "error-private-marker",
    "unsafe-field-private-marker",
  ]
  let getterCalls = 0
  const throwingGetter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error(privateMarkers[0])
    },
  })
  let proxyTrapCalls = 0
  const hostileProxy = new Proxy(
    {},
    {
      ownKeys() {
        proxyTrapCalls += 1
        throw new Error(privateMarkers[1])
      },
    },
  )

  const sanitized = sanitizeHandlerLogArguments([
    `This is an ordinary long secret sentence containing ${privateMarkers[2]} and should never survive`,
    {
      attempt: 2,
      stream: true,
      status: "completed",
      outcome: "retrying",
      target: "/responses",
      unsafe: privateMarkers[5],
      nested: [privateMarkers[3]],
      error: new Error(privateMarkers[4]),
      throwingGetter,
      hostileProxy,
    },
  ])

  expect(getterCalls).toBe(0)
  expect(proxyTrapCalls).toBe(0)
  const output = JSON.stringify(sanitized)
  for (const marker of privateMarkers) expect(output).not.toContain(marker)
  expect(sanitized).toEqual([
    "Log",
    {
      attempt: 2,
      stream: true,
      status: "completed",
      outcome: "retrying",
      target: "/responses",
      unsafe: "[REDACTED]",
      nested: "[1 items omitted]",
      error: { name: "Error" },
      throwingGetter: { secret: "[OBJECT OMITTED]" },
      hostileProxy: "[OBJECT OMITTED]",
    },
  ])
})

test("reduces hostile array and revoked proxies before reflection", () => {
  const privateMarker = "hostile-array-proxy-private-marker"
  let descriptorCalls = 0
  const hostileArrayProxy = new Proxy([privateMarker], {
    getOwnPropertyDescriptor() {
      descriptorCalls += 1
      throw new Error(privateMarker)
    },
  })
  const { proxy: revokedProxy, revoke } = Proxy.revocable({}, {})
  revoke()

  expect(
    sanitizeHandlerLogArguments([
      "Prepared request",
      hostileArrayProxy,
      revokedProxy,
    ]),
  ).toEqual(["Prepared request", "[OBJECT OMITTED]", "[OBJECT OMITTED]"])
  expect(descriptorCalls).toBe(0)
})

test("allowlists fixed Error classes and redacts custom names", () => {
  const custom = new Error("custom-error-private-marker")
  custom.name = "CustomPrivateError"
  const abortError = new Error("abort-error-private-marker")
  abortError.name = "AbortError"

  expect(
    sanitizeHandlerLogArguments([
      "Prepared request",
      new Error("plain-error-private-marker"),
      abortError,
      custom,
      { enabled: true, attempt: 3, status: "completed" },
    ]),
  ).toEqual([
    "Prepared request",
    { name: "Error" },
    { name: "AbortError" },
    { name: "Error" },
    { enabled: true, attempt: 3, status: "completed" },
  ])
})

test("uses inherited Error names without instanceof checks", () => {
  expect(
    sanitizeHandlerLogArguments([
      "Prepared request",
      new TypeError("typed-error-private-marker"),
    ]),
  ).toEqual(["Prepared request", { name: "TypeError" }])
})

test("omits objects whose prototype chain crosses a proxy", () => {
  const privateMarker = "prototype-proxy-private-marker"
  let prototypeTrapCalls = 0
  const hostilePrototype = new Proxy(
    {},
    {
      getPrototypeOf() {
        prototypeTrapCalls += 1
        throw new Error(privateMarker)
      },
    },
  )
  const value = Object.create(hostilePrototype) as Record<string, unknown>
  Object.defineProperty(value, "status", {
    enumerable: true,
    value: "completed",
  })

  expect(sanitizeHandlerLogArguments(["Prepared request", value])).toEqual([
    "Prepared request",
    "[OBJECT OMITTED]",
  ])
  expect(prototypeTrapCalls).toBe(0)
})

test("omits nested revoked prototype chains without throwing", () => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  const value = { nested: Object.create(proxy) as object }
  revoke()

  expect(sanitizeHandlerLogArguments(["Prepared request", value])).toEqual([
    "Prepared request",
    { nested: "[OBJECT OMITTED]" },
  ])
})

test("formats ordinary handler file lines without private payload values", () => {
  const privateMarkers = [
    "handler-prompt-private",
    "handler-model-private",
    "handler-marker-private",
  ]
  const output = formatHandlerLogLine({
    date: new Date(0),
    name: "messages-handler",
    tag: "messages-handler",
    type: "debug",
    args: [
      "Received Anthropic request",
      {
        model: privateMarkers[1],
        messages: [{ content: privateMarkers[0] }],
        marker: privateMarkers[2],
        stream: true,
      },
    ],
  })

  for (const marker of privateMarkers) expect(output).not.toContain(marker)
  expect(output).toContain("Received Anthropic request")
  expect(output).toContain("stream: true")
})

test("forwards upstream quota snapshot headers to the client response", async () => {
  upstreamResponseHeaders = {
    "content-type": "application/json",
    "x-quota-snapshot-chat": "remaining=42;limit=100",
  }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("x-quota-snapshot-chat")).toBe(
    "remaining=42;limit=100",
  )
})

test("does not forward stale quota headers from a failed upstream retry attempt", async () => {
  queuedResponses.push(
    createChatCompletionResponse(503, {
      "content-type": "application/json",
      "retry-after": "0",
      "x-quota-snapshot-chat": "remaining=1;limit=100",
    }),
    createChatCompletionResponse(200, {
      "content-type": "application/json",
    }),
  )

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("x-quota-snapshot-chat")).toBeNull()
})

test("publishes safe metadata from only the final returned attempt", async () => {
  queuedResponses.push(
    new Response("retry", {
      status: 503,
      headers: {
        "retry-after": "0",
        "x-copilot-service-request-id": "failed-attempt",
      },
    }),
    createChatCompletionResponse(200, {
      "x-copilot-service-request-id": "successful-attempt",
      "x-copilot-api-exp-assignment-context": "flight:1;",
      "x-request-id": "upstream-request-id",
    }),
  )

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "x-request-id": "gateway-request-id",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    }),
  )

  expect(response.headers.get("x-copilot-service-request-id")).toBe(
    "successful-attempt",
  )
  expect(response.headers.get("x-copilot-api-exp-assignment-context")).toBe(
    "flight:1;",
  )
  expect(response.headers.get("x-request-id")).toBe("gateway-request-id")
})

test("publishes safe metadata from a terminal upstream error", async () => {
  queuedResponses.push(
    Response.json(
      { error: { message: "invalid request" } },
      {
        status: 400,
        headers: {
          "retry-after": "15",
          "x-copilot-service-request-id": "terminal-error",
        },
      },
    ),
  )

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    }),
  )

  expect(response.status).toBe(400)
  expect(response.headers.get("retry-after")).toBe("15")
  expect(response.headers.get("x-copilot-service-request-id")).toBe(
    "terminal-error",
  )
})

test("records one routed client request after HTTP model handling", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 32,
        messages: [{ role: "user", content: "Hello" }],
        model: "gpt-4o",
      }),
    }),
  )

  expect(response.status).toBe(200)
  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(1)
  expect(snapshot.models[0]).toMatchObject({
    model: "gpt-4o",
    requests: 1,
  })
})

test("does not record non-model dashboard traffic", async () => {
  await seedProtocolDatabase().then(() => server.request("/dashboard"))

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(0)
})

test("does not record model requests rejected before upstream dispatch", () => {
  const telemetryState = createRoutingTelemetryRequestState("Chat Completions")
  const lifecycle = startLogicalRequestLog({
    inputLength: 10,
    method: "POST",
    model: "locally-rejected-model",
    path: "/v1/chat/completions",
    telemetryState,
    transport: "HTTP",
    turnId: "http-rejected",
  })
  lifecycle.finalize({ status: 403, terminalStatus: "REJECTED" })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(0)
  expect(snapshot.models).toEqual([])
})

test("records a logical WebSocket turn exactly once", () => {
  const telemetryState = createRoutingTelemetryRequestState(
    "Responses WebSocket",
  )
  const lifecycle = startLogicalRequestLog({
    inputLength: 10,
    method: "POST",
    model: "gpt-test",
    path: "/responses",
    telemetryState,
    transport: "Responses WebSocket",
    turnId: "turn-1",
  })
  Object.assign(telemetryState, {
    dispatched: true,
    lastDestination: "Responses",
    lastModel: "gpt-test",
    lastProvider: "GitHub Copilot",
  })

  expect(lifecycle.finalize({ status: 200, terminalStatus: "COMPLETE" })).toBe(
    true,
  )
  expect(lifecycle.finalize({ status: 500, terminalStatus: "ERROR" })).toBe(
    false,
  )

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(1)
  expect(snapshot.models[0]).toMatchObject({
    model: "gpt-test",
    requests: 1,
  })
})

test("does not record a logical turn that never reached a provider", () => {
  const telemetryState = createRoutingTelemetryRequestState(
    "Responses WebSocket",
  )
  const lifecycle = startLogicalRequestLog({
    inputLength: 10,
    method: "POST",
    model: "locally-rejected-model",
    path: "/responses",
    telemetryState,
    transport: "Responses WebSocket",
    turnId: "turn-rejected",
  })

  lifecycle.finalize({ status: 400, terminalStatus: "REJECTED" })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(0)
})

test("uses the guarded HTTP snapshot for logical request reporting", () => {
  const privateMarkers = [
    "logical-http-message-private-marker",
    "logical-http-status-private-marker",
  ]
  let getterCalls = 0
  const upstream = Response.json({}, { status: 429 })
  Object.defineProperty(upstream, "status", {
    configurable: true,
    get() {
      getterCalls += 1
      throw new Error(privateMarkers[1])
    },
  })
  const error = new HTTPError("Failed to create responses", upstream)
  Object.defineProperty(error, "message", {
    configurable: true,
    get() {
      getterCalls += 1
      throw new Error(privateMarkers[0])
    },
  })
  const infoSpy = spyOn(console, "info")
  const lifecycle = startLogicalRequestLog({
    inputLength: 10,
    method: "POST",
    model: "gpt-test",
    path: "/responses",
    transport: "Responses WebSocket",
    turnId: "turn-http-error",
  })

  try {
    lifecycle.finalize({
      error,
      status: 429,
      terminalStatus: "REJECTED",
    })
    const diagnostics = JSON.stringify(infoSpy.mock.calls)

    expect(getterCalls).toBe(0)
    expect(diagnostics).toContain("Failed to create responses")
    for (const marker of privateMarkers) {
      expect(diagnostics).not.toContain(marker)
    }
  } finally {
    infoSpy.mockRestore()
  }
})

test("reports a revoked logical request error without throwing", () => {
  const { proxy, revoke } = Proxy.revocable(
    new HTTPError(
      "Failed to create responses",
      Response.json({}, { status: 429 }),
    ),
    {},
  )
  revoke()
  const infoSpy = spyOn(console, "info")
  const lifecycle = startLogicalRequestLog({
    inputLength: 10,
    method: "POST",
    model: "gpt-test",
    path: "/responses",
    transport: "Responses WebSocket",
    turnId: "turn-revoked-error",
  })

  try {
    expect(
      lifecycle.finalize({
        error: proxy,
        status: 500,
        terminalStatus: "ERROR",
      }),
    ).toBe(true)
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(
      "Failed to create responses",
    )
  } finally {
    infoSpy.mockRestore()
  }
})

test("uses a provided HTTP inspection for logical status and message", () => {
  const upstream = Response.json({}, { status: 429 })
  const error = new HTTPError("Failed to create responses", upstream)
  Object.defineProperty(upstream, "status", {
    configurable: true,
    get() {
      throw new Error("provided-inspection-status-private-marker")
    },
  })
  Object.defineProperty(error, "message", {
    configurable: true,
    get() {
      throw new Error("provided-inspection-message-private-marker")
    },
  })
  const infoSpy = spyOn(console, "info")
  const lifecycle = startLogicalRequestLog({
    inputLength: 10,
    method: "POST",
    model: "gpt-test",
    path: "/responses",
    transport: "Responses WebSocket",
    turnId: "turn-provided-inspection",
  })

  try {
    lifecycle.finalize({
      error,
      errorInspection: {
        kind: "local",
        localError: {
          code: "invalid_value",
          message: "The model field must be a non-empty string.",
          param: "model",
          type: "invalid_request_error",
        },
        responseHeaders: {},
        safeMessage: "The model field must be a non-empty string.",
        status: 429,
      },
      status: 500,
      terminalStatus: "ERROR",
    })
    const diagnostics = JSON.stringify(infoSpy.mock.calls)

    expect(diagnostics).toContain("REJECTED")
    expect(diagnostics).toContain("429")
    expect(diagnostics).toContain("The model field must be a non-empty string.")
    expect(diagnostics).not.toContain("Upstream request failed")
    expect(diagnostics).not.toContain(
      "provided-inspection-status-private-marker",
    )
    expect(diagnostics).not.toContain(
      "provided-inspection-message-private-marker",
    )
  } finally {
    infoSpy.mockRestore()
  }
})
