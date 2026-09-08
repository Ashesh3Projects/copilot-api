import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { routedFetch } from "../src/lib/account-router"
import { setModelRoutingOverridesForTest } from "../src/lib/model-routing"
import { runWithRoutingAffinity } from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const queuedResults: Array<Error | Response> = []

const fetchMock = mock(() => {
  const next = queuedResults.shift()
  if (!next) throw new Error("Unexpected fetch")
  if (next instanceof Error) throw next
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

function registerAccount(id: number, modelId: string, token: string): void {
  const account = tokenPool.addAccount(`github-${id}`, "individual", id)
  account.copilotToken = token
  account.models = new Set([modelId])
  account.modelsData = [createModel(modelId)]
  account.healthy = true
}

function snapshot() {
  return getRoutingTelemetrySnapshot({
    accounts: tokenPool.getAllAccounts().map((account) => ({
      accountType: account.accountType,
      healthy: account.healthy,
      id: account.id,
    })),
    multiToken: true,
    window: "1h",
  })
}

function socketError(): Error {
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
  queuedResults.length = 0
  fetchMock.mockClear()
  resetRoutingTelemetryForTest()
  setModelRoutingOverridesForTest({})
  state.isMultiToken = true
  state.sessionId = "router-telemetry-test"
})

test("keeps direct OAuth authentication rejection separate from failover", async () => {
  const modelId = "router-telemetry-failover"
  registerAccount(1001, modelId, "primary")
  registerAccount(1002, modelId, "secondary")
  tokenPool.rebuildModelIndex()
  queuedResults.push(new Response("Unauthorized", { status: 401 }))

  const result = await seedProtocolDatabase().then(() =>
    routedFetch("/chat/completions", { method: "POST" }, { modelId }),
  )

  expect(result.response.status).toBe(401)
  expect(result.account?.id).toBe(1001)
  const usage = snapshot()
  expect(usage.totals).toMatchObject({
    failovers: 0,
    retries: 0,
    upstreamCalls: 1,
  })
  expect(usage.selectionModes).toEqual({ default: 1, single: 0, sticky: 0 })
  expect(usage.models[0]?.accounts).toEqual([
    { accountId: 1001, share: 1, upstreamCalls: 1 },
  ])
  expect(
    usage.accounts.map(({ expectedSelections, selected }) => ({
      expectedSelections,
      selected,
    })),
  ).toEqual([
    { expectedSelections: 0.5, selected: 1 },
    { expectedSelections: 0.5, selected: 0 },
  ])
})

test("keeps transport retries on the initially selected account", async () => {
  const modelId = "router-telemetry-transport"
  registerAccount(1101, modelId, "primary")
  registerAccount(1102, modelId, "secondary")
  tokenPool.rebuildModelIndex()
  queuedResults.push(socketError(), socketError())

  let thrown: unknown
  try {
    await seedProtocolDatabase().then(() =>
      routedFetch("/chat/completions", { method: "POST" }, { modelId }),
    )
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toContain("socket connection")

  const usage = snapshot()
  expect(usage.totals).toMatchObject({
    failovers: 0,
    retries: 1,
    upstreamCalls: 2,
  })
  expect(usage.models[0]?.accounts).toEqual([
    { accountId: 1101, share: 1, upstreamCalls: 2 },
  ])
})

test("records one sticky selection when identified failover is suppressed", async () => {
  const modelId = "router-telemetry-sticky-failover"
  registerAccount(1301, modelId, "sticky-primary")
  registerAccount(1302, modelId, "sticky-secondary")
  tokenPool.rebuildModelIndex()
  queuedResults.push(new Response("forbidden", { status: 403 }))

  const error = await runWithRoutingAffinity(
    { key: "sticky-failover-session", source: "copilot_session" },
    async () =>
      await seedProtocolDatabase().then(() =>
        routedFetch("/chat/completions", { method: "POST" }, { modelId }),
      ),
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(Error)
  const usage = snapshot()
  expect(usage.selectionModes).toEqual({ default: 0, single: 0, sticky: 1 })
  expect(usage.totals.failovers).toBe(0)
  expect(usage.totals.upstreamCalls).toBe(1)
  expect(
    usage.accounts.reduce((sum, account) => sum + account.selected, 0),
  ).toBe(1)
})

test("records typed routing affinity sources and unidentified defaults", async () => {
  resetRoutingTelemetryForTest()
  const cases = [
    [1401, "telemetry-source-copilot", "copilot_session"],
    [1402, "telemetry-source-codex", "codex_session"],
    [1403, "telemetry-source-claude", "claude_metadata"],
  ] as const
  const defaultModel = "telemetry-source-default"
  try {
    for (const [accountId, modelId, source] of cases) {
      registerAccount(accountId, modelId, `token-${accountId}`)
      tokenPool.rebuildModelIndex()
      queuedResults.push(new Response("{}", { status: 200 }))
      await runWithRoutingAffinity(
        { key: `private-session-${accountId}`, source },
        async () =>
          await seedProtocolDatabase().then(() =>
            routedFetch("/chat/completions", { method: "POST" }, { modelId }),
          ),
      )
    }
    registerAccount(1404, defaultModel, "token-1404")
    tokenPool.rebuildModelIndex()
    queuedResults.push(new Response("{}", { status: 200 }))
    await seedProtocolDatabase().then(() =>
      routedFetch(
        "/chat/completions",
        { method: "POST" },
        { modelId: defaultModel },
      ),
    )

    const usage = snapshot()
    expect(usage.affinitySources).toEqual({
      claude_session: 0,
      copilot_session: 1,
      codex_session: 1,
      claude_metadata: 1,
      codex_metadata: 0,
      codex_thread: 0,
      unidentified: 1,
    })
    expect(JSON.stringify(usage)).not.toContain("private-session")
  } finally {
    for (const [accountId] of cases) tokenPool.removeAccountForTest(accountId)
    tokenPool.removeAccountForTest(1404)
  }
})
