import { afterEach, beforeEach, expect, test } from "bun:test"

import type { CustomProviderConfig } from "~/lib/config"
import type { EmbeddingResponse } from "~/services/copilot/create-embeddings"

import { setConfigForTest } from "~/lib/config"
import {
  clearLlmDebugLogs,
  listLlmDebugLogs,
  startLlmDebugLog,
} from "~/lib/llm-debug-log"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"

import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
} from "./helpers/admin-session"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

const originalFetch = globalThis.fetch
const originalState = { ...state }
const requests: Array<Request> = []
const provider: CustomProviderConfig = {
  id: "compat-provider",
  name: "Compatibility provider",
  type: "openai-compatible",
  baseUrl: "https://provider.example/v1",
  apiKey: "first-key",
  models: [
    { id: "provider-chat", kind: "chat" },
    { id: "provider-embedding", kind: "embedding", dimensions: 4 },
  ],
}
let embedding: Array<number> | string = [1, 2, 3, 4]

useProtocolDatabase()

beforeEach(async () => {
  requests.length = 0
  await clearLlmDebugLogs()
  embedding = [1, 2, 3, 4]
  setConfigForTest({
    auth: { apiKeys: [] },
    extraPrompts: {},
    customProviders: [provider],
  })
  Object.assign(state, {
    apiKeyAuth: undefined,
    isMultiToken: false,
    copilotToken: "gho_compat_fake",
    githubToken: undefined,
    models: { object: "list", data: [] },
  })
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request ?
        new Request(input, init)
      : new Request(input.toString(), init)
    await Promise.resolve()
    requests.push(request)
    if (request.url.endsWith("/embeddings"))
      return Response.json({
        object: "list",
        model: "provider-embedding",
        data: [{ object: "embedding", index: 0, embedding }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })
    return Response.json({
      id: "provider-result",
      object: "chat.completion",
      created: 1,
      model: "provider-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "provider answer" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await resetTestAdminSession()
  Object.assign(state, originalState)
  setConfigForTest(null)
})

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  protocolRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

test("base64 embeddings preserve the wire representation with correct vector dimensions", async () => {
  embedding = Buffer.from(new Float32Array([1, 2, 3, 4]).buffer).toString(
    "base64",
  )
  const result = await post("/v1/embeddings", {
    model: "provider-embedding",
    input: "hello",
    encoding_format: "base64",
  })
  expect(result.status).toBe(200)
  const body = (await result.json()) as EmbeddingResponse
  expect(body.data[0].embedding).toBe(embedding)
})

test("custom embeddings accept the requested reduced dimensions", async () => {
  embedding = [1, 2]
  const result = await post("/v1/embeddings", {
    model: "provider-embedding",
    input: "hello",
    dimensions: 2,
  })
  expect(result.status).toBe(200)
  expect(
    ((await result.json()) as EmbeddingResponse).data[0].embedding,
  ).toEqual([1, 2])
})

test("wrong encoded embedding dimensions are still reported", async () => {
  embedding = Buffer.from(new Float32Array([1, 2]).buffer).toString("base64")
  const result = await post("/v1/embeddings", {
    model: "provider-embedding",
    input: "hello",
    encoding_format: "base64",
  })
  expect(result.status).toBe(502)
})

test("dashboard replays a provider log to the same provider with fresh credentials", async () => {
  const body = {
    model: "provider-chat",
    messages: [{ role: "user", content: "private prompt" }],
  }
  expect((await post("/v1/chat/completions", body)).status).toBe(200)
  const log = (await listLlmDebugLogs()).entries[0]
  expect(log).toBeDefined()
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [{ ...provider, apiKey: "rotated-key" }],
  })
  const admin = await createTestAdminSession({ reuseStorage: true })
  requests.length = 0
  const replay = await post(
    `/dashboard/api/llm-debug/${log.id}/replay`,
    { body },
    adminHeaders(admin),
  )
  expect(replay.status).toBe(200)
  expect(((await replay.json()) as { status: number }).status).toBe(200)
  expect(requests[0]?.url).toBe("https://provider.example/v1/chat/completions")
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer rotated-key")
})

test("removed custom providers cannot redirect a replay to Copilot", async () => {
  const body = {
    model: "provider-chat",
    messages: [{ role: "user", content: "private prompt" }],
  }
  await post("/v1/chat/completions", body)
  const log = (await listLlmDebugLogs()).entries[0]
  setConfigForTest({ auth: { apiKeys: [] }, customProviders: [] })
  const admin = await createTestAdminSession({ reuseStorage: true })
  requests.length = 0
  const replay = await post(
    `/dashboard/api/llm-debug/${log.id}/replay`,
    { body },
    adminHeaders(admin),
  )
  expect(replay.status).toBe(409)
  expect(requests).toHaveLength(0)
})

test("changing a provider URL does not retarget a captured replay", async () => {
  const body = {
    model: "provider-chat",
    messages: [{ role: "user", content: "private prompt" }],
  }
  await post("/v1/chat/completions", body)
  const log = (await listLlmDebugLogs()).entries[0]
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [{ ...provider, baseUrl: "https://other.example/v1" }],
  })
  const admin = await createTestAdminSession({ reuseStorage: true })
  requests.length = 0
  const replay = await post(
    `/dashboard/api/llm-debug/${log.id}/replay`,
    { body },
    adminHeaders(admin),
  )
  expect(replay.status).toBe(409)
  expect(requests).toHaveLength(0)
})

test("a replay bound to an unavailable Copilot model does not fall back to another account", async () => {
  state.isMultiToken = true
  const first = tokenPool.addAccount("gho_first", "individual", 701)
  const original = tokenPool.addAccount("gho_original", "individual", 702)
  first.healthy = true
  original.healthy = true
  first.copilotToken = "gho_first"
  original.copilotToken = "gho_original"
  try {
    const body = {
      model: "retired-model",
      messages: [{ role: "user", content: "signed history" }],
    }
    const id = startLlmDebugLog({
      method: "POST",
      path: "/chat/completions",
      url: "https://api.githubcopilot.com/chat/completions",
      requestBody: JSON.stringify(body),
      requestHeaders: { authorization: "Bearer gho_original" },
      upstream: { kind: "copilot", accountId: 702 },
    })
    const admin = await createTestAdminSession({ reuseStorage: true })
    requests.length = 0
    const result = await post(
      `/dashboard/api/llm-debug/${id}/replay`,
      { body },
      adminHeaders(admin),
    )
    expect(result.status).toBe(409)
    expect(requests).toHaveLength(0)
  } finally {
    tokenPool.removeAccountForTest(701)
    tokenPool.removeAccountForTest(702)
  }
})

async function protocolRequest(
  input: Parameters<typeof server.request>[0],
  init?: RequestInit,
) {
  await seedProtocolDatabase()
  const headers = new Headers(init?.headers)
  if (
    !headers.has("authorization")
    && !headers.has("x-api-key")
    && !headers.has("x-goog-api-key")
  )
    headers.set("authorization", "Bearer " + PROTOCOL_GATEWAY_KEY)
  return server.request(input, { ...init, headers })
}
