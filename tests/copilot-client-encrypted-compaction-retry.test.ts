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

import {
  clearLlmDebugLogs,
  getLlmDebugLog,
  listLlmDebugLogs,
} from "../src/lib/llm-debug-log"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { copilotFetch } from "../src/services/copilot/copilot-client"
import { createRetryBudget } from "../src/services/copilot/transport-retry"
import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const queuedResults: Array<Response> = []
const capturedRequests: Array<{ url: string; init?: RequestInit }> = []
const AUTH_HEADERS = {
  Authorization: "Bearer account-7-copilot-token",
  "content-type": "application/json",
}

function getRequestUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.toString()
  return url.url
}

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const requestUrl = getRequestUrl(url)
  capturedRequests.push({ url: requestUrl, init })
  const next = queuedResults.shift()
  if (!next) throw new Error(`Unexpected fetch: ${requestUrl}`)
  return next
})

function llmSends(): Array<{ url: string; init?: RequestInit }> {
  return capturedRequests.filter(
    (request) => !request.url.includes("/copilot_internal/"),
  )
}

function encryptedVerificationFailure(options?: {
  code?: "invalid_encrypted_content" | "invalid_request_body"
  message?: string
  privateMarker?: string
}): Response {
  const privateMarker = options?.privateMarker ?? "opaque-compaction"
  return Response.json(
    {
      error: {
        code: options?.code ?? "invalid_request_body",
        message:
          options?.message
          ?? `The encrypted content ${privateMarker} could not be verified. Reason: Encrypted content could not be decrypted or parsed.`,
      },
    },
    { status: 400 },
  )
}

function compactionRequestBody(encryptedContent = "opaque-compaction"): string {
  return JSON.stringify({
    input: [
      {
        type: "compaction",
        encrypted_content: encryptedContent,
      },
      {
        type: "message",
        role: "user",
        content: "continue",
      },
    ],
    model: "gpt-5.6-sol",
    stream: true,
  })
}

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  queuedResults.length = 0
  capturedRequests.length = 0
  await clearLlmDebugLogs()
  resetRoutingTelemetryForTest()
  state.accountType = "individual"
  state.githubToken = "github-token"
  state.copilotToken = AUTH_HEADERS.Authorization.slice("Bearer ".length)
  state.isMultiToken = false
})

test("retries encrypted compaction verification failures within the shared send budget", async () => {
  const privateMarker = "encrypted-compaction-private-marker"
  const requestBody = compactionRequestBody(privateMarker)
  queuedResults.push(
    encryptedVerificationFailure({ privateMarker }),
    encryptedVerificationFailure({
      code: "invalid_encrypted_content",
      message: `Encrypted content ${privateMarker} could not be decrypted or parsed.`,
      privateMarker,
    }),
    new Response("{}", { status: 200 }),
  )
  const warnSpy = spyOn(consola, "warn")

  try {
    const response = await copilotFetch(
      "/responses",
      {
        body: requestBody,
        headers: {
          ...AUTH_HEADERS,
          "X-Request-Id": "req-compaction-initial",
        },
        method: "POST",
      },
      {
        telemetry: {
          accountId: 7,
          destination: "Responses",
          model: "gpt-5.6-sol",
          provider: "GitHub Copilot",
          reason: "initial",
        },
      },
    )

    expect(response.status).toBe(400)
    expect(llmSends()).toHaveLength(2)
    expect(llmSends().map(({ init }) => init?.body)).toEqual([
      requestBody,
      requestBody,
    ])
    expect(
      llmSends().map(
        ({ init }) =>
          (init?.headers as Record<string, string> | undefined)?.Authorization,
      ),
    ).toEqual([AUTH_HEADERS.Authorization, AUTH_HEADERS.Authorization])
    const requestIds = llmSends().map(
      ({ init }) =>
        (init?.headers as Record<string, string> | undefined)?.["X-Request-Id"],
    )
    expect(requestIds[0]).toBe("req-compaction-initial")
    expect(new Set(requestIds).size).toBe(2)
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateMarker)

    const usage = getRoutingTelemetrySnapshot({
      accounts: [{ id: 7, accountType: "individual", healthy: true }],
      multiToken: true,
      window: "1h",
    })
    expect(usage.totals).toMatchObject({
      failovers: 0,
      retries: 1,
      upstreamCalls: 2,
    })
    expect(usage.models[0]?.accounts).toEqual([
      { accountId: 7, share: 1, upstreamCalls: 2 },
    ])

    await new Promise((resolve) => setTimeout(resolve, 0))
    const debugEntries = (await listLlmDebugLogs()).entries
    expect(debugEntries).toHaveLength(2)
    expect(debugEntries.map(({ responseStatus }) => responseStatus)).toEqual([
      400, 400,
    ])
    expect(
      await Promise.all(
        debugEntries.map(
          async ({ id }) => (await getLlmDebugLog(id))?.request.body,
        ),
      ),
    ).toEqual([requestBody, requestBody])
  } finally {
    warnSpy.mockRestore()
  }
})

test("returns the final encrypted compaction failure after exhausting the shared send budget", async () => {
  queuedResults.push(
    encryptedVerificationFailure(),
    encryptedVerificationFailure(),
    encryptedVerificationFailure(),
  )

  const response = await copilotFetch("/responses", {
    body: compactionRequestBody(),
    headers: AUTH_HEADERS,
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(llmSends()).toHaveLength(2)
})

test("does not retry encrypted compaction when the shared budget is exhausted", async () => {
  queuedResults.push(encryptedVerificationFailure(), new Response("{}"))
  const response = await copilotFetch(
    "/responses",
    { body: compactionRequestBody(), headers: AUTH_HEADERS, method: "POST" },
    { retryBudget: createRetryBudget({ extraSends: 0 }) },
  )
  expect(response.status).toBe(400)
  expect(llmSends()).toHaveLength(1)
})

for (const failureText of ["could not be decrypted", "could not be parsed"]) {
  test(`retries encrypted compaction failures that ${failureText}`, async () => {
    queuedResults.push(
      encryptedVerificationFailure({
        message: `The encrypted content ${failureText}.`,
      }),
      new Response("{}", { status: 200 }),
    )

    const response = await copilotFetch("/responses", {
      body: compactionRequestBody(),
      headers: AUTH_HEADERS,
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(llmSends()).toHaveLength(2)
  })
}

test("does not retry encrypted verification failures without a compaction item", async () => {
  queuedResults.push(
    encryptedVerificationFailure(),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    body: JSON.stringify({
      input: [{ type: "message", role: "user", content: "continue" }],
      model: "gpt-5.6-sol",
    }),
    headers: AUTH_HEADERS,
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(llmSends()).toHaveLength(1)
})

test("does not retry unrelated invalid_request_body errors with compaction input", async () => {
  queuedResults.push(
    encryptedVerificationFailure({ message: "Request blocked." }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    body: compactionRequestBody(),
    headers: AUTH_HEADERS,
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(llmSends()).toHaveLength(1)
})

test("does not retry unrelated parse failures that only mention encrypted content", async () => {
  queuedResults.push(
    encryptedVerificationFailure({
      message:
        "Encrypted content is present, but tool input could not be parsed.",
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    body: compactionRequestBody(),
    headers: AUTH_HEADERS,
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(llmSends()).toHaveLength(1)
})

test("does not treat unencrypted-content errors as encrypted-content errors", async () => {
  queuedResults.push(
    encryptedVerificationFailure({
      message: "Unencrypted content could not be parsed.",
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    body: compactionRequestBody(),
    headers: AUTH_HEADERS,
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(llmSends()).toHaveLength(1)
})

test("does not retry encrypted input that belongs to another principal", async () => {
  queuedResults.push(
    encryptedVerificationFailure({
      message: "The encrypted input item does not belong to this principal.",
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    body: compactionRequestBody(),
    headers: AUTH_HEADERS,
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(llmSends()).toHaveLength(1)
})

test("does not retry encrypted compaction verification failures outside Responses", async () => {
  queuedResults.push(
    encryptedVerificationFailure(),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/chat/completions", {
    body: compactionRequestBody(),
    headers: AUTH_HEADERS,
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(llmSends()).toHaveLength(1)
})
