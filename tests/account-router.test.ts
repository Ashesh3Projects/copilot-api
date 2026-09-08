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

import type { Model } from "../src/services/copilot/get-models"

import {
  getLastUsedAccountId,
  routedControlPlaneFetch,
  routedFetch,
} from "../src/lib/account-router"
import { runWithCopilotContractObservabilityScope } from "../src/lib/copilot-contract-observability"
import { runWithCopilotRequestAttribution } from "../src/lib/copilot-request-context"
import { LocalHTTPError } from "../src/lib/error"
import { setModelRoutingOverridesForTest } from "../src/lib/model-routing"
import {
  clientSessionStorage,
  copilotResponseHeadersStorage,
  getCopilotResponseHeaders,
  requestIdStorage,
  routedAccountStorage,
  runWithRequestDiagnostics,
  suppressRequestModelDiagnostics,
} from "../src/lib/request-session"
import { runWithRoutingAffinity } from "../src/lib/routing-affinity"
/* eslint-disable max-lines -- account-router integration variants share singleton fixtures */
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
type FetchResultFactory = (
  url: string,
  init?: RequestInit,
) => Promise<Response> | Response
const queuedResults: Array<Error | FetchResultFactory | Response> = []
const capturedRequests: Array<{ url: string; init?: RequestInit }> = []

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

  if (next instanceof Error) {
    throw next
  }
  if (typeof next === "function") {
    return next(requestUrl, init)
  }

  return next
})

function createModel(id: string): Model {
  return {
    capabilities: {
      family: "gpt-4o",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "test",
  }
}

function registerAccount(
  id: number,
  modelId: string,
  copilotToken: string,
): void {
  const account = tokenPool.addAccount(`github-token-${id}`, "individual", id)
  account.copilotToken = copilotToken
  account.models = new Set([modelId])
  account.modelsData = [createModel(modelId)]
  account.healthy = true
}

function registerEnterpriseAccount(
  id: number,
  modelId: string,
  instanceDomain: string,
): void {
  const githubToken = `enterprise-token-${id}`
  const account = tokenPool.addAccount(githubToken, {
    accountType: "enterprise",
    githubInstanceDomain: instanceDomain,
    id,
  })
  account.copilotToken = githubToken
  account.copilotApiBaseUrl = `https://copilot-api.${instanceDomain}`
  account.models = new Set([modelId])
  account.modelsData = [createModel(modelId)]
  account.healthy = true
}

function findKeyForAccount(modelId: string, accountId: number): string {
  const key = Array.from(
    { length: 1000 },
    (_, index) => `session-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountForModelBySession(modelId, candidate)?.id
      === accountId,
  )
  if (!key)
    throw new TypeError(`No affinity key found for account ${accountId}`)
  return key
}

function findAnotherKeyForAccount(
  modelId: string,
  accountId: number,
  excluded: string,
): string {
  const key = Array.from({ length: 1000 }, (_, index) => `other-${index}`).find(
    (candidate) =>
      candidate !== excluded
      && tokenPool.getAccountForModelBySession(modelId, candidate)?.id
        === accountId,
  )
  if (!key) throw new TypeError(`No second key found for account ${accountId}`)
  return key
}

function modelsResponse(modelIds: Array<string>): Response {
  return Response.json({
    data: modelIds.map((modelId) => createModel(modelId)),
    object: "list",
  })
}

function llmAuthorizationHeaders(): Array<string | null> {
  return capturedRequests
    .filter(
      ({ url }) =>
        !url.includes("/copilot_internal/") && !url.endsWith("/models"),
    )
    .map(({ init }) => new Headers(init?.headers).get("authorization"))
}

function responseMetadataEvents(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): Array<unknown> {
  return calls
    .filter(
      (call) =>
        call[0] === "[copilot-contract]"
        && (call[1] as { kind?: unknown } | undefined)?.kind
          === "response_metadata",
    )
    .map((call) => call[1])
}

async function routedFetchWithMetadataStore(modelId: string): Promise<{
  headers: Record<string, string>
  result: { account: unknown; response: Response }
}> {
  return await copilotResponseHeadersStorage.run(
    {},
    async () =>
      await runWithCopilotContractObservabilityScope(async () => {
        const result = await seedProtocolDatabase().then(() =>
          routedFetch(
            "/chat/completions",
            { method: "POST" },
            { maxHttpRetryDelaySeconds: 0, modelId },
          ),
        )
        return { result, headers: { ...getCopilotResponseHeaders() } }
      }),
  )
}

function retryableSocketError(): Error {
  return Object.assign(new Error("socket connection was closed unexpectedly"), {
    code: "ECONNRESET",
  })
}

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  setModelRoutingOverridesForTest({})
  tokenPool.rebuildModelIndex()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  tokenPool.dispose()
  for (const account of tokenPool.getAllAccounts()) {
    tokenPool.removeAccountForTest(account.id)
  }
  fetchMock.mockClear()
  queuedResults.length = 0
  capturedRequests.length = 0
  setModelRoutingOverridesForTest({})
  state.isMultiToken = true
  state.githubToken = "github-token"
  state.copilotToken = "copilot-token"
  state.githubInstanceDomain = "github.com"
  state.accountType = "individual"
  state.copilotApiBaseUrl = undefined
  state.sessionId = "router-test-session"
})

test("routes control-plane policy through raw advertised model membership", async () => {
  const modelId = "control-plane-disabled-inference-model"
  registerAccount(13_001, modelId, "raw-advertising-token")
  registerAccount(13_002, modelId, "inference-enabled-token")
  setModelRoutingOverridesForTest({ [modelId]: { "13001": false } })
  tokenPool.rebuildModelIndex()
  const affinityKey = Array.from(
    { length: 1000 },
    (_, index) => `control-plane-policy-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountAdvertisingModelBySession(modelId, candidate)?.id
      === 13_001,
  )
  if (!affinityKey) throw new TypeError("Expected policy affinity key")
  queuedResults.push(Response.json({ success: true }))

  const result = await requestIdStorage.run("control-plane-request-id", () =>
    runWithCopilotRequestAttribution(
      {
        clientMachineId: "control-plane-machine",
        openaiIntent: "control-plane-intent",
        subsystemId: "control-plane-subsystem",
      },
      () =>
        routedAccountStorage.run({}, () =>
          runWithRoutingAffinity(
            { key: affinityKey, source: "copilot_session" },
            async () => {
              await seedProtocolDatabase()
              const routed = await routedControlPlaneFetch({
                modelId,
                path: `/models/${encodeURIComponent(modelId)}/policy`,
              })
              return { lastAccountId: getLastUsedAccountId(), routed }
            },
          ),
        ),
    ),
  )

  expect(tokenPool.getEligibleAccountIdsForModel(modelId)).toEqual([13_002])
  expect(result.routed.account?.id).toBe(13_001)
  expect(result.lastAccountId).toBe(13_001)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.url).toBe(
    `https://api.githubcopilot.com/models/${encodeURIComponent(modelId)}/policy`,
  )
  const headers = new Headers(capturedRequests[0]?.init?.headers)
  expect(headers.get("authorization")).toBe("Bearer raw-advertising-token")
  expect(headers.get("copilot-integration-id")).toBe(state.copilotIntegrationId)
  expect(headers.get("copilot-subsystem-id")).toBe("control-plane-subsystem")
  expect(headers.get("openai-intent")).toBe("control-plane-intent")
  expect(headers.get("x-client-machine-id")).toBe("control-plane-machine")
  expect(headers.get("x-github-api-version")).toBe("2026-08-01")
  expect(headers.get("x-request-id")).toBe("control-plane-request-id")
})

test("forwards typed control-plane body, session token, and abort signal", async () => {
  const matchingSessionToken = `e30.${Buffer.from(
    JSON.stringify({ sub: "control-plane-issuer" }),
  ).toString("base64url")}.c2ln`
  registerAccount(13_011, "model-a", "tid=control-plane-issuer;exp=1900000000")
  tokenPool.rebuildModelIndex()
  const controller = new AbortController()
  queuedResults.push(Response.json({ session: "created" }))

  const result = await runWithRoutingAffinity(
    { key: "control-plane-session", source: "copilot_session" },
    async () =>
      await seedProtocolDatabase().then(() =>
        routedControlPlaneFetch({
          body: { auto_mode: { model_hints: ["auto"] } },
          copilotSessionToken: matchingSessionToken,
          path: "/models/session",
          signal: controller.signal,
        }),
      ),
  )

  expect(result.account?.id).toBe(13_011)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.method).toBe("POST")
  expect(capturedRequests[0]?.init?.body).toBe(
    JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
  )
  expect(capturedRequests[0]?.init?.signal).toBe(controller.signal)
  expect(
    new Headers(capturedRequests[0]?.init?.headers).get(
      "copilot-session-token",
    ),
  ).toBe(matchingSessionToken)
})

test("returns local 503 without sending when no account advertises a policy model", async () => {
  registerAccount(13_021, "different-model", "unrelated-token")
  tokenPool.rebuildModelIndex()

  const { account, response } = await seedProtocolDatabase().then(() =>
    routedControlPlaneFetch({
      modelId: "missing-policy-model",
      path: "/models/missing-policy-model/policy",
    }),
  )

  expect(account).toBeUndefined()
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    error: {
      code: "account_unavailable",
      message: "No healthy Copilot account is available for this request.",
      type: "account_unavailable",
    },
  })
  expect(capturedRequests).toHaveLength(0)
})

test("returns a selected control-plane 401 without reinitialization or cross-account failover", async () => {
  registerAccount(13_031, "model-a", "tid=control-plane-issuer;exp=expired")
  registerAccount(13_032, "model-a", "tid=alternate-issuer;exp=current")
  tokenPool.rebuildModelIndex()
  const affinityKey = Array.from(
    { length: 1000 },
    (_, index) => `control-plane-reinit-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getHealthyAccountBySession(candidate)?.id === 13_031,
  )
  if (!affinityKey) throw new TypeError("Expected control-plane affinity key")
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const { account, response } = await runWithRoutingAffinity(
    { key: affinityKey, source: "copilot_session" },
    async () =>
      await seedProtocolDatabase().then(() =>
        routedControlPlaneFetch({
          copilotSessionToken: `e30.${Buffer.from(
            JSON.stringify({ sub: "control-plane-issuer" }),
          ).toString("base64url")}.c2ln`,
          path: "/models/session",
        }),
      ),
  )

  expect(response.status).toBe(401)
  expect(account?.id).toBe(13_031)
  expect(llmAuthorizationHeaders()).toEqual([
    "Bearer tid=control-plane-issuer;exp=expired",
  ])
  expect(llmAuthorizationHeaders()).not.toContain(
    "Bearer tid=alternate-issuer;exp=current",
  )
})

test("rediscovers a selected control-plane account after a 421", async () => {
  registerAccount(13_033, "model-a", "oauth-control-primary")
  registerAccount(13_034, "model-a", "oauth-control-secondary")
  tokenPool.rebuildModelIndex()
  const account = tokenPool.getEligibleAccountForModel("model-a", 13_033)
  if (!account) throw new TypeError("Expected selected control-plane account")
  account.githubToken = "oauth-control-primary"
  account.copilotApiBaseUrl = "https://api.githubcopilot.com"
  const affinityKey = Array.from(
    { length: 1000 },
    (_, index) => `control-plane-misdirected-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getHealthyAccountBySession(candidate)?.id === account.id,
  )
  if (!affinityKey) throw new TypeError("Expected control-plane affinity key")
  queuedResults.push(
    new Response("Misdirected Request", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.business.githubcopilot.com" },
      login: "control-primary",
    }),
    modelsResponse(["model-a"]),
    Response.json({ session: "created" }),
  )

  const result = await runWithRoutingAffinity(
    { key: affinityKey, source: "copilot_session" },
    async () =>
      await seedProtocolDatabase().then(() =>
        routedControlPlaneFetch({ path: "/models/session" }),
      ),
  )

  expect(result.response.status).toBe(200)
  expect(result.account?.id).toBe(account.id)
  expect(
    tokenPool.getAllAccounts().find((current) => current.id === account.id)
      ?.copilotApiBaseUrl,
  ).toBe("https://api.business.githubcopilot.com")
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.githubcopilot.com/models/session",
    "https://api.github.com/copilot_internal/user",
    "https://api.business.githubcopilot.com/models",
    "https://api.business.githubcopilot.com/models/session",
  ])
  expect(llmAuthorizationHeaders()).toEqual([
    "Bearer oauth-control-primary",
    "Bearer oauth-control-primary",
  ])
})

test("does not resend a control-plane request after the selected account rejects it", async () => {
  const matchingSessionToken = `e30.${Buffer.from(
    JSON.stringify({ sub: "original-issuer" }),
  ).toString("base64url")}.c2ln`
  registerAccount(13_041, "model-a", "tid=original-issuer;exp=expired")
  registerAccount(13_042, "model-a", "tid=alternate-issuer;exp=current")
  tokenPool.rebuildModelIndex()
  const affinityKey = Array.from(
    { length: 1000 },
    (_, index) => `control-plane-changed-issuer-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getHealthyAccountBySession(candidate)?.id === 13_041,
  )
  if (!affinityKey) throw new TypeError("Expected changed-issuer affinity")
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const result = await runWithRoutingAffinity(
    { key: affinityKey, source: "copilot_session" },
    async () =>
      await seedProtocolDatabase().then(() =>
        routedControlPlaneFetch({
          copilotSessionToken: matchingSessionToken,
          path: "/models/session",
        }),
      ),
  )

  expect(result.response.status).toBe(401)
  expect(result.localError).toBeUndefined()
  expect(llmAuthorizationHeaders()).toEqual([
    "Bearer tid=original-issuer;exp=expired",
  ])
  expect(llmAuthorizationHeaders()).not.toContain(
    "Bearer tid=alternate-issuer;exp=current",
  )
})

test("uses the configured token for single-token control-plane calls", async () => {
  state.isMultiToken = false
  state.copilotToken = "single-control-plane-token"
  queuedResults.push(Response.json({ session: "created" }))

  const result = await seedProtocolDatabase().then(() =>
    routedControlPlaneFetch({ path: "/models/session" }),
  )

  expect(result.account?.copilotToken).toBe("single-control-plane-token")
  expect(
    new Headers(capturedRequests[0]?.init?.headers).get("authorization"),
  ).toBe("Bearer single-control-plane-token")
})

test("rediscovers a single-token control-plane endpoint after 421", async () => {
  state.isMultiToken = false
  state.githubToken = "single-github-token"
  state.copilotToken = "single-control-plane-token"
  state.copilotApiBaseUrl = "https://api.githubcopilot.com"
  queuedResults.push(
    new Response("Misdirected Request", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.business.githubcopilot.com" },
    }),
    Response.json({ refreshed: true }),
  )

  const result = await seedProtocolDatabase().then(() =>
    routedControlPlaneFetch({ path: "/models/session" }),
  )

  expect(result.response.status).toBe(200)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.githubcopilot.com/models/session",
    "https://api.github.com/copilot_internal/user",
    "https://api.business.githubcopilot.com/models/session",
  ])
  expect(tokenPool.getAllAccounts()[0]?.copilotApiBaseUrl).toBe(
    "https://api.business.githubcopilot.com",
  )
})

async function routedFetchWithAffinity(modelId: string, key: string) {
  return await runWithRoutingAffinity(
    { key, source: "copilot_session" },
    async () =>
      await seedProtocolDatabase().then(() =>
        routedFetch("/chat/completions", { method: "POST" }, { modelId }),
      ),
  )
}

test("keeps an identified session on its hashed account after persistent 401", async () => {
  const modelId = "identified-401-affinity"
  registerAccount(12_001, modelId, "bound-token")
  registerAccount(12_002, modelId, "alternate-token")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_001)
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const error = await routedFetchWithAffinity(modelId, key).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(409)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      account_id: 12_001,
      code: "session_account_rejected",
      type: "session_affinity_error",
    },
  })
  expect(tokenPool.getEligibleAccountForModel(modelId, 12_001)).toBeDefined()
  expect(llmAuthorizationHeaders()).toEqual(["Bearer bound-token"])
  expect(llmAuthorizationHeaders()).not.toContain("Bearer alternate-token")
})

test("one request rejection cannot remap another session", async () => {
  const modelId = "cross-session-health-regression"
  registerAccount(12_011, modelId, "shared-home")
  registerAccount(12_012, modelId, "other-home")
  tokenPool.rebuildModelIndex()
  const rejectedKey = findKeyForAccount(modelId, 12_011)
  const unaffectedKey = findAnotherKeyForAccount(modelId, 12_011, rejectedKey)
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  await routedFetchWithAffinity(modelId, rejectedKey).catch(() => undefined)
  queuedResults.push(new Response("{}", { status: 200 }))
  const result = await routedFetchWithAffinity(modelId, unaffectedKey)

  expect(result.account?.id).toBe(12_011)
  expect(tokenPool.getHealthyAccountIds()).toContain(12_011)
})

test("returns a local conflict for identified 403 without failover", async () => {
  const modelId = "identified-403-affinity"
  registerAccount(12_021, modelId, "forbidden-home")
  registerAccount(12_022, modelId, "forbidden-alternate")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_021)
  queuedResults.push(new Response("Forbidden", { status: 403 }))

  const error = await routedFetchWithAffinity(modelId, key).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(409)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "session_account_rejected",
      message:
        "The bound account rejected this conversation; affinity was preserved and no cross-account retry was attempted.",
    },
  })
  expect(llmAuthorizationHeaders()).toEqual(["Bearer forbidden-home"])
  expect(tokenPool.getHealthyAccountIds()).toContain(12_021)
})

test("does not reinitialize or retry an identified account after 401", async () => {
  const modelId = "identified-direct-oauth-401-affinity"
  registerAccount(12_025, modelId, "direct-oauth-home")
  registerAccount(12_026, modelId, "direct-oauth-alternate")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_025)
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const error = await routedFetchWithAffinity(modelId, key).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "session_account_rejected",
      message:
        "The bound account rejected this conversation; affinity was preserved and no cross-account retry was attempted.",
    },
  })
  expect(llmAuthorizationHeaders()).toEqual(["Bearer direct-oauth-home"])
  expect(capturedRequests.every(({ url }) => !url.includes("/v2/token"))).toBe(
    true,
  )
})

test("keeps identified 429 retries on the hashed account", async () => {
  const modelId = "identified-429-affinity"
  registerAccount(12_031, modelId, "limited-home")
  registerAccount(12_032, modelId, "limited-alternate")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_031)
  queuedResults.push(
    new Response("limited", {
      status: 429,
      headers: { "retry-after": "0" },
    }),
    new Response("still limited", {
      status: 429,
      headers: { "retry-after": "0" },
    }),
  )

  const result = await runWithRoutingAffinity(
    { key, source: "copilot_session" },
    async () =>
      await seedProtocolDatabase().then(() =>
        routedFetch(
          "/chat/completions",
          { method: "POST" },
          { maxHttpRetryDelaySeconds: 0, modelId },
        ),
      ),
  )

  expect(result.response.status).toBe(429)
  expect(result.account?.id).toBe(12_031)
  expect(llmAuthorizationHeaders()).toEqual([
    "Bearer limited-home",
    "Bearer limited-home",
  ])
})

test("preserves account state when an identified direct OAuth request returns 401", async () => {
  const modelId = "identified-direct-oauth-rejection"
  registerAccount(12_041, modelId, "preserved-home")
  registerAccount(12_042, modelId, "unused-alternate")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 12_041)
  const account = tokenPool.getEligibleAccountForModel(modelId, 12_041)
  if (!account) throw new TypeError("Expected bound account")
  const originalModelsData = account.modelsData
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const error = await routedFetchWithAffinity(modelId, key).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(409)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      account_id: 12_041,
      code: "session_account_rejected",
      type: "session_affinity_error",
    },
  })
  expect(account.copilotToken).toBe("preserved-home")
  expect(account.modelsData).toBe(originalModelsData)
  expect(account.models).toEqual(new Set([modelId]))
  expect(account.healthy).toBe(true)
  expect(llmAuthorizationHeaders()).toEqual(["Bearer preserved-home"])
})

test("preserves legacy WebSocket affinity and typed affinity precedence", async () => {
  const modelId = "router-legacy-websocket-affinity"
  registerAccount(1241, modelId, "legacy-first")
  registerAccount(1242, modelId, "legacy-second")
  tokenPool.rebuildModelIndex()
  const legacyKey = Array.from(
    { length: 100 },
    (_, index) => `legacy-websocket-session-${index}`,
  ).find(
    (key) => tokenPool.getAccountForModelBySession(modelId, key)?.id === 1241,
  )
  if (!legacyKey) throw new TypeError("Expected legacy key for first account")
  const typedKey = "typed-session"
  const legacyPreferred = tokenPool.getAccountForModelBySession(
    modelId,
    legacyKey,
  )
  if (!legacyPreferred) throw new TypeError("Expected legacy preferred account")
  queuedResults.push(new Response("{}", { status: 200 }))

  const legacyResult = await clientSessionStorage.run(
    legacyKey,
    async () =>
      await seedProtocolDatabase().then(() =>
        routedFetch("/chat/completions", { method: "POST" }, { modelId }),
      ),
  )
  expect(legacyResult.account?.id).toBe(legacyPreferred.id)

  const typedPreferred = tokenPool.getAccountForModelBySession(
    modelId,
    typedKey,
  )
  if (!typedPreferred) throw new TypeError("Expected typed preferred account")
  queuedResults.push(new Response("{}", { status: 200 }))
  const typedResult = await clientSessionStorage.run(
    legacyKey,
    async () =>
      await runWithRoutingAffinity(
        { key: typedKey, source: "copilot_session" },
        async () =>
          await seedProtocolDatabase().then(() =>
            routedFetch("/chat/completions", { method: "POST" }, { modelId }),
          ),
      ),
  )
  expect(typedResult.account?.id).toBe(typedPreferred.id)
})

test("preserves an unidentified public OAuth account after a 401", async () => {
  const modelId = "router-public-oauth-401-test"
  registerAccount(1001, modelId, "primary-copilot-token")
  registerAccount(1002, modelId, "secondary-copilot-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("Unauthorized", {
      status: 401,
      headers: { "retry-after": "0" },
    }),
  )

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(401)
  expect(account?.id).toBe(1001)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer primary-copilot-token",
  })
  expect(capturedRequests[0]?.url).not.toContain("/copilot_internal/v2/token")
})

test("preserves an enterprise account and instance after a 401", async () => {
  const modelId = "enterprise-401-preserves-instance"
  registerEnterpriseAccount(1003, modelId, "msft.ghe.com")
  registerEnterpriseAccount(1004, modelId, "github.ghe.com")
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(401)
  expect(account?.id).toBe(1003)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://copilot-api.msft.ghe.com/chat/completions",
  ])
  expect(llmAuthorizationHeaders()).toEqual(["Bearer enterprise-token-1003"])
})

test("rediscovers a 421 endpoint and retries the same account once", async () => {
  const modelId = "router-misdirected-endpoint"
  registerAccount(1005, modelId, "oauth-primary")
  registerAccount(1006, modelId, "oauth-secondary")
  tokenPool.rebuildModelIndex()
  const account = tokenPool.getEligibleAccountForModel(modelId, 1005)
  if (!account) throw new TypeError("Expected selected account")
  account.githubToken = "github-primary"
  account.copilotToken = "github-primary"
  account.copilotApiBaseUrl = "https://api.githubcopilot.com"
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("Misdirected Request", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.enterprise.githubcopilot.com" },
      login: "primary-user",
    }),
    modelsResponse([modelId]),
    new Response("{}", { status: 200 }),
  )

  const { response, account: usedAccount } = await seedProtocolDatabase().then(
    () => routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(200)
  expect(usedAccount?.id).toBe(1005)
  expect(
    tokenPool.getAllAccounts().find((current) => current.id === account.id)
      ?.copilotApiBaseUrl,
  ).toBe("https://api.enterprise.githubcopilot.com")
  expect(
    tokenPool.getAllAccounts().find((current) => current.id === account.id)
      ?.githubUsername,
  ).toBe("primary-user")
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.githubcopilot.com/chat/completions",
    "https://api.github.com/copilot_internal/user",
    "https://api.enterprise.githubcopilot.com/models",
    "https://api.enterprise.githubcopilot.com/chat/completions",
  ])
  expect(llmAuthorizationHeaders()).toEqual([
    "Bearer github-primary",
    "Bearer github-primary",
  ])
})

test("bounds repeated 421 responses to one same-account recovery", async () => {
  const modelId = "router-repeated-misdirected-endpoint"
  registerAccount(10_051, modelId, "oauth-primary")
  registerAccount(10_052, modelId, "oauth-secondary")
  tokenPool.rebuildModelIndex()
  const account = tokenPool.getEligibleAccountForModel(modelId, 10_051)
  if (!account) throw new TypeError("Expected selected account")
  account.githubToken = "oauth-primary"
  account.copilotToken = "oauth-primary"
  account.copilotApiBaseUrl = "https://api.githubcopilot.com"

  queuedResults.push(
    new Response("first misdirect", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.business.githubcopilot.com" },
    }),
    modelsResponse([modelId]),
    new Response("second misdirect", { status: 421 }),
  )

  const { response, account: usedAccount } = await seedProtocolDatabase().then(
    () => routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(421)
  expect(await response.text()).toBe("second misdirect")
  expect(usedAccount?.id).toBe(10_051)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.githubcopilot.com/chat/completions",
    "https://api.github.com/copilot_internal/user",
    "https://api.business.githubcopilot.com/models",
    "https://api.business.githubcopilot.com/chat/completions",
  ])
  expect(llmAuthorizationHeaders()).toEqual([
    "Bearer oauth-primary",
    "Bearer oauth-primary",
  ])
})

test("returns the original 421 when endpoint rediscovery fails", async () => {
  const modelId = "router-misdirected-discovery-failure"
  registerAccount(1007, modelId, "oauth-primary")
  registerAccount(1008, modelId, "oauth-secondary")
  tokenPool.rebuildModelIndex()
  const account = tokenPool.getEligibleAccountForModel(modelId, 1007)
  if (!account) throw new TypeError("Expected selected account")
  const originalModelsData = account.modelsData
  const originalModels = account.models
  account.copilotApiBaseUrl = "https://api.githubcopilot.com"
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("Misdirected Request", { status: 421 }),
    new Response("discovery unavailable", { status: 503 }),
  )

  const { response, account: usedAccount } = await seedProtocolDatabase().then(
    () => routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(421)
  expect(await response.text()).toBe("Misdirected Request")
  expect(usedAccount?.id).toBe(1007)
  expect(
    tokenPool.getAllAccounts().find((current) => current.id === account.id)
      ?.copilotApiBaseUrl,
  ).toBe("https://api.githubcopilot.com")
  expect(account.models).toBe(originalModels)
  expect(account.modelsData).toBe(originalModelsData)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.githubcopilot.com/chat/completions",
    "https://api.github.com/copilot_internal/user",
  ])
  expect(llmAuthorizationHeaders()).toEqual(["Bearer oauth-primary"])
})

test("does not resend a 421 after rediscovery removes endpoint authority", async () => {
  const modelId = "router-misdirected-endpoint-removed"
  registerAccount(1009, modelId, "oauth-primary")
  registerAccount(1010, modelId, "oauth-secondary")
  tokenPool.rebuildModelIndex()
  const account = tokenPool.getEligibleAccountForModel(modelId, 1009)
  if (!account) throw new TypeError("Expected selected account")
  account.copilotApiBaseUrl = "https://api.githubcopilot.com"
  tokenPool.rebuildModelIndex()

  const refreshedModel = createModel(modelId)
  refreshedModel.supported_endpoints = ["/responses"]
  queuedResults.push(
    new Response("Misdirected Request", { status: 421 }),
    Response.json({
      endpoints: { api: "https://api.enterprise.githubcopilot.com" },
    }),
    Response.json({ data: [refreshedModel], object: "list" }),
  )

  const error = await seedProtocolDatabase()
    .then(() =>
      routedFetch("/chat/completions", { method: "POST" }, { modelId }),
    )
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(400)
  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.githubcopilot.com/chat/completions",
    "https://api.github.com/copilot_internal/user",
    "https://api.enterprise.githubcopilot.com/models",
  ])
  expect(llmAuthorizationHeaders()).toEqual(["Bearer oauth-primary"])
})

test("records final response metadata once after a returned 403", async () => {
  const modelId = "router-metadata-failover"
  registerAccount(10_031, modelId, "metadata-primary")
  registerAccount(10_032, modelId, "metadata-secondary")
  tokenPool.rebuildModelIndex()
  queuedResults.push(
    new Response("Forbidden", {
      status: 403,
      headers: { "x-github-request-id": "failed-attempt" },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    const { result, headers } = await routedFetchWithMetadataStore(modelId)

    expect(result.response.status).toBe(403)
    expect(headers).toEqual({
      "x-github-request-id": "failed-attempt",
    })
    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 1,
        quotaSnapshotCount: 0,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("records final response metadata once after a transport retry", async () => {
  const modelId = "router-metadata-transport"
  registerAccount(10_041, modelId, "metadata-transport")
  tokenPool.rebuildModelIndex()
  queuedResults.push(
    retryableSocketError(),
    new Response("{}", {
      status: 200,
      headers: { "x-github-request-id": "transport-final" },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    await routedFetchWithMetadataStore(modelId)

    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 1,
        quotaSnapshotCount: 0,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("records final response metadata once after a direct OAuth 401", async () => {
  const modelId = "router-metadata-direct-oauth-401"
  registerAccount(10_051, modelId, "metadata-expired")
  tokenPool.rebuildModelIndex()
  queuedResults.push(
    new Response("Unauthorized", {
      status: 401,
      headers: { "x-github-request-id": "expired-attempt" },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    const { result } = await routedFetchWithMetadataStore(modelId)

    expect(result.response.status).toBe(401)
    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 1,
        quotaSnapshotCount: 0,
      },
    ])
    expect(capturedRequests).toHaveLength(1)
    expect(capturedRequests[0]?.url).not.toContain("/v2/token")
  } finally {
    debugSpy.mockRestore()
  }
})

test("records final response metadata once for a returned terminal error", async () => {
  const modelId = "router-metadata-terminal"
  registerAccount(10_061, modelId, "metadata-terminal")
  tokenPool.rebuildModelIndex()
  queuedResults.push(
    new Response("unprocessable", {
      status: 422,
      headers: { "x-github-request-id": "terminal-final" },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    const { result } = await routedFetchWithMetadataStore(modelId)

    expect(result.response.status).toBe(422)
    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 1,
        quotaSnapshotCount: 0,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("records final response metadata once when affinity rejection throws", async () => {
  const modelId = "router-metadata-affinity-rejection"
  registerAccount(10_071, modelId, "metadata-affinity")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 10_071)
  queuedResults.push(
    new Response("Unauthorized", {
      status: 401,
      headers: { "x-github-request-id": "affinity-first" },
    }),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    const error = await copilotResponseHeadersStorage
      .run(
        {},
        async () =>
          await runWithCopilotContractObservabilityScope(
            async () =>
              await runWithRoutingAffinity(
                { key, source: "copilot_session" },
                async () =>
                  await seedProtocolDatabase().then(() =>
                    routedFetch(
                      "/chat/completions",
                      { method: "POST" },
                      { modelId },
                    ),
                  ),
              ),
          ),
      )
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LocalHTTPError)
    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 1,
        quotaSnapshotCount: 0,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("returns the second encrypted Responses compaction failure after one selected-account retry", async () => {
  const modelId = "router-encrypted-compaction-retry"
  registerAccount(1021, modelId, "selected-copilot-token")
  registerAccount(1022, modelId, "alternate-copilot-token")
  for (const accountId of [1021, 1022]) {
    const account = tokenPool
      .getAllAccounts()
      .find((entry) => entry.id === accountId)
    if (!account) throw new TypeError("Expected compaction retry account")
    const model = account.modelsData.find((entry) => entry.id === modelId)
    if (!model) throw new TypeError("Expected compaction retry model")
    model.supported_endpoints = ["/responses"]
  }
  tokenPool.rebuildModelIndex()
  const requestBody = JSON.stringify({
    input: [
      {
        encrypted_content: "opaque-compaction",
        type: "compaction",
      },
    ],
    model: modelId,
  })
  const encryptedFailure = () =>
    Response.json(
      {
        error: {
          code: "invalid_request_body",
          message: "The encrypted content could not be verified.",
        },
      },
      {
        status: 400,
        headers: {
          "x-github-request-id": "stale-compaction-attempt",
          "x-quota-snapshot-premium": "stale-quota",
        },
      },
    )
  queuedResults.push(
    encryptedFailure(),
    Response.json(
      {
        error: {
          code: "invalid_request_body",
          message: "The final encrypted content could not be verified. ",
        },
      },
      {
        status: 400,
        headers: {
          "content-type": "application/problem+json",
          "x-github-request-id": "final-compaction-attempt",
          "x-quota-snapshot-premium": "final-quota",
        },
      },
    ),
  )
  const debugSpy = spyOn(consola, "debug")

  try {
    const { result, headers } = await copilotResponseHeadersStorage.run(
      {},
      async () =>
        await runWithCopilotContractObservabilityScope(async () => {
          const result = await seedProtocolDatabase().then(() =>
            routedFetch(
              "/responses",
              { body: requestBody, method: "POST" },
              { modelId },
            ),
          )
          return { result, headers: { ...getCopilotResponseHeaders() } }
        }),
    )
    const { response, account } = result

    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    )
    expect(await response.text()).toBe(
      '{"error":{"code":"invalid_request_body","message":"The final encrypted content could not be verified. "}}',
    )
    expect(account).toBeDefined()
    expect(capturedRequests).toHaveLength(2)
    expect(capturedRequests.map(({ init }) => init?.body)).toEqual([
      requestBody,
      requestBody,
    ])
    expect(llmAuthorizationHeaders()).toEqual([
      `Bearer ${account?.copilotToken}`,
      `Bearer ${account?.copilotToken}`,
    ])
    expect(llmAuthorizationHeaders()).not.toContain(
      "Bearer alternate-copilot-token",
    )
    expect(headers).toEqual({
      "x-github-request-id": "final-compaction-attempt",
      "x-quota-snapshot-premium": "final-quota",
    })
    expect(responseMetadataEvents(debugSpy.mock.calls)).toEqual([
      {
        kind: "response_metadata",
        headerCount: 2,
        quotaSnapshotCount: 1,
      },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("returns a public OAuth 401 without token exchange or retry", async () => {
  const modelId = "router-public-oauth-401-test"
  registerAccount(1011, modelId, "expired-copilot-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("IDE token expired: unauthorized: token expired\n", {
      status: 401,
    }),
  )

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(401)
  expect(account?.id).toBe(1011)
  expect(account?.copilotToken).toBe("expired-copilot-token")
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer expired-copilot-token",
  })
  expect(capturedRequests[0]?.url).not.toContain("/copilot_internal/v2/token")
})

test("discovers public OAuth models without legacy token exchange", async () => {
  const account = tokenPool.addAccount("github-model-token", "individual", 1110)
  queuedResults.push(
    Response.json({
      endpoints: { api: "https://api.githubcopilot.com" },
      login: "model-user",
    }),
    new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )

  await tokenPool.initializeAccount(account)

  expect(capturedRequests[0]?.url).toBe(
    "https://api.github.com/copilot_internal/user",
  )
  expect(
    new Headers(capturedRequests[0]?.init?.headers).get("authorization"),
  ).toBe("Bearer github-model-token")
  expect(capturedRequests[1]?.url).toContain("/models")
  expect(capturedRequests[1]?.init?.keepalive).toBe(false)
  expect(account.copilotToken).toBe("github-model-token")
  expect(account.githubUsername).toBe("model-user")
  expect(capturedRequests.every(({ url }) => !url.includes("/v2/token"))).toBe(
    true,
  )
})

test("updates the GitHub username during direct OAuth revalidation", async () => {
  const account = tokenPool.addAccount(
    "github-username-token",
    "individual",
    1111,
  )
  queuedResults.push(
    Response.json({
      endpoints: { api: "https://api.githubcopilot.com" },
      login: "octocat",
    }),
    new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )

  await tokenPool.initializeAccount(account)

  queuedResults.push(
    Response.json({
      endpoints: { api: "https://api.githubcopilot.com" },
      login: "octocat-refreshed",
    }),
    modelsResponse([]),
  )
  await tokenPool.reinitializeAccount(account)

  expect(account.githubUsername).toBe("octocat-refreshed")
  expect(
    capturedRequests.filter(
      (request) =>
        request.url === "https://api.github.com/copilot_internal/user",
    ),
  ).toHaveLength(2)
  expect(capturedRequests.every(({ url }) => !url.includes("/v2/token"))).toBe(
    true,
  )
})

test("does not fail over aborted multi-token requests", async () => {
  const modelId = "router-abort-test"
  registerAccount(1003, modelId, "abort-primary-token")
  registerAccount(1004, modelId, "abort-secondary-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Error("The operation was aborted"),
    new Response("{}", { status: 200 }),
  )

  let thrownError: unknown
  try {
    await seedProtocolDatabase().then(() =>
      routedFetch("/chat/completions", { method: "POST" }, { modelId }),
    )
  } catch (error) {
    thrownError = error
  }
  expect(thrownError).toBeInstanceOf(Error)
  if (!(thrownError instanceof Error)) {
    throw new TypeError("Expected routedFetch to throw an Error")
  }
  expect(thrownError.message).toContain("aborted")

  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer abort-primary-token",
  })
})

test("applies headerOptions when multi-token falls back with no matching account", async () => {
  state.copilotToken = "fallback-copilot-token"
  const modelId = "router-no-account-header-fallback"
  registerAccount(1012, "different-known-model", "healthy-fallback-token")
  tokenPool.rebuildModelIndex()
  const expectedAccount = tokenPool.getFirstHealthyAccount()
  if (!expectedAccount) {
    throw new Error("Expected a healthy fallback account")
  }
  expectedAccount.copilotToken = "healthy-fallback-token"

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch(
      "/chat/completions",
      { method: "POST" },
      {
        modelId,
        headerOptions: {
          initiator: "agent",
          vision: true,
        },
      },
    ),
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(expectedAccount.id)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer healthy-fallback-token",
    "X-Initiator": "agent",
    "Copilot-Vision-Request": "true",
  })
})

test("omits fallback model diagnostics only inside a suppressed request scope", async () => {
  const modelId = "router-private-fallback-model"
  registerAccount(10_212, "different-known-model", "healthy-fallback-token")
  tokenPool.rebuildModelIndex()
  queuedResults.push(new Response("{}", { status: 200 }))
  const warnSpy = spyOn(consola, "warn")

  try {
    await runWithRequestDiagnostics(async () => {
      suppressRequestModelDiagnostics()
      await seedProtocolDatabase().then(() =>
        routedFetch("/responses", { method: "POST" }, { modelId }),
      )
    })
    const suppressedOutput = JSON.stringify(warnSpy.mock.calls)
    expect(suppressedOutput).toContain("Using Account #10212 as fallback")
    expect(suppressedOutput).not.toContain("for model")
    expect(suppressedOutput).not.toContain(modelId)

    warnSpy.mockClear()
    queuedResults.push(new Response("{}", { status: 200 }))
    await seedProtocolDatabase().then(() =>
      routedFetch("/responses", { method: "POST" }, { modelId }),
    )
    expect(JSON.stringify(warnSpy.mock.calls)).toContain(modelId)
  } finally {
    warnSpy.mockRestore()
  }
})

test("preserves the fallback account after a public OAuth 401", async () => {
  const modelId = "gpt-4.1-mini"
  registerAccount(1013, "different-known-model", "expired-fallback-token")
  tokenPool.rebuildModelIndex()
  const expectedAccount = tokenPool.getFirstHealthyAccount()
  if (!expectedAccount) {
    throw new Error("Expected a healthy fallback account")
  }
  expectedAccount.copilotToken = "expired-fallback-token"

  queuedResults.push(
    new Response("IDE token expired: unauthorized: token expired\n", {
      status: 401,
    }),
  )

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(401)
  expect(account?.id).toBe(expectedAccount.id)
  expect(account?.copilotToken).toBe("expired-fallback-token")
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer expired-fallback-token",
  })
  expect(capturedRequests[0]?.url).not.toContain("/copilot_internal/v2/token")
})

test("does not expose last used account globally outside request context", async () => {
  const modelId = "router-no-global-last-account"
  registerAccount(1005, modelId, "single-router-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1005)
  expect(getLastUsedAccountId()).toBeUndefined()
})

test("routes a model only to accounts where the model is enabled", async () => {
  const modelId = "router-model-disabled-primary"
  registerAccount(1006, modelId, "disabled-account-token")
  registerAccount(1007, modelId, "enabled-account-token")
  setModelRoutingOverridesForTest({ [modelId]: { "1006": false } })
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1007)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer enabled-account-token",
  })
})

test("routes a model that only one account advertises to that account", async () => {
  const exclusiveModelId = "claude-fable-5"
  registerAccount(1014, "claude-opus-4.8", "opus-account-token")
  registerAccount(1015, exclusiveModelId, "fable-account-token")
  registerAccount(1016, "claude-sonnet-4.6", "sonnet-account-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch(
      "/chat/completions",
      { method: "POST" },
      { modelId: exclusiveModelId },
    ),
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1015)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer fable-account-token",
  })
})

test("does not fail over to an account where the model is disabled", async () => {
  const modelId = "router-model-disabled-failover"
  registerAccount(1008, modelId, "enabled-failover-primary")
  registerAccount(1009, modelId, "disabled-failover-secondary")
  setModelRoutingOverridesForTest({ [modelId]: { "1009": false } })
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(401)
  expect(account?.id).toBe(1008)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer enabled-failover-primary",
  })
})

test("returns a routing error when every known account for a model is disabled", async () => {
  const modelId = "router-model-all-disabled"
  registerAccount(1010, modelId, "disabled-only-token")
  setModelRoutingOverridesForTest({ [modelId]: { "1010": false } })
  tokenPool.rebuildModelIndex()

  const { response, account } = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(response.status).toBe(403)
  expect(account).toBeUndefined()
  expect(capturedRequests).toHaveLength(0)

  const body = (await response.json()) as { error: { type: string } }
  expect(body.error.type).toBe("model_routing_error")
})

test("does not switch accounts on a transport connection error", async () => {
  const modelId = "router-network-error"
  registerAccount(1101, modelId, "network-primary-token")
  registerAccount(1102, modelId, "network-secondary-token")
  tokenPool.rebuildModelIndex()

  // Both sends come from copilotFetch's own bounded retry, on one account.
  const socketError = () =>
    Object.assign(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
      { code: "ECONNRESET", errno: 0 },
    )
  queuedResults.push(socketError(), socketError())

  let thrownError: unknown
  try {
    await seedProtocolDatabase().then(() =>
      routedFetch("/chat/completions", { method: "POST" }, { modelId }),
    )
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.message).toContain(
    "socket connection",
  )
  expect(capturedRequests).toHaveLength(2)
  for (const request of capturedRequests) {
    expect(request.init?.headers).toMatchObject({
      Authorization: "Bearer network-primary-token",
    })
  }
})

test("stops after the first public OAuth 401 without consuming retry budget", async () => {
  const modelId = "router-public-oauth-401-budget"
  registerAccount(1105, modelId, "expired-primary-token")
  registerAccount(1106, modelId, "budget-failover-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("unauthorized: token expired\n", { status: 401 }),
  )

  const result = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )
  expect(result.response.status).toBe(401)
  expect(result.account?.id).toBe(1105)

  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer expired-primary-token",
  })
  expect(capturedRequests[0]?.url).not.toContain("/v2/token")
})

test("caps total sends across a 429 failover and a transport retry", async () => {
  const modelId = "router-429-then-network"
  registerAccount(1103, modelId, "budget-primary-token")
  registerAccount(1104, modelId, "budget-secondary-token")
  tokenPool.rebuildModelIndex()

  // Account A 429s and the failover each draw one of the routed call's two
  // extra sends, so the ECONNRESET on account B cannot buy a fourth send.
  const retryAfterZero = { "retry-after": "0" }
  queuedResults.push(
    new Response("Too Many Requests", { status: 429, headers: retryAfterZero }),
    new Response("Too Many Requests", { status: 429, headers: retryAfterZero }),
    Object.assign(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
      { code: "ECONNRESET", errno: 0 },
    ),
  )

  let thrownError: unknown
  try {
    await seedProtocolDatabase().then(() =>
      routedFetch("/chat/completions", { method: "POST" }, { modelId }),
    )
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.message).toContain(
    "socket connection",
  )
  expect(capturedRequests).toHaveLength(3)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer budget-primary-token",
  })
  expect(capturedRequests[1]?.init?.headers).toMatchObject({
    Authorization: "Bearer budget-primary-token",
  })
  expect(capturedRequests[2]?.init?.headers).toMatchObject({
    Authorization: "Bearer budget-secondary-token",
  })
})
