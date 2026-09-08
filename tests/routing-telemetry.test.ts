import { beforeEach, expect, test } from "bun:test"

import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  isRoutingWindow,
  recordRoutingRequest,
  recordRoutingSelection,
  recordUpstreamCall,
  resetRoutingTelemetryForTest,
} from "~/lib/routing-telemetry"
import { getRoutingSourceProtocol } from "~/server"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const NOW = Date.UTC(2026, 7, 3, 12)

const ACCOUNTS = [
  {
    id: 0,
    accountType: "individual",
    githubUsername: "alpha",
    healthy: true,
  },
  {
    id: 1,
    accountType: "individual",
    githubUsername: "beta",
    healthy: true,
  },
]

beforeEach(() => {
  resetRoutingTelemetryForTest(NOW - 2 * HOUR_MS)
})

test("separates client requests from retries and failovers", () => {
  recordRoutingRequest({
    model: "gpt-5.6-sol",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    status: 200,
    timestamp: NOW,
  })
  recordUpstreamCall({
    accountId: 0,
    model: "gpt-5.6-sol",
    outcome: "server_error",
    provider: "GitHub Copilot",
    reason: "initial",
    route: "Responses -> Responses",
    timestamp: NOW,
  })
  recordUpstreamCall({
    accountId: 0,
    model: "gpt-5.6-sol",
    outcome: "client_error",
    provider: "GitHub Copilot",
    reason: "http_retry",
    route: "Responses -> Responses",
    timestamp: NOW,
  })
  recordUpstreamCall({
    accountId: 1,
    model: "gpt-5.6-sol",
    outcome: "success",
    provider: "GitHub Copilot",
    reason: "failover",
    route: "Responses -> Responses",
    timestamp: NOW,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: ACCOUNTS,
    multiToken: true,
    now: NOW,
    window: "1h",
  })

  expect(snapshot.totals).toEqual({
    failovers: 1,
    requests: 1,
    retries: 1,
    upstreamCalls: 3,
  })
  expect(snapshot.lifetime).toEqual(snapshot.totals)
  expect(snapshot.models).toHaveLength(1)
  expect(snapshot.models[0]).toMatchObject({
    amplification: 3,
    failovers: 1,
    model: "gpt-5.6-sol",
    provider: "GitHub Copilot",
    requests: 1,
    retries: 1,
    successRate: 1 / 3,
    upstreamCalls: 3,
  })
  expect(snapshot.models[0]?.accounts).toEqual([
    { accountId: 0, share: 2 / 3, upstreamCalls: 2 },
    { accountId: 1, share: 1 / 3, upstreamCalls: 1 },
  ])
  expect(snapshot.timeSeries.at(-1)).toMatchObject({
    extraCalls: 2,
    requests: 1,
    upstreamCalls: 3,
  })
})

test("retains lifetime totals while pruning minute detail after 24 hours", () => {
  recordRoutingRequest({
    model: "old-model",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    status: 200,
    timestamp: NOW - 25 * HOUR_MS,
  })
  recordUpstreamCall({
    model: "old-model",
    outcome: "success",
    provider: "GitHub Copilot",
    reason: "initial",
    route: "Responses -> Responses",
    timestamp: NOW - 25 * HOUR_MS,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    now: NOW,
    window: "24h",
  })

  expect(snapshot.totals).toMatchObject({ requests: 0, upstreamCalls: 0 })
  expect(snapshot.lifetime).toMatchObject({ requests: 1, upstreamCalls: 1 })
  expect(snapshot.models).toEqual([])
})

test("includes records exactly on the selected window cutoff", () => {
  recordRoutingRequest({
    model: "cutoff-model",
    provider: "GitHub Copilot",
    route: "Messages -> Anthropic Messages",
    status: 200,
    timestamp: NOW - 15 * MINUTE_MS,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    now: NOW,
    window: "15m",
  })

  expect(snapshot.totals.requests).toBe(1)
  expect(snapshot.timeSeries).toHaveLength(16)
  expect(snapshot.timeSeries[0]?.requests).toBe(1)
})

test("chart extra calls use classified resends instead of call-request timing", () => {
  recordUpstreamCall({
    model: "slow-model",
    outcome: "success",
    provider: "GitHub Copilot",
    reason: "initial",
    route: "Responses -> Responses",
    timestamp: NOW - MINUTE_MS,
  })
  recordRoutingRequest({
    model: "slow-model",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    status: 200,
    timestamp: NOW,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    now: NOW,
    window: "15m",
  })

  expect(snapshot.timeSeries.at(-2)).toMatchObject({
    extraCalls: 0,
    requests: 0,
    upstreamCalls: 1,
  })
  expect(snapshot.timeSeries.at(-1)).toMatchObject({
    extraCalls: 0,
    requests: 1,
    upstreamCalls: 0,
  })
})

test("calculates eligibility-weighted account balance separately from calls", () => {
  for (let index = 0; index < 30; index++) {
    recordRoutingSelection({
      accountId: index < 24 ? 0 : 1,
      eligibleAccountIds: [0, 1],
      mode: "sticky",
      model: "claude-sonnet-4.5",
      timestamp: NOW,
    })
  }
  recordUpstreamCall({
    accountId: 1,
    model: "claude-sonnet-4.5",
    outcome: "success",
    provider: "GitHub Copilot",
    reason: "failover",
    route: "Messages -> Anthropic Messages",
    timestamp: NOW,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: ACCOUNTS,
    multiToken: true,
    now: NOW,
    window: "1h",
  })

  expect(snapshot.selectionModes).toEqual({
    default: 0,
    single: 0,
    sticky: 30,
  })
  expect(snapshot.accounts[0]).toMatchObject({
    accountId: 0,
    balanceStatus: "skewed",
    expectedSelections: 15,
    expectedShare: 0.5,
    selected: 24,
    selectionShare: 0.8,
    upstreamCalls: 0,
  })
  expect(snapshot.accounts[1]).toMatchObject({
    accountId: 1,
    balanceStatus: "skewed",
    expectedSelections: 15,
    selected: 6,
    upstreamCalls: 1,
  })
})

test("aggregates fixed routing affinity sources without retaining raw keys", () => {
  const sources = [
    "claude_session",
    "copilot_session",
    "codex_session",
    "claude_metadata",
    "codex_metadata",
    "codex_thread",
  ] as const
  for (const [index, affinitySource] of sources.entries()) {
    recordRoutingSelection({
      accountId: index,
      affinitySource,
      eligibleAccountIds: [index],
      mode: "sticky",
      model: `raw-session-id-${index}`,
      timestamp: NOW,
    })
  }
  recordRoutingSelection({
    accountId: 0,
    eligibleAccountIds: [0],
    mode: "default",
    model: "default-model",
    timestamp: NOW,
  })
  recordRoutingSelection({
    eligibleAccountIds: [],
    mode: "single",
    model: "single-model",
    timestamp: NOW,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: true,
    now: NOW,
    window: "1h",
  })

  expect(snapshot.affinitySources).toEqual({
    claude_session: 1,
    copilot_session: 1,
    codex_session: 1,
    claude_metadata: 1,
    codex_metadata: 1,
    codex_thread: 1,
    unidentified: 1,
  })
  expect(Object.keys(snapshot.affinitySources).sort()).toEqual(
    [...sources, "unidentified"].sort(),
  )
  const serialized = JSON.stringify(snapshot)
  expect(serialized).not.toContain("raw-session-id")
})

test("windows, prunes, resets, and bounds affinity source counters", () => {
  recordRoutingSelection({
    accountId: 1,
    affinitySource: "claude_session",
    eligibleAccountIds: [1],
    mode: "sticky",
    model: "old",
    timestamp: NOW - 25 * HOUR_MS,
  })
  recordRoutingSelection({
    accountId: 1,
    affinitySource: "copilot_session",
    eligibleAccountIds: [1],
    mode: "sticky",
    model: "current",
    timestamp: NOW,
  })
  recordRoutingSelection({
    accountId: 1,
    affinitySource: "invalid_source" as "copilot_session",
    eligibleAccountIds: [1],
    mode: "sticky",
    model: "invalid",
    timestamp: NOW,
  })

  const current = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: true,
    now: NOW,
    window: "1h",
  })
  expect(current.affinitySources).toEqual({
    claude_session: 0,
    copilot_session: 1,
    codex_session: 0,
    claude_metadata: 0,
    codex_metadata: 0,
    codex_thread: 0,
    unidentified: 1,
  })

  resetRoutingTelemetryForTest(NOW)
  expect(
    getRoutingTelemetrySnapshot({
      accounts: [],
      multiToken: true,
      now: NOW,
      window: "1h",
    }).affinitySources,
  ).toEqual({
    claude_session: 0,
    copilot_session: 0,
    codex_session: 0,
    claude_metadata: 0,
    codex_metadata: 0,
    codex_thread: 0,
    unidentified: 0,
  })
})

test("aligns affinity source counters with selection modes", () => {
  recordRoutingSelection({
    accountId: 1,
    affinitySource: "copilot_session",
    eligibleAccountIds: [1],
    mode: "default",
    model: "default-with-source",
    timestamp: NOW,
  })
  recordRoutingSelection({
    accountId: 1,
    eligibleAccountIds: [1],
    mode: "sticky",
    model: "sticky-missing-source",
    timestamp: NOW,
  })
  recordRoutingSelection({
    accountId: 1,
    affinitySource: "invalid" as "claude_session",
    eligibleAccountIds: [1],
    mode: "sticky",
    model: "sticky-invalid-source",
    timestamp: NOW,
  })
  recordRoutingSelection({
    affinitySource: "claude_session",
    eligibleAccountIds: [],
    mode: "single",
    model: "single-with-source",
    timestamp: NOW,
  })

  expect(
    getRoutingTelemetrySnapshot({
      accounts: [],
      multiToken: true,
      now: NOW,
      window: "1h",
    }).affinitySources,
  ).toEqual({
    claude_session: 0,
    copilot_session: 0,
    codex_session: 0,
    claude_metadata: 0,
    codex_metadata: 0,
    codex_thread: 0,
    unidentified: 3,
  })
})

test("counts single-token selections without inventing an account", () => {
  recordRoutingSelection({
    eligibleAccountIds: [],
    mode: "single",
    model: "gpt-5-mini",
    timestamp: NOW,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    now: NOW,
    window: "1h",
  })

  expect(snapshot.selectionModes).toEqual({
    default: 0,
    single: 1,
    sticky: 0,
  })
  expect(snapshot.accounts[0]).toMatchObject({
    accountId: null,
    label: "Default credential",
  })
})

test("shows custom providers without an account distribution", () => {
  recordRoutingRequest({
    model: "qwen3-embedding",
    provider: "Nebius",
    route: "Embeddings -> Nebius",
    status: 200,
    timestamp: NOW,
  })
  recordUpstreamCall({
    model: "qwen3-embedding",
    outcome: "success",
    provider: "Nebius",
    reason: "initial",
    route: "Embeddings -> Nebius",
    timestamp: NOW,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: ACCOUNTS,
    multiToken: true,
    now: NOW,
    window: "1h",
  })

  expect(snapshot.models[0]).toMatchObject({
    accounts: [],
    model: "qwen3-embedding",
    provider: "Nebius",
    requests: 1,
    upstreamCalls: 1,
  })
})

test("sorts models deterministically by calls then provider and model", () => {
  for (const model of ["z-model", "a-model"]) {
    recordUpstreamCall({
      model,
      outcome: "success",
      provider: "GitHub Copilot",
      reason: "initial",
      route: "Responses -> Responses",
      timestamp: NOW,
    })
  }
  recordUpstreamCall({
    model: "busy-model",
    outcome: "success",
    provider: "GitHub Copilot",
    reason: "initial",
    route: "Responses -> Responses",
    timestamp: NOW,
  })
  recordUpstreamCall({
    model: "busy-model",
    outcome: "success",
    provider: "GitHub Copilot",
    reason: "http_retry",
    route: "Responses -> Responses",
    timestamp: NOW,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    now: NOW,
    window: "1h",
  })

  expect(snapshot.models.map((model) => model.model)).toEqual([
    "busy-model",
    "a-model",
    "z-model",
  ])
})

test("folds excess model dimensions into a bounded Other row", () => {
  for (let index = 0; index < 240; index++) {
    recordUpstreamCall({
      model: `model-${index}`,
      outcome: "success",
      provider: `provider-${index}`,
      reason: "initial",
      route: "Responses -> Responses",
      timestamp: NOW,
    })
  }

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    now: NOW,
    window: "1h",
  })

  expect(snapshot.models.length).toBeLessThanOrEqual(201)
  expect(snapshot.models.some((row) => row.model === "Other")).toBe(true)
  expect(snapshot.totals.upstreamCalls).toBe(240)
})

test("ignores invalid events and returns a complete zero snapshot", () => {
  recordRoutingRequest({
    model: "bad",
    provider: "bad",
    route: "bad",
    status: Number.NaN,
    timestamp: NOW,
  })
  recordUpstreamCall({
    model: "bad",
    outcome: "success",
    provider: "bad",
    reason: "initial",
    route: "bad",
    timestamp: Number.POSITIVE_INFINITY,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    now: NOW,
    window: "6h",
  })

  expect(snapshot).toMatchObject({
    accounts: [
      {
        accountId: null,
        balanceStatus: "not_applicable",
        label: "Default credential",
      },
    ],
    models: [],
    multiToken: false,
    retentionMinutes: 1440,
    routes: [],
    selectionModes: { default: 0, single: 0, sticky: 0 },
    totals: { failovers: 0, requests: 0, retries: 0, upstreamCalls: 0 },
    window: "6h",
    windowMinutes: 360,
  })
  expect(snapshot.timeSeries).toHaveLength(13)
})

test("recognizes only supported routing windows", () => {
  expect(isRoutingWindow("15m")).toBe(true)
  expect(isRoutingWindow("1h")).toBe(true)
  expect(isRoutingWindow("6h")).toBe(true)
  expect(isRoutingWindow("24h")).toBe(true)
  expect(isRoutingWindow("7d")).toBe(false)
  expect(isRoutingWindow("")).toBe(false)
})

test("labels supported client protocol paths before provider routing", () => {
  expect(getRoutingSourceProtocol("/v1/messages/count_tokens")).toBe(
    "Token Count",
  )
  expect(getRoutingSourceProtocol("/v1/messages")).toBe("Messages")
  expect(getRoutingSourceProtocol("/v1/responses")).toBe("Responses")
  expect(getRoutingSourceProtocol("/v1/chat/completions")).toBe(
    "Chat Completions",
  )
  expect(getRoutingSourceProtocol("/v1/embeddings")).toBe("Embeddings")
  expect(getRoutingSourceProtocol("/v1/audio/transcriptions")).toBe(
    "Audio Transcriptions",
  )
  expect(
    getRoutingSourceProtocol("/models/gemini-2.0-flash:generateContent"),
  ).toBe("Google AI")
  expect(
    getRoutingSourceProtocol("/v1/models/gemini-2.0-flash:generateContent"),
  ).toBe("Google AI")
  expect(
    getRoutingSourceProtocol(
      "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
    ),
  ).toBe("Google AI")
  expect(getRoutingSourceProtocol("/v1/complete")).toBe("Legacy Complete")
})
