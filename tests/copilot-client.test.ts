import * as Sentry from "@sentry/bun"
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

import { runWithCopilotRequestAttribution } from "../src/lib/copilot-request-context"
/* eslint-disable max-lines -- Copilot client integration cases share singleton fetch fixtures */
import {
  clearLlmDebugLogs,
  getLlmDebugLog,
  listLlmDebugLogs,
  toLlmDebugLogError,
} from "../src/lib/llm-debug-log"
import { runWithRoutingAffinity } from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import {
  copilotBaseUrl,
  copilotFetch,
  copilotHeaders,
  setHttpRetrySleepForTest,
} from "../src/services/copilot/copilot-client"
import { DEFAULT_COPILOT_INTEGRATION_ID } from "../src/services/copilot/copilot-contract"
import {
  abortableSleep,
  createRetryBudget,
  createTransportChain,
  handleTransportFailure,
  isAbortLikeError,
  MAX_DELAY_SECONDS,
  MAX_RETRIES,
  MAX_ROUTED_SENDS,
  PRE_HEADER_MAX_DELAY_SECONDS,
  setTransportEventSinkForTest,
} from "../src/services/copilot/transport-retry"
import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotApiBaseUrl: state.copilotApiBaseUrl,
  copilotIntegrationId: state.copilotIntegrationId,
  copilotToken: state.copilotToken,
  githubInstanceDomain: state.githubInstanceDomain,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  sessionId: state.sessionId,
}
const queuedResults: Array<Error | QueuedThrow | Response> = []
const capturedRequests: Array<{ url: string; init?: RequestInit }> = []
const transportEvents: Array<{
  attributes: Record<string, unknown>
  outcome: string
}> = []
const httpRetrySleeps: Array<number> = []

test("does not log deterministic HTTP 400 response bodies", async () => {
  const privateMarker = "deterministic-private-marker"
  queuedResults.push(
    Response.json(
      {
        error: {
          code: "invalid_request_body",
          message: privateMarker,
        },
      },
      { status: 400 },
    ),
  )
  const warnSpy = spyOn(consola, "warn")

  try {
    const response = await copilotFetch("/responses", {
      method: "POST",
      body: "{}",
    })

    expect(response.status).toBe(400)
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateMarker)
  } finally {
    warnSpy.mockRestore()
  }
})

type BunTimeoutRequestInit = RequestInit & {
  timeout?: boolean | number
}

interface QueuedThrow {
  readonly kind: "throw"
  readonly value: unknown
}

function getRequestUrl(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url
  }
  if (url instanceof URL) {
    return url.toString()
  }
  return url.url
}

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const requestUrl = getRequestUrl(url)
  capturedRequests.push({ url: requestUrl, init })

  const next = queuedResults.shift()
  if (!next) {
    throw new Error(`Unexpected fetch: ${requestUrl}`)
  }

  if ("kind" in next) {
    throw next.value
  }

  if (next instanceof Error) {
    throw next
  }

  return next
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  setTransportEventSinkForTest((message, attributes) => {
    transportEvents.push({
      attributes,
      outcome: message.replace("copilot transport ", ""),
    })
  })
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  setTransportEventSinkForTest()
  setHttpRetrySleepForTest()
  Object.assign(state, originalState)
})

beforeEach(async () => {
  fetchMock.mockClear()
  queuedResults.length = 0
  capturedRequests.length = 0
  transportEvents.length = 0
  httpRetrySleeps.length = 0
  setHttpRetrySleepForTest((ms) => {
    httpRetrySleeps.push(ms)
    return Promise.resolve()
  })
  await clearLlmDebugLogs()
  resetRoutingTelemetryForTest()
  state.accountType = "individual"
  state.githubInstanceDomain = "github.com"
  state.githubToken = "github-token"
  state.copilotToken = "expired-copilot-token"
  state.copilotApiBaseUrl = undefined
  state.copilotIntegrationId = DEFAULT_COPILOT_INTEGRATION_ID
  state.isMultiToken = false
})

test.each([
  ["individual", "https://api.githubcopilot.com"],
  ["business", "https://api.business.githubcopilot.com"],
  ["enterprise", "https://api.enterprise.githubcopilot.com"],
] as const)("uses the reviewed %s Copilot host", (accountType, expected) => {
  state.accountType = accountType
  expect(copilotBaseUrl()).toBe(expected)
})

test("uses the enterprise data-residency Copilot host", () => {
  state.githubInstanceDomain = "msft.ghe.com"
  state.accountType = "enterprise"
  expect(copilotBaseUrl()).toBe("https://copilot-api.msft.ghe.com")
})

test("uses the endpoint discovered during Copilot authentication", () => {
  state.githubInstanceDomain = "github.ghe.com"
  state.copilotApiBaseUrl = "https://copilot-api.github.ghe.com"
  expect(copilotBaseUrl()).toBe("https://copilot-api.github.ghe.com")
})

test("uses one current API version and the configured integration id", () => {
  state.copilotIntegrationId = "assigned-integration"
  const headers = copilotHeaders()
  expect(headers["X-GitHub-Api-Version"]).toBe("2026-08-01")
  expect(headers["Copilot-Integration-Id"]).toBe("assigned-integration")
  expect(headers["Copilot-Harness-Id"]).toBe("copilot-sdk")
})

test("builds only supported Copilot betas from Claude Desktop flags", () => {
  const headers = copilotHeaders({
    anthropicBeta:
      "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,tool-search-tool-2025-10-19,effort-2025-11-24",
  })

  expect(headers["Anthropic-Beta"]).toBe(
    "claude-code-20250219,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20",
  )
})

test.each([
  "adaptive-thinking-2026-01-28",
  "advisor-tool-2026-03-01",
  "advanced-tool-use-2025-11-20",
  "claude-code-20250219",
  "compact-2026-01-12",
  "computer-use-2025-01-24",
  "computer-use-2025-11-24",
  "context-management-2025-06-27",
  "fallback-credit-2026-07-01",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
  "mid-conv-tool-change-2026-07-01",
  "mid-conversation-system-2026-04-07",
  "task-budgets-2026-03-13",
  "thinking-binding-controls-2026-08-01",
  "token-efficient-tools-2025-02-19",
])("retains supported beta %s while dropping unknown siblings", (beta) => {
  const headers = copilotHeaders({
    anthropicBeta: `unknown-beta, ${beta}, ${beta}`,
  })
  expect(headers["Anthropic-Beta"]).toBe(beta)
})

test.each([
  "unknown-beta",
  "INTERLEAVED-THINKING-2025-05-14",
  "files-api-2025-04-14,code-execution-2025-08-25,mcp-client-2025-11-20,skills-2025-10-02,web-fetch-2025-09-10,output-128k-2025-02-19",
  "context-1m-2025-08-07,effort-2025-11-24,prompt-caching-2024-07-31,pdfs-2024-09-25,token-counting-2024-11-01",
])("omits Anthropic-Beta when no flags are supported: %s", (anthropicBeta) => {
  expect(copilotHeaders({ anthropicBeta })).not.toHaveProperty("Anthropic-Beta")
})

test("deduplicates supported tool aliases before enforcing header limits", () => {
  const headers = copilotHeaders({
    anthropicBeta: [
      ...Array<string>(80).fill("unknown-future-beta"),
      " tool-search-tool-2025-10-19 ",
      "tool-examples-2025-10-29",
      "advanced-tool-use-2025-11-20",
      "interleaved-thinking-2025-05-14",
    ].join(","),
  })
  expect(headers["Anthropic-Beta"]).toBe(
    "advanced-tool-use-2025-11-20,interleaved-thinking-2025-05-14",
  )
})

test.each(["record", "Headers", "tuples"] as const)(
  "filters %s headers before every Copilot send and debug capture",
  async (representation) => {
    queuedResults.push(
      new Response("retry", { status: 503, headers: { "retry-after": "0" } }),
      Response.json({ ok: true }),
    )
    const rawHeaders = {
      Authorization: "Bearer test-upstream-token",
      "content-type": "application/json",
      "X-Request-Id": "allowlist-regression",
      "X-Client-Machine-Id": "desktop-test",
      "Copilot-Session-Token": "opaque-session-token",
      "aNtHrOpIc-BeTa":
        "interleaved-thinking-2025-05-14,tool-search-tool-2025-10-19,files-api-2025-04-14,unknown-beta",
      "anthropic-version": "2023-06-01",
      Cookie: "client-only-cookie",
      "X-Api-Key": "client-only-key",
      "X-Stainless-Retry-Count": "2",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      "X-Unreviewed-Header": "client-only-value",
    }
    let headers: RequestInit["headers"] = rawHeaders
    if (representation === "Headers") headers = new Headers(rawHeaders)
    if (representation === "tuples") headers = Object.entries(rawHeaders)

    const response = await copilotFetch("/v1/messages", {
      method: "POST",
      body: "{}",
      headers,
    })
    await response.text()

    expect(response.status).toBe(200)
    expect(capturedRequests).toHaveLength(2)
    for (const request of capturedRequests) {
      expect(Object.fromEntries(new Headers(request.init?.headers))).toEqual({
        authorization: "Bearer test-upstream-token",
        "content-type": "application/json",
        "x-request-id": "allowlist-regression",
        "x-client-machine-id": "desktop-test",
        "copilot-session-token": "opaque-session-token",
        "anthropic-beta":
          "interleaved-thinking-2025-05-14,advanced-tool-use-2025-11-20",
        "anthropic-version": "2023-06-01",
      })
    }
    const logs = await listLlmDebugLogs({ limit: 10 })
    expect(logs.entries).toHaveLength(2)
    for (const entry of logs.entries) {
      const log = await getLlmDebugLog(entry.id)
      const captured = new Headers(log?.request.headers)
      expect(captured.get("anthropic-beta")).toBe(
        "interleaved-thinking-2025-05-14,advanced-tool-use-2025-11-20",
      )
      expect(captured.has("cookie")).toBe(false)
      expect(captured.has("x-unreviewed-header")).toBe(false)
    }
  },
)

test("preserves repeated beta header lines through endpoint rediscovery", async () => {
  state.copilotApiBaseUrl = "https://api.individual.githubcopilot.com"
  queuedResults.push(
    new Response("Misdirected Request", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.business.githubcopilot.com" },
    }),
    Response.json({ ok: true }),
  )

  const response = await copilotFetch("/v1/messages", {
    method: "POST",
    body: "{}",
    headers: [
      ["Authorization", "Bearer test-upstream-token"],
      ["Anthropic-Beta", "interleaved-thinking-2025-05-14"],
      ["Anthropic-Beta", "tool-search-tool-2025-10-19"],
      ["X-Request-Id", "before-rediscovery"],
    ],
  })

  expect(response.status).toBe(200)
  const messagesRequests = capturedRequests.filter(({ url }) =>
    url.endsWith("/v1/messages"),
  )
  expect(messagesRequests).toHaveLength(2)
  for (const request of messagesRequests) {
    expect(new Headers(request.init?.headers).get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14,advanced-tool-use-2025-11-20",
    )
  }
  expect(messagesRequests[1]?.url).toBe(
    "https://api.business.githubcopilot.com/v1/messages",
  )
  expect(
    new Headers(messagesRequests[1]?.init?.headers).get("x-request-id"),
  ).not.toBe("before-rediscovery")
})

test("does not exchange or retry an immutable public OAuth token after a 401", async () => {
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const response = await copilotFetch("/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
  })

  expect(response.status).toBe(401)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.githubcopilot.com/chat/completions",
  ])
  expect(state.copilotToken).toBe("expired-copilot-token")
})

test("rediscovers a changed public OAuth endpoint and retries one 421", async () => {
  state.copilotApiBaseUrl = "https://api.individual.githubcopilot.com"
  queuedResults.push(
    new Response("Misdirected Request", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.business.githubcopilot.com" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
      "X-Request-Id": "stale-endpoint-request",
    },
  })

  expect(response.status).toBe(200)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.individual.githubcopilot.com/responses",
    "https://api.github.com/copilot_internal/user",
    "https://api.business.githubcopilot.com/responses",
  ])
  expect(
    new Headers(capturedRequests[1]?.init?.headers).get("authorization"),
  ).toBe("Bearer github-token")
  expect(
    new Headers(capturedRequests[2]?.init?.headers).get("authorization"),
  ).toBe("Bearer expired-copilot-token")
  expect(
    new Headers(capturedRequests[2]?.init?.headers).get("x-request-id"),
  ).not.toBe("stale-endpoint-request")
  expect(state.copilotApiBaseUrl).toBe("https://api.business.githubcopilot.com")
})

test("retries at most once after 421 endpoint rediscovery", async () => {
  state.copilotApiBaseUrl = "https://api.individual.githubcopilot.com"
  queuedResults.push(
    new Response("first misdirect", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.business.githubcopilot.com" },
    }),
    new Response("second misdirect", {
      status: 421,
      headers: { "x-github-request-id": "second-421" },
    }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: { Authorization: "Bearer expired-copilot-token" },
  })

  expect(response.status).toBe(421)
  expect(response.headers.get("x-github-request-id")).toBe("second-421")
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.individual.githubcopilot.com/responses",
    "https://api.github.com/copilot_internal/user",
    "https://api.business.githubcopilot.com/responses",
  ])
})

test("preserves the original 421 when endpoint rediscovery fails", async () => {
  state.copilotApiBaseUrl = "https://api.individual.githubcopilot.com"
  queuedResults.push(
    new Response("Misdirected Request", {
      status: 421,
      headers: { "x-github-request-id": "original-421" },
    }),
    new Response("Unavailable", { status: 503 }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: { Authorization: "Bearer expired-copilot-token" },
  })

  expect(response.status).toBe(421)
  expect(response.headers.get("x-github-request-id")).toBe("original-421")
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.individual.githubcopilot.com/responses",
    "https://api.github.com/copilot_internal/user",
  ])
  expect(state.copilotApiBaseUrl).toBe(
    "https://api.individual.githubcopilot.com",
  )
})

test("preserves the original 421 when rediscovery returns the same endpoint", async () => {
  state.copilotApiBaseUrl = "https://api.individual.githubcopilot.com"
  queuedResults.push(
    new Response("Misdirected Request", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.individual.githubcopilot.com" },
    }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: { Authorization: "Bearer expired-copilot-token" },
  })

  expect(response.status).toBe(421)
  expect(capturedRequests).toHaveLength(2)
})

test("preserves the original 421 when rediscovery omits a trusted endpoint", async () => {
  state.copilotApiBaseUrl = "https://api.individual.githubcopilot.com"
  queuedResults.push(
    new Response("Misdirected Request", { status: 421 }),
    Response.json({ login: "octocat" }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: { Authorization: "Bearer expired-copilot-token" },
  })

  expect(response.status).toBe(421)
  expect(state.copilotApiBaseUrl).toBe(
    "https://api.individual.githubcopilot.com",
  )
  expect(capturedRequests).toHaveLength(2)
})

test("does not rediscover a caller-pinned account endpoint after 421", async () => {
  queuedResults.push(new Response("Misdirected Request", { status: 421 }))

  const response = await copilotFetch(
    "/responses",
    {
      method: "POST",
      headers: { Authorization: "Bearer account-token" },
    },
    { baseUrl: "https://api.business.githubcopilot.com" },
  )

  expect(response.status).toBe(421)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.business.githubcopilot.com/responses",
  ])
})

test("allows 421 endpoint recovery after a compatibility retry", async () => {
  state.copilotApiBaseUrl = "https://api.individual.githubcopilot.com"
  queuedResults.push(
    Response.json(
      {
        error: {
          code: "invalid_request_body",
          message: "The encrypted content could not be verified.",
        },
      },
      { status: 400 },
    ),
    new Response("Misdirected Request", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.business.githubcopilot.com" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    body: JSON.stringify({
      input: [{ encrypted_content: "opaque", type: "compaction" }],
    }),
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
  })

  expect(response.status).toBe(200)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.individual.githubcopilot.com/responses",
    "https://api.individual.githubcopilot.com/responses",
    "https://api.github.com/copilot_internal/user",
    "https://api.business.githubcopilot.com/responses",
  ])
})

test("does not exchange or retry an immutable enterprise OAuth token after a 401", async () => {
  state.githubInstanceDomain = "msft.ghe.com"
  state.accountType = "enterprise"
  state.copilotApiBaseUrl = "https://copilot-api.msft.ghe.com"
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const response = await copilotFetch("/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
  })

  expect(response.status).toBe(401)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://copilot-api.msft.ghe.com/chat/completions",
  ])
})

test("does not move a public OAuth request to another host after a 401", async () => {
  state.copilotApiBaseUrl = "https://api.githubcopilot.com"
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: { Authorization: "Bearer expired-copilot-token" },
  })

  expect(response.status).toBe(401)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.githubcopilot.com/responses",
  ])
  expect(state.copilotApiBaseUrl).toBe("https://api.githubcopilot.com")
})

test("retries transient 408 and 504 upstream responses", async () => {
  for (const status of [408, 504]) {
    queuedResults.length = 0
    capturedRequests.length = 0
    fetchMock.mockClear()

    queuedResults.push(
      new Response("Retry me", {
        status,
        headers: { "retry-after": "0" },
      }),
      new Response("{}", { status: 200 }),
    )

    const response = await copilotFetch("/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer expired-copilot-token",
        "content-type": "application/json",
      },
    })

    expect(response.status).toBe(200)
    expect(capturedRequests).toHaveLength(2)
  }
})

test("stops after a single retry for retryable upstream responses", async () => {
  queuedResults.push(
    new Response("Still overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
    new Response("Still overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
  })

  expect(response.status).toBe(503)
  expect(capturedRequests).toHaveLength(2)
})

test("includes a per-session X-Agent-Task-Id header", () => {
  state.sessionId = "session-guid"

  const headers = copilotHeaders()

  expect(headers["X-Agent-Task-Id"]).toBe("session-guid")
})

test("keeps conversation identity stable while preserving task attribution", () => {
  state.copilotToken = "token"
  const headers = runWithRoutingAffinity(
    { key: "conversation", source: "codex_session" },
    () =>
      runWithCopilotRequestAttribution(
        { agentTaskId: "task-123", parentAgentId: "parent-456" },
        () => copilotHeaders(),
      ),
  )
  expect(headers["X-Agent-Task-Id"]).toBe("task-123")
  expect(headers["X-Parent-Agent-Id"]).toBe("parent-456")
  expect(headers["X-Interaction-Id"]).toBe(headers["X-Client-Session-Id"])
})

test("maps only typed attribution and header options", () => {
  const headers = copilotHeaders({
    anthropicBeta: " interleaved-thinking-2025-05-14 ",
    anthropicVersion: " 2023-06-01 ",
    attribution: {
      clientExperimentAssignment: "client_flight:1;",
      clientMachineId: "machine-abc",
      harnessId: "copilot",
      interactionType: "conversation-agent",
      openaiIntent: "conversation-agent",
      repositoryHost: "github.example",
      repositoryNwo: "owner/repo",
      subsystemId: "cli",
    },
    copilotSessionToken: " session-token ",
    modelProviderPreference: " azure ",
  })

  expect(headers).toMatchObject({
    "Anthropic-Beta": "interleaved-thinking-2025-05-14",
    "anthropic-version": "2023-06-01",
    "Copilot-Harness-Id": "copilot",
    "Copilot-Session-Token": "session-token",
    "Copilot-Subsystem-Id": "cli",
    "Openai-Intent": "conversation-agent",
    "X-Client-Machine-Id": "machine-abc",
    "X-Copilot-Client-Exp-Assignment-Context": "client_flight:1;",
    "X-GitHub-Repository-Host": "github.example",
    "X-GitHub-Repository-Nwo": "owner/repo",
    "X-Interaction-Type": "conversation-agent",
    "X-Model-Provider-Preference": "azure",
  })
})

test("drops invalid typed Copilot header options", () => {
  const headers = copilotHeaders({
    anthropicBeta: "bad\nbeta",
    anthropicVersion: "x".repeat(1025),
    copilotSessionToken: " ",
    modelProviderPreference: "bad\rprovider",
  })

  expect(headers["Anthropic-Beta"]).toBeUndefined()
  expect(headers["anthropic-version"]).toBeUndefined()
  expect(headers["Copilot-Session-Token"]).toBeUndefined()
  expect(headers["X-Model-Provider-Preference"]).toBeUndefined()
})

test("drops every C0 and C1 control from every typed Copilot header", () => {
  const controlCodePoints = [
    ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint),
    ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
  ]

  for (const codePoint of controlCodePoints) {
    const control = String.fromCodePoint(codePoint)
    for (const invalid of [
      (value: string) => `safe${control}${value}`,
      (value: string) => `${control}${value}`,
      (value: string) => `${value}${control}`,
    ]) {
      const headers = copilotHeaders({
        anthropicBeta: invalid("interleaved-thinking-2025-05-14"),
        anthropicVersion: invalid("2026-08"),
        attribution: {
          agentTaskId: invalid("task-id"),
          parentAgentId: invalid("parent-id"),
        },
        copilotSessionToken: invalid("session-token"),
        modelProviderPreference: invalid("provider-preference"),
      })

      expect(headers["Anthropic-Beta"]).toBeUndefined()
      expect(headers["anthropic-version"]).toBeUndefined()
      expect(headers["Copilot-Session-Token"]).toBeUndefined()
      expect(headers["X-Model-Provider-Preference"]).toBeUndefined()
      expect(headers["X-Agent-Task-Id"]).not.toContain(control)
      expect(headers["X-Parent-Agent-Id"]).toBeUndefined()
    }
  }
})

test("derives restart-stable upstream headers from request affinity", () => {
  state.sessionId = "before-restart"
  const first = runWithRoutingAffinity(
    { key: "conversation", source: "codex_session" },
    () => copilotHeaders(),
  )
  state.sessionId = "after-restart"
  const second = runWithRoutingAffinity(
    { key: "conversation", source: "codex_session" },
    () => copilotHeaders(),
  )

  expect(second["X-Client-Session-Id"]).toBe(first["X-Client-Session-Id"])
  expect(first["X-Interaction-Id"]).toBe(first["X-Client-Session-Id"])
  expect(first["X-Agent-Task-Id"]).toBe(first["X-Client-Session-Id"])
  expect(first["X-Client-Session-Id"]).not.toBe(state.sessionId)
})

test("uses process identity for unidentified requests", () => {
  state.sessionId = "process-session"

  const headers = copilotHeaders()

  expect(headers["X-Interaction-Id"]).toBe("process-session")
  expect(headers["X-Client-Session-Id"]).toBe("process-session")
  expect(headers["X-Agent-Task-Id"]).toBe("process-session")
})

test("sets a descriptive User-Agent header", () => {
  const headers = copilotHeaders()

  expect(headers["User-Agent"]).toContain("copilot-api")
})

test("does not retry unknown upstream 400 responses", async () => {
  queuedResults.push(
    new Response("feature unsupported by model", {
      status: 400,
      headers: { "retry-after": "0" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
  })

  expect(response.status).toBe(400)
  expect(capturedRequests).toHaveLength(1)
})

test("does not retry aborted upstream fetches", async () => {
  queuedResults.push(new Error("The operation was aborted"))

  let thrownError: unknown
  try {
    await copilotFetch("/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer expired-copilot-token",
        "content-type": "application/json",
      },
    })
  } catch (error) {
    thrownError = error
  }
  expect(thrownError).toBeInstanceOf(Error)
  if (!(thrownError instanceof Error)) {
    throw new TypeError("Expected copilotFetch to throw an Error")
  }
  expect(thrownError.message).toContain("aborted")

  expect(capturedRequests).toHaveLength(1)
  expect((await listLlmDebugLogs()).entries[0]?.status).toBe("aborted")
})

test("marks an aborted upstream response body as aborted without changing the client error", async () => {
  const abortError = new Error("response body was aborted")
  abortError.name = "AbortError"
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(abortError)
      },
    }),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    },
  )
  queuedResults.push(response)

  const capturedResponse = await copilotFetch("/responses", {
    body: JSON.stringify({ model: "gpt-aborted-stream", stream: true }),
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
    method: "POST",
  })
  expect(await capturedResponse.text().catch((error: unknown) => error)).toBe(
    abortError,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = (await listLlmDebugLogs()).entries[0]
  expect(entry).toBeDefined()
  expect(entry.status).toBe("aborted")
  expect(entry.responseStatus).toBe(200)
  expect(entry.errorMessage).toBe("response body was aborted")
})

test("captures raw LLM request and response attempts for dashboard debugging", async () => {
  queuedResults.push(
    new Response('{"choices":[]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )

  const requestBody = JSON.stringify({
    messages: [{ role: "user", content: "debug capture" }],
    model: "gpt-debug",
  })
  const response = await copilotFetch("/chat/completions", {
    body: requestBody,
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
      "X-Request-Id": "req-capture",
    },
    method: "POST",
  })
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const logs = await listLlmDebugLogs()
  expect(logs.count).toBe(1)
  expect(logs.entries[0]?.model).toBe("gpt-debug")
  expect(logs.entries[0]?.requestId).toBe("req-capture")
  expect(logs.entries[0]?.requestPreview).toContain("debug capture")
  expect(logs.entries[0]?.responseStatus).toBe(200)
  expect(logs.entries[0]?.responsePreview).toContain("choices")
  const detail = await getLlmDebugLog(logs.entries[0]?.id ?? "")
  expect(detail?.request.body).toBe(requestBody)
  expect(detail?.request.headers.Authorization).toBe(
    "Bearer expired-copilot-token",
  )
  expect(detail?.response?.body).toBe('{"choices":[]}')
})

test("drains superseded retry responses into raw capture without buffering a second full body", async () => {
  const body = "synthetic retry body\r\n".repeat(70_000)
  queuedResults.push(
    new Response(body, { status: 503, headers: { "retry-after": "0" } }),
    new Response("accepted", { status: 200 }),
  )
  const response = await copilotFetch("/responses", {
    body: '{"model":"retry-capture"}',
    method: "POST",
    headers: AUTH_HEADERS,
  })
  expect(await response.text()).toBe("accepted")
  let retryBody: string | null | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const entry of (await listLlmDebugLogs()).entries) {
      if (entry.responseStatus === 503)
        retryBody = (await getLlmDebugLog(entry.id))?.response?.body
    }
    if (retryBody === body) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(retryBody === body).toBe(true)
})

test("captures large raw Copilot request bytes and CRLF response without reconstruction", async () => {
  const requestBody =
    '\uFEFF{ "model":"gpt-debug", "input":"'
    + "x".repeat(2 * 1024 * 1024)
    + '", "api_key":"synthetic-key" }\r\n'
  const responseBody =
    ': keepalive\r\nevent: delta\r\ndata:{"token":"synthetic-response"}\r\n\r\n'
  queuedResults.push(
    new Response(responseBody, {
      headers: {
        "content-type": "text/event-stream",
        "set-cookie": "synthetic=cookie",
      },
    }),
  )
  const response = await copilotFetch("/responses", {
    body: new TextEncoder().encode(requestBody),
    headers: {
      Authorization: "Bearer synthetic-key",
      "content-type": "application/json",
    },
    method: "POST",
  })
  expect(await response.text()).toBe(responseBody)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const summary = (await listLlmDebugLogs()).entries[0]
  const detail = await getLlmDebugLog(summary.id)
  expect(detail?.request.body === requestBody).toBe(true)
  expect(detail?.request.bodyBytes).toBe(Buffer.byteLength(requestBody))
  expect(detail?.response?.body).toBe(responseBody)
  expect(detail?.response?.headers["set-cookie"]).toBe("synthetic=cookie")
})

test("keeps raw native Responses terminal bodies exact in LLM Debug", async () => {
  const privateMarker = "llm-debug-native-terminal-private-marker"
  const rawBody = `event: response.failed\ndata: ${JSON.stringify({
    type: "response.failed",
    response: {
      status: "failed",
      error: { code: "server_error", message: privateMarker },
    },
  })}\n\n`
  queuedResults.push(
    new Response(rawBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    body: '{"model":"gpt-debug","stream":true}',
    headers: {
      Authorization: "Bearer raw-debug-token",
      "content-type": "application/json",
    },
  })
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const summary = (await listLlmDebugLogs()).entries[0]
  const detail = await getLlmDebugLog(summary.id)
  expect(detail?.response?.body).toBe(rawBody)
  expect(detail?.response?.body).toContain(privateMarker)
})

// --- Transport-level connection errors ---

const AUTH_HEADERS = {
  Authorization: "Bearer expired-copilot-token",
  "content-type": "application/json",
}

/** The exact shape Bun throws when a pooled keep-alive socket is reset. */
function bunSocketClosedError(): Error {
  const error = new Error(
    "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  )
  return Object.assign(error, {
    code: "ECONNRESET",
    errno: 0,
    path: "https://api.githubcopilot.com/responses?session=secret-token",
  })
}

function privateBunSocketClosedError(privateMarker: string): Error {
  const error = new Error(`socket reset ${privateMarker}`)
  return Object.assign(error, {
    code: "ECONNRESET",
    errno: 0,
    path: `https://api.githubcopilot.com/responses?private=${privateMarker}`,
  })
}

function llmSends(): Array<{ url: string; init?: RequestInit }> {
  return capturedRequests.filter(
    (request) => !request.url.includes("/copilot_internal/"),
  )
}

async function captureThrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject")
}

async function captureRejection(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise
  } catch {
    return true
  }
  return false
}

test("retries Bun's socket-closed ECONNRESET and returns the retried response", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(2)
})

test("leaves logical response metadata emission to routedFetch", async () => {
  queuedResults.push(
    new Response("retry", {
      status: 500,
      headers: {
        "x-quota-snapshot-private": "retry-value",
        "x-github-request-id": "retry-id",
      },
    }),
    new Response("{}", {
      status: 200,
      headers: {
        "x-quota-snapshot-premium": "final-value",
        "x-github-request-id": "final-id",
        authorization: "Bearer private-token",
      },
    }),
  )
  const debugSpy = spyOn(consola, "debug")
  const breadcrumbSpy = spyOn(Sentry, "addBreadcrumb").mockImplementation(
    () => undefined,
  )

  try {
    const response = await copilotFetch("/responses", { method: "POST" })

    expect(response.status).toBe(200)
    const contractLogs = debugSpy.mock.calls.filter(
      (call) => call[0] === "[copilot-contract]",
    )
    expect(contractLogs).toEqual([])
    const diagnostics = JSON.stringify({
      breadcrumbs: breadcrumbSpy.mock.calls,
      logs: contractLogs,
    })
    expect(diagnostics).not.toContain("retry-value")
    expect(diagnostics).not.toContain("final-value")
    expect(diagnostics).not.toContain("private-token")
  } finally {
    breadcrumbSpy.mockRestore()
    debugSpy.mockRestore()
  }
})

test("omits private transport values from retry logs and breadcrumbs", async () => {
  const privateMarker = "transport-retry-private-marker"
  queuedResults.push(
    privateBunSocketClosedError(privateMarker),
    new Response("{}", { status: 200 }),
  )
  const warnSpy = spyOn(consola, "warn")
  const breadcrumbSpy = spyOn(Sentry, "addBreadcrumb").mockImplementation(
    () => undefined,
  )
  const sentryLogSpy = spyOn(Sentry.logger, "info")

  try {
    const response = await copilotFetch("/responses", {
      method: "POST",
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(200)
    expect(capturedRequests).toHaveLength(2)
    const diagnostics = JSON.stringify({
      breadcrumbs: breadcrumbSpy.mock.calls,
      logger: sentryLogSpy.mock.calls,
      warn: warnSpy.mock.calls,
    })
    expect(diagnostics).not.toContain(privateMarker)
    expect(diagnostics).not.toContain("api.githubcopilot.com")
    expect(diagnostics).toContain("ECONNRESET")
    expect(diagnostics).toContain("retrying")
  } finally {
    sentryLogSpy.mockRestore()
    breadcrumbSpy.mockRestore()
    warnSpy.mockRestore()
  }
})

test("records every Copilot transport attempt with its retry reason", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch(
    "/responses",
    { method: "POST", headers: AUTH_HEADERS },
    {
      telemetry: {
        accountId: 7,
        destination: "Responses",
        model: "gpt-telemetry-test",
        provider: "GitHub Copilot",
        reason: "initial",
      },
    },
  )

  expect(response.status).toBe(200)
  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [{ id: 7, accountType: "individual", healthy: true }],
    multiToken: true,
    window: "1h",
  })
  expect(snapshot.totals).toMatchObject({
    failovers: 0,
    retries: 1,
    upstreamCalls: 2,
  })
  expect(snapshot.models[0]).toMatchObject({
    model: "gpt-telemetry-test",
    outcomes: { success: 1, transportError: 1 },
    provider: "GitHub Copilot",
  })
  expect(snapshot.models[0]?.accounts).toEqual([
    { accountId: 7, share: 1, upstreamCalls: 2 },
  ])
})

test("disables Bun pooling and replaces its idle deadline with caller cancellation", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )
  const abortController = new AbortController()
  const requestInit: BunTimeoutRequestInit = {
    method: "POST",
    headers: AUTH_HEADERS,
    keepalive: true,
    signal: abortController.signal,
    timeout: 1,
  }

  const response = await copilotFetch("/responses", requestInit)

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(2)
  expect(capturedRequests.map(({ init }) => init?.keepalive)).toEqual([
    false,
    false,
  ])
  expect(
    capturedRequests.map(
      ({ init }) => (init as BunTimeoutRequestInit | undefined)?.timeout,
    ),
  ).toEqual([false, false])
})

test("keeps Bun's runtime timeout on signal-less control-plane calls", async () => {
  queuedResults.push(new Response("{}", { status: 200 }))
  const requestInit: BunTimeoutRequestInit = {
    method: "GET",
    timeout: false,
  }

  const response = await copilotFetch("/models", requestInit)

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.keepalive).toBe(false)
  expect(
    (capturedRequests[0]?.init as BunTimeoutRequestInit | undefined)?.timeout,
  ).toBeUndefined()
})

test("retries when the connection code is only on error.cause", async () => {
  const cause = Object.assign(new Error("upstream closed the stream"), {
    code: "ECONNRESET",
  })
  // Message matches no retry pattern — only the nested code makes it retryable.
  queuedResults.push(
    new Error("request failed", { cause }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(2)
})

test("retries platform errors whose connection code is inherited", async () => {
  const prototype = Object.create(Error.prototype, {
    code: {
      configurable: true,
      value: "ECONNRESET",
    },
  }) as object
  const inheritedCodeError = Object.create(prototype) as object
  Object.defineProperty(inheritedCodeError, "message", {
    configurable: true,
    value: "provider request failed",
  })
  queuedResults.push(
    { kind: "throw", value: inheritedCodeError } satisfies QueuedThrow,
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(2)
})

test("classifies Bun DOMException cancellation from inherited semantics", () => {
  const cancellation = new DOMException(
    "The operation was aborted.",
    "AbortError",
  )

  expect(isAbortLikeError(cancellation)).toBe(true)
})

test("does not spend retry budget on Bun DOMException cancellation", async () => {
  const cancellation = new DOMException(
    "The operation was aborted.",
    "AbortError",
  )
  let claims = 0

  expect(
    await captureRejection(
      handleTransportFailure({
        attemptMs: 1,
        chain: createTransportChain("/responses", "dom-cancelled"),
        claimRetry: () => {
          claims += 1
          return true
        },
        error: cancellation,
        signal: undefined,
      }),
    ),
  ).toBe(true)
  expect(claims).toBe(0)
})

test("converts Bun DOMException abort reasons without losing semantics", async () => {
  const controller = new AbortController()
  const cancellation = new DOMException(
    "The operation was aborted.",
    "AbortError",
  )
  controller.abort(cancellation)
  const thrown = await captureThrown(abortableSleep(1, controller.signal))

  expect(isAbortLikeError(thrown)).toBe(true)
})

test("does not invoke inherited transport accessors", async () => {
  let getterCalls = 0
  const prototype = Object.defineProperties(
    {},
    {
      code: {
        get() {
          getterCalls += 1
          return "ECONNRESET"
        },
      },
      message: {
        get() {
          getterCalls += 1
          return "socket connection was closed"
        },
      },
      name: {
        get() {
          getterCalls += 1
          return "AbortError"
        },
      },
    },
  )
  const hostile = Object.create(prototype) as object
  queuedResults.push({ kind: "throw", value: hostile } satisfies QueuedThrow)

  expect(
    await captureRejection(
      copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS }),
    ),
  ).toBe(true)
  expect(getterCalls).toBe(0)
  expect(capturedRequests).toHaveLength(1)
})

test("classifies a hostile inherited prototype chain conservatively", async () => {
  let prototypeTrapCalls = 0
  const prototype = new Proxy(
    {},
    {
      getPrototypeOf() {
        prototypeTrapCalls += 1
        throw new Error("prototype-private-marker")
      },
    },
  )
  const hostile = Object.create(prototype) as object
  queuedResults.push({ kind: "throw", value: hostile } satisfies QueuedThrow)

  expect(
    await captureRejection(
      copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS }),
    ),
  ).toBe(true)
  expect(prototypeTrapCalls).toBe(0)
  expect(capturedRequests).toHaveLength(1)
})

test("keeps inherited runtime error details exact in LLM Debug", () => {
  const ordinary = new TypeError("typed-private-message")
  const domException = new DOMException("dom-private-message", "AbortError")

  expect(toLlmDebugLogError(ordinary)).toMatchObject({
    message: "typed-private-message",
    name: "TypeError",
    stack: ordinary.stack,
  })
  expect(toLlmDebugLogError(domException)).toMatchObject({
    code: 20,
    message: "dom-private-message",
    name: "AbortError",
  })
})

test.each([
  { error: new Error(), name: "Error" },
  { error: new TypeError(), name: "TypeError" },
  { error: new DOMException("", "AbortError"), name: "AbortError" },
])(
  "keeps an exact empty inherited $name message in LLM Debug",
  ({ error, name }) => {
    expect(toLlmDebugLogError(error)).toMatchObject({ message: "", name })
  },
)

test("uses fallback text for an unreadable Error message descriptor", () => {
  let getterCalls = 0
  const error = new Error()
  Object.defineProperty(error, "message", {
    get() {
      getterCalls += 1
      return "private-message"
    },
  })

  expect(toLlmDebugLogError(error)).toMatchObject({
    message: "Unknown thrown value",
    name: "Error",
  })
  expect(getterCalls).toBe(0)
})

test("keeps nested DOMException codes exact in LLM Debug", () => {
  const wrapped = new Error("wrapped transport failure", {
    cause: new DOMException("nested abort", "AbortError"),
  })

  expect(toLlmDebugLogError(wrapped)).toMatchObject({
    code: 20,
    message: "wrapped transport failure",
    name: "Error",
  })
})

test("keeps LLM Debug bounded on hostile inherited descriptors", () => {
  let getterCalls = 0
  const prototype = Object.defineProperties(
    {},
    {
      code: {
        get() {
          getterCalls += 1
          return "PRIVATE_CODE"
        },
      },
      message: {
        get() {
          getterCalls += 1
          return "private message"
        },
      },
      name: {
        get() {
          getterCalls += 1
          return "PrivateError"
        },
      },
      stack: {
        get() {
          getterCalls += 1
          return "private stack"
        },
      },
    },
  )

  expect(toLlmDebugLogError(Object.create(prototype))).toEqual({
    message: "Unknown thrown value",
    name: "Error",
  })
  expect(getterCalls).toBe(0)
})

test("classifies hostile transport values without invoking getters", async () => {
  const privateMarker = "transport-hostile-getter-private-marker"
  let getterCalls = 0
  const hostile = Object.defineProperties(
    {},
    {
      code: {
        get() {
          getterCalls += 1
          throw new Error(privateMarker)
        },
      },
      message: {
        get() {
          getterCalls += 1
          throw new Error(privateMarker)
        },
      },
      name: {
        get() {
          getterCalls += 1
          throw new Error(privateMarker)
        },
      },
    },
  )
  queuedResults.push({ kind: "throw", value: hostile } satisfies QueuedThrow)

  const thrown = await captureThrown(
    copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS }),
  )
  expect(thrown).toBe(hostile)

  expect(getterCalls).toBe(0)
  expect(capturedRequests).toHaveLength(1)
})

test("classifies revoked transport proxies conservatively", async () => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  queuedResults.push({ kind: "throw", value: proxy } satisfies QueuedThrow)

  expect(
    await captureRejection(
      copilotFetch("/models", { method: "GET", headers: AUTH_HEADERS }),
    ),
  ).toBe(true)

  expect(capturedRequests).toHaveLength(1)
})

test("keeps revoked transport values bounded on the Responses debug path", async () => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  queuedResults.push({ kind: "throw", value: proxy } satisfies QueuedThrow)

  expect(
    await captureRejection(
      copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS }),
    ),
  ).toBe(true)

  expect(capturedRequests).toHaveLength(1)
  const entry = (await listLlmDebugLogs()).entries[0]
  expect(entry.status).toBe("error")
  expect(entry.errorMessage).toBe("Unknown thrown value")
})

test("does not expose or retry arbitrary transport classes and codes", async () => {
  const privateMarker = "transport-custom-private-marker"
  const custom = Object.assign(new Error(privateMarker), {
    code: "CUSTOM_PRIVATE_CODE",
    name: "CustomPrivateError",
  })
  queuedResults.push(custom)
  const warnSpy = spyOn(consola, "warn")
  const breadcrumbSpy = spyOn(Sentry, "addBreadcrumb").mockImplementation(
    () => undefined,
  )
  const sentryLogSpy = spyOn(Sentry.logger, "info")

  try {
    const thrown = await captureThrown(
      copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS }),
    )
    expect(thrown).toBe(custom)

    expect(capturedRequests).toHaveLength(1)
    const diagnostics = JSON.stringify({
      breadcrumbs: breadcrumbSpy.mock.calls,
      logger: sentryLogSpy.mock.calls,
      warn: warnSpy.mock.calls,
    })
    expect(diagnostics).not.toContain(privateMarker)
    expect(diagnostics).not.toContain("CUSTOM_PRIVATE_CODE")
    expect(diagnostics).not.toContain("CustomPrivateError")
  } finally {
    sentryLogSpy.mockRestore()
    breadcrumbSpy.mockRestore()
    warnSpy.mockRestore()
  }
})

test("keeps hostile direct transport classification inside its retry budget", async () => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  let claims = 0
  expect(
    await captureRejection(
      handleTransportFailure({
        attemptMs: 1,
        chain: createTransportChain("/responses", "direct-hostile"),
        claimRetry: () => {
          claims += 1
          return true
        },
        error: proxy,
        signal: undefined,
      }),
    ),
  ).toBe(true)
  expect(claims).toBe(0)
})

test("caps repeated connection errors at two transport sends", async () => {
  queuedResults.push(bunSocketClosedError(), bunSocketClosedError())

  let thrownError: unknown
  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch (error) {
    thrownError = error
  }

  expect(thrownError).toBeInstanceOf(Error)
  expect((thrownError as Error).message).toContain("socket connection")
  expect(capturedRequests).toHaveLength(2)
})

test("stops retrying when the request is aborted during the backoff", async () => {
  const controller = new AbortController()
  queuedResults.push(bunSocketClosedError())
  setTimeout(() => {
    controller.abort()
  }, 50)

  let thrownError: unknown
  try {
    await copilotFetch("/responses", {
      method: "POST",
      headers: AUTH_HEADERS,
      signal: controller.signal,
    })
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.name).toBe("AbortError")
  expect(capturedRequests).toHaveLength(1)
})

test("caps an ECONNRESET followed by a 503 at two sends", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("Overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(503)
  expect(capturedRequests).toHaveLength(2)
})

test("caps a 503 followed by an ECONNRESET at two sends", async () => {
  queuedResults.push(
    new Response("Overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
    bunSocketClosedError(),
  )

  let thrownError: unknown
  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.message).toContain(
    "socket connection",
  )
  expect(capturedRequests).toHaveLength(2)
})

test("does not spend the retry budget after an OAuth 401", async () => {
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(401)
  expect(llmSends()).toHaveLength(1)
})

test("keeps the same X-Request-Id across a transport retry", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  await copilotFetch("/responses", {
    method: "POST",
    headers: { ...AUTH_HEADERS, "X-Request-Id": "req-retry-chain" },
  })

  expect(capturedRequests).toHaveLength(2)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    "X-Request-Id": "req-retry-chain",
  })
  expect(capturedRequests[1]?.init?.headers).toMatchObject({
    "X-Request-Id": "req-retry-chain",
  })
})

test("records the connection error code and full path in LLM debug", async () => {
  queuedResults.push(bunSocketClosedError(), bunSocketClosedError())

  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch {
    // exhausted retries — the debug entry is what this test asserts on
  }
  await new Promise((resolve) => setTimeout(resolve, 0))

  const summary = (await listLlmDebugLogs()).entries[0]
  expect(summary).toBeDefined()
  const entry = await getLlmDebugLog(summary.id)
  expect(entry?.error?.code).toBe("ECONNRESET")
  expect(entry?.error?.errno).toBe(0)
  expect(entry?.error?.path).toBe(
    "https://api.githubcopilot.com/responses?session=secret-token",
  )
})

test("does not retry an ECONNABORTED when the caller already disconnected", async () => {
  const controller = new AbortController()
  controller.abort()
  queuedResults.push(
    Object.assign(new Error("The connection was aborted by the peer"), {
      code: "ECONNABORTED",
    }),
  )

  let thrownError: unknown
  try {
    await copilotFetch("/responses", {
      method: "POST",
      headers: AUTH_HEADERS,
      signal: controller.signal,
    })
  } catch (error) {
    thrownError = error
  }

  expect(thrownError).toBeDefined()
  expect(capturedRequests).toHaveLength(1)
  expect(transportEvents).toHaveLength(0)
})

// `delayMs` is the rounded nominal backoff, while `elapsedMs` is real wall
// clock; a timer may fire a couple of ms early, so compare with tolerance.
// The regression this guards (per-attempt timing reported as chain elapsed)
// would leave elapsedMs near zero, far outside this margin.
const SCHEDULING_TOLERANCE_MS = 50

test("reports total chain elapsed time including backoff", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })

  const terminal = transportEvents.at(-1)
  expect(terminal?.outcome).toBe("response_received")
  const elapsedMs = terminal?.attributes.elapsedMs as number
  const attemptMs = terminal?.attributes.attemptMs as number
  const delayMs = transportEvents[0]?.attributes.delayMs as number

  expect(elapsedMs).toBeGreaterThanOrEqual(delayMs - SCHEDULING_TOLERANCE_MS)
  // Chain elapsed must exceed the single send it ended on.
  expect(elapsedMs).toBeGreaterThan(attemptMs)
})

/** A Bun socket error wrapped in an outer Error, carrying fields on the cause. */
function causeWrappedSocketError(): Error {
  return new Error("upstream request failed", {
    cause: Object.assign(new Error("socket closed"), {
      code: "ECONNRESET",
      errno: 0,
      path: "https://api.githubcopilot.com/responses?session=secret",
    }),
  })
}

test("records cause-level errno and full path in LLM debug", async () => {
  queuedResults.push(causeWrappedSocketError(), causeWrappedSocketError())

  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch {
    // exhausted — the debug entry is what this test asserts on
  }
  await new Promise((resolve) => setTimeout(resolve, 0))

  const summary = (await listLlmDebugLogs()).entries[0]
  const entry = await getLlmDebugLog(summary.id)
  expect(entry?.error?.code).toBe("ECONNRESET")
  expect(entry?.error?.errno).toBe(0)
  expect(entry?.error?.path).toBe(
    "https://api.githubcopilot.com/responses?session=secret",
  )
})

test("retries ECONNABORTED instead of reading it as a client cancellation", async () => {
  // The message contains "aborted"; only the code distinguishes a dead socket
  // from a caller-initiated abort.
  const socketAborted = Object.assign(
    new Error("The connection was aborted by the peer"),
    { code: "ECONNABORTED" },
  )
  queuedResults.push(socketAborted, new Response("{}", { status: 200 }))

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(2)
  expect(transportEvents.map((event) => event.outcome)).toEqual([
    "retrying",
    "response_received",
  ])
})

test("emits no transport telemetry when only an HTTP status was retried", async () => {
  queuedResults.push(
    new Response("Overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
    new Response("{}", { status: 200 }),
  )

  await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })

  expect(capturedRequests).toHaveLength(2)
  expect(transportEvents).toHaveLength(0)
})

test("emits no transport telemetry for an OAuth 401", async () => {
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(401)
  expect(capturedRequests).toHaveLength(1)
  expect(transportEvents).toHaveLength(0)
})

test("pairs a retried chain with exactly one response_received", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })

  expect(transportEvents.map((event) => event.outcome)).toEqual([
    "retrying",
    "response_received",
  ])
  const chainIds = new Set(
    transportEvents.map((event) => event.attributes.retryChainId),
  )
  expect(chainIds.size).toBe(1)
  expect(transportEvents[1]?.attributes.status).toBe(200)
})

test("pairs an exhausted chain with exactly one terminal event", async () => {
  queuedResults.push(bunSocketClosedError(), bunSocketClosedError())

  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch {
    // exhausted — telemetry is what this test asserts on
  }

  expect(transportEvents.map((event) => event.outcome)).toEqual([
    "retrying",
    "exhausted",
  ])
  const chainIds = new Set(
    transportEvents.map((event) => event.attributes.retryChainId),
  )
  expect(chainIds.size).toBe(1)
})

test("reports a retried chain that ends in 503 as response_received, not recovery", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("Overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(503)
  expect(transportEvents.map((event) => event.outcome)).toEqual([
    "retrying",
    "response_received",
  ])
  expect(transportEvents[1]?.attributes.status).toBe(503)
})

test("bounds pre-header retry delay without weakening the send budget", () => {
  // A `retry-after` large enough to clamp at MAX_DELAY_SECONDS sleeps 144-180s
  // before any header is sent, which alone exceeds Cloudflare's ~120-125s
  // origin inactivity budget and produces a deterministic 524.
  expect(PRE_HEADER_MAX_DELAY_SECONDS).toBe(30)
  expect(PRE_HEADER_MAX_DELAY_SECONDS).toBeLessThan(MAX_DELAY_SECONDS)

  // MAX_ROUTED_SENDS permits at most two pre-header sleeps per routed call.
  const worstCaseSilenceSeconds =
    (MAX_ROUTED_SENDS - 1) * PRE_HEADER_MAX_DELAY_SECONDS
  expect(worstCaseSilenceSeconds).toBeLessThan(120)

  // The ceiling bounds delay duration only — the COPILOT-API-15 send-count
  // invariants must be untouched.
  expect(MAX_ROUTED_SENDS).toBe(3)
  expect(MAX_RETRIES).toBe(1)
  expect(createRetryBudget()).toEqual({
    compatibilityRetryUsed: false,
    remaining: MAX_ROUTED_SENDS - 1,
  })
})

test("allows a caller to reserve the retry budget for one exact recovery send", () => {
  expect(createRetryBudget({ extraSends: 0 })).toEqual({
    compatibilityRetryUsed: false,
    remaining: 0,
  })
})

test("caps Retry-After only when the caller opts into the streaming pre-header ceiling", async () => {
  queuedResults.push(
    new Response("overloaded", {
      status: 429,
      headers: { "retry-after": "170" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch(
    "/chat/completions",
    { method: "POST" },
    { maxHttpRetryDelaySeconds: PRE_HEADER_MAX_DELAY_SECONDS },
  )

  expect(response.status).toBe(200)
  expect(httpRetrySleeps).toEqual([PRE_HEADER_MAX_DELAY_SECONDS * 1000])
  expect(capturedRequests).toHaveLength(2)
})

test("keeps the normal Retry-After delay for callers without a streaming ceiling", async () => {
  queuedResults.push(
    new Response("overloaded", {
      status: 429,
      headers: { "retry-after": "170" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/chat/completions", { method: "POST" })

  expect(response.status).toBe(200)
  expect(httpRetrySleeps).toHaveLength(1)
  expect(httpRetrySleeps[0]).toBeGreaterThan(
    PRE_HEADER_MAX_DELAY_SECONDS * 1000,
  )
  expect(httpRetrySleeps[0]).toBeLessThanOrEqual(MAX_DELAY_SECONDS * 1000)
  expect(capturedRequests).toHaveLength(2)
})
