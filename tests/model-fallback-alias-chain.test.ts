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
const calls: Array<{ host: string; model: string }> = []
const successes = new Set<string>()

function model(id: string): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      family: "gpt",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function configure(edges: Array<[string, string]>): void {
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: edges.map(([sourceModel, targetModel], index) => ({
        id: `alias-rule-${index}`,
        sourceModel,
        targetModel,
        enabled: true,
      })),
    }),
  )
}

function post(sourceModel: string, threadId?: string) {
  return seedProtocolDatabase().then(() =>
    server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.apiKeyAuth ?? PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        ...(threadId ? { "thread-id": threadId } : {}),
      },
      body: JSON.stringify({
        model: sourceModel,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )
}

beforeEach(() => {
  calls.length = 0
  successes.clear()
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "alias-test-token",
    githubToken: "alias-test-token",
    isMultiToken: false,
    manualApprove: false,
    apiKeyAuth: undefined,
    models: {
      object: "list",
      data: [model("copilot-source"), model("shared-model")],
    },
  })
  setConfigForTest({
    customProviders: [
      {
        id: "alias-provider-one",
        name: "Alias Provider One",
        type: "openai-compatible",
        baseUrl: "https://alias-one.example/v1",
        apiKey: "alias-test-secret",
        models: [
          {
            id: "shared-model",
            aliases: ["alias-a", "alias-b"],
            kind: "chat",
          },
          { id: "other-model", kind: "chat" },
        ],
      },
      {
        id: "alias-provider-two",
        name: "Alias Provider Two",
        type: "openai-compatible",
        baseUrl: "https://alias-two.example/v1",
        apiKey: "alias-test-secret",
        models: [{ id: "shared-model", aliases: ["alias-c"], kind: "chat" }],
      },
    ],
  })
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  clearModelFallbackCache()
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected serialized inference body")
    const url = new URL(input instanceof Request ? input.url : String(input))
    const body = JSON.parse(init.body) as { model: string }
    calls.push({ host: url.hostname, model: body.model })
    if (!successes.has(`${url.hostname}:${body.model}`))
      return await Promise.resolve(
        Response.json(
          { error: { code: "alias_rejected", message: "model rejected" } },
          { status: 422 },
        ),
      )
    return Response.json({
      id: "chat_alias",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "fallback answer" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    })
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
})

test("Chat stops before an alias repeats the same custom provider model", async () => {
  configure([
    ["alias-a", "alias-b"],
    ["alias-b", "other-model"],
  ])
  const response = await post("alias-a")
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({
    error: { code: "alias_rejected" },
  })
  expect(calls).toEqual([{ host: "alias-one.example", model: "shared-model" }])
})

test("Chat stops an intermediate alias cycle without skipping to the next rule", async () => {
  configure([
    ["copilot-source", "alias-a"],
    ["alias-a", "alias-b"],
    ["alias-b", "other-model"],
  ])
  expect((await post("copilot-source")).status).toBe(422)
  expect(calls.map((call) => call.model)).toEqual([
    "copilot-source",
    "shared-model",
  ])
})

test("Chat prevents alias loops when starting from a remembered custom model", async () => {
  configure([
    ["copilot-source", "alias-a"],
    ["alias-a", "alias-b"],
  ])
  successes.add("alias-one.example:shared-model")
  expect((await post("copilot-source", "alias-conversation")).status).toBe(200)
  calls.length = 0
  successes.clear()
  expect((await post("copilot-source", "alias-conversation")).status).toBe(422)
  expect(calls).toEqual([{ host: "alias-one.example", model: "shared-model" }])
})

test("Chat permits the same upstream model name at a different custom provider", async () => {
  configure([["alias-a", "alias-c"]])
  successes.add("alias-two.example:shared-model")
  expect((await post("alias-a")).status).toBe(200)
  expect(calls).toEqual([
    { host: "alias-one.example", model: "shared-model" },
    { host: "alias-two.example", model: "shared-model" },
  ])
})

test("Chat distinguishes a Copilot model from an explicit custom alias with the same upstream name", async () => {
  configure([["shared-model", "alias-a"]])
  successes.add("alias-one.example:shared-model")
  expect((await post("shared-model")).status).toBe(200)
  expect(calls).toHaveLength(2)
  expect(calls[0].host).not.toBe("alias-one.example")
  expect(calls[1]).toEqual({
    host: "alias-one.example",
    model: "shared-model",
  })
})
