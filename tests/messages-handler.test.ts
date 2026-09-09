/* eslint-disable max-lines */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
let lastUpstreamPayload: ChatCompletionsPayload | undefined
let lastUpstreamHeaders: Headers | undefined
let lastUpstreamUrl: string | undefined
let upstreamResponseOverride: Response | undefined

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

const upstreamMaxReasoningModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {
          max_thinking_budget: 32000,
          min_thinking_budget: 1024,
          reasoning_effort: ["low", "medium", "high", "max"],
        },
        tokenizer: "cl100k_base",
        type: "chat",
      },
      supported_endpoints: ["/chat/completions"],
    },
  ],
}

const upstreamThinkingBudgetModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 64000 },
        object: "model_capabilities",
        supports: {
          max_thinking_budget: 32000,
          min_thinking_budget: 1024,
          reasoning_effort: ["low", "medium", "high", "max"],
        },
        tokenizer: "cl100k_base",
        type: "chat",
      },
      supported_endpoints: ["/chat/completions"],
    },
  ],
}

const nativeMessagesModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 64000 },
        object: "model_capabilities",
        supports: {
          max_thinking_budget: 32000,
          min_thinking_budget: 1024,
          reasoning_effort: ["low", "medium", "high", "max"],
        },
        tokenizer: "cl100k_base",
        type: "chat",
      },
      supported_endpoints: ["/v1/messages", "/chat/completions"],
    },
  ],
}

const responsesOnlyMessagesModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-responses-only",
      name: "GPT Responses Only",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "gpt",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
      supported_endpoints: ["/responses"],
    },
  ],
}

const toolReferenceTurn = {
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: "toolu_search",
      content: [{ type: "tool_reference", tool_name: "Bash" }],
    },
    { type: "text", text: "Tool loaded." },
  ],
}

function parseRequestBody(init?: RequestInit): ChatCompletionsPayload {
  if (typeof init?.body !== "string") {
    return {} as ChatCompletionsPayload
  }

  return JSON.parse(init.body) as ChatCompletionsPayload
}

const fetchMock = mock((url: string, init?: RequestInit) => {
  lastUpstreamUrl = url
  lastUpstreamPayload = parseRequestBody(init)
  lastUpstreamHeaders = new Headers(init?.headers)
  if (upstreamResponseOverride) return upstreamResponseOverride

  // The native Anthropic endpoint returns Messages-shaped bodies; every other
  // path returns chat.completion. Match on URL so both routes parse cleanly.
  if (typeof url === "string" && url.includes("/v1/messages")) {
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4.8",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  }

  if (typeof url === "string" && url.includes("/responses")) {
    return Response.json({
      id: "resp_messages_header",
      object: "response",
      created_at: 1,
      model: "gpt-responses-only",
      output: [
        {
          id: "msg_responses_header",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
      output_text: "hello",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    })
  }

  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hello",
          },
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
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )
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
  lastUpstreamPayload = undefined
  lastUpstreamHeaders = undefined
  lastUpstreamUrl = undefined
  upstreamResponseOverride = undefined
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
        name: "gpt-4o",
        object: "model",
        version: "1",
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
      {
        id: "claude-target-1m",
        name: "claude-target-1m",
        object: "model",
        version: "1",
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
      {
        id: "claude-opus-4.7-1m-internal",
        name: "claude-opus-4.7-1m-internal",
        object: "model",
        version: "1",
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
      {
        id: "claude-implicit-medium",
        name: "claude-implicit-medium",
        object: "model",
        version: "1",
        supported_endpoints: ["/chat/completions"],
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test.each([
  {
    name: "null body",
    body: "null",
    message: "The Messages request body must be a JSON object.",
    code: "invalid_type",
    param: "body",
  },
  {
    name: "array body",
    body: "[]",
    message: "The Messages request body must be a JSON object.",
    code: "invalid_type",
    param: "body",
  },
  {
    name: "blank model",
    body: JSON.stringify({
      model: " ",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 1,
    }),
    message: "model is required for Messages requests.",
    code: "invalid_value",
    param: "model",
  },
  {
    name: "missing model",
    body: JSON.stringify({
      messages: [{ role: "user", content: "x" }],
      max_tokens: 1,
    }),
    message: "model is required for Messages requests.",
    code: "invalid_value",
    param: "model",
  },
  {
    name: "empty messages",
    body: JSON.stringify({ model: "claude", messages: [], max_tokens: 1 }),
    message: "messages is required for Messages requests.",
    code: "invalid_value",
    param: "messages",
  },
  {
    name: "missing messages",
    body: JSON.stringify({ model: "claude", max_tokens: 1 }),
    message: "messages is required for Messages requests.",
    code: "invalid_value",
    param: "messages",
  },
] as const)(
  "rejects public Messages $name before upstream dispatch",
  async ({ body, code, message, param }) => {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body,
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", code, message, param },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test.each([
  ["primitive message entry", { messages: [null] }, "messages"],
  [
    "primitive content entry",
    { messages: [{ role: "user", content: [null] }] },
    "content",
  ],
  [
    "non-string text",
    { messages: [{ role: "user", content: [{ type: "text", text: 3 }] }] },
    "content",
  ],
  [
    "invalid image source",
    {
      messages: [{ role: "user", content: [{ type: "image", source: null }] }],
    },
    "source",
  ],
  [
    "non-string tool id",
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: 2, name: "x", input: {} }],
        },
      ],
    },
    "content",
  ],
  ["non-string tool name", { tools: [{ name: 3, input_schema: {} }] }, "tools"],
] as const)(
  "best-effort handles malformed valid-JSON Messages %s before upstream dispatch",
  async (_name, extra, _param) => {
    state.models = structuredClone(nativeMessagesModels)
    Object.assign(state.models.data[0], {
      id: "claude-opus-4.6",
      name: "Claude Opus 4.6",
    })
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-4.6",
          messages: [{ role: "user", content: "x" }],
          max_tokens: 1,
          ...extra,
        }),
      }),
    )

    if (_name === "primitive message entry") {
      expect(response.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    } else {
      expect(response.status).toBe(200)
      expect(lastUpstreamUrl).toContain("/v1/messages")
      expect(fetchMock).toHaveBeenCalled()
    }
  },
)

test("preserves a forward-compatible native content record", async () => {
  state.models = structuredClone(nativeMessagesModels)
  const futureBlock = {
    type: "future_native_block_20270101",
    future_payload: { enabled: true },
  }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        messages: [{ role: "user", content: [futureBlock] }],
        max_tokens: 1,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload).toHaveProperty(
    "messages.0.content.0",
    futureBlock,
  )
})

test("preserves system and future roles plus unknown native tool and top-level fields", async () => {
  state.models = structuredClone(nativeMessagesModels)
  const futureBlock = {
    type: "future_native_block_20270101",
    future_payload: { enabled: true },
  }
  const futureSystemBlock = {
    type: "future_system_block_20270101",
    future_payload: { enabled: true },
  }
  const futureTool = {
    name: "lookup",
    future_tool_field: { enabled: true },
  }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        system: [futureSystemBlock],
        messages: [
          { role: "system", content: "bootstrap" },
          { role: "future-role", content: [futureBlock] },
        ],
        tools: [futureTool],
        future_native_field: { enabled: true },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/v1/messages")
  expect(lastUpstreamPayload).toMatchObject({
    system: [futureSystemBlock],
    messages: [
      { role: "system", content: "bootstrap" },
      { role: "future-role", content: [futureBlock] },
    ],
    tools: [futureTool],
    future_native_field: { enabled: true },
  })
})

test("preserves unnamed future native tool records on the messages route", async () => {
  state.models = structuredClone(nativeMessagesModels)
  const futureTool = {
    type: "future_server_tool_20270101",
    config: { enabled: true, nested: { mode: "opaque" } },
  }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 1,
        tools: [futureTool],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/v1/messages")
  expect(lastUpstreamPayload).toMatchObject({
    tools: [futureTool],
  })
})

test.each([
  [
    "opaque native tool records without name or type",
    {
      opaque: {
        enabled: true,
        nested: { mode: "opaque" },
      },
    },
  ],
  [
    "future native tool records with numeric names",
    {
      type: "future_server_tool_20270101",
      name: 3,
      config: { enabled: true, nested: { mode: "opaque" } },
    },
  ],
  [
    "future native tool records with blank names",
    {
      type: "future_server_tool_20270101",
      name: "   ",
      config: { enabled: true, nested: { mode: "opaque" } },
    },
  ],
] as const)(
  "preserves %s on the messages route",
  async (_label, futureTool) => {
    state.models = structuredClone(nativeMessagesModels)

    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-4.8",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1,
          tools: [futureTool],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(lastUpstreamUrl).toContain("/v1/messages")
    expect(lastUpstreamPayload).toMatchObject({
      tools: [futureTool],
    })
  },
)

test("drops malformed optional controls and invalid optional Anthropic headers", async () => {
  state.models = structuredClone(nativeMessagesModels)

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "anthropic-beta": "PRIVATE_BAD_BETA value",
        "anthropic-version": "PRIVATE_BAD_VERSION\u007f",
        "x-model-provider-preference": "PRIVATE_BAD_PROVIDER\u007f",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        messages: [{ role: "user", content: "hello" }],
        metadata: "private",
        tool_choice: null,
        cache_control: "ephemeral",
        thinking: true,
        output_config: "high",
        system: ["not-a-block"],
        stop_sequences: ["good", 3],
        top_p: "0.8",
        stream: "yes",
        fallback_credit_token: 42,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload).toEqual({
    model: "claude-opus-4.8",
    max_tokens: 64000,
    messages: [{ role: "user", content: "hello" }],
  })
  expect(lastUpstreamHeaders?.get("anthropic-beta")).toBeNull()
  expect(lastUpstreamHeaders?.get("anthropic-version")).toBe("2023-06-01")
  expect(lastUpstreamHeaders?.get("x-model-provider-preference")).toBeNull()
})

test("fills a missing native max_tokens from model metadata at transport time", async () => {
  state.models = structuredClone(nativeMessagesModels)

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload).toMatchObject({
    model: "claude-opus-4.8",
    max_tokens: 64000,
    messages: [{ role: "user", content: "hello" }],
  })
})

test("strips Claude diagnostics before native Messages dispatch", async () => {
  state.models = structuredClone(nativeMessagesModels)

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "adaptive" },
        context_management: {
          edits: [{ type: "clear_thinking_20251015", keep: "all" }],
        },
        output_config: { effort: "xhigh" },
        diagnostics: { previous_message_id: null },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(lastUpstreamPayload).not.toHaveProperty("diagnostics")
  expect(lastUpstreamPayload).toMatchObject({
    thinking: { type: "adaptive" },
    output_config: { effort: "xhigh" },
    context_management: {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    },
  })
})

test("allows chat fallback requests without max_tokens", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload).toMatchObject({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
  })
  expect(lastUpstreamPayload).not.toHaveProperty("max_tokens")
})

test("rejects malformed public Messages JSON before upstream dispatch", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: '{"model":',
    }),
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "invalid_json",
      message: "The Messages request body must contain valid JSON.",
      param: "body",
    },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("returns the exact upstream body for a non-stream Messages failure", async () => {
  upstreamResponseOverride = Response.json(
    { error: { message: "messages-upstream-private-marker" } },
    { status: 400, statusText: "messages-status-private-marker" },
  )

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "x-request-id": "req-messages-safe",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    }),
  )
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toBe(
    "application/json;charset=utf-8",
  )
  expect(body).toBe('{"error":{"message":"messages-upstream-private-marker"}}')
  expect(body).not.toContain("messages-status-private-marker")
  expect(body).not.toContain("req-messages-safe")
})

test("removes top_p when thinking is enabled on the chat completions path", async () => {
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
        top_p: 0.2,
        thinking: { type: "enabled" },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.temperature).toBe(1)
  expect(lastUpstreamPayload?.top_p).toBeUndefined()
})

test("prepared Chat fallback applies replacements before selection exactly once", async () => {
  const { setReplacementsForTest } = await import("../src/lib/auto-replace")
  setReplacementsForTest([
    {
      id: "review-replacement",
      pattern: "PRIVATE_PREPARED_CHAT",
      replacement: "MUTATED_AFTER_SELECTION",
      isRegex: false,
      enabled: true,
    },
  ])
  try {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "PRIVATE_PREPARED_CHAT" }],
          max_tokens: 32,
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(JSON.stringify(lastUpstreamPayload)).not.toContain(
      "PRIVATE_PREPARED_CHAT",
    )
    expect(JSON.stringify(lastUpstreamPayload)).toContain(
      "MUTATED_AFTER_SELECTION",
    )
  } finally {
    setReplacementsForTest([])
  }
})

test("routes PDF documents to native /v1/messages and preserves thinking blocks", async () => {
  state.models = nativeMessagesModels
  const pdfB64 = Buffer.from("%PDF-1.4 regression test").toString("base64")

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        thinking: { type: "enabled" },
        messages: [
          { role: "user", content: "Hi, I have a document." },
          {
            role: "assistant",
            content: [
              // Foreign (OpenAI-format) signature from a prior /chat/completions
              // turn — invalid on the native Anthropic endpoint.
              {
                type: "thinking",
                thinking: "hmm",
                signature: "b2FpX2ZvcmVpZ24=",
              },
              { type: "text", text: "Sure, share it." },
            ],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize this." },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfB64,
                },
              },
            ],
          },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  // Routed to the native Anthropic endpoint, not /chat/completions
  expect(lastUpstreamUrl).toContain("/v1/messages")

  const messages =
    (lastUpstreamPayload as { messages?: Array<{ content?: unknown }> })
      .messages ?? []
  const blocks = messages.flatMap((m) =>
    Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : [],
  )
  expect(blocks.some((b) => b.type === "thinking")).toBe(true)
  expect(blocks.some((b) => b.type === "document")).toBe(true)
})

test("forwards canonical beta, anthropic version, and provider preference on native Messages", async () => {
  state.models = nativeMessagesModels
  const pdfB64 = Buffer.from("%PDF-1.4 native header regression").toString(
    "base64",
  )

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "anthropic-beta":
          " advanced-tool-use-2025-11-20, fallback-credit-2026-07-01, advanced-tool-use-2025-11-20 ",
        "anthropic-version": "2023-06-01",
        "x-model-provider-preference": "anthropic",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Read this document." },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfB64,
                },
              },
            ],
          },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/v1/messages")
  expect(lastUpstreamHeaders?.get("anthropic-beta")).toBe(
    "advanced-tool-use-2025-11-20,fallback-credit-2026-07-01",
  )
  expect(lastUpstreamHeaders?.get("anthropic-version")).toBe("2023-06-01")
  expect(lastUpstreamHeaders?.get("x-model-provider-preference")).toBe(
    "anthropic",
  )
})

test("filters Claude Desktop beta flags and client-only headers on native Messages", async () => {
  state.models = nativeMessagesModels
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "anthropic-beta":
          "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,tool-search-tool-2025-10-19,effort-2025-11-24",
        "anthropic-version": "2023-06-01",
        "x-client-machine-id": "desktop-header-test",
        cookie: "client-only-cookie",
        "x-stainless-runtime": "node",
        "x-unreviewed-header": "client-only-value",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/v1/messages")
  expect(lastUpstreamHeaders?.get("anthropic-beta")).toBe(
    "claude-code-20250219,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20",
  )
  expect(lastUpstreamHeaders?.get("x-client-machine-id")).toBe(
    "desktop-header-test",
  )
  expect(lastUpstreamHeaders?.get("cookie")).toBeNull()
  expect(lastUpstreamHeaders?.get("x-stainless-runtime")).toBeNull()
  expect(lastUpstreamHeaders?.get("x-unreviewed-header")).toBeNull()
})

test("forwards native Messages headers when a dual-endpoint model selects native", async () => {
  state.models = nativeMessagesModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "anthropic-beta": "advanced-tool-use-2025-11-20",
        "anthropic-version": "2024-01-01",
        "x-model-provider-preference": "anthropic",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        messages: [{ role: "user", content: "Use the native branch." }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/v1/messages")
  expect(lastUpstreamHeaders?.get("anthropic-beta")).toBe(
    "advanced-tool-use-2025-11-20",
  )
  expect(lastUpstreamHeaders?.get("anthropic-version")).toBe("2024-01-01")
  expect(lastUpstreamHeaders?.get("x-model-provider-preference")).toBe(
    "anthropic",
  )
})

test("forwards only matching model-scoped session tokens on Messages inference", async () => {
  state.models = nativeMessagesModels
  const matchingToken = sessionToken({ selected_model: "claude-opus-4.8" })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": matchingToken,
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBe(matchingToken)

  const binaryToken = binarySessionToken({ selected_model: "claude-opus-4.8" })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": binaryToken,
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        messages: [{ role: "user", content: "binary opaque segments" }],
      }),
    }),
  )
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBe(binaryToken)

  for (const token of [
    sessionToken({ selected_model: "different-model" }),
    "malformed-token",
    ...invalidSessionTokens("claude-opus-4.8"),
  ]) {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
          "copilot-session-token": token,
        },
        body: JSON.stringify({
          model: "claude-opus-4.8",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(lastUpstreamHeaders?.get("copilot-session-token")).toBeNull()
    expect(lastUpstreamHeaders?.get("authorization")).toBe(
      "Bearer copilot-token",
    )
  }

  const redirectedModel = structuredClone(nativeMessagesModels.data[0])
  redirectedModel.id = "claude-opus-4.7"
  redirectedModel.name = "Claude Opus 4.7"
  state.models = { object: "list", data: [redirectedModel] }
  setModelRedirectsForTest([
    {
      id: "messages-session-token-redirect",
      sourceModel: "claude-opus-4.8",
      targetModel: "claude-opus-4.7",
      enabled: true,
    },
  ])
  const redirectedToken = sessionToken({
    selected_model: "claude-opus-4.7",
    available_models: ["claude-opus-4.8", "claude-opus-4.7"],
  })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": redirectedToken,
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )
  expect(lastUpstreamPayload?.model).toBe("claude-opus-4.7")
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBeNull()

  setModelRedirectsForTest([])
  state.models = nativeMessagesModels
  const aliasToken = sessionToken({ selected_model: "claude-opus-4.8" })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": aliasToken,
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 64,
        messages: [{ role: "user", content: "ordinary alias" }],
      }),
    }),
  )
  expect(lastUpstreamPayload?.model).toBe("claude-opus-4.8")
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBe(aliasToken)

  setModelRedirectsForTest([
    {
      id: "messages-alias-chain-1",
      sourceModel: "claude-opus-4.8",
      targetModel: "claude-alias-middle",
      enabled: true,
    },
    {
      id: "messages-alias-chain-2",
      sourceModel: "claude-alias-middle",
      targetModel: "claude-opus-4-8",
      enabled: true,
    },
  ])
  const rawAliasModel = structuredClone(nativeMessagesModels.data[0])
  rawAliasModel.id = "claude-opus-4-8"
  state.models = { object: "list", data: [rawAliasModel] }
  await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": aliasToken,
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 64,
        messages: [{ role: "user", content: "configured alias redirect" }],
      }),
    }),
  )
  expect(lastUpstreamPayload?.model).toBe("claude-opus-4-8")
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBeNull()
})

test("does not forward native Messages headers to a Responses branch", async () => {
  state.models = responsesOnlyMessagesModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "anthropic-beta": "advanced-tool-use-2025-11-20",
        "anthropic-version": "2024-01-01",
        "x-model-provider-preference": "anthropic",
      },
      body: JSON.stringify({
        model: "gpt-responses-only",
        max_tokens: 64,
        messages: [{ role: "user", content: "Use the Responses branch." }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/responses")
  expect(lastUpstreamHeaders?.get("anthropic-beta")).toBeNull()
  expect(lastUpstreamHeaders?.get("anthropic-version")).toBeNull()
  expect(lastUpstreamHeaders?.get("x-model-provider-preference")).toBeNull()
})

test("applies redirect verbosity to a Messages request routed through Responses", async () => {
  state.models = responsesOnlyMessagesModels
  setModelRedirectsForTest([
    {
      id: "messages-to-responses-verbosity",
      sourceModel: "gpt-responses-only",
      sourceEffort: "all",
      targetModel: "gpt-responses-only",
      targetVerbosity: "high",
      enabled: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-responses-only",
        max_tokens: 64,
        messages: [{ role: "user", content: "Explain this." }],
        output_config: { format: { type: "json_object" } },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/responses")
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)?.text,
  ).toEqual({
    format: { type: "json_object" },
    verbosity: "high",
  })
})

test("routes forward-compatible Messages through Responses when native delivery is unavailable", async () => {
  state.models = responsesOnlyMessagesModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-responses-only",
        max_tokens: 64,
        messages: [
          {
            role: "future-role",
            content: [
              {
                type: "future_native_block_20270101",
                future_payload: { enabled: true },
              },
              { type: "image", source: null },
            ],
          },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/responses")
})

test("preserves ToolSearch tool references on the native messages route", async () => {
  state.models = nativeMessagesModels
  const pdfB64 = Buffer.from("%PDF-1.4 tool reference regression").toString(
    "base64",
  )

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        tools: [
          {
            name: "Bash",
            description: "Run a shell command",
            input_schema: { type: "object", properties: {} },
            defer_loading: true,
          },
          {
            name: "ToolSearch",
            description: "Load deferred tools",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
          {
            name: "DeferredToolPlaceholder",
            description: "Keep deferred tool loading active",
            input_schema: { type: "object", properties: {} },
            defer_loading: true,
          },
        ],
        messages: [
          { role: "user", content: "Load Bash before reading the document." },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_search",
                name: "ToolSearch",
                input: { query: "select:Bash" },
              },
            ],
          },
          toolReferenceTurn,
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize this." },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfB64,
                },
              },
            ],
          },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/v1/messages")
  const messages =
    (
      lastUpstreamPayload as unknown as {
        messages?: Array<{ content?: unknown; role: string }>
      }
    ).messages ?? []
  const toolSearchTurn = messages.find(
    (message) =>
      Array.isArray(message.content)
      && message.content.some(
        (block: unknown) =>
          isToolResultBlock(block) && block.tool_use_id === "toolu_search",
      ),
  )

  expect(toolSearchTurn?.content).toEqual([
    {
      type: "tool_result",
      tool_use_id: "toolu_search",
      content: [{ type: "tool_reference", tool_name: "Bash" }],
    },
    { type: "text", text: "Tool loaded." },
  ])
})

test("routes ToolSearch references to native messages without a PDF", async () => {
  state.models = nativeMessagesModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64,
        messages: [toolReferenceTurn],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/v1/messages")
})

test("continues merging sibling text into ordinary tool results", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 32,
        messages: [
          { role: "user", content: "Run the parser." },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_parser",
                name: "parse",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_parser",
                content: "parsed",
              },
              { type: "text", text: "Use that result." },
            ],
          },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const messages = lastUpstreamPayload?.messages ?? []
  const toolMessage = messages.find(
    (message) =>
      message.role === "tool" && message.tool_call_id === "toolu_parser",
  )
  expect(toolMessage?.content).toBe("parsed\n\nUse that result.")
})

function isToolResultBlock(
  value: unknown,
): value is { tool_use_id: string; type: "tool_result" } {
  return (
    typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "tool_result"
    && "tool_use_id" in value
    && typeof value.tool_use_id === "string"
  )
}

test("forwards native thinking budgets above the advertised model limit", async () => {
  state.models = nativeMessagesModels
  const pdfB64 = Buffer.from("%PDF-1.4 regression test").toString("base64")

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64000,
        thinking: { type: "enabled", budget_tokens: 63999 },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize this." },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfB64,
                },
              },
            ],
          },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/v1/messages")
  expect(
    (
      lastUpstreamPayload as
        | { thinking?: { budget_tokens?: number } }
        | undefined
    )?.thinking?.budget_tokens,
  ).toBe(63999)
})

test("forwards native thinking budgets below the advertised model minimum", async () => {
  state.models = nativeMessagesModels
  const pdfB64 = Buffer.from("%PDF-1.4 regression test").toString("base64")

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        max_tokens: 64000,
        thinking: { type: "enabled", budget_tokens: 1 },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize this." },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfB64,
                },
              },
            ],
          },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamUrl).toContain("/v1/messages")
  expect(
    (
      lastUpstreamPayload as
        | { thinking?: { budget_tokens?: number } }
        | undefined
    )?.thinking?.budget_tokens,
  ).toBe(1)
})

test("maps output_config.effort onto chat completions reasoning_effort", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Think carefully." }],
        max_tokens: 32,
        thinking: { type: "enabled" },
        output_config: { effort: "max" },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("max")
})

test("maps literal xhigh output_config.effort onto chat completions reasoning_effort", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Think carefully." }],
        max_tokens: 32,
        thinking: { type: "enabled" },
        output_config: { effort: "xhigh" },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("xhigh")
})

test("passes max reasoning through when upstream metadata advertises max", async () => {
  state.models = upstreamMaxReasoningModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.6:max",
        messages: [{ role: "user", content: "Think carefully." }],
        max_tokens: 32,
        thinking: { type: "enabled" },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-sonnet-4.6")
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("max")
})

test("defaults chat completions reasoning_effort to medium when thinking is enabled", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Think carefully." }],
        max_tokens: 32,
        thinking: { type: "enabled" },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("medium")
})

test("forwards chat completions thinking budgets above the advertised model limit", async () => {
  state.models = upstreamThinkingBudgetModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "Think carefully." }],
        max_tokens: 64000,
        thinking: { type: "enabled", budget_tokens: 63999 },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.thinking_budget,
  ).toBe(63999)
})

test("forwards chat completions thinking budgets below the advertised model minimum", async () => {
  state.models = upstreamThinkingBudgetModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "Think carefully." }],
        max_tokens: 64000,
        thinking: { type: "enabled", budget_tokens: 1 },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.thinking_budget,
  ).toBe(1)
})

test("forwards chat completions thinking budgets when upstream limits are unknown", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Think carefully." }],
        max_tokens: 64000,
        thinking: { type: "enabled", budget_tokens: 63999 },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.thinking_budget,
  ).toBe(63999)
})

test("redirects unsupported Anthropic high-effort model suffixes before upstream", async () => {
  setModelRedirectsForTest([
    {
      id: "source-high",
      sourceModel: "claude-source-1m",
      sourceEffort: "high",
      targetModel: "claude-target-1m",
      targetEffort: "high",
      enabled: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-source-1m:high",
        messages: [{ role: "user", content: "Think carefully." }],
        max_tokens: 32,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-target-1m")
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("high")
})

test("rewrites final assistant message after model redirects when prefill is unsupported", async () => {
  setModelRedirectsForTest([
    {
      id: "opus-48-to-47",
      sourceModel: "claude-opus-4.8",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "internal-xhigh",
      sourceModel: "claude-opus-4.7-1m-internal",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      targetEffort: "xhigh",
      enabled: true,
    },
  ])
  setModelSettingsForTest([
    {
      model: "claude-opus-4.7-1m-internal",
      supportsAssistantPrefill: false,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.8",
        messages: [
          { role: "user", content: "Help me investigate an error." },
          {
            role: "assistant",
            content:
              "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded - calling them directly will fail with InputValidationError.",
          },
        ],
        max_tokens: 32,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-opus-4.7-1m-internal")
  expect(lastUpstreamPayload?.messages).toEqual([
    { role: "user", content: "Help me investigate an error." },
    {
      role: "user",
      content:
        "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded - calling them directly will fail with InputValidationError.",
    },
  ])
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("xhigh")
})

test("applies final self-redirect effort on direct chat completions requests", async () => {
  state.models = structuredClone(upstreamMaxReasoningModels)
  Object.assign(state.models.data[0], {
    id: "claude-opus-4.7-1m-internal",
    supported_endpoints: undefined,
  })
  setModelSettingsForTest([
    {
      model: "claude-opus-4.7-1m-internal",
      supportedReasoningEfforts: ["low", "medium", "high", "max", "xhigh"],
    },
  ])
  setModelRedirectsForTest([
    {
      id: "opus-47-to-internal",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "internal-xhigh",
      sourceModel: "claude-opus-4.7-1m-internal",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      targetEffort: "xhigh",
      enabled: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4.7:low",
        messages: [{ role: "user", content: "Think carefully." }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-opus-4.7-1m-internal")
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("xhigh")
})

test("does not send custom reasoning effort for implicit-default models", async () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-implicit-medium:high",
        messages: [{ role: "user", content: "Think carefully." }],
        max_tokens: 32,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-implicit-medium")
  expect(lastUpstreamPayload?.temperature).toBe(1)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBeUndefined()
})

test("strips custom reasoning effort for direct implicit-default chat completions", async () => {
  state.models = structuredClone(upstreamMaxReasoningModels)
  Object.assign(state.models.data[0], {
    id: "claude-implicit-medium",
    supported_endpoints: undefined,
  })
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-implicit-medium:high",
        messages: [{ role: "user", content: "Think carefully." }],
        reasoning_effort: "high",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-implicit-medium")
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBeUndefined()
})
