/* eslint-disable max-lines -- control-plane wire and routing cases share one fixture */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { HTTPError, LocalHTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"
import {
  createCopilotAutoSession,
  createCopilotModelSession,
  enableCopilotModelPolicy,
  predictCopilotIntent,
} from "~/services/copilot/control-plane"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalApiKeyAuth = state.apiKeyAuth
const originalCopilotToken = state.copilotToken
const originalGitHubToken = state.githubToken
const originalIsMultiToken = state.isMultiToken
const capturedRequests: Array<{ init?: RequestInit; url: string }> = []
const queuedResponses: Array<Response> = []

function sessionToken(subject: string): string {
  return `e30.${Buffer.from(JSON.stringify({ sub: subject })).toString(
    "base64url",
  )}.c2ln`
}

function requestHeaders(index = capturedRequests.length - 1): Headers {
  return new Headers(capturedRequests[index]?.init?.headers)
}

function requestPayload(index = capturedRequests.length - 1): unknown {
  const body = capturedRequests[index]?.init?.body
  return typeof body === "string" ? JSON.parse(body) : undefined
}

function requestUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.toString()
  return url.url
}

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const urlString = requestUrl(url)
  capturedRequests.push({ url: urlString, init })
  const response = queuedResponses.shift()
  if (!response) throw new Error(`Unexpected fetch: ${urlString}`)
  return response
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  tokenPool.dispose()
  state.apiKeyAuth = originalApiKeyAuth
  state.copilotToken = originalCopilotToken
  state.githubToken = originalGitHubToken
  state.isMultiToken = originalIsMultiToken
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

afterEach(() => {
  for (const account of tokenPool.getAllAccounts()) {
    tokenPool.removeAccountForTest(account.id)
  }
})

beforeEach(() => {
  tokenPool.dispose()
  for (const account of tokenPool.getAllAccounts()) {
    tokenPool.removeAccountForTest(account.id)
  }
  capturedRequests.length = 0
  queuedResponses.length = 0
  fetchMock.mockClear()
  state.isMultiToken = false
  state.apiKeyAuth = undefined
  state.copilotToken = "control-plane-copilot-token"
  state.githubToken = undefined
  state.sessionId = "control-plane-test-session"
})

function registerAccount(
  id: number,
  token: string,
  models: Array<string>,
): void {
  const account = tokenPool.addAccount(`github-token-${id}`, "individual", id)
  account.copilotToken = token
  account.healthy = true
  account.models = new Set(models)
  tokenPool.rebuildModelIndex()
}

const continuityErrorBody = {
  error: {
    code: "session_account_continuity_error",
    message: "The Copilot session token does not match the selected account.",
    type: "session_affinity_error",
  },
}

function findHealthyAffinity(accountId: number): string {
  const key = Array.from(
    { length: 2000 },
    (_, index) => `route-affinity-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getHealthyAccountBySession(candidate)?.id === accountId,
  )
  if (!key) throw new TypeError(`No affinity found for account ${accountId}`)
  return key
}

const accountUnavailableBody = {
  error: {
    code: "account_unavailable",
    message: "No healthy Copilot account is available for this request.",
    type: "account_unavailable",
  },
}

function noAccountServiceCalls(): Array<{
  name: string
  run(): Promise<unknown>
}> {
  return [
    {
      name: "policy",
      run: async () =>
        await seedProtocolDatabase().then(() =>
          enableCopilotModelPolicy("missing-model"),
        ),
    },
    {
      name: "model session",
      run: async () =>
        await seedProtocolDatabase().then(() => createCopilotModelSession({})),
    },
    {
      name: "Auto",
      run: async () =>
        await seedProtocolDatabase().then(() =>
          createCopilotAutoSession({
            payload: { prompt: "choose a model" },
          }),
        ),
    },
    {
      name: "intent",
      run: async () =>
        await seedProtocolDatabase().then(() =>
          predictCopilotIntent({
            payload: {
              available_models: ["missing-model"],
              prompt: "choose a model",
            },
            sessionToken: "service-session-secret",
          }),
        ),
    },
  ]
}

function noAccountRouteRequests(): Array<{
  init: RequestInit
  name: string
  path: string
}> {
  return [
    {
      name: "policy",
      path: "/models/missing-model/policy",
      init: { method: "POST" },
    },
    {
      name: "model session",
      path: "/models/session",
      init: {
        method: "POST",
        headers: { "Copilot-Session-Token": "route-session-secret" },
      },
    },
    {
      name: "Auto",
      path: "/auto",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "choose a model" }),
      },
    },
    {
      name: "intent",
      path: "/models/session/intent",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Copilot-Session-Token": "route-session-secret",
        },
        body: JSON.stringify({
          available_models: ["missing-model"],
          prompt: "choose a model",
        }),
      },
    },
  ]
}

test("enables a percent-encoded model policy", async () => {
  queuedResponses.push(Response.json({ ignored: true }))

  const result = await seedProtocolDatabase().then(() =>
    enableCopilotModelPolicy("claude/model 1"),
  )

  expect(result).toEqual({ success: true })
  expect(capturedRequests[0]?.url).toBe(
    "https://api.githubcopilot.com/models/claude%2Fmodel%201/policy",
  )
  expect(capturedRequests[0]?.init?.method).toBe("POST")
  expect(capturedRequests[0]?.init?.body).toBeUndefined()
})

test("maps policy 403 to the fixed compatibility result", async () => {
  const upstream = Response.json(
    { error: { message: "private policy reason" } },
    { status: 403 },
  )
  queuedResponses.push(upstream)

  const result = await seedProtocolDatabase().then(() =>
    enableCopilotModelPolicy("gpt-current"),
  )

  expect(result).toEqual({
    success: false,
    can_be_enabled: false,
    error:
      "This model cannot be enabled. Your organization or subscription may not permit self-service model enablement.",
  })
  expect(upstream.bodyUsed).toBe(true)
})

test("creates and refreshes model sessions", async () => {
  queuedResponses.push(
    Response.json({ token: "created" }),
    Response.json({ token: "refreshed" }),
  )

  expect(
    await seedProtocolDatabase().then(() => createCopilotModelSession({})),
  ).toEqual({ token: "created" })
  expect(capturedRequests[0]?.url).toBe(
    "https://api.githubcopilot.com/models/session",
  )
  expect(requestPayload(0)).toEqual({
    auto_mode: { model_hints: ["auto"] },
  })
  expect(requestHeaders(0).get("copilot-session-token")).toBeNull()

  expect(
    await seedProtocolDatabase().then(() =>
      createCopilotModelSession({ existingToken: "session-secret" }),
    ),
  ).toEqual({ token: "refreshed" })
  expect(capturedRequests[1]?.url).toBe(
    "https://api.githubcopilot.com/models/session",
  )
  expect(capturedRequests[1]?.init?.body).toBeUndefined()
  expect(requestHeaders(1).get("copilot-session-token")).toBe("session-secret")
})

test("creates Auto sessions with forward-compatible optional fields", async () => {
  queuedResponses.push(Response.json({ selected_model: "gpt-current" }))

  const payload = {
    prompt: "inspect image",
    has_image: false,
    tier: null,
    multi_turn: { sigma: 1.2 },
    previous_user_messages: ["oldest", "latest"],
    model_hints: ["custom"],
    sticky_threshold: 0,
    routing_method: "future",
    copilot_plan: { name: "pro" },
    unknown: { nested: [false, null, { value: 1 }] },
  }
  const source = structuredClone(payload)

  await seedProtocolDatabase().then(() => createCopilotAutoSession({ payload }))

  expect(capturedRequests[0]?.url).toBe("https://api.githubcopilot.com/auto")
  expect(requestPayload()).toEqual(source)
  expect(payload).toEqual(source)
})

test("requires and forwards the model session token for intent", async () => {
  const missingTokenError = await seedProtocolDatabase()
    .then(() =>
      predictCopilotIntent({
        sessionToken: "",
        payload: { prompt: "refactor", available_models: ["gpt-current"] },
      }),
    )
    .catch((error: unknown) => error)
  expect(missingTokenError).toBeInstanceOf(LocalHTTPError)
  expect(capturedRequests).toHaveLength(0)

  queuedResponses.push(Response.json({ intent: "code" }))
  const payload = {
    prompt: "refactor",
    previous_user_messages: ["oldest", "latest"],
    routing_intent: "code",
    available_models: ["must-not-override"],
    has_image: true,
    model_hints: ["future-model"],
    sticky_threshold: null,
    routing_method: "future",
    copilot_plan: { tier: "enterprise" },
    unknown: { nested: [false, null] },
  }
  const source = structuredClone(payload)
  await seedProtocolDatabase().then(() =>
    predictCopilotIntent({
      sessionToken: "session-secret",
      payload,
    }),
  )

  expect(capturedRequests[0]?.url).toBe(
    "https://api.githubcopilot.com/models/session/intent",
  )
  expect(requestHeaders().get("copilot-session-token")).toBe("session-secret")
  expect(requestPayload()).toEqual(source)
  expect(payload).toEqual(source)
})

test("normalizes invalid session tokens before control-plane sends", async () => {
  queuedResponses.push(Response.json({ token: "created" }))

  await seedProtocolDatabase().then(() =>
    createCopilotModelSession({ existingToken: " \r\n" }),
  )

  expect(requestPayload()).toEqual({
    auto_mode: { model_hints: ["auto"] },
  })
  expect(requestHeaders().get("copilot-session-token")).toBeNull()

  const error = await seedProtocolDatabase()
    .then(() =>
      predictCopilotIntent({
        sessionToken: " \r\n",
        payload: { prompt: "refactor", available_models: ["gpt-current"] },
      }),
    )
    .catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(LocalHTTPError)
  expect(capturedRequests).toHaveLength(1)
})

test("rejects malformed successful control-plane JSON", async () => {
  queuedResponses.push(Response.json(["not", "a", "record"]))

  const error = await seedProtocolDatabase()
    .then(() => createCopilotModelSession({}))
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).message).toBe(
    "Invalid Copilot control-plane response",
  )
  expect((error as HTTPError).response.status).toBe(502)
})

test("never logs or exposes a session token on service errors", async () => {
  const upstream = Response.json(
    { error: { message: "session-secret private body" } },
    { status: 400 },
  )
  const expectedBytes = Array.from(
    new Uint8Array(await upstream.clone().arrayBuffer()),
  )
  queuedResponses.push(upstream)
  const errorSpy = spyOn(consola, "error")
  let error: unknown
  try {
    error = await seedProtocolDatabase()
      .then(() =>
        createCopilotModelSession({
          existingToken: "session-secret",
        }),
      )
      .catch((caught: unknown) => caught)
  } finally {
    errorSpy.mockRestore()
  }

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).message).toBe(
    "Copilot control-plane request failed",
  )
  const failedResponse = (error as HTTPError).response
  expect(failedResponse.status).toBe(upstream.status)
  expect(failedResponse.statusText).toBe(upstream.statusText)
  expect(Object.fromEntries(failedResponse.headers)).toEqual(
    Object.fromEntries(upstream.headers),
  )
  expect(failedResponse.bodyUsed).toBe(false)
  expect(
    Array.from(new Uint8Array(await failedResponse.arrayBuffer())),
  ).toEqual(expectedBytes)
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("session-secret")
})

test("preserves the fixed local account-unavailable error for every service", async () => {
  state.isMultiToken = true
  const errorSpy = spyOn(consola, "error")
  try {
    for (const service of noAccountServiceCalls()) {
      const error = await service.run().catch((caught: unknown) => caught)

      expect(error, service.name).toBeInstanceOf(LocalHTTPError)
      expect((error as LocalHTTPError).response.status, service.name).toBe(503)
      expect((error as LocalHTTPError).clientBody, service.name).toEqual(
        accountUnavailableBody,
      )
    }
  } finally {
    errorSpy.mockRestore()
  }

  expect(capturedRequests).toHaveLength(0)
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
    "service-session-secret",
  )
})

test("keeps an identical upstream 503 body on the sanitized HTTPError path", async () => {
  queuedResponses.push(
    Response.json(accountUnavailableBody, {
      status: 503,
      headers: { "retry-after": "0" },
    }),
    Response.json(accountUnavailableBody, { status: 503 }),
  )

  const error = await seedProtocolDatabase()
    .then(() => createCopilotModelSession({}))
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect(error).not.toBeInstanceOf(LocalHTTPError)
  expect((error as HTTPError).message).toBe(
    "Copilot control-plane request failed",
  )
  expect(capturedRequests).toHaveLength(2)
})

test("serves exact model-session, Auto, and intent routes", async () => {
  queuedResponses.push(
    Response.json({ session_token: "created-token" }),
    Response.json({ selected_model: "gpt-current" }),
    Response.json({ intent: "code" }),
  )

  const session = await seedProtocolDatabase().then(() =>
    server.request("/models/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "Copilot-Session-Token": "existing-session-token",
        "X-Client-Session-Id": "route-session",
      },
    }),
  )
  expect(session.status).toBe(200)
  expect(await session.json()).toEqual({ session_token: "created-token" })
  expect(capturedRequests[0]?.url).toBe(
    "https://api.githubcopilot.com/models/session",
  )
  expect(capturedRequests[0]?.init?.body).toBeUndefined()
  expect(requestHeaders(0).get("copilot-session-token")).toBe(
    "existing-session-token",
  )

  const autoPayload = {
    prompt: "inspect image",
    has_image: "future-value",
    tier: null,
    multi_turn: ["future-shape"],
    previous_user_messages: { future: true },
    model_hints: ["custom"],
    sticky_threshold: false,
    routing_method: "future",
    copilot_plan: { name: "pro" },
    unknown: { nested: [false, null] },
  }
  const auto = await seedProtocolDatabase().then(() =>
    server.request("/auto", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "X-Client-Session-Id": "route-session",
      },
      body: JSON.stringify(autoPayload),
    }),
  )
  expect(auto.status).toBe(200)
  expect(await auto.json()).toEqual({ selected_model: "gpt-current" })
  expect(capturedRequests[1]?.url).toBe("https://api.githubcopilot.com/auto")
  expect(requestPayload(1)).toEqual(autoPayload)

  const intentPayload = {
    prompt: "refactor",
    available_models: ["gpt-current", "claude-current"],
    has_image: "future-value",
    previous_user_messages: { future: true },
    routing_intent: { future: true },
    model_hints: ["custom"],
    sticky_threshold: null,
    routing_method: "future",
    copilot_plan: { name: "pro" },
    unknown: { nested: [false, null] },
  }
  const intent = await seedProtocolDatabase().then(() =>
    server.request("/models/session/intent", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "Copilot-Session-Token": "existing-session-token",
        "X-Client-Session-Id": "route-session",
      },
      body: JSON.stringify(intentPayload),
    }),
  )
  expect(intent.status).toBe(200)
  expect(await intent.json()).toEqual({ intent: "code" })
  expect(capturedRequests[2]?.url).toBe(
    "https://api.githubcopilot.com/models/session/intent",
  )
  expect(requestPayload(2)).toEqual(intentPayload)
})

test("preserves the fixed local account-unavailable error on every public route", async () => {
  state.isMultiToken = true
  const errorSpy = spyOn(consola, "error")
  try {
    for (const route of noAccountRouteRequests()) {
      const response = await seedProtocolDatabase().then(() =>
        server.request(route.path, {
          ...route.init,
          headers: {
            authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
            ...Object.fromEntries(new Headers(route.init.headers)),
          },
        }),
      )

      expect(response.status, route.name).toBe(503)
      expect(await response.json(), route.name).toEqual(accountUnavailableBody)
    }
  } finally {
    errorSpy.mockRestore()
  }

  expect(capturedRequests).toHaveLength(0)
  const logs = JSON.stringify(errorSpy.mock.calls)
  expect(logs).not.toContain("route-session-secret")
  expect(logs).not.toContain("service-session-secret")
})

test("serves model policy on both public aliases", async () => {
  queuedResponses.push(
    Response.json({ enabled: true }),
    Response.json({ enabled: true }),
  )
  const encodedModel = "claude%2Fmodel%201"

  for (const prefix of ["/models", "/v1/models"]) {
    const response = await seedProtocolDatabase().then(() =>
      server.request(`${prefix}/${encodedModel}/policy`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "X-Client-Session-Id": "policy-session",
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
  }

  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.githubcopilot.com/models/claude%2Fmodel%201/policy",
    "https://api.githubcopilot.com/models/claude%2Fmodel%201/policy",
  ])
})

test("keeps every control-plane route behind inference authentication", async () => {
  state.apiKeyAuth = "control-plane-api-key"

  for (const path of [
    "/models/session",
    "/models/session/intent",
    "/auto",
    "/models/gpt-current/policy",
    "/v1/models/gpt-current/policy",
  ]) {
    const response = await seedProtocolDatabase().then(() =>
      server.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(response.status, path).toBe(401)
  }
  expect(capturedRequests).toHaveLength(0)

  queuedResponses.push(Response.json({ created: true }))
  const authorized = await seedProtocolDatabase().then(() =>
    server.request("/models/session", {
      method: "POST",
      headers: { "x-api-key": "control-plane-api-key" },
    }),
  )
  expect(authorized.status).toBe(200)
})

test("rejects invalid Auto and intent payloads without upstream sends", async () => {
  const invalidRequests: Array<{
    body: string
    headers: Record<string, string>
    param: string
    path: string
  }> = [
    {
      path: "/auto",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: " " }),
      param: "prompt",
    },
    {
      path: "/models/session/intent",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "refactor",
        available_models: ["gpt-current"],
      }),
      param: "Copilot-Session-Token",
    },
    {
      path: "/models/session/intent",
      headers: {
        "content-type": "application/json",
        "Copilot-Session-Token": "session-token",
      },
      body: JSON.stringify({ prompt: "refactor", available_models: [] }),
      param: "available_models",
    },
  ]

  for (const request of invalidRequests) {
    const response = await seedProtocolDatabase().then(() =>
      server.request(request.path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          ...Object.fromEntries(new Headers(request.headers)),
        },
        body: request.body,
      }),
    )
    expect(response.status, request.param).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        param: request.param,
        type: "invalid_request_error",
      },
    })
  }
  expect(capturedRequests).toHaveLength(0)
})

test("routes by affinity and forwards token-required calls only on issuer continuity", async () => {
  state.isMultiToken = true
  registerAccount(14_001, "tid=issuer-one;exp=1900000000", ["gpt-current"])
  registerAccount(14_002, "tid=issuer-two;exp=1900000000", ["gpt-current"])
  const secondAffinity = findHealthyAffinity(14_002)
  const token = sessionToken("issuer-one")
  queuedResponses.push(Response.json({ call: 1 }), Response.json({ call: 2 }))

  const refresh = await seedProtocolDatabase().then(() =>
    server.request("/models/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "Copilot-Session-Token": token,
        "X-Client-Session-Id": secondAffinity,
      },
    }),
  )
  expect(refresh.status).toBe(200)
  const intent = await seedProtocolDatabase().then(() =>
    server.request("/models/session/intent", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "Copilot-Session-Token": token,
        "X-Client-Session-Id": secondAffinity,
      },
      body: JSON.stringify({
        prompt: "route this",
        available_models: ["gpt-current"],
        unknown: { preserve: true },
      }),
    }),
  )
  expect(intent.status).toBe(200)

  expect(
    capturedRequests.map((request) =>
      new Headers(request.init?.headers).get("authorization"),
    ),
  ).toEqual([
    "Bearer tid=issuer-one;exp=1900000000",
    "Bearer tid=issuer-one;exp=1900000000",
  ])
  expect(
    capturedRequests.map((request) =>
      new Headers(request.init?.headers).get("copilot-session-token"),
    ),
  ).toEqual([token, token])
  expect(requestPayload(1)).toEqual({
    prompt: "route this",
    available_models: ["gpt-current"],
    unknown: { preserve: true },
  })
})

test.each([
  {
    name: "model-session refresh",
    path: "/models/session",
    body: undefined,
  },
  {
    name: "model-session intent",
    path: "/models/session/intent",
    body: JSON.stringify({
      prompt: "refactor",
      available_models: ["gpt-current"],
    }),
  },
] as const)(
  "$name rejects mismatched or unknown issuer proof locally without an upstream send",
  async ({ body, path }) => {
    state.isMultiToken = true
    registerAccount(14_001, "tid=issuer-one;exp=1900000000", ["gpt-current"])
    registerAccount(14_002, "tid=issuer-two;exp=1900000000", ["gpt-current"])
    const affinity = findHealthyAffinity(14_001)

    for (const token of [
      sessionToken("issuer-three"),
      `e30.${Buffer.from(JSON.stringify({ selected_model: "gpt-current" })).toString("base64url")}.c2ln`,
      "malformed-session-token",
    ]) {
      const response = await seedProtocolDatabase().then(() =>
        server.request(path, {
          method: "POST",
          headers: {
            authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
            ...(body ? { "content-type": "application/json" } : {}),
            "Copilot-Session-Token": token,
            "X-Client-Session-Id": affinity,
          },
          ...(body ? { body } : {}),
        }),
      )
      expect(response.status).toBe(409)
      const responseText = await response.text()
      expect(JSON.parse(responseText) as unknown).toEqual(continuityErrorBody)
      expect(responseText).not.toContain(token)
      expect(responseText).not.toContain("issuer-one")
      expect(responseText).not.toContain("issuer-two")
    }

    expect(capturedRequests).toHaveLength(0)
  },
)

test("tokenless model-session creation and Auto remain ordinary affinity-selected calls", async () => {
  state.isMultiToken = true
  registerAccount(14_001, "tid=issuer-one;exp=1900000000", ["gpt-current"])
  registerAccount(14_002, "tid=issuer-two;exp=1900000000", ["gpt-current"])
  const affinity = findHealthyAffinity(14_001)
  queuedResponses.push(
    Response.json({ session_token: sessionToken("issuer-one") }),
    Response.json({ selected_model: "gpt-current" }),
  )

  const session = await seedProtocolDatabase().then(() =>
    server.request("/models/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "X-Client-Session-Id": affinity,
      },
    }),
  )
  expect(session.status).toBe(200)
  const auto = await seedProtocolDatabase().then(() =>
    server.request("/auto", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "X-Client-Session-Id": affinity,
      },
      body: JSON.stringify({ prompt: "choose" }),
    }),
  )
  expect(auto.status).toBe(200)
  expect(capturedRequests.map(({ url }) => new URL(url).pathname)).toEqual([
    "/models/session",
    "/auto",
  ])
  expect(
    capturedRequests.map((request) =>
      new Headers(request.init?.headers).get("authorization"),
    ),
  ).toEqual([
    "Bearer tid=issuer-one;exp=1900000000",
    "Bearer tid=issuer-one;exp=1900000000",
  ])
})

test("preserves control-plane error bytes and approved response metadata", async () => {
  const errorSpy = spyOn(consola, "error")
  const rawBodyMarker = "raw-control-plane-body-marker"
  const requestSessionMarker = "request-session-marker"
  const body = new TextEncoder().encode(`${rawBodyMarker}\r\n  `)
  queuedResponses.push(
    new Response(body.slice(), {
      status: 400,
      headers: {
        "content-type": "application/problem+json",
        "x-github-request-id": "safe-request-id",
        "x-private-upstream": "private-metadata",
      },
    }),
  )
  let response: Response
  let logOutput: string
  try {
    response = await seedProtocolDatabase().then(() =>
      server.request("/models/session", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "Copilot-Session-Token": requestSessionMarker,
        },
      }),
    )
    logOutput = JSON.stringify(errorSpy.mock.calls)
  } finally {
    errorSpy.mockRestore()
  }

  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toBe("application/problem+json")
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
    Array.from(body),
  )
  expect(response.headers.get("x-github-request-id")).toBe("safe-request-id")
  expect(response.headers.get("x-private-upstream")).toBeNull()
  expect(logOutput).toContain(rawBodyMarker)
  expect(logOutput).not.toContain(requestSessionMarker)
})
