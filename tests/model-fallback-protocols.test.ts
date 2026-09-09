import { afterEach, beforeEach, expect, test } from "bun:test"

/* eslint-disable unicorn/consistent-function-scoping, no-nested-ternary -- protocol fixtures stay beside their round-trip assertions */
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { listLlmDebugLogs } from "~/lib/llm-debug-log"
import { clearModelFallbackCache } from "~/lib/model-fallback"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { setSsePreflushDeadlineForTest } from "~/lib/sse-lifecycle"
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
const originalInferenceDigests =
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
const calls: Array<{ path: string; body: Record<string, unknown> }> = []
let delaySource = false
let signedResponse = false

function model(id: string, endpoint = "/chat/completions"): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "test",
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

function configure(sourceModel = "source-model", targetModel = "target-model") {
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: [{ id: "test", sourceModel, targetModel, enabled: true }],
    }),
  )
}

test("native Messages fallback redirects override body effort on each turn", async () => {
  state.models = {
    object: "list",
    data: [
      model("source-model", "/v1/messages"),
      model("fast-target", "/v1/messages"),
    ],
  }
  setModelRedirectsForTest([
    {
      id: "native-fast",
      sourceModel: "target-model",
      sourceEffort: "all",
      targetModel: "fast-target",
      targetEffort: "high",
      enabled: true,
    },
  ])
  for (let i = 0; i < 2; i++) {
    const response = await post("/v1/messages", {
      model: "source-model",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "low" },
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(calls.at(-1)?.body.output_config).toMatchObject({ effort: "high" })
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "fast-target",
    "fast-target",
  ])
  expect((await listLlmDebugLogs()).entries[0]).toMatchObject({
    fallback: { cached: true, targetModel: "fast-target" },
  })
})

test.each([
  [
    "Chat",
    "/v1/chat/completions",
    {
      model: "custom-source",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "low",
    },
  ],
  [
    "Responses",
    "/v1/responses",
    { model: "custom-source", input: "hello", reasoning: { effort: "low" } },
  ],
] as const)(
  "%s retains redirect effort on custom-provider to Copilot fallback",
  async (_protocol, path, body) => {
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
    configure("custom-source", "target-model")
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
    const response = await post(path, body)
    expect(response.status).toBe(200)
    await response.text()
    expect(calls.map((call) => call.body.model)).toEqual([
      "custom-source",
      "fast-target",
    ])
    expect(calls[1].body.reasoning_effort).toBe("high")
  },
)

test("Google custom fallback effort is normalized against its target model", async () => {
  setConfigForTest({
    customProviders: [
      {
        id: "custom",
        name: "Custom",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "synthetic",
        passReasoningEffort: true,
        models: [
          { id: "gpt-5.2", kind: "chat" },
          { id: "fast-target", kind: "chat" },
        ],
      },
    ],
  })
  state.models = { object: "list", data: [] }
  configure("gpt-5.2", "target-model")
  setModelRedirectsForTest([
    {
      id: "fast",
      sourceModel: "target-model",
      sourceEffort: "all",
      targetModel: "fast-target",
      targetEffort: "xhigh",
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
      && (JSON.parse(init.body) as Record<string, unknown>).model === "gpt-5.2"
    ) {
      calls.push({
        path: "/chat/completions",
        body: JSON.parse(init.body) as Record<string, unknown>,
      })
      return new Response("unprocessable", { status: 422 })
    }
    return await original(input, init)
  }) as typeof fetch
  const response = await post("/v1beta/models/gpt-5.2:low:generateContent", {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
  })
  expect(response.status).toBe(200)
  await response.text()
  expect(calls.map((call) => call.body.model)).toEqual([
    "gpt-5.2",
    "fast-target",
  ])
  expect(calls[1].body.reasoning_effort).toBe("xhigh")
})

function success(body: Record<string, unknown>, path: string): Response {
  if (path === "/v1/messages") {
    const response = {
      id: `msg_${calls.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "fallback answer" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    }
    if (!body.stream) return Response.json(response)
    return new Response(
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...response, content: [] } })}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  const response = {
    id: `chat_${calls.length}`,
    object: "chat.completion",
    created: 1,
    model: body.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "fallback answer",
          ...(signedResponse ?
            {
              reasoning_text: "fallback thinking",
              reasoning_opaque: "fallback-opaque",
              encrypted_content: "fallback-encrypted",
            }
          : {}),
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  }
  if (body.stream) {
    const chunk = {
      id: response.id,
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          delta: {
            content: "fallback answer",
            ...(signedResponse ?
              {
                reasoning_text: "fallback thinking",
                reasoning_opaque: "fallback-opaque",
              }
            : {}),
          },
          finish_reason: "stop",
        },
      ],
    }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  }
  return Response.json(response)
}

beforeEach(() => {
  calls.length = 0
  delaySource = false
  signedResponse = false
  Object.assign(state, {
    copilotToken: "test-token",
    githubToken: "test-token",
    accountType: "individual",
    isMultiToken: false,
    manualApprove: false,
    apiKeyAuth: undefined,
    models: {
      object: "list",
      data: [model("source-model"), model("target-model")],
    },
  })
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  clearModelFallbackCache()
  configure()
  globalThis.fetch = (async (
    input: string | Request | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (typeof init?.body !== "string")
      throw new Error("Expected serialized inference body")
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path: url.pathname, body })
    if (body.model === "source-model" || body.model === "custom-source") {
      if (delaySource) await new Promise((resolve) => setTimeout(resolve, 25))
      return new Response("any reason", { status: 422 })
    }
    return success(body, url.pathname)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
  clearModelFallbackCache()
  setSsePreflushDeadlineForTest()
  if (originalInferenceDigests === undefined)
    delete process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  else
    process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = originalInferenceDigests
})

function post(
  path: string,
  payload: Record<string, unknown>,
  session = "thread",
) {
  return seedProtocolDatabase().then(() =>
    server.request(path, {
      method: "POST",
      headers: {
        ...(path.includes("?key=") ?
          {}
        : {
            authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
          }),
        "content-type": "application/json",
        "thread-id": session,
      },
      body: JSON.stringify(payload),
    }),
  )
}

test.each([
  [
    "Chat",
    "/v1/chat/completions",
    {
      model: "source-model",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "low",
    },
  ],
  [
    "Messages",
    "/v1/messages",
    {
      model: "source-model:low",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    },
  ],
  [
    "Google",
    "/v1beta/models/source-model:low:generateContent",
    { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  ],
] as const)(
  "%s applies fallback redirects and target effort before preparing upstream payloads",
  async (_protocol, path, payload) => {
    state.models?.data.push(model("fast-target"))
    setModelRedirectsForTest([
      {
        id: "faster-target",
        sourceModel: "target-model",
        sourceEffort: "all",
        targetModel: "fast-target",
        targetEffort: "high",
        enabled: true,
      },
    ])
    const response = await post(path, payload)
    expect(response.status).toBe(200)
    await response.text()
    expect(calls.map((call) => call.body.model)).toEqual([
      "source-model",
      "fast-target",
    ])
    expect(calls[1].body.reasoning_effort).toBe("high")
    const next = await post(path, payload)
    expect(next.status).toBe(200)
    await next.text()
    expect(calls.at(-1)?.body.model).toBe("fast-target")
    expect(calls.at(-1)?.body.reasoning_effort).toBe("high")
  },
)

test("Chat preserves public model and fallback reasoning through the next turn", async () => {
  const payload = (signature: string) => ({
    model: "source-model",
    messages: [
      {
        role: "assistant",
        content: "previous",
        reasoning_text: "reasoning",
        reasoning_opaque: signature,
      },
      { role: "user", content: "next" },
    ],
  })
  const first = await post("/v1/chat/completions", payload("old-signature"))
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({ model: "source-model" })
  const next = await post("/v1/chat/completions", payload("fallback-signature"))
  expect(next.status).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "target-model",
  ])
  expect(JSON.stringify(calls[1].body)).not.toContain("old-signature")
  expect(JSON.stringify(calls[2].body)).toContain("fallback-signature")
})

test("Messages late 422 retries before SSE preflush and keeps the public model", async () => {
  state.models = {
    object: "list",
    data: [
      model("source-model", "/v1/messages"),
      model("target-model", "/v1/messages"),
    ],
  }
  delaySource = true
  setSsePreflushDeadlineForTest(1)
  const first = await post("/v1/messages", {
    model: "source-model",
    stream: true,
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
  })
  const wire = await first.text()
  expect(first.status).toBe(200)
  expect(wire).toContain('"model":"source-model"')
  expect(wire).not.toContain("event: error")
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
  ])
})

test("Messages removes old thinking once and preserves new signed thinking", async () => {
  state.models = {
    object: "list",
    data: [
      model("source-model", "/v1/messages"),
      model("target-model", "/v1/messages"),
    ],
  }
  const payload = (signature: string) => ({
    model: "source-model",
    max_tokens: 128,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", signature },
          { type: "text", text: "previous" },
        ],
      },
      { role: "user", content: "hello" },
    ],
  })
  expect((await post("/v1/messages", payload("old-signature"))).status).toBe(
    200,
  )
  expect(
    (await post("/v1/messages", payload("fallback-signature"))).status,
  ).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "target-model",
  ])
  expect(JSON.stringify(calls[1].body)).not.toContain("old-signature")
  expect(JSON.stringify(calls[2].body)).toContain("fallback-signature")
})

test("Google generation retries transparently and remembers its thread", async () => {
  const payload = { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
  const first = await post(
    "/v1beta/models/source-model:generateContent",
    payload,
  )
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({ modelVersion: "source-model" })
  expect(
    (await post("/v1beta/models/source-model:generateContent", payload)).status,
  ).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "target-model",
  ])
})

test("Google query credentials isolate identical conversation IDs", async () => {
  state.apiKeyAuth = "query-client-a"
  await seedProtocolDatabase({ inferenceKeys: ["query-client-b"] })
  const payload = { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
  for (const credential of [
    "query-client-a",
    "query-client-a",
    "query-client-b",
  ]) {
    const response = await post(
      `/v1beta/models/source-model:generateContent?key=${credential}`,
      payload,
      "same-thread",
    )
    expect(response.status).toBe(200)
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "target-model",
    "source-model",
    "target-model",
  ])
})

test("Responses applies the configured fallback after its normal 1m variant routing", async () => {
  state.models = {
    object: "list",
    data: [model("source-model-1m"), model("target-model")],
  }
  configure("source-model-1m")
  const original = globalThis.fetch
  globalThis.fetch = (async (
    input: string | Request | URL,
    init?: RequestInit,
  ) => {
    if (
      typeof init?.body === "string"
      && (JSON.parse(init.body) as Record<string, unknown>).model
        === "source-model-1m"
    ) {
      calls.push({
        path: "/chat/completions",
        body: JSON.parse(init.body) as Record<string, unknown>,
      })
      return new Response("variant rejected", { status: 422 })
    }
    return await original(input, init)
  }) as typeof fetch
  const response = await post("/v1/responses", {
    model: "source-model",
    input: "hello",
  })
  expect(response.status).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model-1m",
    "target-model",
  ])
})

test("Responses translated to Chat preserves target signed reasoning on the next turn", async () => {
  signedResponse = true
  const first = await post("/v1/responses", {
    model: "source-model",
    input: "hello",
  })
  expect(first.status).toBe(200)
  const body = (await first.json()) as {
    output: Array<Record<string, unknown>>
  }
  const reasoning = body.output.find((item) => item.type === "reasoning")
  expect(reasoning).toMatchObject({
    id: "fallback-opaque",
    encrypted_content: "fallback-encrypted",
  })
  const next = await post("/v1/responses", {
    model: "source-model",
    input: [...body.output, { role: "user", content: "continue" }],
  })
  expect(next.status).toBe(200)
  expect(calls.map((call) => call.body.model)).toEqual([
    "source-model",
    "target-model",
    "target-model",
  ])
  expect(JSON.stringify(calls[2].body)).toContain(
    '"reasoning_opaque":"fallback-opaque"',
  )
  expect(JSON.stringify(calls[2].body)).toContain(
    '"encrypted_content":"fallback-encrypted"',
  )
})

test("Responses streaming through Chat emits signed reasoning and preserves the next turn", async () => {
  signedResponse = true
  const response = await post("/v1/responses", {
    model: "source-model",
    stream: true,
    input: "hello",
  })
  expect(response.status).toBe(200)
  const frames = (await response.text()).split("\n\n").flatMap((frame) => {
    const line = frame.split("\n").find((item) => item.startsWith("data: "))
    return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : []
  })
  const completed = frames.find((frame) => frame.type === "response.completed")
  const result = completed?.response as {
    output: Array<Record<string, unknown>>
  }
  const reasoning = result.output.find((item) => item.type === "reasoning")
  expect(reasoning).toMatchObject({
    id: "fallback-opaque",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "fallback thinking" }],
  })
  expect(
    frames
      .filter((frame) => frame.type === "response.output_item.done")
      .some(
        (frame) => (frame.item as Record<string, unknown>).id === reasoning?.id,
      ),
  ).toBe(true)
  const next = await post("/v1/responses", {
    model: "source-model",
    input: [...result.output, { role: "user", content: "continue" }],
  })
  expect(next.status).toBe(200)
  expect(JSON.stringify(calls[2].body)).toContain(
    '"reasoning_opaque":"fallback-opaque"',
  )
})

test.each([
  { protocol: "chat", reverse: false },
  { protocol: "chat", reverse: true },
  { protocol: "messages", reverse: false },
  { protocol: "messages", reverse: true },
  { protocol: "responses", reverse: false },
  { protocol: "responses", reverse: true },
  { protocol: "google", reverse: false },
  { protocol: "google", reverse: true },
])(
  "$protocol switches between Copilot and a custom provider, reverse=$reverse",
  async ({ protocol, reverse }) => {
    setConfigForTest({
      customProviders: [
        {
          id: "test-custom",
          name: "Test Custom",
          type: "openai-compatible",
          baseUrl: "https://custom.example/v1",
          apiKey: "provider-secret",
          models: [
            { id: "custom-source", kind: "chat" },
            { id: "custom-target", kind: "chat" },
          ],
        },
      ],
    })
    const source = reverse ? "custom-source" : "source-model"
    const target = reverse ? "target-model" : "custom-target"
    configure(source, target)
    const payload: Record<string, unknown> =
      protocol === "google" ?
        { contents: [{ role: "user", parts: [{ text: "hello" }] }] }
      : protocol === "responses" ? { model: source, input: "hello" }
      : {
          model: source,
          max_tokens: 128,
          messages: [{ role: "user", content: "hello" }],
        }
    const path =
      protocol === "google" ? `/v1beta/models/${source}:generateContent`
      : protocol === "responses" ? "/v1/responses"
      : protocol === "messages" ? "/v1/messages"
      : "/v1/chat/completions"
    const first = await post(path, payload)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject(
      protocol === "google" ? { modelVersion: source } : { model: source },
    )
    expect((await post(path, payload)).status).toBe(200)
    expect(calls.map((call) => call.body.model)).toEqual([
      source,
      target,
      target,
    ])
  },
)
