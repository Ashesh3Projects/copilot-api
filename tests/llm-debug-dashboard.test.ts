import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { ModelFallbackDebugInfo } from "~/lib/model-fallback"

import {
  AccountsService,
  createAccountMutationContext,
} from "../src/lib/accounts-service"
import {
  clearLlmDebugLogs,
  finishLlmDebugLog,
  startLlmDebugLog,
} from "../src/lib/llm-debug-log"
import { state } from "../src/lib/state"
import { getStorageRuntime } from "../src/lib/storage/runtime"
import {
  createHistoryRuntime,
  peekHistoryRuntime,
} from "../src/lib/telemetry-writer"
import { tokenPool } from "../src/lib/token-pool"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import { server } from "../src/server"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

const originalApiKeyAuth = state.apiKeyAuth
const originalFetch = globalThis.fetch
let adminSession: TestAdminSession

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) => {
  return new Response(
    [
      'data: {"choices":[{"finish_reason":"content_filter","index":0,"delta":{"content":null}}],"id":"msg_replay","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n",
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  await peekHistoryRuntime()?.close(500)
  state.accountType = "individual"
  state.copilotToken = "fresh-copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  adminSession = await createTestAdminSession()
  await createHistoryRuntime(getStorageRuntime().storage, { autoFlush: false })
  await clearLlmDebugLogs()
  const storage = getStorageRuntime().storage
  const service = new AccountsService(storage, {
    pool: tokenPool,
    validate: (input) =>
      Promise.resolve({
        persisted: {
          token: input.token,
          instanceDomain: "github.com",
          upstreamUserId: "debug-fixture",
          login: "fixture",
          label: null,
          accountType: "individual",
          modelCount: 0,
        },
        resolved: {
          token: "fresh-copilot-token",
          baseUrl: "https://api.githubcopilot.com",
          models: { object: "list", data: [] },
        },
      }),
  })
  const context = await createAccountMutationContext(
    storage,
    "account.create",
    {},
    "owner:debug-fixture",
  )
  await service.create({ token: "github-token" }, context)
})

afterEach(async () => {
  await clearLlmDebugLogs()
})

afterAll(async () => {
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  state.apiKeyAuth = originalApiKeyAuth
  await peekHistoryRuntime()?.close(500)
  await resetTestAdminSession()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("serves LLM debug logs through dashboard API", async () => {
  const fallback: ModelFallbackDebugInfo = {
    reason: "http_422",
    sourceModel: "gpt-source",
    fromModel: "gpt-source",
    configuredTargetModel: "gpt-ui-alias",
    targetModel: "gpt-ui",
    cached: false,
    hop: 1,
  }
  const requestBody = `{ "input": "dashboard lookup", "api_key": "body-secret", "model": "gpt-ui" }`
  const responseBody = `{ "access_token": "response-secret", "ok": true }`
  const requestHeaders = {
    authorization: "Bearer raw-token",
    cookie: "dashboard-session=secret",
  }
  const responseHeaders = {
    "content-type": "application/json",
    "set-cookie": "upstream=secret",
  }
  const url = "https://example.test/responses?api_key=query-secret"
  const id = startLlmDebugLog({
    fallback,
    method: "POST",
    path: "/responses",
    requestBody,
    requestHeaders,
    requestId: "req-dashboard",
    url,
  })
  finishLlmDebugLog(id, {
    body: responseBody,
    headers: responseHeaders,
    status: 200,
    statusText: "OK",
  })

  const listResponse = await server.request("/dashboard/api/llm-debug", {
    headers: adminHeaders(adminSession, false),
  })
  expect(listResponse.status).toBe(200)
  expect(listResponse.headers.get("cache-control")).toBe("no-store")
  const listBody = (await listResponse.json()) as {
    entries: Array<{
      fallback?: ModelFallbackDebugInfo
      id: string
      requestPreview: string
    }>
  }
  expect(listBody.entries[0]?.id).toBe(id)
  expect(listBody.entries[0]?.fallback).toEqual(fallback)
  expect(listBody.entries[0]?.requestPreview).toContain("dashboard lookup")

  const detailResponse = await server.request(
    `/dashboard/api/llm-debug/${id}`,
    {
      headers: adminHeaders(adminSession, false),
    },
  )
  expect(detailResponse.status).toBe(200)
  expect(detailResponse.headers.get("cache-control")).toBe("no-store")
  const detailBody = (await detailResponse.json()) as {
    fallback?: ModelFallbackDebugInfo
    request: {
      body: string | null
      headers: Record<string, string>
      url: string
    }
    response?: {
      body: string | null
      headers: Record<string, string>
    }
  }
  expect(detailBody.fallback).toEqual(fallback)
  expect(detailBody.request).toMatchObject({
    body: requestBody,
    headers: requestHeaders,
    url,
  })
  expect(detailBody.response).toMatchObject({
    body: responseBody,
    headers: responseHeaders,
  })

  const clearResponse = await server.request("/dashboard/api/llm-debug", {
    headers: adminHeaders(adminSession),
    method: "DELETE",
  })
  expect(clearResponse.status).toBe(200)
  expect(clearResponse.headers.get("cache-control")).toBe("no-store")

  const afterClearResponse = await server.request("/dashboard/api/llm-debug", {
    headers: adminHeaders(adminSession, false),
  })
  const afterClearBody = (await afterClearResponse.json()) as { count: number }
  expect(afterClearBody.count).toBe(0)
})

test("replays a raw JSON string verbatim including duplicate keys and credentials", async () => {
  const raw =
    ' { "model":"claude-fable-5", "model":"claude-fable-5", "messages":[], "api_key":"synthetic-key", "input":"[REDACTED]" }\r\n'
  const id = startLlmDebugLog({
    method: "POST",
    path: "/chat/completions",
    requestBody: raw,
    requestHeaders: { authorization: "Bearer synthetic-key" },
    url: "https://api.githubcopilot.com/chat/completions",
  })
  const response = await server.request(
    `/dashboard/api/llm-debug/${id}/replay`,
    {
      method: "POST",
      headers: adminHeaders(adminSession),
      body: JSON.stringify({ body: raw }),
    },
  )
  expect(response.status).toBe(200)
  const upstream = fetchMock.mock.calls[0]?.[1]
  expect(upstream?.body).toBe(raw)
})

test("dashboard bundle ships the LLM debug UI", () => {
  expect(DASHBOARD_HTML).toContain("LLM Debug")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/llm-debug")
  expect(DASHBOARD_HTML).toContain("Expand all")
  expect(DASHBOARD_HTML).toContain("Collapse all")
  expect(DASHBOARD_HTML).toContain("cURL command")
  expect(DASHBOARD_HTML).toContain("Request JSON")
  expect(DASHBOARD_HTML).toContain("Formatted request body")
  expect(DASHBOARD_HTML).toContain("Raw HTTP request")
  expect(DASHBOARD_HTML).toContain("contain:layout paint")
  expect(DASHBOARD_HTML).not.toContain("Reformatted, not exact bytes")
  expect(DASHBOARD_HTML).not.toContain("Quick Add: Nebius Qwen3 Embedding")
})

test("dashboard debug pagination serves distinct pages from memory", async () => {
  const startedAtMs = Date.now()
  const ids = Array.from({ length: 3 }, () =>
    startLlmDebugLog({
      method: "POST",
      path: "/responses",
      requestHeaders: {},
      requestBody: "{}",
      url: "https://example.test/responses",
      startedAtMs,
    }),
  )
    .sort()
    .reverse()
  const firstResponse = await server.request(
    "/dashboard/api/llm-debug?limit=2",
    {
      headers: adminHeaders(adminSession, false),
    },
  )
  const first = (await firstResponse.json()) as {
    cursor: string
    entries: Array<{ id: string }>
  }
  expect(first.entries.map((entry) => entry.id)).toEqual(ids.slice(0, 2))
  const secondResponse = await server.request(
    `/dashboard/api/llm-debug?limit=2&cursor=${encodeURIComponent(first.cursor)}`,
    {
      headers: adminHeaders(adminSession, false),
    },
  )
  const second = (await secondResponse.json()) as {
    cursor: string | null
    entries: Array<{ id: string }>
  }
  expect(second.entries.map((entry) => entry.id)).toEqual(ids.slice(2))
  expect(second.cursor).toBeNull()
})

test("dashboard rejects invalid debug pagination without caching the response", async () => {
  for (const query of ["cursor=invalid", "limit=invalid", "limit=Infinity"]) {
    const response = await server.request(`/dashboard/api/llm-debug?${query}`, {
      headers: adminHeaders(adminSession, false),
    })
    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
  }
})

test("replays a chat completions debug log with fresh auth and parses SSE metadata", async () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/chat/completions",
    requestBody: JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
      model: "claude-fable-5",
      stream: true,
    }),
    requestHeaders: { authorization: "Bearer captured-token" },
    requestId: "req-replay",
    url: "https://api.githubcopilot.com/chat/completions",
  })

  const response = await server.request(
    `/dashboard/api/llm-debug/${id}/replay`,
    {
      body: JSON.stringify({
        body: {
          messages: [{ role: "user", content: "Hello edited" }],
          model: "claude-fable-5",
          stream: true,
        },
      }),
      headers: adminHeaders(adminSession),
      method: "POST",
    },
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const body = (await response.json()) as {
    finishReason: string
    responseId: string
    streamEvents: Array<unknown>
    usage: { prompt_tokens: number }
  }
  expect(body.finishReason).toBe("content_filter")
  expect(body.responseId).toBe("msg_replay")
  expect(body.usage.prompt_tokens).toBe(10)
  expect(body.streamEvents.length).toBeGreaterThan(0)

  const upstreamInit = fetchMock.mock.calls[0]?.[1] as
    | { body?: string; headers?: Record<string, string> }
    | undefined
  expect(upstreamInit?.headers?.Authorization).toBe(
    "Bearer fresh-copilot-token",
  )
  expect(upstreamInit?.headers?.Authorization).not.toBe("Bearer captured-token")
  expect(upstreamInit?.body).toContain("Hello edited")
})

test("rejects invalid replay requests", async () => {
  const missingResponse = await server.request(
    "/dashboard/api/llm-debug/missing/replay",
    {
      body: JSON.stringify({ body: {} }),
      headers: adminHeaders(adminSession),
      method: "POST",
    },
  )
  expect(missingResponse.status).toBe(404)
  expect(missingResponse.headers.get("cache-control")).toBe("no-store")

  const embeddingsId = startLlmDebugLog({
    method: "POST",
    path: "/embeddings",
    requestBody: JSON.stringify({ input: "hello", model: "embed" }),
    requestHeaders: {},
    url: "https://api.githubcopilot.com/embeddings",
  })
  const unsupportedResponse = await server.request(
    `/dashboard/api/llm-debug/${embeddingsId}/replay`,
    {
      body: JSON.stringify({ body: { input: "hello", model: "embed" } }),
      headers: adminHeaders(adminSession),
      method: "POST",
    },
  )
  expect(unsupportedResponse.status).toBe(400)

  const chatId = startLlmDebugLog({
    method: "POST",
    path: "/chat/completions",
    requestBody: JSON.stringify({ messages: [], model: "gpt" }),
    requestHeaders: {},
    url: "https://api.githubcopilot.com/chat/completions",
  })
  const invalidJsonResponse = await server.request(
    `/dashboard/api/llm-debug/${chatId}/replay`,
    {
      body: JSON.stringify({ body: "{nope" }),
      headers: adminHeaders(adminSession),
      method: "POST",
    },
  )
  expect(invalidJsonResponse.status).toBe(400)

  const missingModelResponse = await server.request(
    `/dashboard/api/llm-debug/${chatId}/replay`,
    {
      body: JSON.stringify({ body: { messages: [] } }),
      headers: adminHeaders(adminSession),
      method: "POST",
    },
  )
  expect(missingModelResponse.status).toBe(400)
})

test("dashboard bundle ships the LLM replay workspace", () => {
  expect(DASHBOARD_HTML).toContain("LLM Replay")
  expect(DASHBOARD_HTML).toContain("Request JSON")
  expect(DASHBOARD_HTML).toContain("Format JSON")
  expect(DASHBOARD_HTML).toContain("Reset request")
  expect(DASHBOARD_HTML).toContain("Run Replay")
  expect(DASHBOARD_HTML).toContain("Replay result")
  expect(DASHBOARD_HTML).toContain("Last successful result")
  expect(DASHBOARD_HTML).toContain("replay-workspace")
  expect(DASHBOARD_HTML).toContain("Export request")
  expect(DASHBOARD_HTML).toContain("Export response")
})
