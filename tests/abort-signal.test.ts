import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
let lastSignal: AbortSignal | null | undefined

const chatCompletionsResponse = {
  id: "chatcmpl-1",
  object: "chat.completion" as const,
  created: 1,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant" as const,
        content: "hello",
      },
      finish_reason: "stop" as const,
      logprobs: null,
    },
  ],
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  },
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

const messagesOnlyResponsesModels: ModelsResponse = {
  object: "list",
  data: [
    {
      ...responsesCapableModels.data[0],
      id: "claude-messages-only",
      name: "claude-messages-only",
      vendor: "anthropic",
      supported_endpoints: ["/v1/messages"],
      capabilities: {
        ...responsesCapableModels.data[0].capabilities,
        family: "claude",
      },
    },
  ],
}

const fetchMock = mock((url: string, init?: RequestInit) => {
  lastSignal = init?.signal

  let body: unknown = chatCompletionsResponse
  if (url.includes("/v1/messages")) {
    body = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-messages-only",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  } else if (url.includes("/responses")) {
    body = responsesResult
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
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
  lastSignal = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        ...responsesCapableModels.data[0],
        id: "gpt-4o",
        name: "gpt-4o",
        supported_endpoints: ["/chat/completions"],
      },
    ],
  }
})

test("passes the client abort signal to messages upstream requests", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
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
  expect(lastSignal).toBeInstanceOf(AbortSignal)
})

test("passes the client abort signal to responses upstream requests", async () => {
  state.models = responsesCapableModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: "Hello",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastSignal).toBeInstanceOf(AbortSignal)
})

test("passes the client abort signal to Responses Messages fallback requests", async () => {
  state.models = messagesOnlyResponsesModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-messages-only",
        input: "Hello",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastSignal).toBeInstanceOf(AbortSignal)
})

test("preserves native Codex web search on the Responses path", async () => {
  state.models = responsesCapableModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: "What changed today?",
        tools: [
          {
            type: "web_search",
            external_web_access: true,
            search_context_size: "high",
            filters: { allowed_domains: ["example.com"] },
          },
        ],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
  const body = JSON.parse(
    typeof request.body === "string" ? request.body : "{}",
  ) as {
    tools?: Array<Record<string, unknown>>
  }
  expect(body.tools?.[0]).toEqual({
    type: "web_search",
    external_web_access: true,
    search_context_size: "high",
    filters: { allowed_domains: ["example.com"] },
  })
})

test("passes the client abort signal to Google AI upstream requests", async () => {
  state.models = responsesCapableModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/models/gpt-4o-mini:generateContent", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 32 },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastSignal).toBeInstanceOf(AbortSignal)
})
