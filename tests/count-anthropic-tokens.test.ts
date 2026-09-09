import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { RoutingAffinity } from "../src/lib/routing-affinity"
import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { HTTPError } from "../src/lib/error"
import {
  getRoutingAffinity,
  runWithRoutingAffinity,
} from "../src/lib/routing-affinity"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import { countAnthropicTokens } from "../src/services/copilot/count-anthropic-tokens"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
let capturedBody: unknown
let capturedHeaders: Headers | undefined
let capturedPath: string | undefined
let capturedRoutingAffinity: RoutingAffinity | undefined
let capturedSignal: AbortSignal | null | undefined
let queuedResponse: Response

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected native count-tokens JSON body")
  }
  capturedBody = JSON.parse(init.body) as unknown
  capturedHeaders = new Headers(init.headers)
  capturedPath = new URL(url instanceof Request ? url.url : url).pathname
  capturedRoutingAffinity = getRoutingAffinity()
  capturedSignal = init.signal
  return queuedResponse
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.models = originalModels
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  capturedBody = undefined
  capturedHeaders = undefined
  capturedPath = undefined
  capturedRoutingAffinity = undefined
  capturedSignal = undefined
  queuedResponse = Response.json({ input_tokens: 42 })
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
  await seedProtocolDatabase()
})

test("posts the exact native count-tokens body with request context", async () => {
  const controller = new AbortController()
  const affinity: RoutingAffinity = {
    key: "count-service-session",
    source: "claude_metadata",
  }
  const payload = {
    model: "claude-current",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
            cache_control: {
              type: "ephemeral",
              ttl: "5m",
              scope: "private",
            },
          },
        ],
      },
    ],
    system: [
      {
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral", ttl: "1h", scope: "private" },
      },
    ],
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        input_schema: {
          type: "object",
          properties: {},
          metadata: { retained: true },
        },
        cache_control: { type: "ephemeral", client_hint: true },
      },
    ],
    tool_choice: { type: "tool", name: "lookup" },
    stream: true,
    temperature: 0.4,
    top_p: 0.8,
    thinking: { type: "enabled", budget_tokens: 1000 },
    output_config: { effort: "high" },
    cache_control: { type: "ephemeral" },
    fallback_credit_token: "opaque",
    future_native_field: { enabled: true },
  } as unknown as AnthropicMessagesPayload
  const originalPayload = structuredClone(payload)

  const result = await runWithRoutingAffinity(
    affinity,
    async () =>
      await countAnthropicTokens(payload, {
        anthropicBeta:
          " interleaved-thinking-2025-05-14, context-management-2025-06-27, interleaved-thinking-2025-05-14 ",
        anthropicVersion: " 2024-01-01 ",
        modelProviderPreference: " anthropic ",
        signal: controller.signal,
      }),
  )

  expect(result).toEqual({ input_tokens: 42 })
  expect(payload).toEqual(originalPayload)
  expect(capturedPath).toBe("/v1/messages/count_tokens")
  expect(capturedBody).toEqual({
    model: "claude-current",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        ],
      },
    ],
    system: [
      {
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        input_schema: {
          type: "object",
          properties: {},
          metadata: { retained: true },
        },
        cache_control: { type: "ephemeral" },
      },
    ],
    tool_choice: { type: "tool", name: "lookup" },
  })
  expect(capturedHeaders?.get("anthropic-beta")).toBe(
    "interleaved-thinking-2025-05-14,context-management-2025-06-27",
  )
  expect(capturedHeaders?.get("anthropic-version")).toBe("2024-01-01")
  expect(capturedHeaders?.get("x-model-provider-preference")).toBe("anthropic")
  expect(capturedHeaders?.get("copilot-vision-request")).toBe("true")
  expect(capturedHeaders?.get("x-initiator")).toBe("user")
  expect(capturedRoutingAffinity).toEqual(affinity)
  expect(capturedSignal).toBe(controller.signal)
})

test("does not require max_tokens", async () => {
  const result = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  })

  expect(result).toEqual({ input_tokens: 42 })
  expect(capturedBody).toEqual({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  })
})

test.each([
  ["string", "32"],
  ["null", null],
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
] as const)(
  "does not reject present safe-JSON max_tokens: %s",
  async (_name, maxTokens) => {
    const result = await countAnthropicTokens({
      model: "claude-current",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: maxTokens,
    } as unknown as AnthropicMessagesPayload)

    expect(result).toEqual({ input_tokens: 42 })
    expect(capturedBody).toEqual({
      model: "claude-current",
      messages: [{ role: "user", content: "hello" }],
    })
  },
)

test.each([
  ["undefined", undefined],
  ["NaN", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY],
] as const)(
  "keeps failing closed for non-JSON max_tokens: %s",
  async (_name, maxTokens) => {
    try {
      await countAnthropicTokens({
        model: "claude-current",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: maxTokens,
      } as unknown as AnthropicMessagesPayload)
      throw new Error("Expected count-token preparation to fail")
    } catch (error) {
      expect(error).toHaveProperty("clientBody.error.code", "invalid_type")
      expect(error).toHaveProperty("clientBody.error.param", "body")
    }
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test("returns only the validated token count field", async () => {
  queuedResponse = Response.json({
    input_tokens: 42,
    private_upstream_metadata: "do-not-forward",
  })

  const result = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  })

  expect(result).toEqual({ input_tokens: 42 })
})

test("throws the upstream HTTP error instead of fabricating one token", async () => {
  queuedResponse = Response.json(
    { type: "error", error: { type: "invalid_request_error", message: "bad" } },
    { status: 400 },
  )

  const error = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  }).catch((caught: unknown) => caught)

  expect(error).toHaveProperty("response.status", 400)
})

test("preserves count-tokens failure metadata and exact route bytes", async () => {
  const body = new TextEncoder().encode("count failed\r\n  ")
  const createUpstream = () =>
    new Response(body.slice(), {
      status: 409,
      headers: { "content-type": "text/plain" },
    })
  const upstream = createUpstream()
  queuedResponse = upstream
  const payload = {
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  } as AnthropicMessagesPayload

  const error = await countAnthropicTokens(payload).catch(
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(HTTPError)
  const upstreamFailure = (error as HTTPError).response
  expect(upstreamFailure.status).toBe(upstream.status)
  expect(upstreamFailure.statusText).toBe(upstream.statusText)
  expect(Array.from(upstreamFailure.headers)).toEqual(
    Array.from(upstream.headers),
  )
  expect(upstreamFailure.bodyUsed).toBe(false)
  expect(
    Array.from(new Uint8Array(await upstreamFailure.arrayBuffer())),
  ).toEqual(Array.from(body))

  state.models = {
    object: "list",
    data: [
      {
        id: "claude-current",
        name: "Claude Current",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  queuedResponse = createUpstream()
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  )
  expect(response.status).toBe(409)
  expect(response.headers.get("content-type")).toBe("text/plain")
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
    Array.from(body),
  )
})

test.each([
  ["missing", {}],
  ["negative", { input_tokens: -1 }],
  ["fractional", { input_tokens: 1.5 }],
  ["string", { input_tokens: "42" }],
] as const)("rejects a %s upstream token count", async (_name, body) => {
  queuedResponse = Response.json(body)

  const error = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  }).catch((caught: unknown) => caught)

  expect(error).toHaveProperty(
    "message",
    "Invalid token count response from upstream",
  )
  expect(error).toHaveProperty("response.status", 502)
})

test("rejects invalid JSON from a successful upstream response", async () => {
  queuedResponse = new Response("not-json", { status: 200 })

  const error = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  }).catch((caught: unknown) => caught)

  expect(error).toHaveProperty(
    "message",
    "Invalid token count response from upstream",
  )
  expect(error).toHaveProperty("response.status", 502)
})
