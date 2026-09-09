import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"
import { createHash } from "node:crypto"

import type { Model, ModelsResponse } from "../src/services/copilot/get-models"

import {
  isModelEnabledForAccount,
  resetModelRoutingOverridesForTest,
  setModelRoutingOverridesForTest,
} from "../src/lib/model-routing"
import { state } from "../src/lib/state"
import * as tokenPoolModule from "../src/lib/token-pool"
import { DEFAULT_COPILOT_INTEGRATION_ID } from "../src/services/copilot/copilot-contract"
import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const MODEL_A = "model-a"
const MODEL_B = "model-b"
const originalFetch = globalThis.fetch
const capturedRequests: Array<{ init?: RequestInit; url: string }> = []
const queuedResults: Array<DeferredFetchResponse | Response> = []
const pools = new Set<tokenPoolModule.TokenPool>()

interface DeferredFetchResponse {
  requestStarted: Promise<void>
  resolveResponse(response: Response): void
  startRequest(): Promise<Response>
}

function createDeferredFetchResponse(): DeferredFetchResponse {
  let resolveRequestStarted!: () => void
  let resolveResponse!: (response: Response) => void
  const requestStarted = new Promise<void>((resolve) => {
    resolveRequestStarted = resolve
  })
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve
  })
  return {
    requestStarted,
    resolveResponse,
    startRequest() {
      resolveRequestStarted()
      return responsePromise
    },
  }
}

function requestUrl(value: string | URL | Request): string {
  if (typeof value === "string") return value
  return value instanceof URL ? value.toString() : value.url
}

const fetchMock = mock(
  (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const normalizedUrl = requestUrl(url)
    capturedRequests.push({ init, url: normalizedUrl })
    const next = queuedResults.shift()
    if (!next) throw new Error(`Unexpected fetch: ${normalizedUrl}`)
    return Promise.resolve(
      next instanceof Response ? next : next.startRequest(),
    )
  },
)

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

function copilotUserResponse(
  login = "github-user",
  api = "https://api.githubcopilot.com",
): Response {
  return Response.json({
    endpoints: { api },
    login,
  })
}

function modelsResponse(models: Array<Model>): Response {
  return Response.json({ data: models, object: "list" })
}

function createInitializedAccount(pool: tokenPoolModule.TokenPool) {
  const account = pool.addAccount(
    "github-token-reinitialize",
    "individual",
    801,
  )
  account.copilotToken = "old-copilot-token"
  account.copilotTokenExpiry = 1_800_000_000
  account.healthy = true
  account.models = new Set([MODEL_A])
  account.modelsData = [createModel(MODEL_A)]
  pool.rebuildModelIndex()
  return account
}

function snapshotAccount(account: tokenPoolModule.Account) {
  return {
    copilotToken: account.copilotToken,
    copilotTokenExpiry: account.copilotTokenExpiry,
    healthy: account.healthy,
    models: [...account.models],
    modelsData: account.modelsData,
  }
}

function copilotUserRequests() {
  return capturedRequests.filter(({ url }) =>
    url.includes("/copilot_internal/user"),
  )
}

function modelRequests() {
  return capturedRequests.filter(({ url }) => url.endsWith("/models"))
}

function createPool(
  accountIds: Array<number>,
  models: Array<string> = [MODEL_A],
): tokenPoolModule.TokenPool {
  const pool = new tokenPoolModule.TokenPool()
  pools.add(pool)
  for (const accountId of accountIds) {
    const account = pool.addAccount(
      `github-token-${accountId}`,
      "individual",
      accountId,
    )
    account.healthy = true
    account.models = new Set(models)
  }
  pool.rebuildModelIndex()
  return pool
}

function assignment(
  pool: tokenPoolModule.TokenPool,
  key: string,
  model = MODEL_A,
): number | undefined {
  return pool.getAccountForModelBySession(model, key)?.id
}

function expectedRendezvousAccount(
  key: string,
  accountIds: Array<number>,
): number {
  return accountIds.reduce((winner, candidate) => {
    const winnerScore = createHash("sha256")
      .update(`${key}\0${winner}`)
      .digest("hex")
    const candidateScore = createHash("sha256")
      .update(`${key}\0${candidate}`)
      .digest("hex")
    return candidateScore > winnerScore ? candidate : winner
  })
}

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  capturedRequests.length = 0
  queuedResults.length = 0
  fetchMock.mockClear()
  setModelRoutingOverridesForTest({})
  state.copilotIntegrationId = DEFAULT_COPILOT_INTEGRATION_ID
})

afterEach(() => {
  for (const pool of pools) pool.dispose()
  pools.clear()
  resetModelRoutingOverridesForTest()
})

test("resets model-routing test overrides after isolated use", () => {
  setModelRoutingOverridesForTest({ [MODEL_A]: { "1": false } })
  expect(isModelEnabledForAccount(MODEL_A, 1)).toBe(false)

  resetModelRoutingOverridesForTest()

  expect(isModelEnabledForAccount(MODEL_A, 1)).toBe(true)
})

test("uses the enterprise OAuth token directly for tenant model discovery", async () => {
  const pool = new tokenPoolModule.TokenPool()
  pools.add(pool)
  const account = pool.addAccount("enterprise-github-token", {
    accountType: "enterprise",
    githubInstanceDomain: "msft.ghe.com",
    id: 810,
  })
  queuedResults.push(
    Response.json({
      login: "enterprise-user",
      endpoints: { api: "https://copilot-api.msft.ghe.com" },
    }),
    modelsResponse([createModel(MODEL_A)]),
  )

  await pool.initializeAccount(account)

  expect(capturedRequests[0]?.url).toBe(
    "https://api.msft.ghe.com/copilot_internal/user",
  )
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    authorization: "Bearer enterprise-github-token",
  })
  expect(capturedRequests[1]?.url).toBe(
    "https://copilot-api.msft.ghe.com/models",
  )
  expect(capturedRequests[1]?.init?.headers).toMatchObject({
    Authorization: "Bearer enterprise-github-token",
    "Copilot-Harness-Id": "copilot-sdk",
  })
  expect(capturedRequests).toHaveLength(2)
  expect(account.copilotToken).toBe("enterprise-github-token")
  expect(account.copilotTokenExpiry).toBeUndefined()
  expect(account.githubUsername).toBe("enterprise-user")
  expect(pool.getBaseUrl(account)).toBe("https://copilot-api.msft.ghe.com")
})

test("uses a GitHub.com OAuth token directly for model discovery", async () => {
  const pool = new tokenPoolModule.TokenPool()
  pools.add(pool)
  const account = pool.addAccount("github-oauth-token", "individual", 811)
  queuedResults.push(
    copilotUserResponse(
      "public-user",
      "https://api.individual.githubcopilot.com",
    ),
    modelsResponse([createModel(MODEL_A)]),
  )

  await pool.initializeAccount(account)

  expect(capturedRequests.map(({ url }) => url)).toEqual([
    "https://api.github.com/copilot_internal/user",
    "https://api.individual.githubcopilot.com/models",
  ])
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    authorization: "Bearer github-oauth-token",
  })
  expect(capturedRequests[1]?.init?.headers).toMatchObject({
    Authorization: "Bearer github-oauth-token",
    "Copilot-Harness-Id": "copilot-sdk",
  })
  expect(account.copilotToken).toBe("github-oauth-token")
  expect(account.copilotTokenExpiry).toBeUndefined()
  expect(account.githubUsername).toBe("public-user")
  expect(pool.getBaseUrl(account)).toBe(
    "https://api.individual.githubcopilot.com",
  )
  expect(
    capturedRequests.some(({ url }) =>
      url.includes("/copilot_internal/v2/token"),
    ),
  ).toBe(false)
})

test("uses the account integration override and current contract for multi-token model discovery", async () => {
  const pool = new tokenPoolModule.TokenPool()
  pools.add(pool)
  const account = createInitializedAccount(pool)
  state.copilotIntegrationId = "unrelated-global-integration"
  account.integrationId = "assigned-integration"
  queuedResults.push(
    copilotUserResponse(),
    modelsResponse([createModel(MODEL_A)]),
  )

  await pool.reinitializeAccount(account)

  expect(modelRequests()[0]?.init?.headers).toMatchObject({
    "Copilot-Integration-Id": "assigned-integration",
    "X-GitHub-Api-Version": "2026-08-01",
  })
})

test("reinitializes token and models as one account update", async () => {
  const pool = new tokenPoolModule.TokenPool()
  pools.add(pool)
  const account = createInitializedAccount(pool)
  queuedResults.push(
    copilotUserResponse("refreshed-user"),
    modelsResponse([createModel(MODEL_B)]),
  )

  await pool.reinitializeAccount(account)

  expect(account.copilotToken).toBe("github-token-reinitialize")
  expect(account.copilotTokenExpiry).toBeUndefined()
  expect(account.githubUsername).toBe("refreshed-user")
  expect(account.models).toEqual(new Set([MODEL_B]))
  expect(account.modelsData.map((model) => model.id)).toEqual([MODEL_B])
  expect(account.healthy).toBe(true)
})

test("preserves account state when reinitialization fails", async () => {
  const pool = new tokenPoolModule.TokenPool()
  pools.add(pool)
  const account = createInitializedAccount(pool)
  const before = snapshotAccount(account)
  queuedResults.push(
    copilotUserResponse(),
    new Response("model outage", { status: 503 }),
  )

  const error = await pool
    .reinitializeAccount(account)
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(Error)
  expect(snapshotAccount(account)).toEqual(before)
})

test("rejects malformed model discovery before mutating account state", async () => {
  const pool = new tokenPoolModule.TokenPool()
  pools.add(pool)
  const account = createInitializedAccount(pool)
  const before = snapshotAccount(account)
  queuedResults.push(
    copilotUserResponse(),
    Response.json({ data: null, object: "list" }),
  )

  const error = await pool
    .reinitializeAccount(account)
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(Error)
  expect(snapshotAccount(account)).toEqual(before)
})

test("preserves account state when Copilot user discovery fails", async () => {
  for (const [index, status] of [401, 403, 503].entries()) {
    const modelRequestCountBefore = modelRequests().length
    const pool = new tokenPoolModule.TokenPool()
    pools.add(pool)
    const account = createInitializedAccount(pool)
    const before = snapshotAccount(account)
    queuedResults.push(new Response("discovery failed", { status }))

    const error = await pool
      .reinitializeAccount(account)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(snapshotAccount(account)).toEqual(before)
    expect(modelRequests()).toHaveLength(modelRequestCountBefore)
    expect(copilotUserRequests()).toHaveLength(index + 1)
  }
})

test("publishes the merged model snapshot only after reinitialization commits", async () => {
  const published: Array<ModelsResponse> = []
  const pool = new tokenPoolModule.TokenPool((models) => published.push(models))
  pools.add(pool)
  const firstAccount = createInitializedAccount(pool)
  const secondAccount = pool.addAccount(
    "github-token-static-model",
    "individual",
    802,
  )
  secondAccount.copilotToken = "static-copilot-token"
  secondAccount.copilotTokenExpiry = 1_800_000_000
  secondAccount.healthy = true
  secondAccount.models = new Set(["model-c"])
  secondAccount.modelsData = [createModel("model-c")]
  pool.rebuildModelIndex()
  queuedResults.push(
    copilotUserResponse(),
    modelsResponse([createModel(MODEL_B)]),
  )

  await pool.reinitializeAccount(firstAccount)

  expect(published).toHaveLength(1)
  expect(published[0]?.data.map((model) => model.id)).toEqual([
    MODEL_B,
    "model-c",
  ])
})

test("coalesces concurrent account reinitialization", async () => {
  const pool = new tokenPoolModule.TokenPool()
  pools.add(pool)
  const account = createInitializedAccount(pool)
  const deferredModels = createDeferredFetchResponse()
  queuedResults.push(copilotUserResponse(), deferredModels)

  const first = pool.reinitializeAccount(account)
  const second = pool.reinitializeAccount(account)
  await deferredModels.requestStarted
  deferredModels.resolveResponse(modelsResponse([createModel(MODEL_B)]))
  await Promise.all([first, second])

  expect(copilotUserRequests()).toHaveLength(1)
  expect(modelRequests()).toHaveLength(1)
  expect(account.copilotToken).toBe("github-token-reinitialize")
  expect(account.models).toEqual(new Set([MODEL_B]))
})

test("masks tokens before logging them", () => {
  expect(tokenPoolModule.maskTokenForLog("1234567890abcdef")).toBe(
    "1234...cdef",
  )
})

test("coalesced discovery refreshes every detached lease snapshot", async () => {
  const pool = new tokenPoolModule.TokenPool()
  pools.add(pool)
  const account = createInitializedAccount(pool)
  account.credentialRevision = 4
  const firstLease = pool.acquireLease(account)
  const secondLease = pool.acquireLease(account)
  if (!firstLease || !secondLease) throw new Error("Expected two leases")
  const deferredModels = createDeferredFetchResponse()
  queuedResults.push(
    Response.json({
      login: "refreshed",
      analytics_tracking_id: "refreshed-subject",
      endpoints: { api: "https://api.business.githubcopilot.com" },
    }),
    deferredModels,
  )
  const first = pool.reinitializeAccount(firstLease.account)
  const second = pool.reinitializeAccount(secondLease.account)
  await deferredModels.requestStarted
  deferredModels.resolveResponse(modelsResponse([createModel(MODEL_B)]))
  await Promise.all([first, second])
  for (const snapshot of [firstLease.account, secondLease.account]) {
    expect(snapshot.copilotApiBaseUrl).toBe(
      "https://api.business.githubcopilot.com",
    )
    expect(snapshot.copilotAccountSubject).toBe("refreshed-subject")
    expect(snapshot.models).toEqual(new Set([MODEL_B]))
  }
  expect(copilotUserRequests()).toHaveLength(1)
  expect(modelRequests()).toHaveLength(1)
  expect(firstLease.account.modelsData).not.toBe(secondLease.account.modelsData)
  firstLease.release()
  secondLease.release()
})

test("selects the exact highest SHA-256 rendezvous score", () => {
  const ids = [7, 42, 1001]
  const pool = createPool(ids)

  for (const key of ["alpha", "beta", "gamma", "delta"]) {
    expect(assignment(pool, key)).toBe(expectedRendezvousAccount(key, ids))
  }
})

test("keeps an identified session stable across repeated selections", () => {
  const pool = createPool([1, 2, 3])
  const selections = Array.from({ length: 20 }, () =>
    assignment(pool, "stable-session"),
  )

  expect(new Set(selections).size).toBe(1)
})

test("balances deterministic identified sessions across three accounts", () => {
  const pool = createPool([1, 2, 3])
  const counts = new Map<number, number>()
  for (let index = 0; index < 900; index++) {
    const accountId = assignment(pool, `session-${index}`)
    if (accountId !== undefined) {
      counts.set(accountId, (counts.get(accountId) ?? 0) + 1)
    }
  }

  expect([...counts.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3])
  for (const count of counts.values()) {
    expect(count).toBeGreaterThan(240)
    expect(count).toBeLessThan(360)
  }
})

test("uses one account preference order across models", () => {
  const pool = createPool([11, 22, 33], [MODEL_A, MODEL_B])

  expect(assignment(pool, "cross-model-session", MODEL_A)).toBe(
    assignment(pool, "cross-model-session", MODEL_B),
  )
})

test("removing an account only remaps sessions assigned to it", () => {
  const pool = createPool([1, 2, 3])
  const keys = Array.from({ length: 300 }, (_, index) => `remove-${index}`)
  const before = new Map(keys.map((key) => [key, assignment(pool, key)]))
  const removed = pool.getAllAccounts().find((account) => account.id === 2)
  if (!removed) throw new TypeError("Expected account 2")

  pool.markUnhealthy(removed)

  for (const key of keys) {
    if (before.get(key) !== 2) {
      expect(assignment(pool, key)).toBe(before.get(key))
    }
  }
})

test("adding an account preserves most prior assignments", () => {
  const pool = createPool([1, 2])
  const keys = Array.from({ length: 600 }, (_, index) => `add-${index}`)
  const before = new Map(keys.map((key) => [key, assignment(pool, key)]))
  const added = pool.addAccount("github-token-3", "individual", 3)
  added.healthy = true
  added.models = new Set([MODEL_A])
  pool.rebuildModelIndex()

  const preserved = keys.filter(
    (key) => assignment(pool, key) === before.get(key),
  ).length
  expect(preserved / keys.length).toBeGreaterThan(0.58)
})

test("selection is independent of account insertion and index rebuild order", () => {
  const forward = createPool([1, 2, 3])
  const reverse = createPool([3, 2, 1])
  const keys = Array.from({ length: 100 }, (_, index) => `order-${index}`)

  forward.rebuildModelIndex()
  reverse.rebuildModelIndex()

  for (const key of keys) {
    expect(assignment(forward, key)).toBe(assignment(reverse, key))
  }
})

test("returns the sole eligible account for identified sessions", () => {
  const pool = createPool([19])
  expect(assignment(pool, "single-session")).toBe(19)
})

test("keeps unidentified clients on the first eligible account", () => {
  const pool = createPool([9, 4, 7])
  expect(pool.getAccountForModelBySession(MODEL_A, undefined)?.id).toBe(9)
})

test("selects an advertising model account outside the inference index", () => {
  const pool = createPool([1, 2])
  setModelRoutingOverridesForTest({ [MODEL_A]: { "1": false } })
  pool.rebuildModelIndex()

  expect(pool.getEligibleAccountIdsForModel(MODEL_A)).toEqual([2])
  expect(pool.getAccountAdvertisingModelBySession(MODEL_A)?.id).toBe(1)
})

test("keeps a control-plane affinity on one healthy account", () => {
  const pool = createPool([1, 2, 3])
  const selections = Array.from(
    { length: 20 },
    () => pool.getHealthyAccountBySession("control-plane-stable")?.id,
  )

  expect(new Set(selections).size).toBe(1)
})

test("distributes distinct control-plane affinities across healthy accounts", () => {
  const pool = createPool([1, 2, 3])
  const selected = new Set(
    Array.from({ length: 300 }, (_, index) => {
      const accountId = pool.getHealthyAccountBySession(
        `control-plane-${index}`,
      )?.id
      if (accountId === undefined) {
        throw new TypeError("Expected a healthy control-plane account")
      }
      return accountId
    }),
  )

  expect([...selected].sort((left, right) => left - right)).toEqual([1, 2, 3])
})

test("uses the first healthy account without control-plane affinity", () => {
  const pool = createPool([9, 4, 7])
  const first = pool.getAllAccounts().at(0)
  if (!first) throw new TypeError("Expected first account")
  pool.markUnhealthy(first)

  expect(pool.getHealthyAccountBySession()?.id).toBe(4)
})

test("does not route an unadvertised model to an unrelated account", () => {
  const pool = createPool([1, 2, 3])

  expect(
    pool.getAccountAdvertisingModelBySession("unadvertised-model", "session"),
  ).toBeUndefined()
})

test("removes test accounts from model eligibility", () => {
  const pool = createPool([91, 92])
  pool.removeAccountForTest(91)

  expect(pool.getAllAccounts().map((account) => account.id)).toEqual([92])
  expect(pool.getEligibleAccountIdsForModel(MODEL_A)).toEqual([92])
})
