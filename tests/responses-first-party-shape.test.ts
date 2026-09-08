import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalGithubToken = state.githubToken
const originalIsMultiToken = state.isMultiToken
const originalApiKeyAuth = state.apiKeyAuth

let upstreamBody: Record<string, unknown> | undefined
let upstreamHeaders: Headers | undefined
let copilotToken = ""
let gatewayKey = ""
let messageId = ""
let responseId = ""

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
  if (new URL(rawUrl).pathname !== "/responses") {
    throw new Error("Unexpected upstream route in first-party shape regression")
  }

  upstreamBody =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined
  upstreamHeaders = new Headers(init?.headers)

  return Response.json({
    id: responseId,
    object: "response",
    created_at: 1,
    model: "first-party-shape-model",
    output: [
      {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [] }],
      },
    ],
    output_text: "OK",
    status: "completed",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    reasoning: { effort: "low", summary: null },
    temperature: null,
    tool_choice: "none",
    tools: [],
    top_p: null,
  })
})

beforeAll(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

beforeEach(() => {
  fetchMock.mockClear()
  upstreamBody = undefined
  upstreamHeaders = undefined
  copilotToken = randomUUID()
  gatewayKey = randomUUID()
  messageId = `msg-${randomUUID()}`
  responseId = `resp-${randomUUID()}`
  state.copilotToken = copilotToken
  state.githubToken = randomUUID()
  state.apiKeyAuth = gatewayKey
  state.isMultiToken = false
  state.models = {
    object: "list",
    data: [createNativeResponsesModel()],
  } satisfies ModelsResponse
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

afterAll(() => {
  state.models = originalModels
  state.copilotToken = originalCopilotToken
  state.githubToken = originalGithubToken
  state.isMultiToken = originalIsMultiToken
  state.apiKeyAuth = originalApiKeyAuth
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
})

test("preserves a first-party Responses shape through the public route without arbitrary headers or caller mutation", async () => {
  const agentTaskId = `task-${randomUUID()}`
  const parentAgentId = `parent-${randomUUID()}`
  const interactionType = `conversation-${randomUUID()}`
  const turnMetadata = JSON.stringify({
    turn_id: `turn-${randomUUID()}`,
    request_kind: "turn",
  })
  const payload = {
    model: "first-party-shape-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with exactly OK." }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "lookup_synthetic_value",
        description: "Return a synthetic value without side effects.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: "none",
    reasoning: { effort: "low" },
    include: ["reasoning.encrypted_content"],
    client_metadata: { "x-codex-turn-metadata": turnMetadata },
    max_output_tokens: 16,
    store: false,
    stream: false,
  }
  const snapshot = structuredClone(payload)

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        "content-type": "application/json",
        "x-agent-task-id": agentTaskId,
        "x-parent-agent-id": parentAgentId,
        "x-interaction-type": interactionType,
        "x-private-probe-secret": "must-not-pass-upstream",
      },
      body: JSON.stringify(payload),
    }),
  )

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(payload).toEqual(snapshot)
  expect(upstreamBody).toEqual({
    ...snapshot,
    reasoning: { effort: "low", summary: "auto" },
  })
  expect(upstreamHeaders?.get("x-agent-task-id")).toBe(agentTaskId)
  expect(upstreamHeaders?.get("x-parent-agent-id")).toBe(parentAgentId)
  expect(upstreamHeaders?.get("x-interaction-type")).toBe(interactionType)
  expect(upstreamHeaders?.get("x-private-probe-secret")).toBeNull()
  expect(upstreamHeaders?.get("authorization")).toBe(`Bearer ${copilotToken}`)
})

function createNativeResponsesModel(): Model {
  return {
    id: "first-party-shape-model",
    name: "First-party Shape Model",
    object: "model",
    preview: false,
    vendor: "synthetic",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: {
      family: "synthetic",
      limits: { max_output_tokens: 1024 },
      object: "model_capabilities",
      supports: {
        reasoning_effort: ["low", "medium"],
        tool_calls: true,
      },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}
