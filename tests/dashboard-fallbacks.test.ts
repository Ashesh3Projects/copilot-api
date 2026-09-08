import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"

import {
  getLoadedModelFallbackConfig,
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "../src/lib/model-fallback-config"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import { server } from "../src/server"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

let adminSession: TestAdminSession

beforeAll(async () => {
  adminSession = await createTestAdminSession()
})

beforeEach(() => {
  setModelFallbackConfigForTest(validateModelFallbackConfig({}))
})

afterAll(async () => {
  setModelFallbackConfigForTest(null)
  await resetTestAdminSession()
})

test("fallback settings require dashboard authentication", async () => {
  const response = await server.request("/dashboard/api/fallbacks")
  expect(response.status).toBe(401)
})

test("authenticated fallback settings include configuration and cache size", async () => {
  const response = await server.request("/dashboard/api/fallbacks", {
    headers: adminHeaders(adminSession, false),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    config: { enabled: boolean; rules: Array<unknown> }
    cache: { entries: number }
  }
  expect(typeof body.config.enabled).toBe("boolean")
  expect(Array.isArray(body.config.rules)).toBe(true)
  expect(body.cache.entries).toBe(0)
})

test("fallback mutations require the admin CSRF header", async () => {
  for (const [method, path] of [
    ["PUT", "/dashboard/api/fallbacks"],
    ["DELETE", "/dashboard/api/fallbacks/cache"],
  ]) {
    const response = await server.request(path, {
      method,
      headers: adminHeaders(adminSession, false),
      ...(method === "PUT" ? { body: JSON.stringify({ enabled: true }) } : {}),
    })
    expect(response.status).toBe(401)
  }
  expect(getLoadedModelFallbackConfig().enabled).toBe(false)
})

test("fallback PUT saves rules and settings and GET returns them", async () => {
  const config = validateModelFallbackConfig({
    enabled: true,
    conversationAffinity: false,
    notifyClient: true,
    nativeClientNotice: true,
    affinityTtlSeconds: 120,
    affinityMaxEntries: 25,
    rules: [
      {
        id: "test-rule",
        sourceModel: "source",
        targetModel: "alternate",
        enabled: true,
      },
    ],
  })
  const update = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers: adminHeaders(adminSession),
    body: JSON.stringify(config),
  })
  expect(update.status).toBe(200)
  expect(await update.json()).toEqual({ config, cache: { entries: 0 } })

  const read = await server.request("/dashboard/api/fallbacks", {
    headers: adminHeaders(adminSession, false),
  })
  expect(await read.json()).toEqual({ config, cache: { entries: 0 } })
})

test("invalid fallback requests cannot replace the active configuration", async () => {
  const baseline = getLoadedModelFallbackConfig()
  const invalidBodies: Array<unknown> = [
    null,
    [],
    { enabled: "true" },
    { affinityTtlSeconds: 0 },
    { affinityMaxEntries: 100001 },
    { rules: [{ id: "invalid", sourceModel: "same", targetModel: "same" }] },
    {
      rules: [
        { id: "first", sourceModel: "source", targetModel: "alternate" },
        { id: "second", sourceModel: "source", targetModel: "other" },
      ],
    },
  ]
  for (const body of invalidBodies) {
    const response = await server.request("/dashboard/api/fallbacks", {
      method: "PUT",
      headers: adminHeaders(adminSession),
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(400)
    expect(typeof ((await response.json()) as { error: unknown }).error).toBe(
      "string",
    )
    expect(getLoadedModelFallbackConfig()).toEqual(baseline)
  }
})

test("fallback PUT rejects malformed JSON with a readable error", async () => {
  const response = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers: adminHeaders(adminSession),
    body: "{",
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: "Request body must be valid JSON",
  })
})

test("fallback validation errors identify the field without raw validator JSON", async () => {
  const response = await server.request("/dashboard/api/fallbacks", {
    method: "PUT",
    headers: adminHeaders(adminSession),
    body: JSON.stringify({ affinityTtlSeconds: 0 }),
  })
  const body = (await response.json()) as { error: string }
  expect(response.status).toBe(400)
  expect(body.error).toContain("affinityTtlSeconds:")
  expect(body.error).not.toContain('"code"')
})

test("clearing fallback affinity preserves configured rules", async () => {
  const baseline = getLoadedModelFallbackConfig()
  const response = await server.request("/dashboard/api/fallbacks/cache", {
    method: "DELETE",
    headers: adminHeaders(adminSession),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ success: true, cleared: 0 })
  expect(getLoadedModelFallbackConfig()).toEqual(baseline)
})

test("dashboard bundle exposes fallback settings, bounded chains, and notice limitations", () => {
  expect(DASHBOARD_HTML).toContain("/dashboard/api/fallbacks")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/fallbacks/cache")
  expect(DASHBOARD_HTML).toContain("Enable fallbacks")
  expect(DASHBOARD_HTML).toContain("3 fallback hops (4 model attempts)")
  expect(DASHBOARD_HTML).toContain("Each hop requires HTTP 422")
  expect(DASHBOARD_HTML).toContain("Loops stop before retrying a model")
  expect(DASHBOARD_HTML).not.toContain("fallback rules do not form a chain")
  expect(DASHBOARD_HTML).toContain(
    "Keep using the fallback for the same conversation",
  )
  expect(DASHBOARD_HTML).toContain("Include diagnostic response headers")
  expect(DASHBOARD_HTML).toContain("Show native client fallback notice")
  expect(DASHBOARD_HTML).toContain("cybersecurity routing")
  expect(DASHBOARD_HTML).toContain("generic fallback notice")
})
