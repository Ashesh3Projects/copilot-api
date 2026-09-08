import { afterEach, beforeEach, expect, test } from "bun:test"

import { setConfigForTest } from "~/lib/config"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const previous = { ...state }
const originalFetch = globalThis.fetch
const calls: Array<{ path: string; body: Record<string, unknown> }> = []

beforeEach(() => {
  calls.length = 0
  setConfigForTest({})
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: [
        {
          id: "compact",
          sourceModel: "compact-source",
          targetModel: "compact-target",
          enabled: true,
        },
      ],
    }),
  )
  Object.assign(state, {
    apiKeyAuth: undefined,
    copilotToken: "test-token",
    githubToken: "test-token",
    isMultiToken: false,
    models: {
      object: "list",
      data: ["compact-source", "compact-target"].map((id) => ({
        id,
        name: id,
        object: "model",
        version: "1",
        vendor: "openai",
        preview: false,
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt",
          limits: { max_output_tokens: 1000 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      })),
    },
  })
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON body")
    const path = new URL(input instanceof Request ? input.url : String(input))
      .pathname
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path, body })
    if (body.model === "compact-source")
      return Promise.resolve(new Response("unprocessable", { status: 422 }))
    if (path === "/v1/messages")
      return Promise.resolve(
        Response.json({
          type: "message",
          role: "assistant",
          id: "msg_compact",
          model: body.model,
          content: [{ type: "text", text: "summary" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
      )
    if (path.endsWith("/chat/completions"))
      return Promise.resolve(
        Response.json({
          id: "chat_compact",
          model: body.model,
          object: "chat.completion",
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "summary" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      )
    return Promise.resolve(
      Response.json({
        id: "resp_compact",
        model: body.model,
        object: "response",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "summary" }],
          },
        ],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      }),
    )
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, previous)
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
  setModelRedirectsForTest([])
})

function configureCompactTarget(endpoint: string): void {
  if (!state.models) throw new Error("Expected test models")
  state.models.data[1].supported_endpoints = [endpoint]
  if (endpoint !== "custom") return
  setConfigForTest({
    customProviders: [
      {
        id: "compact-custom",
        name: "Compact custom",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "test-key",
        models: [{ id: "compact-target", kind: "chat" }],
      },
    ],
  })
  state.models.data.pop()
}

test.each(["/responses", "/chat/completions", "/v1/messages", "custom"])(
  "compaction falls back to %s and remembers its client thread",
  async (endpoint) => {
    configureCompactTarget(endpoint)
    const request = () =>
      seedProtocolDatabase().then(() =>
        server.request("/v1/responses/compact", {
          method: "POST",
          headers: {
            authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
            "content-type": "application/json",
            "thread-id": "compact-thread",
          },
          body: JSON.stringify({
            model: "compact-source",
            input: [
              { type: "reasoning", id: "old-signature", summary: [] },
              { role: "user", content: "history" },
            ],
          }),
        }),
      )
    const first = await request()
    expect(first.status).toBe(200)
    const body = (await first.json()) as {
      object: string
      output: Array<{ type: string; encrypted_content: string }>
    }
    expect(body.object).toBe("response.compaction")
    expect(body.output[0].type).toBe("compaction")
    expect(
      Buffer.from(body.output[0].encrypted_content, "base64").toString(),
    ).toBe("summary")
    expect(JSON.stringify(calls[1].body)).not.toContain("old-signature")
    expect((await request()).status).toBe(200)
    expect(calls.map((entry) => entry.body.model)).toEqual([
      "compact-source",
      "compact-target",
      "compact-target",
    ])
  },
)

test.each(["/responses", "/chat/completions", "/v1/messages", "custom"])(
  "compaction rejects an incomplete %s fallback without replacing history",
  async (endpoint) => {
    configureCompactTarget(endpoint)
    const successfulFetch = globalThis.fetch
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const response = await successfulFetch(input, init)
      if (!response.ok) return response
      const result = (await response.json()) as Record<string, unknown>
      if (endpoint === "/responses") {
        result.status = "incomplete"
        result.incomplete_details = { reason: "max_output_tokens" }
      } else if (endpoint === "/v1/messages") {
        result.stop_reason = "max_tokens"
      } else {
        result.choices = [
          {
            index: 0,
            message: { role: "assistant", content: "Partial summary" },
            finish_reason: "length",
          },
        ]
      }
      return Response.json(result)
    }) as typeof fetch
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "compact-source",
          input: [{ role: "user", content: "Keep the full conversation." }],
        }),
      }),
    )
    expect(response.status).toBe(502)
    const result = (await response.json()) as {
      error: { code: string }
      output?: unknown
    }
    expect(result.error.code).toBe("compaction_summary_failed")
    expect(result.output).toBeUndefined()
    expect(calls.map((entry) => entry.body.model)).toEqual([
      "compact-source",
      "compact-target",
    ])
  },
)

test("normal Responses fallback routes the next compaction directly to the remembered model", async () => {
  const headers = {
    authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
    "content-type": "application/json",
    "thread-id": "shared-inference-compaction",
  }
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "compact-source", input: "first" }),
    }),
  )
  expect(response.status).toBe(200)
  const compact = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses/compact", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "compact-source",
        input: [{ role: "user", content: "history" }],
      }),
    }),
  )
  expect(compact.status).toBe(200)
  expect(calls.map((entry) => entry.body.model)).toEqual([
    "compact-source",
    "compact-target",
    "compact-target",
  ])
})

test("compaction resolves the same source alias used by ordinary Responses fallback", async () => {
  setModelRedirectsForTest([
    {
      id: "alias",
      sourceModel: "compact-alias",
      sourceEffort: "all",
      targetModel: "compact-source",
      enabled: true,
    },
  ])
  const headers = {
    authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
    "content-type": "application/json",
    "thread-id": "aliased-thread",
  }
  expect(
    (
      await seedProtocolDatabase().then(() =>
        server.request("/v1/responses", {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "compact-alias", input: "first" }),
        }),
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await seedProtocolDatabase().then(() =>
        server.request("/v1/responses/compact", {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "compact-alias", input: [] }),
        }),
      )
    ).status,
  ).toBe(200)
  expect(calls.map((entry) => entry.body.model)).toEqual([
    "compact-source",
    "compact-target",
    "compact-target",
  ])
})
