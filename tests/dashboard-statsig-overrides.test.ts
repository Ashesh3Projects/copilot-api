import { afterAll, beforeEach, expect, test } from "bun:test"

import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import {
  getFeatureFlags,
  removeFeatureFlag,
} from "../src/routes/feature-flags/store"
import {
  statsigOverrideStore,
  type StatsigOverrides,
} from "../src/routes/statsig-overrides/store"
import { server } from "../src/server"
import { parseDynamicConfig } from "../ui/src/lib/dynamicConfig"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

const TEST_CLAUDE_FLAG = "dashboard_statsig_overrides_test_flag"
let adminSession: TestAdminSession

function createEmptyOverrides(): StatsigOverrides {
  return {
    featureGates: {},
    dynamicConfigs: {},
  }
}

async function requestDashboard(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers)
  for (const [name, value] of Object.entries(
    adminHeaders(adminSession, init?.method !== undefined),
  )) {
    headers.set(name, value)
  }

  return server.request(path, {
    ...init,
    headers,
  })
}

async function requestDashboardJson(
  path: string,
  method: "POST" | "DELETE",
  body: unknown,
): Promise<Response> {
  return requestDashboard(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  adminSession = await createTestAdminSession()
  await removeFeatureFlag(TEST_CLAUDE_FLAG)
  statsigOverrideStore.replaceForTest(createEmptyOverrides())
})

afterAll(async () => {
  await removeFeatureFlag(TEST_CLAUDE_FLAG)
  await resetTestAdminSession()
  statsigOverrideStore.replaceForTest(createEmptyOverrides())
  statsigOverrideStore.resetAfterTest()
})

test("dashboard statsig overrides require authentication", async () => {
  const response = await server.request("/dashboard/api/statsig-overrides")

  expect(response.status).toBe(401)
})

test("dashboard statsig overrides can add, list, and remove both override kinds", async () => {
  const featureGateResponse = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "POST",
    {
      kind: "featureGate",
      name: "gate-enabled",
      value: true,
    },
  )
  expect(featureGateResponse.status).toBe(200)
  expect(await featureGateResponse.json()).toEqual({ success: true })

  const dynamicConfigResponse = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "POST",
    {
      kind: "dynamicConfig",
      name: "assistant-config",
      value: { rollout: 50, nested: { enabled: true } },
    },
  )
  expect(dynamicConfigResponse.status).toBe(200)
  expect(await dynamicConfigResponse.json()).toEqual({ success: true })

  const listResponse = await requestDashboard(
    "/dashboard/api/statsig-overrides",
  )
  expect(listResponse.status).toBe(200)
  const listedOverrides = (await listResponse.json()) as StatsigOverrides
  expect(listedOverrides).toEqual({
    featureGates: { "gate-enabled": true },
    dynamicConfigs: {
      "assistant-config": { rollout: 50, nested: { enabled: true } },
    },
  })

  listedOverrides.featureGates["gate-enabled"] = false
  ;(
    listedOverrides.dynamicConfigs["assistant-config"] as {
      nested: { enabled: boolean }
    }
  ).nested.enabled = false

  const secondListResponse = await requestDashboard(
    "/dashboard/api/statsig-overrides",
  )
  expect(await secondListResponse.json()).toEqual({
    featureGates: { "gate-enabled": true },
    dynamicConfigs: {
      "assistant-config": { rollout: 50, nested: { enabled: true } },
    },
  })

  const deleteFeatureGateResponse = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "DELETE",
    {
      kind: "featureGate",
      name: "gate-enabled",
    },
  )
  expect(deleteFeatureGateResponse.status).toBe(200)
  expect(await deleteFeatureGateResponse.json()).toEqual({ success: true })

  const deleteDynamicConfigResponse = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "DELETE",
    {
      kind: "dynamicConfig",
      name: "assistant-config",
    },
  )
  expect(deleteDynamicConfigResponse.status).toBe(200)
  expect(await deleteDynamicConfigResponse.json()).toEqual({ success: true })

  const emptyListResponse = await requestDashboard(
    "/dashboard/api/statsig-overrides",
  )
  expect(await emptyListResponse.json()).toEqual(createEmptyOverrides())
})

test("dashboard statsig overrides reject invalid kinds", async () => {
  const response = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "POST",
    {
      kind: "gate",
      name: "gate-enabled",
      value: true,
    },
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: "kind must be featureGate or dynamicConfig",
  })
})

test("dashboard statsig overrides surface store validation errors", async () => {
  const invalidFeatureGateResponse = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "POST",
    {
      kind: "featureGate",
      name: "gate-enabled",
      value: "true",
    },
  )
  expect(invalidFeatureGateResponse.status).toBe(400)
  expect(await invalidFeatureGateResponse.json()).toEqual({
    error: "feature gate value must be boolean",
  })

  const invalidDynamicConfigResponse = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "POST",
    {
      kind: "dynamicConfig",
      name: "assistant-config",
      value: [],
    },
  )
  expect(invalidDynamicConfigResponse.status).toBe(400)
  expect(await invalidDynamicConfigResponse.json()).toEqual({
    error: "dynamic config value must be a JSON object",
  })
})

test("dashboard statsig overrides surface invalid names", async () => {
  const blankNameResponse = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "POST",
    {
      kind: "featureGate",
      name: "   ",
      value: true,
    },
  )
  expect(blankNameResponse.status).toBe(400)
  expect(await blankNameResponse.json()).toEqual({
    error: "name is required",
  })

  const unsafeNameResponse = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "DELETE",
    {
      kind: "dynamicConfig",
      name: "__proto__",
    },
  )
  expect(unsafeNameResponse.status).toBe(400)
  expect(await unsafeNameResponse.json()).toEqual({
    error: "name is not allowed",
  })
})

test("dashboard statsig overrides return not found for missing deletes", async () => {
  const response = await requestDashboardJson(
    "/dashboard/api/statsig-overrides",
    "DELETE",
    {
      kind: "featureGate",
      name: "missing-gate",
    },
  )

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: "Override not found" })
})

test("dashboard overview counts claude flags and statsig overrides together", async () => {
  const baselineFlagsCount = Object.keys(getFeatureFlags()).length

  const claudeFlagResponse = await requestDashboardJson(
    "/dashboard/api/flags",
    "POST",
    {
      name: TEST_CLAUDE_FLAG,
      value: true,
    },
  )
  expect(claudeFlagResponse.status).toBe(200)

  await requestDashboardJson("/dashboard/api/statsig-overrides", "POST", {
    kind: "featureGate",
    name: "gate-enabled",
    value: true,
  })
  await requestDashboardJson("/dashboard/api/statsig-overrides", "POST", {
    kind: "dynamicConfig",
    name: "assistant-config",
    value: { enabled: true },
  })

  const response = await requestDashboard("/dashboard/api/overview")
  const body = (await response.json()) as { flagsCount: number }

  expect(response.status).toBe(200)
  expect(body.flagsCount).toBe(baselineFlagsCount + 3)
})

test("dashboard bundle ships ChatGPT/Codex feature flag controls", () => {
  expect(DASHBOARD_HTML).toContain("ChatGPT / Codex")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/statsig-overrides")
  expect(DASHBOARD_HTML).toContain("ab.chatgpt.com")
  expect(DASHBOARD_HTML).toContain("api.anthropic.com")
})

test("dashboard dynamic config parser preserves existing errors", () => {
  expect(parseDynamicConfig("{")).toEqual({
    ok: false,
    error: "Enter valid JSON",
  })
  expect(parseDynamicConfig("[]")).toEqual({
    ok: false,
    error: "Dynamic config must be a JSON object",
  })
})

test("dashboard dynamic config parser accepts JSON-compatible values", () => {
  expect(
    parseDynamicConfig(
      '{"null":null,"boolean":true,"string":"value","number":1.5,"array":[false,2,{"nested":null}]}',
    ),
  ).toEqual({
    ok: true,
    value: {
      null: null,
      boolean: true,
      string: "value",
      number: 1.5,
      array: [false, 2, { nested: null }],
    },
  })
})

test("dashboard dynamic config parser rejects exponent overflow", () => {
  expect(parseDynamicConfig('{"x":1e400}')).toEqual({
    ok: false,
    error: "Dynamic config numbers must be finite",
  })
})

test("dashboard dynamic config parser rejects nested array exponent overflow", () => {
  expect(
    parseDynamicConfig('{"nested":{"values":[1,{"limit":-1e400}]}}'),
  ).toEqual({
    ok: false,
    error: "Dynamic config numbers must be finite",
  })
})

test("dashboard claude flags endpoint remains unchanged alongside statsig overrides", async () => {
  const setClaudeFlagResponse = await requestDashboardJson(
    "/dashboard/api/flags",
    "POST",
    {
      name: TEST_CLAUDE_FLAG,
      value: false,
    },
  )
  expect(setClaudeFlagResponse.status).toBe(200)
  expect(await setClaudeFlagResponse.json()).toEqual({ success: true })

  await requestDashboardJson("/dashboard/api/statsig-overrides", "POST", {
    kind: "featureGate",
    name: "gate-enabled",
    value: true,
  })

  const listFlagsResponse = await requestDashboard("/dashboard/api/flags")
  expect(listFlagsResponse.status).toBe(200)
  expect(await listFlagsResponse.json()).toEqual(
    structuredClone(getFeatureFlags()),
  )

  const deleteClaudeFlagResponse = await requestDashboardJson(
    "/dashboard/api/flags",
    "DELETE",
    {
      name: TEST_CLAUDE_FLAG,
    },
  )
  expect(deleteClaudeFlagResponse.status).toBe(200)
  expect(await deleteClaudeFlagResponse.json()).toEqual({ success: true })
})
