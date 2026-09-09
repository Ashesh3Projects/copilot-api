import * as Sentry from "@sentry/bun"
/* eslint-disable max-lines -- Google route variants share one upstream transport harness */
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

import type { ResponsesPayload } from "../src/services/copilot/create-responses"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { getGoogleRoutingContractRows } from "../src/lib/compatibility-contract"
import { HTTPError } from "../src/lib/error"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { isIpBlocked, resetIpSecurityForTest } from "../src/lib/ip-blocker"
import {
  clearLlmDebugLogs,
  getLlmDebugLog,
  listLlmDebugLogs,
} from "../src/lib/llm-debug-log"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { getUsageResponse, resetUsageForTest } from "../src/lib/usage-tracker"
import { selectGoogleUpstreamEndpoint } from "../src/routes/google-ai/handler"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

const originalFetch = globalThis.fetch
const originalGatewayKey = state.apiKeyAuth

let lastResponsesPayload: ResponsesPayload | undefined
let lastHeaders: Record<string, string> | undefined
let lastPath: string | undefined
let lastBody: Record<string, unknown> | undefined
let chatStreamBody: string | undefined
let responsesStreamBody: string | undefined
let chatStreamResponse: Response | undefined
let responsesStreamResponse: Response | undefined
let messagesStreamBody: string | undefined
let messagesStreamResponse: Response | undefined

function parseRequestBody(init?: RequestInit): ResponsesPayload {
  if (typeof init?.body !== "string") {
    return {} as ResponsesPayload
  }

  return JSON.parse(init.body) as ResponsesPayload
}

function hasEphemeralCacheControl(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "ephemeral"
  )
}

function createLateChatHttpErrorResponse(upstream: Response): Response {
  const encoder = new TextEncoder()
  let emitted = false
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!emitted) {
          emitted = true
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: "chat-late-error",
                object: "chat.completion.chunk",
                created: 1,
                model: "chat-http-error-model",
                choices: [
                  {
                    index: 0,
                    delta: { content: "partial" },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              })}\n\n`,
            ),
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.error(new HTTPError("Late upstream failure", upstream))
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function createLateSseHttpErrorResponse(
  event: string,
  data: Record<string, unknown>,
  upstream: Response,
): Response {
  const encoder = new TextEncoder()
  let emitted = false
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!emitted) {
          emitted = true
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.error(new HTTPError("Late upstream failure", upstream))
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

const responsesResult = {
  id: "resp_1",
  object: "response" as const,
  created_at: 1,
  model: "gpt-4o-mini",
  output: [
    {
      id: "msg_1",
      type: "message" as const,
      role: "assistant" as const,
      status: "completed" as const,
      content: [{ type: "output_text" as const, text: "hello" }],
    },
  ],
  output_text: "hello",
  status: "completed",
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
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

const responsesCapableModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-4o-mini",
      name: "gpt-4o-mini",
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

const fetchMock = mock((url: string, init?: RequestInit) => {
  lastPath = new URL(url).pathname
  lastResponsesPayload = parseRequestBody(init)
  lastBody = lastResponsesPayload as unknown as Record<string, unknown>
  lastHeaders = init?.headers as Record<string, string> | undefined

  if (lastPath === "/v1/messages") {
    if ((lastBody as { stream?: unknown } | undefined)?.stream === true) {
      if (messagesStreamResponse) return messagesStreamResponse
      return new Response(
        messagesStreamBody
          ?? [
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: "message-placeholder",
                type: "message",
                role: "assistant",
                content: [],
                model: "route-model",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            })}`,
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            })}`,
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "hello" },
            })}`,
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: 0,
            })}`,
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            })}`,
            'event: message_stop\ndata: {"type":"message_stop"}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return Response.json({
      id: "message-placeholder",
      type: "message",
      role: "assistant",
      model: "route-model",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
  if (lastPath === "/chat/completions") {
    if ((lastBody as { stream?: unknown } | undefined)?.stream === true) {
      if (chatStreamResponse) return chatStreamResponse
      return new Response(
        chatStreamBody
          ?? [
            `data: ${JSON.stringify({
              id: "chat-stream",
              object: "chat.completion.chunk",
              created: 1,
              model: "route-model",
              choices: [
                {
                  index: 0,
                  delta: { content: "hello" },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            })}`,
            `data: ${JSON.stringify({
              id: "chat-stream",
              object: "chat.completion.chunk",
              created: 1,
              model: "route-model",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                  logprobs: null,
                },
              ],
            })}`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return Response.json({
      id: "chat-placeholder",
      object: "chat.completion",
      created: 1,
      model: "route-model",
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
    })
  }
  if ((lastBody as { stream?: unknown } | undefined)?.stream === true) {
    if (responsesStreamResponse) return responsesStreamResponse
    return new Response(
      responsesStreamBody
        ?? [
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            sequence_number: 1,
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "hello",
          })}`,
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            sequence_number: 2,
            response: responsesResult,
          })}`,
          "",
        ].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  return new Response(JSON.stringify(responsesResult), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
})

useProtocolDatabase()

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.apiKeyAuth = originalGatewayKey
  resetIpSecurityForTest()
})

beforeEach(() => {
  resetRoutingTelemetryForTest()
  setIpAllowlistForTest([])
  fetchMock.mockClear()
  lastResponsesPayload = undefined
  lastHeaders = undefined
  lastPath = undefined
  lastBody = undefined
  chatStreamBody = undefined
  responsesStreamBody = undefined
  chatStreamResponse = undefined
  responsesStreamResponse = undefined
  messagesStreamBody = undefined
  messagesStreamResponse = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.debug = false
  state.verbose = false
  state.apiKeyAuth = originalGatewayKey
  state.models = responsesCapableModels
  resetIpSecurityForTest()
  setModelRedirectsForTest([])
})

test.each(["/v1beta/models", "/v1/models", "/models"] as const)(
  "authenticates Google generation with a query credential on %s",
  async (prefix) => {
    state.apiKeyAuth = "google-gateway-key"
    const response = await protocolRequest(
      `${prefix}/gpt-4o-mini:generateContent?key=google-gateway-key`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-copilot-peer-ip": "198.51.100.201",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(lastPath).toBe("/responses")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  },
)

test("applies redirect verbosity to Google generation routed through Responses", async () => {
  setModelRedirectsForTest([
    {
      id: "google-to-responses-verbosity",
      sourceModel: "gpt-4o-mini",
      sourceEffort: "all",
      targetModel: "gpt-4o-mini",
      targetVerbosity: "medium",
      enabled: true,
    },
  ])

  const response = await protocolRequest(
    "/v1beta/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Explain this." }] }],
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastPath).toBe("/responses")
  expect(lastResponsesPayload?.text).toEqual({ verbosity: "medium" })
})

test("accepts equal Google credentials and rejects ambiguous credentials before dispatch", async () => {
  state.apiKeyAuth = "google-gateway-key"
  const path = "/v1/models/gpt-4o-mini:generateContent?key=google-gateway-key"
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  })
  const equal = await protocolRequest(path, {
    method: "POST",
    headers: {
      authorization: "Bearer google-gateway-key",
      "content-type": "application/json",
      "x-api-key": "google-gateway-key",
      "x-copilot-peer-ip": "198.51.100.202",
      "x-goog-api-key": "google-gateway-key",
    },
    body,
  })
  expect(equal.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  fetchMock.mockClear()
  const ambiguous = await protocolRequest(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-copilot-peer-ip": "198.51.100.203",
      "x-goog-api-key": "different-key",
    },
    body,
  })
  expect(ambiguous.status).toBe(401)
  expect(await ambiguous.json()).toEqual({
    error: { message: "Unauthorized", type: "authentication_error" },
  })
  expect(ambiguous.headers.get("cache-control")).toBe("no-store")
  expect(ambiguous.headers.get("www-authenticate")).toBe(
    'Bearer realm="copilot-api"',
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

test("treats invalid Google query credentials as supplied attempts without leaking them", async () => {
  state.apiKeyAuth = "google-gateway-key"
  const clientIp = "198.51.100.204"
  const privateKey = "private-google-query-key"
  const consoleWarn = spyOn(consola, "warn")
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await protocolRequest(
        `/v1/models/gpt-4o-mini:generateContent?key=${privateKey}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-copilot-peer-ip": clientIp,
          },
          body: "{}",
        },
      )
      expect(response.status).toBe(401)
    }
    const diagnostics = JSON.stringify(consoleWarn.mock.calls)
    expect(isIpBlocked(clientIp)).toBe(true)
    expect(diagnostics).toContain("/v1/models/:modelAction")
    expect(diagnostics).not.toContain(privateKey)
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    consoleWarn.mockRestore()
  }
})

test("does not use query credentials outside exact Google actions", async () => {
  state.apiKeyAuth = "google-gateway-key"
  for (const pathname of [
    "/v1/responses?key=google-gateway-key",
    "/v1/models/gpt-4o-mini:futureAction?key=google-gateway-key",
  ]) {
    const response = await protocolRequest(pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-copilot-peer-ip": `198.51.100.${pathname.includes("responses") ? 205 : 206}`,
      },
      body: "{}",
    })
    expect(response.status).toBe(401)
  }
  expect(fetchMock).not.toHaveBeenCalled()
})

test("authenticates countTokens with a query credential without inference dispatch", async () => {
  state.apiKeyAuth = "google-gateway-key"
  const response = await protocolRequest(
    "/v1beta/models/gpt-4o-mini:countTokens?key=google-gateway-key",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-copilot-peer-ip": "198.51.100.207",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Count me" }] }],
      }),
    },
  )
  expect(response.status).toBe(200)
  expect(
    typeof ((await response.json()) as { totalTokens?: unknown }).totalTokens,
  ).toBe("number")
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each(["/v1beta/models", "/v1/models", "/models"] as const)(
  "keeps successful Google route model and action out of ordinary diagnostics for %s",
  async (prefix) => {
    const privateModel = "private-supported-model-marker"
    const privateAction = "generateContent"
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = privateModel
    model.name = "Private supported model marker"
    state.models = { object: "list", data: [model] }
    state.debug = true
    state.verbose = true
    const consoleLog = spyOn(console, "log").mockImplementation(() => undefined)
    const consoleInfo = spyOn(console, "info").mockImplementation(
      () => undefined,
    )
    const debugLog = spyOn(consola, "debug")
    const sentryLog = spyOn(Sentry.logger, "info").mockImplementation(
      () => undefined,
    )

    try {
      const response = await protocolRequest(
        `${prefix}/${privateModel}:${privateAction}?key=mounted-query-secret&alt=json`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          }),
        },
      )
      const diagnostics = JSON.stringify([
        consoleLog.mock.calls,
        consoleInfo.mock.calls,
        debugLog.mock.calls,
        sentryLog.mock.calls,
      ])

      expect(response.status).toBe(200)
      expect(lastPath).toBe("/responses")
      expect(diagnostics).toContain(`${prefix}/:modelAction`)
      expect(diagnostics).toContain("alt=json")
      expect(diagnostics).not.toContain(privateModel)
      expect(diagnostics).not.toContain(privateAction)
      expect(diagnostics).not.toContain("mounted-query-secret")
    } finally {
      state.debug = false
      state.verbose = false
      consoleLog.mockRestore()
      consoleInfo.mockRestore()
      debugLog.mockRestore()
      sentryLog.mockRestore()
    }
  },
)

test("keeps a multi-account Google model internal while ordinary routing diagnostics stay structural", async () => {
  const privateModel = "multi-private-google-model"
  const privateAction = "generateContent"
  const accountId = 99_192
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = privateModel
  model.name = "Multi private Google model"
  state.models = { object: "list", data: [model] }
  state.isMultiToken = true
  const account = tokenPool.addAccount(
    "multi-private-google-github-token",
    "individual",
    accountId,
  )
  account.copilotToken = "multi-private-google-copilot-token"
  account.models = new Set([privateModel])
  account.modelsData = [model]
  account.healthy = true
  tokenPool.rebuildModelIndex()
  await clearLlmDebugLogs()
  resetUsageForTest()
  const usageBefore = (await getUsageResponse()).lifetime as {
    total_input_tokens: number
    total_output_tokens: number
    total_requests: number
  }

  const originalConsolaLevel = consola.level
  const capturedConsola: Array<unknown> = []
  const ordinaryReporter = {
    log(logObject: unknown) {
      capturedConsola.push(logObject)
    },
  }
  const sentryReporterInput: Array<unknown> = []
  const sentryReporter = Sentry.createConsolaReporter()
  const sentryReporterLog = spyOn(sentryReporter, "log").mockImplementation(
    (logObject) => {
      sentryReporterInput.push(logObject)
    },
  )
  consola.level = 5
  consola.addReporter(ordinaryReporter)
  consola.addReporter(sentryReporter)

  try {
    const response = await protocolRequest(
      `/v1/models/${privateModel}:${privateAction}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
      },
    )
    const diagnostics = JSON.stringify([capturedConsola, sentryReporterInput])
    const telemetry = getRoutingTelemetrySnapshot({
      accounts: tokenPool.getAllAccounts(),
      multiToken: true,
      window: "15m",
    })

    expect(response.status).toBe(200)
    expect(lastPath).toBe("/responses")
    expect(lastResponsesPayload?.model).toBe(privateModel)
    expect(lastHeaders?.Authorization).toBe(
      "Bearer multi-private-google-copilot-token",
    )
    const debugEntries = (await listLlmDebugLogs()).entries
    const debugDetails = await Promise.all(
      debugEntries.map((entry) => getLlmDebugLog(entry.id)),
    )
    expect(
      debugDetails.some(
        (entry) =>
          entry?.request.path === "/responses"
          && entry.request.body?.includes(privateModel),
      ),
    ).toBe(true)
    expect(telemetry.models.some((entry) => entry.model === privateModel)).toBe(
      true,
    )
    expect(
      telemetry.accounts.find((entry) => entry.accountId === accountId)
        ?.selected,
    ).toBeGreaterThan(0)
    const usageAfter = (await getUsageResponse()).lifetime as {
      total_input_tokens: number
      total_output_tokens: number
      total_requests: number
    }
    expect(usageAfter.total_input_tokens - usageBefore.total_input_tokens).toBe(
      1,
    )
    expect(
      usageAfter.total_output_tokens - usageBefore.total_output_tokens,
    ).toBe(1)
    expect(usageAfter.total_requests - usageBefore.total_requests).toBe(1)
    expect(diagnostics).toContain(`[Account #${accountId}]`)
    expect(diagnostics).toContain("/responses")
    expect(diagnostics).toContain("session: default")
    expect(diagnostics).not.toContain(privateModel)
    expect(diagnostics).not.toContain(privateAction)
  } finally {
    consola.removeReporter(ordinaryReporter)
    consola.removeReporter(sentryReporter)
    sentryReporterLog.mockRestore()
    consola.level = originalConsolaLevel
    tokenPool.removeAccountForTest(accountId)
    state.isMultiToken = false
    await clearLlmDebugLogs()
    resetUsageForTest()
  }
})

test("keeps Google non-default diagnostics free of route-derived models", async () => {
  const sourceModel = "private-google-source-marker"
  const targetModel = "private-google-target-marker"
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = targetModel
  model.name = "Private Google target marker"
  model.vendor = "anthropic"
  model.supported_endpoints = ["/v1/messages"]
  state.models = { object: "list", data: [model] }
  setModelRedirectsForTest([
    {
      id: "private-google-redirect-rule-marker",
      sourceModel,
      sourceEffort: "all",
      targetModel,
      enabled: true,
    },
  ])
  const consoleLog = spyOn(console, "log").mockImplementation(() => undefined)
  const consoleInfo = spyOn(console, "info").mockImplementation(() => undefined)
  const breadcrumb = spyOn(Sentry, "addBreadcrumb").mockImplementation(
    () => undefined,
  )
  const sentryInfo = spyOn(Sentry.logger, "info").mockImplementation(
    () => undefined,
  )

  try {
    const response = await protocolRequest(
      `/v1/models/${sourceModel}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
      },
    )
    const diagnostics = JSON.stringify([
      consoleLog.mock.calls,
      consoleInfo.mock.calls,
      breadcrumb.mock.calls,
      sentryInfo.mock.calls,
    ])

    expect(response.status).toBe(200)
    expect(lastPath).toBe("/v1/messages")
    expect(diagnostics).toContain("model_redirect")
    expect(diagnostics).toContain("endpoint_fallback")
    expect(diagnostics).not.toContain(sourceModel)
    expect(diagnostics).not.toContain(targetModel)
    expect(diagnostics).not.toContain("private-google-redirect-rule-marker")
  } finally {
    consoleLog.mockRestore()
    consoleInfo.mockRestore()
    breadcrumb.mockRestore()
    sentryInfo.mockRestore()
  }
})

test("preserves non-Google diagnostic paths while redacting query credentials", async () => {
  state.debug = true
  const consoleLog = spyOn(console, "log").mockImplementation(() => undefined)
  const sentryInfo = spyOn(Sentry.logger, "info").mockImplementation(
    () => undefined,
  )

  try {
    const response = await protocolRequest(
      "/health?api_key=non-google-query-secret&alt=json",
    )
    const diagnostics = JSON.stringify([
      consoleLog.mock.calls,
      sentryInfo.mock.calls,
    ])

    expect(response.status).toBe(200)
    expect(diagnostics).toContain("/health")
    expect(diagnostics).toContain("alt=json")
    expect(diagnostics).not.toContain("non-google-query-secret")
    expect(diagnostics).not.toContain(":modelAction")
  } finally {
    state.debug = false
    consoleLog.mockRestore()
    sentryInfo.mockRestore()
  }
})

test("adds reasoning defaults on the Google AI responses path", async () => {
  const response = await protocolRequest(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  const reasoning = lastResponsesPayload?.reasoning
  expect(reasoning).toBeTruthy()
  if (!reasoning) {
    throw new Error("Expected reasoning defaults on responses payload")
  }
  expect(reasoning.summary).toBe("auto")
  expect(lastResponsesPayload?.include).toContain("reasoning.encrypted_content")
})

test.each([
  {
    label: "futureAction",
    path: "/v1/models/gpt-4o-mini:futureAction",
    message: "Unsupported Google AI action",
  },
  {
    label: "private unknown suffix",
    path: "/v1/models/gpt-4o-mini:private-action-marker",
    message: "Unsupported Google AI action",
  },
  {
    label: "empty suffix",
    path: "/v1/models/gpt-4o-mini:",
    message: "Missing Google AI action suffix",
  },
  {
    label: "missing suffix",
    path: "/v1/models/gpt-4o-mini",
    message: "Missing Google AI action suffix",
  },
])(
  "rejects unsupported Google action $label without parsing or forwarding",
  async ({ message, path }) => {
    const response = await protocolRequest(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({
      error: {
        code: 400,
        message,
        status: "INVALID_ARGUMENT",
      },
    })
  },
)

test("flushes a pending Chat tool call as the Google EOF terminal", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "chat-tool-eof"
  model.supported_endpoints = ["/chat/completions"]
  state.models = { object: "list", data: [model] }
  chatStreamBody = `data: ${JSON.stringify({
    id: "chat-tool-eof",
    object: "chat.completion.chunk",
    created: 1,
    model: "private-upstream-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_weather",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })}\n\n`

  const response = await requestGoogleStream(model.id)
  expect(await response.json()).toEqual([
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  id: "call_weather",
                  args: { city: "Paris" },
                },
              },
            ],
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
      modelVersion: "chat-tool-eof",
    },
  ])
})

test.each(["/v1beta/models", "/v1/models", "/models"] as const)(
  "does not expose an unknown Google route or inspect its body for %s",
  async (prefix) => {
    const privateModel = "private-model-marker"
    const privateAction = "private-action-marker"
    const privateBody = "private-body-marker"
    const consoleLog = spyOn(console, "log").mockImplementation(() => undefined)
    const debugLog = spyOn(consola, "debug")
    const errorLog = spyOn(consola, "error")
    const sentryLog = spyOn(Sentry.logger, "info")
    const captureException = spyOn(
      Sentry,
      "captureException",
    ).mockImplementation(() => "event-id")
    state.debug = true
    try {
      const request = new Request(
        `http://localhost${prefix}/${privateModel}:${privateAction}/?alt=sse`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + PROTOCOL_GATEWAY_KEY,
          },
          body: privateBody,
        },
      )
      let cloneCalls = 0
      Object.defineProperty(request, "clone", {
        configurable: true,
        value: () => {
          cloneCalls += 1
          throw new Error("debug logger read an unsupported Google body")
        },
      })
      await seedProtocolDatabase()
      const response = await server.fetch(request)

      expect([400, 404]).toContain(response.status)
      expect(await response.text()).not.toContain(privateAction)
      const output = JSON.stringify([
        consoleLog.mock.calls,
        debugLog.mock.calls,
        errorLog.mock.calls,
        sentryLog.mock.calls,
        captureException.mock.calls,
      ])
      expect(output).not.toContain(privateModel)
      expect(output).not.toContain(privateAction)
      expect(output).toContain(`${prefix}/:modelAction`)
      expect(cloneCalls).toBe(0)
      const consoleOutput = JSON.stringify(consoleLog.mock.calls)
      expect(consoleOutput).not.toContain(privateBody)
      expect(consoleOutput).not.toContain("Body:")
      expect(consoleOutput).not.toContain("Body (sanitized):")
    } finally {
      state.debug = false
      consoleLog.mockRestore()
      debugLog.mockRestore()
      errorLog.mockRestore()
      sentryLog.mockRestore()
      captureException.mockRestore()
    }
  },
)

test.each(["/v1beta/models", "/v1/models", "/models"] as const)(
  "does not expose an unauthenticated Google route for %s",
  async (prefix) => {
    const privateModel = "private-unauthenticated-model"
    const privateAction = "private-unauthenticated-action"
    const consoleWarn = spyOn(consola, "warn")
    const captureMessage = spyOn(Sentry, "captureMessage").mockImplementation(
      () => "event-id",
    )
    state.apiKeyAuth = "gateway-key"
    try {
      const response = await protocolRequest(
        `${prefix}/${privateModel}:${privateAction}/?alt=sse`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-copilot-peer-ip": "198.51.100.240",
          },
          body: "private-body-marker",
        },
      )

      expect(response.status).toBe(401)
      const output = JSON.stringify([
        consoleWarn.mock.calls,
        captureMessage.mock.calls,
      ])
      expect(output).not.toContain(privateModel)
      expect(output).not.toContain(privateAction)
      expect(output).toContain(`${prefix}/:modelAction`)
    } finally {
      state.apiKeyAuth = undefined
      consoleWarn.mockRestore()
      captureMessage.mockRestore()
    }
  },
)

test("mounted Google routes match the exported routing contract", async () => {
  const cases = [
    {
      surface: "Ordinary text with Chat advertised",
      endpoints: ["/chat/completions", "/v1/messages", "/responses"],
      vendor: "openai",
    },
    {
      surface:
        "Non-Anthropic, Chat unavailable; Responses and Messages advertised",
      endpoints: ["/v1/messages", "/responses"],
      vendor: "openai",
    },
    {
      surface: "Anthropic, Chat unavailable; Responses and Messages advertised",
      endpoints: ["/v1/messages", "/responses"],
      vendor: "anthropic",
    },
    {
      surface: "Messages-only and lossless",
      endpoints: ["/v1/messages"],
      vendor: "anthropic",
    },
    {
      surface: "Chat-only",
      endpoints: ["/chat/completions"],
      vendor: "openai",
    },
    {
      surface: "Legacy omitted endpoint metadata",
      endpoints: undefined,
      vendor: "openai",
    },
    {
      surface: "No compatible advertised endpoint",
      endpoints: [],
      vendor: "openai",
    },
  ] as const
  const expectedRows = new Map(
    getGoogleRoutingContractRows().map(({ behavior, surface }) => [
      surface,
      behavior,
    ]),
  )

  for (const routingCase of cases) {
    fetchMock.mockClear()
    lastPath = undefined
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = "route-model"
    model.name = "Route Model"
    model.vendor = routingCase.vendor
    model.capabilities.family =
      routingCase.vendor === "anthropic" ? "claude" : "gpt"
    model.supported_endpoints =
      routingCase.endpoints === undefined ?
        undefined
      : [...routingCase.endpoints]
    state.models = { object: "list", data: [model] }

    const response = await protocolRequest(
      "/v1/models/route-model:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          generationConfig: { maxOutputTokens: 32 },
        }),
      },
    )

    const expected = expectedRows.get(routingCase.surface)
    if (expected === "endpoint_translation_unsupported") {
      expect(response.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    } else {
      if (expected === undefined) {
        throw new Error(`Missing routing contract row: ${routingCase.surface}`)
      }
      expect(response.status).toBe(200)
      expect(lastPath as string | undefined).toBe(expected)
    }
  }
})

test.each([
  { suffix: "", contentType: "application/json", sse: false },
  { suffix: "?alt=json", contentType: "application/json", sse: false },
  { suffix: "?alt=sse", contentType: "text/event-stream", sse: true },
  { suffix: "?alt=legacy", contentType: "application/json", sse: false },
])(
  "routes streaming Google text to Messages-only output for $suffix",
  async ({ suffix, contentType, sse }) => {
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = "route-model"
    model.name = "Route Model"
    model.vendor = "anthropic"
    model.supported_endpoints = ["/v1/messages"]
    state.models = { object: "list", data: [model] }

    const response = await protocolRequest(
      `/v1/models/route-model:streamGenerateContent${suffix}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(lastPath).toBe("/v1/messages")
    const body = await response.text()
    expect(response.headers.get("content-type")).toContain(contentType)
    expect(body).toContain("hello")
    const chunks =
      sse ?
        [...body.matchAll(/^data: (.+)$/gm)].map(
          (match) => JSON.parse(match[1]) as Record<string, unknown>,
        )
      : (JSON.parse(body) as Array<Record<string, unknown>>)
    expect(chunks.filter((chunk) => "candidates" in chunk)).toHaveLength(2)
    expect(chunks.at(-1)).toMatchObject({
      candidates: [{ finishReason: "STOP" }],
    })
    if (sse) {
      expect(body).toContain("data:")
    } else {
      expect(body).not.toContain("data:")
      expect(body).not.toContain(": keepalive")
    }
  },
)

test("emits one Google failure after partial Chat output ends without a terminal", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "chat-stream-model"
  model.supported_endpoints = ["/chat/completions"]
  state.models = { object: "list", data: [model] }
  chatStreamBody = `data: ${JSON.stringify({
    id: "chat-partial",
    object: "chat.completion.chunk",
    created: 1,
    model: "chat-stream-model",
    choices: [
      {
        index: 0,
        delta: { content: "partial" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })}\n\ndata: [DONE]\n\n`

  const response = await protocolRequest(
    "/v1/models/chat-stream-model:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    },
  )
  const chunks = (await response.json()) as Array<Record<string, unknown>>

  expect(response.status).toBe(200)
  expect(chunks).toHaveLength(2)
  expect(chunks[0]).toMatchObject({
    candidates: [
      { content: { parts: [{ text: "partial" }] }, finishReason: null },
    ],
  })
  expect(chunks[1]).toEqual({
    error: {
      code: 500,
      message: "Upstream stream ended before a terminal response",
      status: "INTERNAL",
    },
  })
})

test("stops after the first valid Chat terminal and ignores trailing malformed data", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "chat-terminal-model"
  model.supported_endpoints = ["/chat/completions"]
  state.models = { object: "list", data: [model] }
  chatStreamBody = [
    `data: ${JSON.stringify({
      id: "chat-terminal",
      object: "chat.completion.chunk",
      created: 1,
      model: "chat-terminal-model",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    })}`,
    "data: {not-json",
    "",
  ].join("\n\n")

  const response = await protocolRequest(
    "/v1/models/chat-terminal-model:streamGenerateContent?alt=sse",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    },
  )
  const body = await response.text()

  expect(body.match(/"finishReason":"STOP"/g) ?? []).toHaveLength(1)
  expect(body).not.toContain('"error"')
})

test("Google Responses stream preserves call IDs from output items for next-turn results", async () => {
  responsesStreamBody = [
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_lookup",
        call_id: "call_lookup",
        name: "lookup",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 2,
      output_index: 0,
      item_id: "fc_lookup",
      arguments: '{"key":"A"}',
    },
    {
      type: "response.completed",
      sequence_number: 3,
      response: { ...responsesResult, output: [] },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")
  const response = await protocolRequest(
    "/v1beta/models/gpt-4o-mini:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "lookup" }] }],
      }),
    },
  )
  const events = (await response.json()) as Array<{
    candidates: Array<{ content: { parts: Array<unknown> } }>
  }>
  expect(events[0].candidates[0].content.parts).toEqual([
    { functionCall: { id: "call_lookup", name: "lookup", args: { key: "A" } } },
  ])
  const next = await protocolRequest(
    "/v1beta/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "lookup" }] },
          events[0].candidates[0].content,
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_lookup",
                  name: "lookup",
                  response: { answer: 1 },
                },
              },
            ],
          },
        ],
      }),
    },
  )
  expect(next.status).toBe(200)
  expect(lastResponsesPayload?.input).toContainEqual({
    type: "function_call_output",
    call_id: "call_lookup",
    output: '{"answer":1}',
  })
})

test.each(["/chat/completions", "/responses", "/v1/messages"])(
  "Google preserves schemas at the real Copilot %s dispatch",
  async (endpoint) => {
    const model = structuredClone(responsesCapableModels.data[0])
    model.supported_endpoints = [endpoint]
    state.models = { object: "list", data: [model] }
    const schema = {
      $defs: { scalar: { type: "string" } },
      properties: {
        nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
        referenced: { $ref: "#/$defs/scalar" },
      },
      required: ["nullable"],
    }
    const response = await protocolRequest(
      "/v1beta/models/gpt-4o-mini:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Use tool" }] }],
          tools: [
            {
              functionDeclarations: [
                { name: "lookup", parametersJsonSchema: schema },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: schema,
          },
        }),
      },
    )
    expect(response.status).toBe(200)
    expect(lastPath).toBe(endpoint)
    const tools = lastBody?.tools as Array<{
      function?: { parameters?: unknown }
      input_schema?: unknown
      parameters?: unknown
    }>
    expect(
      tools[0].function?.parameters
        ?? tools[0].parameters
        ?? tools[0].input_schema,
    ).toEqual(schema)
    expect(JSON.stringify(lastBody)).toContain("referenced")
    if (endpoint !== "/v1/messages")
      expect(JSON.stringify(lastBody)).toContain(
        "MUST conform to this JSON schema",
      )
    else
      expect(lastBody?.output_config).toMatchObject({
        format: { type: "json_schema", schema },
      })
  },
)

test("maps Responses failed to one received Google failure and stops", async () => {
  const receivedMessage = "  received response failure\r\n"
  responsesStreamBody = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      sequence_number: 1,
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    })}`,
    `event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      sequence_number: 2,
      response: {
        ...responsesResult,
        status: "failed",
        error: {
          code: "upstream_error",
          message: receivedMessage,
          status: 529,
          upstream_status: 529,
          content_type: "text/plain",
        },
      },
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 3,
      response: responsesResult,
    })}`,
    "",
  ].join("\n\n")

  const response = await protocolRequest(
    "/v1/models/gpt-4o-mini:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    },
  )
  const chunks = (await response.json()) as Array<Record<string, unknown>>

  expect(chunks).toHaveLength(2)
  expect(chunks[0]).toMatchObject({
    candidates: [{ content: { parts: [{ text: "partial" }] } }],
  })
  expect(chunks[1]).toEqual({
    error: {
      code: 529,
      message: receivedMessage,
      status: "INTERNAL",
      content_type: "text/plain",
      upstream_status: 529,
    },
  })
})

test.each([
  { suffix: "", contentType: "application/json" },
  { suffix: "?alt=sse", contentType: "text/event-stream" },
])(
  "wraps an exact late Chat HTTP text body once for $suffix",
  async ({ suffix, contentType }) => {
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = "chat-http-error-model"
    model.supported_endpoints = ["/chat/completions"]
    state.models = { object: "list", data: [model] }
    const exactBody = "  upstream late body\r\n"
    chatStreamResponse = createLateChatHttpErrorResponse(
      new Response(exactBody, {
        status: 529,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    )
    const consoleError = spyOn(consola, "error")
    const captureException = spyOn(
      Sentry,
      "captureException",
    ).mockImplementation(() => "event-id")

    try {
      const response = await protocolRequest(
        `/v1/models/chat-http-error-model:streamGenerateContent${suffix}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          }),
        },
      )
      const body = await response.text()
      const failures: Array<Record<string, unknown>> =
        suffix ?
          [...body.matchAll(/^data: (.+)$/gm)].map(
            (match) => JSON.parse(match[1]) as Record<string, unknown>,
          )
        : (JSON.parse(body) as Array<Record<string, unknown>>)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain(contentType)
      expect(failures).toEqual([
        {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "partial" }] },
              finishReason: null,
              index: 0,
            },
          ],
          modelVersion: "chat-http-error-model",
        },
        {
          error: {
            code: 529,
            message: exactBody,
            status: "INTERNAL",
            content_type: "text/plain; charset=utf-8",
            upstream_status: 529,
          },
        },
      ])
      expect(captureException).toHaveBeenCalledTimes(1)
      expect(consoleError.mock.calls).toContainEqual([
        expect.objectContaining({ upstreamResponseBody: exactBody }),
      ])
    } finally {
      consoleError.mockRestore()
      captureException.mockRestore()
    }
  },
)

test("wraps an exact binary late Chat HTTP body with the fixed local message", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "chat-binary-error-model"
  model.supported_endpoints = ["/chat/completions"]
  state.models = { object: "list", data: [model] }
  chatStreamResponse = createLateChatHttpErrorResponse(
    new Response(new Uint8Array([0, 255, 1, 128]), {
      status: 502,
      headers: { "content-type": "application/octet-stream" },
    }),
  )

  const response = await protocolRequest(
    "/v1/models/chat-binary-error-model:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    },
  )

  expect(await response.json()).toEqual([
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "partial" }] },
          finishReason: null,
          index: 0,
        },
      ],
      modelVersion: "chat-binary-error-model",
    },
    {
      error: {
        code: 502,
        message: "Upstream stream ended before a terminal response",
        status: "INTERNAL",
        body_bytes: [0, 255, 1, 128],
        content_type: "application/octet-stream",
        upstream_status: 502,
      },
    },
  ])
})

test("turns a non-empty malformed Chat frame into one local terminal failure", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "chat-malformed-model"
  model.supported_endpoints = ["/chat/completions"]
  state.models = { object: "list", data: [model] }
  chatStreamBody = "data: {not-json\n\n"

  const response = await protocolRequest(
    "/v1/models/chat-malformed-model:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    },
  )

  expect(await response.json()).toEqual([
    {
      error: {
        code: 500,
        message: "Upstream stream ended before a terminal response",
        status: "INTERNAL",
      },
    },
  ])
})

test("preserves a native Messages received failure as one Google terminal", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "messages-error-model"
  model.vendor = "anthropic"
  model.supported_endpoints = ["/v1/messages"]
  state.models = { object: "list", data: [model] }
  messagesStreamBody = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_error",
        type: "message",
        role: "assistant",
        content: [],
        model: "messages-error-model",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })}`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    })}`,
    `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: "  exact messages failure\r\n",
        status: 527,
        body_bytes: [32, 32, 101],
        content_type: "text/plain",
      },
    })}`,
    "",
  ].join("\n\n")

  const response = await protocolRequest(
    "/v1/models/messages-error-model:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    },
  )
  const chunks = (await response.json()) as Array<Record<string, unknown>>

  expect(chunks.at(-1)).toEqual({
    error: {
      code: 527,
      message: "  exact messages failure\r\n",
      status: "INTERNAL",
      body_bytes: [32, 32, 101],
      content_type: "text/plain",
      upstream_status: 527,
    },
  })
  expect(chunks.filter((chunk) => "error" in chunk)).toHaveLength(1)
})

test.each([
  {
    endpoints: ["/chat/completions", "/v1/messages", "/responses"],
    expected: "/responses",
  },
  { endpoints: ["/chat/completions", "/responses"], expected: "/responses" },
  {
    endpoints: ["/chat/completions", "/v1/messages"],
    expected: "/v1/messages",
  },
])(
  "keeps viable Google PDF content compatible for $endpoints",
  async ({ endpoints, expected }) => {
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = "route-model"
    model.name = "Route Model"
    model.vendor = "openai"
    model.supported_endpoints = [...endpoints]
    state.models = { object: "list", data: [model] }

    const response = await protocolRequest(
      "/v1/models/route-model:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Review the PDF." },
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    data: "JVBERi0=",
                  },
                },
              ],
            },
          ],
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(lastPath).toBe(expected)
    expect(JSON.stringify(lastBody)).toContain("JVBERi0=")
  },
)

test.each(["/v1beta/models", "/v1/models", "/models"])(
  "supports Google countTokens locally on %s",
  async (prefix) => {
    const response = await protocolRequest(
      `${prefix}/gpt-4o-mini:countTokens?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Count me" }] }],
        }),
      },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const body = (await response.json()) as { totalTokens?: unknown }
    expect(typeof body.totalTokens).toBe("number")
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test("performs no attachment I/O when no endpoint is advertised", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "no-route-file-model"
  model.supported_endpoints = []
  state.models = { object: "list", data: [model] }
  const response = await protocolRequest(
    "/v1/models/no-route-file-model:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  mimeType: "application/pdf",
                  fileUri: "https://attachment.test/private.pdf",
                },
              },
            ],
          },
        ],
      }),
    },
  )
  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("estimates countTokens for an unknown model without inference dispatch", async () => {
  state.models = { object: "list", data: [] }
  const response = await protocolRequest(
    "/v1/models/future-custom-model:countTokens",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Count future" }] }],
      }),
    },
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { totalTokens?: unknown }
  expect(typeof body.totalTokens).toBe("number")
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each(["/v1beta/models", "/v1/models", "/models"])(
  "returns a fixed invalid JSON error on %s",
  async (prefix) => {
    const response = await protocolRequest(
      `${prefix}/gpt-4o-mini:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "private-invalid-json-marker",
      },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 400,
        message: "Invalid JSON request body",
        status: "INVALID_ARGUMENT",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test("dispatches Google PDF content when the model advertises only Chat", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.name = "Route Model"
  model.supported_endpoints = ["/chat/completions"]
  state.models = { object: "list", data: [model] }

  const response = await protocolRequest(
    "/v1/models/route-model:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: "JVBERi0=",
                },
              },
            ],
          },
        ],
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastPath).toBe("/chat/completions")
})

test("rejects Google requests when the model advertises no compatible endpoint", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.name = "Route Model"
  model.supported_endpoints = []
  state.models = { object: "list", data: [model] }

  const response = await protocolRequest(
    "/v1/models/route-model:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    },
  )

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toEqual({
    error: {
      code: "endpoint_translation_unsupported",
      message:
        "The selected Copilot model cannot accept this request without losing required protocol data.",
      param: "request_shape",
      type: "invalid_request_error",
    },
  })
})

test("skips an advertised Google Messages endpoint when translation is lossy", () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.supported_endpoints = ["/v1/messages", "/chat/completions"]

  expect(
    selectGoogleUpstreamEndpoint({
      selectedModel: model,
      payload: {
        model: "route-model",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        prediction: { type: "content", content: "expected" },
      },
    }),
  ).toMatchObject({ target: "/chat/completions", translated: false })
})

test("uses the advertised Messages endpoint despite advisory loss", () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.supported_endpoints = ["/v1/messages"]

  expect(
    selectGoogleUpstreamEndpoint({
      selectedModel: model,
      payload: {
        model: "route-model",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        prediction: { type: "content", content: "expected" },
      },
    }),
  ).toMatchObject({ target: "/v1/messages", translated: true })
})

test("routes Google googleSearch through Copilot native Responses web search", async () => {
  const response = await protocolRequest(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "What changed today?" }] }],
        tools: [{ googleSearch: {} }],
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastResponsesPayload?.tools?.[0]).toMatchObject({
    type: "function",
    name: "web_search",
  })
})

test("forwards Google maxOutputTokens above the advertised model limit", async () => {
  const response = await protocolRequest(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 2048 },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(
    (lastResponsesPayload as Record<string, unknown> | undefined)
      ?.max_output_tokens,
  ).toBe(2048)
})

test("adds prompt caching markers on the Google AI responses path", async () => {
  const response = await protocolRequest(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "Remember this context." }] },
          { role: "model", parts: [{ text: "Stored." }] },
          { role: "user", parts: [{ text: "Use the cached context." }] },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                parameters: {
                  type: "object",
                  properties: {
                    location: { type: "string" },
                  },
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  const inputItems = lastResponsesPayload?.input
  expect(Array.isArray(inputItems)).toBe(true)
  if (!Array.isArray(inputItems)) {
    throw new TypeError("Expected input array on responses payload")
  }
  const hasAssistantCacheMarker = inputItems.some((item) => {
    const record = item as {
      role?: unknown
      copilot_cache_control?: unknown
    }
    return (
      record.role === "assistant"
      && hasEphemeralCacheControl(record.copilot_cache_control)
    )
  })
  expect(hasAssistantCacheMarker).toBe(false)

  const tools = lastResponsesPayload?.tools
  expect(Array.isArray(tools)).toBe(true)
  if (!Array.isArray(tools)) {
    throw new TypeError("Expected tools array on responses payload")
  }
  const hasToolCacheMarker = tools.some((tool) => {
    return hasEphemeralCacheControl(
      (tool as { copilot_cache_control?: unknown }).copilot_cache_control,
    )
  })
  expect(hasToolCacheMarker).toBe(true)
})

test("detects vision and initiator headers on the Google AI responses path", async () => {
  const response = await protocolRequest(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Review this image." },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: "aGVsbG8=",
                },
              },
            ],
          },
          { role: "model", parts: [{ text: "I will inspect it." }] },
        ],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastHeaders?.["Copilot-Vision-Request"]).toBe("true")
  expect(lastHeaders?.["X-Initiator"]).toBe("agent")
})

test("threads typed native options through the Google PDF Messages path", async () => {
  state.models = {
    object: "list",
    data: [
      {
        ...structuredClone(responsesCapableModels.data[0]),
        id: "claude-native",
        name: "claude-native",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }
  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    lastPath = new URL(url).pathname
    lastHeaders = init?.headers as Record<string, string> | undefined
    lastBody =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : undefined
    return Response.json({
      id: "msg_google_native",
      type: "message",
      role: "assistant",
      model: "claude-native",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })

  const response = await protocolRequest(
    "/v1/models/claude-native:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta":
          " interleaved-thinking-2025-05-14,context-management-2025-06-27,interleaved-thinking-2025-05-14 ",
        "anthropic-version": "2024-01-01",
        "x-model-provider-preference": "anthropic",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Review the PDF." },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: "JVBERi0=",
                },
              },
            ],
          },
          { role: "model", parts: [{ text: "I will inspect it." }] },
        ],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastPath).toBe("/v1/messages")
  expect(new Headers(lastHeaders).get("anthropic-beta")).toBe(
    "interleaved-thinking-2025-05-14,context-management-2025-06-27",
  )
  expect(new Headers(lastHeaders).get("anthropic-version")).toBe("2024-01-01")
  expect(new Headers(lastHeaders).get("x-model-provider-preference")).toBe(
    "anthropic",
  )
  expect(new Headers(lastHeaders).get("x-initiator")).toBe("agent")
  expect(lastBody).not.toHaveProperty("anthropic-beta")
  expect(lastBody).not.toHaveProperty("anthropic-version")
  expect(lastBody).not.toHaveProperty("x-model-provider-preference")
})

test("keeps the requested Google model in a redirected native response", async () => {
  state.models = {
    object: "list",
    data: [
      {
        ...structuredClone(responsesCapableModels.data[0]),
        id: "claude-target",
        name: "claude-target",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }
  setModelRedirectsForTest([
    {
      id: "google-native-redirect",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target",
      enabled: true,
    },
  ])
  fetchMock.mockImplementationOnce(() =>
    Response.json({
      id: "msg_google_redirected",
      type: "message",
      role: "assistant",
      model: "claude-target",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  )

  const response = await protocolRequest(
    "/v1/models/claude-source:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Review." },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: "JVBERi0=",
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )
  const body = (await response.json()) as { modelVersion?: string }

  expect(response.status).toBe(200)
  expect(body.modelVersion).toBe("claude-source")
})

test("accepts unknown Google root request fields with meaningful content", async () => {
  const response = await protocolRequest(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        cachedContent: "cached-content-id",
      }),
    },
  )

  expect(response.status).toBe(200)
})

test("treats unsupported Google code execution as advisory", async () => {
  const response = await protocolRequest(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Run code." }] }],
        tools: [{ codeExecution: {} }],
      }),
    },
  )

  expect(response.status).toBe(200)
})

const requestGoogleStream = async (
  model: string,
  suffix = "",
  tools?: Array<Record<string, unknown>>,
): Promise<Response> =>
  await protocolRequest(`/v1/models/${model}:streamGenerateContent${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      ...(tools ? { tools } : {}),
    }),
  })

const localGoogleFailure = {
  error: {
    code: 500,
    message: "Upstream stream ended before a terminal response",
    status: "INTERNAL",
  },
}

test("preserves a nested top-level Responses error through the mounted route", async () => {
  responsesStreamBody = `event: error\ndata: ${JSON.stringify({
    type: "error",
    sequence_number: 1,
    status: 531,
    error: {
      message: "  nested mounted body\r\n",
      body_bytes: [32, 32, 109],
      content_type: "text/plain",
    },
  })}\n\n`

  const response = await requestGoogleStream("gpt-4o-mini")
  expect(await response.json()).toEqual([
    {
      error: {
        code: 531,
        message: "  nested mounted body\r\n",
        status: "INTERNAL",
        body_bytes: [32, 32, 109],
        content_type: "text/plain",
        upstream_status: 531,
      },
    },
  ])
})

test.each([
  { endpoint: "/v1/messages" as const, kind: "Messages" },
  { endpoint: "/responses" as const, kind: "Responses" },
])(
  "emits one local Google failure when $kind ends at EOF",
  async ({ endpoint }) => {
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = `eof-${endpoint.slice(1).replaceAll("/", "-")}`
    model.vendor = endpoint === "/v1/messages" ? "anthropic" : "openai"
    model.supported_endpoints = [endpoint]
    state.models = { object: "list", data: [model] }
    if (endpoint === "/v1/messages") {
      messagesStreamBody =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_eof","type":"message","role":"assistant","content":[],"model":"eof","usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
    } else {
      responsesStreamBody = `event: response.output_text.delta\ndata: ${JSON.stringify(
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: "msg_eof",
          output_index: 0,
          content_index: 0,
          delta: "partial",
        },
      )}\n\n`
    }

    const response = await requestGoogleStream(model.id)
    const chunks = (await response.json()) as Array<Record<string, unknown>>
    expect(chunks.at(-1)).toEqual(localGoogleFailure)
    expect(chunks.filter((chunk) => "error" in chunk)).toHaveLength(1)
  },
)

test("emits a Responses completed terminal in SSE mode", async () => {
  const response = await requestGoogleStream("gpt-4o-mini", "?alt=sse")
  const body = await response.text()
  const chunks = [...body.matchAll(/^data: (.+)$/gm)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  )

  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(chunks.at(-1)).toMatchObject({
    candidates: [{ finishReason: "STOP" }],
  })
  expect(chunks.filter((chunk) => "error" in chunk)).toHaveLength(0)
})

test.each([
  { endpoint: "/chat/completions" as const, suffix: "?alt=sse", sse: true },
  { endpoint: "/responses" as const, suffix: "", sse: false },
])(
  "emits buffered $endpoint web search in the selected Google mode",
  async ({ endpoint, suffix, sse }) => {
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = `search-${endpoint.slice(1).replaceAll("/", "-")}`
    model.supported_endpoints = [endpoint]
    state.models = { object: "list", data: [model] }

    const response = await requestGoogleStream(model.id, suffix, [
      { googleSearch: { blockedDomains: ["blocked.example"] } },
    ])
    const body = await response.text()
    const chunks =
      sse ?
        [...body.matchAll(/^data: (.+)$/gm)].map(
          (match) => JSON.parse(match[1]) as Record<string, unknown>,
        )
      : (JSON.parse(body) as Array<Record<string, unknown>>)

    expect(response.headers.get("content-type")).toContain(
      sse ? "text/event-stream" : "application/json",
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      candidates: [{ finishReason: "STOP" }],
    })
  },
)

test.each([
  { endpoint: "/v1/messages" as const, kind: "Messages" },
  { endpoint: "/responses" as const, kind: "Responses" },
])(
  "emits one local Google failure for malformed $kind data",
  async ({ endpoint }) => {
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = `malformed-${endpoint.slice(1).replaceAll("/", "-")}`
    model.vendor = endpoint === "/v1/messages" ? "anthropic" : "openai"
    model.supported_endpoints = [endpoint]
    state.models = { object: "list", data: [model] }
    if (endpoint === "/v1/messages") {
      messagesStreamBody = "event: message_start\ndata: {not-json\n\n"
    } else {
      responsesStreamBody =
        "event: response.output_text.delta\ndata: {not-json\n\n"
    }

    const response = await requestGoogleStream(model.id)
    const chunks = (await response.json()) as Array<Record<string, unknown>>
    expect(chunks.at(-1)).toEqual(localGoogleFailure)
    expect(chunks.filter((chunk) => "error" in chunk)).toHaveLength(1)
  },
)

test.each([
  { endpoint: "/v1/messages" as const, kind: "Messages" },
  { endpoint: "/responses" as const, kind: "Responses" },
])(
  "preserves and reports one late $kind HTTP failure",
  async ({ endpoint }) => {
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = `late-${endpoint.slice(1).replaceAll("/", "-")}`
    model.vendor = endpoint === "/v1/messages" ? "anthropic" : "openai"
    model.supported_endpoints = [endpoint]
    state.models = { object: "list", data: [model] }
    const exactBody = `  late ${endpoint} body\r\n`
    const upstream = new Response(exactBody, {
      status: 530,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
    if (endpoint === "/v1/messages") {
      messagesStreamResponse = createLateSseHttpErrorResponse(
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_late",
            type: "message",
            role: "assistant",
            content: [],
            model: model.id,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        upstream,
      )
    } else {
      responsesStreamResponse = createLateSseHttpErrorResponse(
        "response.output_text.delta",
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: "msg_late",
          output_index: 0,
          content_index: 0,
          delta: "partial",
        },
        upstream,
      )
    }
    const captureException = spyOn(
      Sentry,
      "captureException",
    ).mockImplementation(() => "event-id")

    try {
      const response = await requestGoogleStream(model.id)
      const chunks = (await response.json()) as Array<Record<string, unknown>>
      expect(chunks.at(-1)).toEqual({
        error: {
          code: 530,
          message: exactBody,
          status: "INTERNAL",
          content_type: "text/plain; charset=utf-8",
          upstream_status: 530,
        },
      })
      expect(chunks.filter((chunk) => "error" in chunk)).toHaveLength(1)
      expect(captureException).toHaveBeenCalledTimes(1)
    } finally {
      captureException.mockRestore()
    }
  },
)

async function protocolRequest(
  input: Parameters<typeof server.request>[0],
  init?: RequestInit,
) {
  await seedProtocolDatabase({
    gatewayKeys: [
      PROTOCOL_GATEWAY_KEY,
      "mounted-query-secret",
      ...(state.apiKeyAuth ? [state.apiKeyAuth] : []),
    ],
  })
  const headers = new Headers(init?.headers)
  const requestUrl = new URL(
    input instanceof Request ? input.url : String(input),
    "http://localhost",
  )
  if (
    !state.apiKeyAuth
    && !requestUrl.searchParams.has("key")
    && !headers.has("authorization")
    && !headers.has("x-api-key")
    && !headers.has("x-goog-api-key")
  )
    headers.set("authorization", "Bearer " + PROTOCOL_GATEWAY_KEY)
  return server.request(input, { ...init, headers })
}
