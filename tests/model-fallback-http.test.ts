import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { clearModelFallbackCache } from "~/lib/model-fallback"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
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
let sourceStatus = 422
let targetStatus = 200

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
      supports: { reasoning_effort: ["low", "medium", "high"] },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

test("native Responses applies fallback target redirects, effort and verbosity on consecutive turns", async () => {
  state.models?.data.push(model("fast-target"))
  setModelRedirectsForTest([
    {
      id: "fast",
      sourceModel: "target-model",
      sourceEffort: "all",
      targetModel: "fast-target",
      targetEffort: "high",
      targetVerbosity: "low",
      enabled: true,
    },
  ])
  for (let i = 0; i < 2; i++) {
    const response = await post(
      { reasoning: { effort: "low" }, text: { verbosity: "high" } },
      { "thread-id": "redirect-thread" },
    )
    expect(response.status).toBe(200)
    await response.text()
    expect(calls.at(-1)?.body.model).toBe("fast-target")
    expect(calls.at(-1)?.body.reasoning).toMatchObject({ effort: "high" })
    expect(calls.at(-1)?.body.text).toMatchObject({ verbosity: "low" })
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "fast-target",
    "fast-target",
  ])
})

function configure(extra: Record<string, unknown> = {}): void {
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: [
        {
          id: "test-fallback",
          sourceModel: "source-model",
          targetModel: "target-model",
          enabled: true,
        },
      ],
      ...extra,
    }),
  )
}

function successfulResponse(
  body: Record<string, unknown>,
  path: string,
): Response {
  if (path === "/v1/messages") {
    return Response.json({
      id: `msg_${calls.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "fallback answer" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    })
  }
  const response = {
    id: `resp_${calls.length}`,
    object: "response",
    created_at: 1,
    model: body.model,
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_answer",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "fallback answer", annotations: [] },
        ],
      },
    ],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    error: null,
  }
  if (!body.stream) return Response.json(response)
  return new Response(
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response,
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

beforeEach(() => {
  calls.length = 0
  sourceStatus = 422
  targetStatus = 200
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "fallback-test-token",
    githubToken: "fallback-test-github-token",
    isMultiToken: false,
    manualApprove: false,
    apiKeyAuth: undefined,
    models: {
      object: "list",
      data: [model("source-model"), model("target-model")],
    },
  })
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  clearModelFallbackCache()
  configure()
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (typeof init?.body !== "string") throw new Error("Unexpected test fetch")
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path: url.pathname, body })
    const status = body.model === "source-model" ? sourceStatus : targetStatus
    if (status !== 200) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: "arbitrary_validation",
              message: "Any upstream 422",
            },
          },
          { status, headers: { "retry-after": "0" } },
        ),
      )
    }
    return Promise.resolve(successfulResponse(body, url.pathname))
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
  clearModelFallbackCache()
  setConfigForTest(null)
})

test("custom-provider source retries native Responses with redirected effort", async () => {
  setConfigForTest({
    customProviders: [
      {
        id: "custom",
        name: "Custom",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "synthetic",
        models: [{ id: "custom-source", kind: "chat" }],
      },
    ],
  })
  configure({
    rules: [
      {
        id: "cross-provider",
        sourceModel: "custom-source",
        targetModel: "target-model",
        enabled: true,
      },
    ],
  })
  state.models?.data.push(model("fast-target"))
  setModelRedirectsForTest([
    {
      id: "fast",
      sourceModel: "target-model",
      sourceEffort: "all",
      targetModel: "fast-target",
      targetEffort: "high",
      enabled: true,
    },
  ])
  const original = globalThis.fetch
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (
      typeof init?.body === "string"
      && (JSON.parse(init.body) as Record<string, unknown>).model
        === "custom-source"
    ) {
      calls.push({
        path: "/chat/completions",
        body: JSON.parse(init.body) as Record<string, unknown>,
      })
      return new Response("unprocessable", { status: 422 })
    }
    return await original(input, init)
  }) as typeof fetch
  const response = await post({
    model: "custom-source",
    reasoning: { effort: "low" },
  })
  expect(response.status).toBe(200)
  await response.text()
  expect(calls.map((call) => call.body.model)).toEqual([
    "custom-source",
    "fast-target",
  ])
  expect(calls[1].path).toBe("/responses")
  expect(calls[1].body.reasoning).toMatchObject({ effort: "high" })
})

function post(
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ model: "source-model", input: "hello", ...extra }),
    }),
  )
}

function reasoningInput(signature: string) {
  return [
    {
      type: "reasoning",
      id: "rs_history",
      summary: [],
      encrypted_content: signature,
    },
    { role: "user", content: "continue" },
  ]
}

test("Responses 422 strips original reasoning once and routes future thread turns directly", async () => {
  const first = await post(
    { input: reasoningInput("original-signature") },
    { "thread-id": "one" },
  )
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({
    model: "source-model",
    status: "completed",
  })
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
  ])
  expect(JSON.stringify(calls[1].body)).not.toContain("original-signature")

  const next = await post(
    { input: reasoningInput("fallback-signature") },
    { "thread-id": "one" },
  )
  expect(next.status).toBe(200)
  expect(calls).toHaveLength(3)
  expect(calls[2].body.model).toBe("target-model")
  expect(JSON.stringify(calls[2].body)).toContain("fallback-signature")
})

test("Responses full-history replay removes known source signatures and preserves new fallback signatures", async () => {
  const originalInput = reasoningInput("foreign-source-signature")
  const first = await post(
    { input: originalInput },
    { "thread-id": "full-replay" },
  )
  expect(first.status).toBe(200)
  const next = await post(
    { input: [...originalInput, ...reasoningInput("own-fallback-signature")] },
    { "thread-id": "full-replay" },
  )
  expect(next.status).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "target-model",
  ])
  expect(JSON.stringify(calls[2].body)).not.toContain(
    "foreign-source-signature",
  )
  expect(JSON.stringify(calls[2].body)).toContain("own-fallback-signature")
})

test("Responses preserves its public wire protocol when fallback changes to native Messages", async () => {
  if (!state.models) throw new Error("Test models missing")
  state.models.data[1] = model("target-model", "/v1/messages")
  const response = await post({ input: reasoningInput("old-envelope") })
  expect(response.status).toBe(200)
  expect(calls.map((call) => call.path)).toEqual(["/responses", "/v1/messages"])
  expect(JSON.stringify(calls[1].body)).not.toContain("old-envelope")
  expect(await response.json()).toMatchObject({
    object: "response",
    model: "source-model",
  })
})

test("Responses streaming retries before exposing the upstream 422 and preserves source model", async () => {
  const response = await post({ stream: true })
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).toContain("response.completed")
  expect(text).toContain('"model":"source-model"')
  expect(text).not.toContain("arbitrary_validation")
  expect(calls).toHaveLength(2)
})

test("Codex child threads sharing a session do not inherit each other's fallback", async () => {
  const metadata = { session_id: "parent", thread_id: "child-one" }
  expect((await post({ client_metadata: metadata })).status).toBe(200)
  expect(
    (await post({ client_metadata: { ...metadata, thread_id: "child-two" } }))
      .status,
  ).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "source-model",
    "target-model",
  ])
  expect((await post({ client_metadata: metadata })).status).toBe(200)
  expect(calls[4].body.model).toBe("target-model")
})

test("requests without conversation identity retry independently despite prompt cache key", async () => {
  for (let i = 0; i < 2; i++) {
    expect((await post({ prompt_cache_key: "shared-cache" })).status).toBe(200)
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "source-model",
    "target-model",
  ])
})

test.each([400, 401, 403, 404, 429, 500, 502, 503])(
  "HTTP %i does not change models",
  async (status) => {
    sourceStatus = status
    const response = await post()
    expect(response.status).not.toBe(200)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.body.model === "source-model")).toBe(true)
  },
)

test.each([{ enabled: false }, { rules: [] }])(
  "disabled or unconfigured fallbacks return 422",
  async (config) => {
    configure(config)
    expect((await post()).status).toBe(422)
    expect(calls).toHaveLength(1)
  },
)

test("a failed fallback is not remembered and never starts a third model attempt", async () => {
  targetStatus = 422
  for (let i = 0; i < 2; i++) {
    expect((await post({}, { "thread-id": "unsuccessful" })).status).toBe(422)
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "source-model",
    "target-model",
  ])
})

test("fallback rules match after normal redirects and retain the original public model", async () => {
  setModelRedirectsForTest([
    {
      id: "alias",
      sourceModel: "requested-alias",
      sourceEffort: "all",
      targetModel: "source-model",
      enabled: true,
    },
  ])
  for (let i = 0; i < 2; i++) {
    const response = await post(
      { model: "requested-alias" },
      { "thread-id": "redirected" },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ model: "requested-alias" })
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "target-model",
  ])
})

test("native Codex headers and diagnostic headers are independently opt-in", async () => {
  let response = await post()
  expect(response.status).toBe(200)
  expect(response.headers.get("openai-model")).toBeNull()
  expect(response.headers.get("x-copilot-api-fallback-to")).toBeNull()
  configure({ nativeClientNotice: true })
  response = await post()
  expect(response.headers.get("openai-model")).toBe("target-model")
  expect(response.headers.get("x-copilot-api-fallback-to")).toBeNull()
  configure({ notifyClient: true })
  response = await post({}, { "thread-id": "diagnostics" })
  expect(response.headers.get("openai-model")).toBeNull()
  expect(response.headers.get("x-copilot-api-fallback-to")).toBe("target-model")
  expect(response.headers.get("x-copilot-api-fallback-cached")).toBe("false")
  response = await post({}, { "thread-id": "diagnostics" })
  expect(response.headers.get("x-copilot-api-fallback-cached")).toBe("true")
})
