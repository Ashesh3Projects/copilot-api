/* eslint-disable max-lines -- native transport fixtures and compatibility coverage share one singleton fetch */
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

import { HTTPError } from "../src/lib/error"
import { state } from "../src/lib/state"
import {
  asAnthropicUnknownRole,
  type AnthropicMessagesPayload,
} from "../src/routes/messages/anthropic-types"
import { server } from "../src/server"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "../src/services/copilot/compaction-payload"
import { createAnthropicMessages } from "../src/services/copilot/create-anthropic-messages"
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
const capturedHeaderAttempts: Array<Headers> = []
const capturedBodies: Array<Record<string, unknown>> = []
const queuedResponses: Array<Response> = []
let pendingResponse: Promise<Response> | undefined

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected native Messages JSON body")
  }
  capturedBody = JSON.parse(init.body) as unknown
  capturedBodies.push(capturedBody as Record<string, unknown>)
  capturedHeaders = new Headers(init.headers)
  capturedHeaderAttempts.push(capturedHeaders)
  return (
    queuedResponses.shift()
    ?? pendingResponse
    ?? new Response(
      JSON.stringify({
        id: "msg_cache_control",
        type: "message",
        role: "assistant",
        model: "claude-opus-4.8",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  )
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
  capturedHeaderAttempts.length = 0
  capturedBodies.length = 0
  queuedResponses.length = 0
  pendingResponse = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
  await seedProtocolDatabase()
})

test("retries exact native thinking signature failure after stripping only thinking", async () => {
  queuedResponses.push(
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    Response.json({
      id: "msg_retry",
      type: "message",
      role: "assistant",
      model: "claude-opus-4.8",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  )
  const payload = {
    model: "claude-opus-4.8",
    max_tokens: 64,
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "bad" },
          { type: "text", text: "kept" },
        ],
      },
    ],
  } as AnthropicMessagesPayload
  const source = structuredClone(payload)

  const result = await createAnthropicMessages(payload, {
    alreadyAdapted: true,
    copilotSessionToken: "messages-session-fixed",
  })

  expect(result).toHaveProperty("id", "msg_retry")
  expect(payload).toEqual(source)
  expect(capturedBodies).toHaveLength(2)
  expect(capturedBodies[0]).toEqual(source)
  expect(capturedBodies[1]).toEqual({
    ...source,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "kept" }] },
    ],
  })
  expect(
    capturedHeaderAttempts.map((headers) =>
      headers.get("copilot-session-token"),
    ),
  ).toEqual(["messages-session-fixed", "messages-session-fixed"])
})

test("serializes native cache controls using Copilot's supported wire shape", async () => {
  const payload = {
    model: "claude-opus-4.8",
    max_tokens: 64,
    system: [
      { type: "text", text: "base" },
      {
        type: "text",
        text: "scoped",
        cache_control: { type: "ephemeral", scope: "global" },
      },
      {
        type: "text",
        text: "long lived",
        cache_control: {
          type: "ephemeral",
          ttl: "1h",
          scope: "global",
          client_hint: true,
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: {
              type: "ephemeral",
              ttl: "unsupported",
              scope: "global",
            },
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              {
                type: "text",
                text: "result",
                cache_control: {
                  type: "ephemeral",
                  ttl: "5m",
                  scope: "global",
                },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      {
        name: "run",
        input_schema: {
          type: "object",
          metadata: { type: "ephemeral", scope: "global" },
        },
        cache_control: { type: "ephemeral", scope: "global" },
      },
    ],
  } as unknown as AnthropicMessagesPayload
  const originalPayload = structuredClone(payload)

  await createAnthropicMessages(payload)

  expect(payload).toEqual(originalPayload)
  expect(capturedBody).toEqual({
    model: "claude-opus-4.8",
    max_tokens: 64,
    system: [
      { type: "text", text: "base" },
      {
        type: "text",
        text: "scoped",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "long lived",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: { type: "ephemeral" },
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              {
                type: "text",
                text: "result",
                cache_control: { type: "ephemeral", ttl: "5m" },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      {
        name: "run",
        input_schema: {
          type: "object",
          metadata: { type: "ephemeral", scope: "global" },
        },
        cache_control: { type: "ephemeral" },
      },
    ],
  })
})

test("does not log native Messages upstream status text or body", async () => {
  const statusMarker = "anthropic-private-status"
  const bodyMarker = "anthropic-private-body"
  fetchMock.mockImplementationOnce(() =>
    Response.json(
      { error: { code: "invalid_request_body", message: bodyMarker } },
      { status: 400, statusText: statusMarker },
    ),
  )
  const errorSpy = spyOn(consola, "error")

  try {
    let thrown: unknown
    try {
      await createAnthropicMessages({
        model: "claude-opus-4.8",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toHaveProperty("response.status", 400)
    const output = JSON.stringify(errorSpy.mock.calls)
    expect(output).not.toContain(statusMarker)
    expect(output).not.toContain(bodyMarker)
  } finally {
    errorSpy.mockRestore()
  }
})

test("preserves native Messages failure metadata and exact route bytes", async () => {
  const body = new TextEncoder().encode('{"type":"future_error"}\r\n  ')
  const createUpstream = () =>
    new Response(body.slice(), {
      status: 418,
      headers: { "content-type": "application/problem+json" },
    })
  const upstream = createUpstream()
  pendingResponse = Promise.resolve(upstream)
  const payload = {
    model: "claude-opus-4.8",
    max_tokens: 16,
    messages: [{ role: "user", content: "hello" }],
  } as AnthropicMessagesPayload

  const error = await createAnthropicMessages(payload).catch(
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
        id: "claude-opus-4.8",
        name: "Claude Opus",
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
  pendingResponse = Promise.resolve(createUpstream())
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  )
  expect(response.status).toBe(418)
  expect(response.headers.get("content-type")).toBe("application/problem+json")
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
    Array.from(body),
  )
  state.models = originalModels
})

test("preserves controls already validated by the Responses bridge", async () => {
  const previousModels = state.models
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-no-effort",
        name: "Claude No Effort",
        object: "model",
        version: "1",
        capabilities: {
          family: "claude",
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }

  try {
    await createAnthropicMessages(
      {
        model: "claude-no-effort",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        output_config: { effort: "high" },
        temperature: 0.4,
      },
      { preserveValidatedControls: true },
    )

    expect(capturedBody).toMatchObject({
      output_config: { effort: "high" },
      temperature: 0.4,
    })
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.models = previousModels
  }
})

test("defaults bridge max_tokens from an advertised positive model limit", async () => {
  const previousModels = state.models
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-bridge-default",
        name: "Claude Bridge Default",
        object: "model",
        version: "1",
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 4096 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  const payload: AnthropicMessagesPayload = {
    model: "claude-bridge-default",
    messages: [{ role: "user", content: "hello" }],
  }

  try {
    await createAnthropicMessages(payload, {
      preserveValidatedControls: true,
    })

    expect(capturedBody).toHaveProperty("max_tokens", 4096)
    expect(payload).not.toHaveProperty("max_tokens")
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.models = previousModels
  }
})

test("keeps failing closed for non-JSON undefined bridge max_tokens", async () => {
  const previousModels = state.models
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-bridge-default",
        name: "Claude Bridge Default",
        object: "model",
        version: "1",
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 4096 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  const payload = {
    model: "claude-bridge-default",
    max_tokens: undefined,
    messages: [{ role: "user", content: "hello" }],
  } as unknown as AnthropicMessagesPayload

  try {
    const error = await createAnthropicMessages(payload, {
      preserveValidatedControls: true,
    }).catch((caught: unknown) => caught)

    expect(error).toHaveProperty("clientBody.error.code", "invalid_type")
    expect(error).toHaveProperty("clientBody.error.param", "body")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(payload).toHaveProperty("max_tokens", undefined)
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.models = previousModels
  }
})

test("rejects a bridge request without an explicit or advertised max_tokens", async () => {
  const previousModels = state.models
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-bridge-missing-limit",
        name: "Claude Bridge Missing Limit",
        object: "model",
        version: "1",
        capabilities: {
          family: "claude",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  const payload: AnthropicMessagesPayload = {
    model: "claude-bridge-missing-limit",
    messages: [{ role: "user", content: "hello" }],
  }

  try {
    const error = await createAnthropicMessages(payload, {
      preserveValidatedControls: true,
    }).catch((caught: unknown) => caught)
    expect(error).toHaveProperty(
      "clientBody.error.message",
      "max_tokens is required for Messages requests.",
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(payload).not.toHaveProperty("max_tokens")
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.models = previousModels
  }
})

test("preserves an explicit bridge max_tokens without catalog fallback", async () => {
  const previousModels = state.models
  state.models = undefined
  const payload: AnthropicMessagesPayload = {
    model: "claude-bridge-explicit-limit",
    max_tokens: 1,
    messages: [{ role: "user", content: "hello" }],
  }

  try {
    await createAnthropicMessages(payload, { preserveValidatedControls: true })

    expect(capturedBody).toHaveProperty("max_tokens", 1)
    expect(payload).toHaveProperty("max_tokens", 1)
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.models = previousModels
  }
})

test("defaults a missing native transport max_tokens from model metadata", async () => {
  const previousModels = state.models
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-transport-default",
        name: "Claude Transport Default",
        object: "model",
        version: "1",
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 2048 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  const payload: AnthropicMessagesPayload = {
    model: "claude-transport-default",
    messages: [
      {
        role: asAnthropicUnknownRole("system"),
        content: "bootstrap",
      },
    ],
  }

  try {
    await createAnthropicMessages(payload)

    expect(capturedBody).toMatchObject({
      model: "claude-transport-default",
      max_tokens: 2048,
      messages: [{ role: "system", content: "bootstrap" }],
    })
    expect(payload).not.toHaveProperty("max_tokens")
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.models = previousModels
  }
})

test("defaults literal null native max_tokens from model metadata", async () => {
  const previousModels = state.models
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-transport-null-default",
        name: "Claude Transport Null Default",
        object: "model",
        version: "1",
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 3072 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  const payload: AnthropicMessagesPayload = {
    model: "claude-transport-null-default",
    max_tokens: null,
    messages: [{ role: "user", content: "hello" }],
  }

  try {
    await createAnthropicMessages(payload)
    expect(capturedBody).toHaveProperty("max_tokens", 3072)
    expect(payload).toHaveProperty("max_tokens", null)
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.models = previousModels
  }
})

test("preserves an explicit zero max_tokens instead of defaulting it", async () => {
  const previousModels = state.models
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-transport-default",
        name: "Claude Transport Default",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 2048 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }

  const payload = {
    model: "claude-transport-default",
    max_tokens: 0,
    messages: [
      {
        role: asAnthropicUnknownRole("system"),
        content: "bootstrap",
      },
    ],
  } as unknown as AnthropicMessagesPayload

  try {
    await createAnthropicMessages(payload)

    expect(capturedBody).toMatchObject({
      model: "claude-transport-default",
      max_tokens: 0,
      messages: [{ role: "system", content: "bootstrap" }],
    })
  } finally {
    // eslint-disable-next-line require-atomic-updates
    state.models = previousModels
  }
})

test("preserves native fields and forwards canonical prepared headers", async () => {
  const payload = {
    model: "claude-opus-4.8",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.4,
    top_p: 0.8,
    output_config: { effort: "high", future_effort_option: true },
    cache_control: { type: "ephemeral", ttl: "5m", scope: "global" },
    fallback_credit_token: "opaque",
    future_native_field: { enabled: true },
    _gateway_compaction: true,
    _json_schema: { type: "object" },
  } as AnthropicMessagesPayload
  const originalPayload = structuredClone(payload)

  await createAnthropicMessages(payload, {
    anthropicBeta: " beta-one,beta-two, beta-one ",
    anthropicVersion: " 2023-06-01 ",
    modelProviderPreference: " anthropic ",
  })

  expect(payload).toEqual(originalPayload)
  expect(capturedBody).toMatchObject({
    temperature: 0.4,
    top_p: 0.8,
    output_config: { effort: "high", future_effort_option: true },
    cache_control: { type: "ephemeral", ttl: "5m" },
    fallback_credit_token: "opaque",
    future_native_field: { enabled: true },
  })
  expect(capturedBody).not.toHaveProperty("_gateway_compaction")
  expect(capturedBody).not.toHaveProperty("_json_schema")
  expect(capturedHeaders?.get("anthropic-beta")).toBe("beta-one,beta-two")
  expect(capturedHeaders?.get("anthropic-version")).toBe("2023-06-01")
  expect(capturedHeaders?.get("x-model-provider-preference")).toBe("anthropic")
})

test("preserves beta, anthropic version, and provider preference on transport retry", async () => {
  fetchMock
    .mockImplementationOnce((_url, init) => {
      capturedHeaderAttempts.push(new Headers(init?.headers))
      return new Response("retry", {
        status: 503,
        headers: { "retry-after": "0" },
      })
    })
    .mockImplementationOnce((_url, init) => {
      capturedHeaderAttempts.push(new Headers(init?.headers))
      return Response.json({
        id: "msg_retry_headers",
        type: "message",
        role: "assistant",
        model: "claude-opus-4.8",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

  await createAnthropicMessages(
    {
      model: "claude-opus-4.8",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    },
    {
      anthropicBeta: "beta-one, beta-two, beta-one",
      anthropicVersion: "2023-06-01",
      modelProviderPreference: "anthropic",
    },
  )

  expect(capturedHeaderAttempts).toHaveLength(2)
  for (const headers of capturedHeaderAttempts) {
    expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(headers.get("x-model-provider-preference")).toBe("anthropic")
  }
})

test.each(["unicode-βeta", "latin-é"])(
  "drops invalid beta %s before physical header dispatch",
  async (anthropicBeta) => {
    const payload = {
      model: "claude-opus-4.8",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      future_native_field: { preserved: true },
    } as AnthropicMessagesPayload

    const result = await createAnthropicMessages(payload, { anthropicBeta })

    expect(result).toHaveProperty("id", "msg_cache_control")
    expect(capturedHeaders?.get("anthropic-beta")).toBeNull()
    expect(capturedBody).toMatchObject({
      model: "claude-opus-4.8",
      future_native_field: { preserved: true },
    })
  },
)

test("retains valid beta siblings when another segment is invalid", async () => {
  const payload = {
    model: "claude-opus-4.8",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  } as AnthropicMessagesPayload

  await createAnthropicMessages(payload, {
    anthropicBeta: "safe-beta,bad\u0001beta,safe-beta",
  })

  expect(capturedHeaders?.get("anthropic-beta")).toBe("safe-beta")
})

test("uses one prepared snapshot when the caller mutates after invocation", async () => {
  let resolveResponse!: (response: Response) => void
  pendingResponse = new Promise<Response>((resolve) => {
    resolveResponse = resolve
  })
  const payload: AnthropicMessagesPayload = {
    model: "claude-opus-4.8",
    max_tokens: 64,
    messages: [{ role: "user", content: "original" }],
    stream: false,
  }

  const resultPromise = createAnthropicMessages(payload)
  payload.model = "mutated-model"
  payload.stream = true
  payload.messages[0] = { role: "user", content: "mutated" }
  resolveResponse(
    Response.json({
      id: "msg_snapshot",
      type: "message",
      role: "assistant",
      model: "claude-opus-4.8",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  )

  expect(await resultPromise).toHaveProperty("id", "msg_snapshot")
  expect(capturedBody).toMatchObject({
    model: "claude-opus-4.8",
    messages: [{ role: "user", content: "original" }],
    stream: false,
  })
})

test("fits the normalized wire body after removed cache fields are discarded", async () => {
  const removedScope = "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 1024)
  const payload = {
    model: "claude-opus-4.8",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    cache_control: {
      type: "ephemeral",
      ttl: "5m",
      scope: removedScope,
    },
  } as AnthropicMessagesPayload

  await createAnthropicMessages(payload, { compaction: true })

  expect(capturedBody).toHaveProperty("cache_control", {
    type: "ephemeral",
    ttl: "5m",
  })
  expect(JSON.stringify(capturedBody)).not.toContain(removedScope.slice(0, 100))
  expect(payload.cache_control).toHaveProperty("scope", removedScope)
})

test("fits explicitly marked native Messages compaction payloads", async () => {
  const oversizedOutput =
    "BEGIN-MESSAGES\n"
    + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
    + "\nEND-MESSAGES"

  await createAnthropicMessages(
    {
      model: "claude-opus-4.8",
      max_tokens: 64,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_messages",
              name: "exec",
              input: { input: "run messages diagnostic" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_messages",
              content: oversizedOutput,
            },
          ],
        },
      ],
    },
    { compaction: true },
  )

  const serialized = JSON.stringify(capturedBody)
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    COMPACTION_PAYLOAD_MAX_BYTES,
  )
  expect(serialized).toContain("run messages diagnostic")
  expect(serialized).toContain("call_messages")
  expect(serialized).toContain("BEGIN-MESSAGES")
  expect(serialized).toContain("END-MESSAGES")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
})
