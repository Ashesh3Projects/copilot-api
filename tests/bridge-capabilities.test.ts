import { afterEach, beforeEach, expect, test } from "bun:test"
import { spyOn } from "bun:test"
import consola from "consola"
import { createHash } from "node:crypto"

import {
  authorizeEnvironmentCapability,
  authorizeWorkerCapability,
  bindWorkerCapability,
  issueEnvironmentCapability,
  issueWorkerCapability,
  resetBridgeCapabilitiesForTest,
} from "../src/lib/bridge-capabilities"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { isIpBlocked, resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { OAuthStore, setOAuthStoreForTest } from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import { trustedJwtDigestStore } from "../src/lib/trusted-jwt-digests"
import {
  getClientEvents,
  getInternalEvents,
  getSession,
  listSessions,
} from "../src/routes/code-sessions/session-store"
import {
  getEnvironment,
  listEnvironments,
} from "../src/routes/environments/environment-store"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

const GATEWAY_KEY = "bridge-test-gateway-key-with-enough-entropy"
const originalPublicBase = process.env.COPILOT_PUBLIC_BASE_URL

function bearer(value: string): { authorization: string } {
  return { authorization: `Bearer ${value}` }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

useProtocolDatabase()

beforeEach(async () => {
  setIpAllowlistForTest([])
  state.apiKeyAuth = GATEWAY_KEY
  await seedProtocolDatabase()
  resetIpSecurityForTest()
  setOAuthStoreForTest(new OAuthStore())
  resetBridgeCapabilitiesForTest()
  trustedJwtDigestStore.resetAfterTest()
  delete process.env.COPILOT_PUBLIC_BASE_URL
})

afterEach(() => {
  setIpAllowlistForTest([])
  resetIpSecurityForTest()
  state.apiKeyAuth = undefined
  setOAuthStoreForTest(null)
  resetBridgeCapabilitiesForTest()
  trustedJwtDigestStore.resetAfterTest()
  if (originalPublicBase === undefined)
    delete process.env.COPILOT_PUBLIC_BASE_URL
  else process.env.COPILOT_PUBLIC_BASE_URL = originalPublicBase
})

test("code-session bridges use the configured public API base", async () => {
  process.env.COPILOT_PUBLIC_BASE_URL = "https://public.example.test/gateway"
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Public origin" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: bearer(GATEWAY_KEY),
  })
  expect(bridge.status).toBe(200)
  expect((await bridge.json()) as { api_base_url: string }).toMatchObject({
    api_base_url: "https://public.example.test/gateway",
  })
})

test("code sessions require a scoped user credential", async () => {
  const denied = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Denied" }),
  })
  expect(denied.status).toBe(401)

  const allowed = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Allowed" }),
  })
  expect(allowed.status).toBe(201)
})

test("code-session and session guards record missing credentials", async () => {
  for (const [clientIp, path, method] of [
    ["198.51.100.96", "/v1/code/sessions", "POST"],
    ["198.51.100.97", "/v1/sessions", "GET"],
  ] as const) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await server.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-copilot-peer-ip": clientIp,
        },
        ...(method === "POST" ? { body: JSON.stringify({ title: "x" }) } : {}),
      })
      expect(response.status).toBe(401)
    }
    expect(isIpBlocked(clientIp)).toBe(true)
  }
})

test("worker capability failures record missing credentials", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Worker failures" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const clientIp = "198.51.100.98"

  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(
      (
        await server.request(`/v1/code/sessions/${sessionId}/worker`, {
          headers: { "x-copilot-peer-ip": clientIp },
        })
      ).status,
    ).toBe(401)
  }
  expect(isIpBlocked(clientIp)).toBe(true)
})

test("stale worker epochs count toward the shared IP ban", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Stale worker epoch" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const firstBridge = await server.request(
    `/v1/code/sessions/${sessionId}/bridge`,
    {
      method: "POST",
      headers: bearer(GATEWAY_KEY),
    },
  )
  const firstWorker = (await firstBridge.json()) as {
    worker_jwt: string
    worker_epoch: number
  }
  expect(firstWorker.worker_epoch).toBe(1)
  const secondBridge = await server.request(
    `/v1/code/sessions/${sessionId}/bridge`,
    {
      method: "POST",
      headers: bearer(GATEWAY_KEY),
    },
  )
  const secondWorker = (await secondBridge.json()) as { worker_epoch: number }
  expect(secondWorker.worker_epoch).toBe(2)

  const clientIp = "198.51.100.101"
  const clientHeaders = {
    ...bearer(firstWorker.worker_jwt),
    "x-copilot-peer-ip": "127.0.0.1",
    "x-forwarded-for": clientIp,
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await server.request(
      `/v1/code/sessions/${sessionId}/worker`,
      { headers: clientHeaders },
    )
    expect(response.status).toBe(401)
  }
  expect(isIpBlocked(clientIp)).toBe(true)
})

test("missing worker sessions do not count as credential failures", async () => {
  const sessionId = "cse_missing"
  const clientIp = "198.51.100.102"
  const headers = {
    ...bearer(issueWorkerCapability(sessionId, 1)),
    "x-copilot-peer-ip": "127.0.0.1",
    "x-forwarded-for": clientIp,
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await server.request(
      `/v1/code/sessions/${sessionId}/worker`,
      { headers },
    )
    expect(response.status).toBe(401)
  }
  expect(isIpBlocked(clientIp)).toBe(false)
})

test("environment OAuth and capability guards record failures", async () => {
  for (const [clientIp, path, method] of [
    ["198.51.100.99", "/v1/environments/bridge", "POST"],
    ["198.51.100.100", "/v1/environments/env_missing/work/poll", "GET"],
  ] as const) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await server.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-copilot-peer-ip": clientIp,
        },
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      })
      expect(response.status).toBe(401)
    }
    expect(isIpBlocked(clientIp)).toBe(true)
  }
})

test("worker capabilities are opaque, session-bound and epoch-bound", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Worker" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: bearer(GATEWAY_KEY),
  })
  const credentials = (await bridge.json()) as {
    worker_jwt: string
    worker_epoch: number
  }
  expect(credentials.worker_jwt).not.toContain(GATEWAY_KEY)
  expect(
    (
      await authorizeWorkerCapability(
        new Request("https://example.test", {
          headers: bearer(credentials.worker_jwt),
        }),
        sessionId,
      )
    )?.workerEpoch,
  ).toBe(credentials.worker_epoch)

  const crossSession = issueWorkerCapability("cse_other")
  expect(
    await authorizeWorkerCapability(
      new Request("https://example.test", { headers: bearer(crossSession) }),
      sessionId,
    ),
  ).toBeNull()
  expect(bindWorkerCapability(credentials.worker_jwt, sessionId, 99)).toBe(true)
})

test("worker HTTP routes reject user and cross-session credentials", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Worker routes" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: bearer(GATEWAY_KEY),
  })
  const token = ((await bridge.json()) as { worker_jwt: string }).worker_jwt

  expect(
    (
      await server.request(`/v1/code/sessions/${sessionId}/worker`, {
        headers: bearer(GATEWAY_KEY),
      })
    ).status,
  ).toBe(401)
  expect(
    (
      await server.request(`/v1/code/sessions/${sessionId}/worker`, {
        headers: bearer(issueWorkerCapability("cse_other")),
      })
    ).status,
  ).toBe(401)
  expect(
    (
      await server.request(`/v1/code/sessions/${sessionId}/worker`, {
        headers: bearer(token),
      })
    ).status,
  ).toBe(200)
})

test("worker capability can open the client event SSE stream", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Worker SSE" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: bearer(GATEWAY_KEY),
  })
  const token = ((await bridge.json()) as { worker_jwt: string }).worker_jwt

  const response = await server.request(
    `/v1/code/sessions/${sessionId}/events/stream`,
    { headers: bearer(token) },
  )

  expect(response.status).toBe(200)
  await response.body?.cancel()
})

test("environment capabilities are opaque and environment-bound", async () => {
  const first = issueEnvironmentCapability("env_first")
  const second = issueEnvironmentCapability("env_second")
  expect(first).not.toBe(second)
  expect(
    await authorizeEnvironmentCapability(
      new Request("https://example.test", { headers: bearer(first) }),
      "env_first",
    ),
  ).toBe(true)
  expect(
    await authorizeEnvironmentCapability(
      new Request("https://example.test", { headers: bearer(first) }),
      "env_second",
    ),
  ).toBe(false)
})

test("managed JWT rows reserve issued bridge capabilities until deleted", async () => {
  const workerSessionId = "cse_managed_collision"
  const environmentId = "env_managed_collision"
  const worker = issueWorkerCapability(workerSessionId)
  const environment = issueEnvironmentCapability(environmentId)
  const workerRequest = new Request("https://example.test", {
    headers: bearer(worker),
  })
  const environmentRequest = new Request("https://example.test", {
    headers: bearer(environment),
  })

  expect(
    await authorizeWorkerCapability(workerRequest, workerSessionId),
  ).not.toBeNull()
  expect(
    await authorizeEnvironmentCapability(environmentRequest, environmentId),
  ).toBe(true)

  const workerEntry = await trustedJwtDigestStore.add({
    label: "Worker collision",
    digest: sha256Hex(worker),
  })
  const environmentEntry = await trustedJwtDigestStore.add({
    label: "Environment collision",
    digest: sha256Hex(environment),
  })

  expect(
    await authorizeWorkerCapability(workerRequest, workerSessionId),
  ).toBeNull()
  expect(
    await authorizeEnvironmentCapability(environmentRequest, environmentId),
  ).toBe(false)
  expect(
    await authorizeWorkerCapability(
      new Request("https://example.test", {
        headers: bearer(workerEntry.digest),
      }),
      workerSessionId,
    ),
  ).toBeNull()
  expect(
    await authorizeEnvironmentCapability(
      new Request("https://example.test", {
        headers: bearer(environmentEntry.digest),
      }),
      environmentId,
    ),
  ).toBe(false)

  await trustedJwtDigestStore.setEnabled(workerEntry.id, false)
  await trustedJwtDigestStore.setEnabled(environmentEntry.id, false)
  expect(
    await authorizeWorkerCapability(workerRequest, workerSessionId),
  ).toBeNull()
  expect(
    await authorizeEnvironmentCapability(environmentRequest, environmentId),
  ).toBe(false)

  await trustedJwtDigestStore.remove(workerEntry.id)
  await trustedJwtDigestStore.remove(environmentEntry.id)
  expect(
    await authorizeWorkerCapability(workerRequest, workerSessionId),
  ).not.toBeNull()
  expect(
    await authorizeEnvironmentCapability(environmentRequest, environmentId),
  ).toBe(true)
})

test("bridge capability stores do not evict active credentials by count", async () => {
  const workerSessionId = "cse_capacity"
  const worker = issueWorkerCapability(workerSessionId)
  for (let index = 0; index < 600; index += 1) {
    issueWorkerCapability(`cse_other_${index}`)
  }
  expect(
    await authorizeWorkerCapability(
      new Request("https://example.test", { headers: bearer(worker) }),
      workerSessionId,
    ),
  ).not.toBeNull()

  const environment = issueEnvironmentCapability("env_capacity")
  for (let index = 0; index < 150; index += 1) {
    issueEnvironmentCapability(`env_other_${index}`)
  }
  expect(
    await authorizeEnvironmentCapability(
      new Request("https://example.test", { headers: bearer(environment) }),
      "env_capacity",
    ),
  ).toBe(true)
})

test("code-session writes accept large bodies and event batches", async () => {
  const largeSession = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearer(GATEWAY_KEY),
    },
    body: JSON.stringify({ title: "x".repeat(1024 * 1024 + 1) }),
  })
  expect(largeSession.status).toBe(201)

  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    body: JSON.stringify({ title: "Complete events" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    method: "POST",
    headers: bearer(GATEWAY_KEY),
  })
  const worker = (await bridge.json()) as {
    worker_epoch: number
    worker_jwt: string
  }
  const clientIp = "198.51.100.103"
  const workerBatch = await server.request(
    `/v1/code/sessions/${sessionId}/worker/events`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(worker.worker_jwt),
        "x-copilot-peer-ip": "127.0.0.1",
        "x-forwarded-for": clientIp,
      },
      body: JSON.stringify({
        worker_epoch: worker.worker_epoch,
        events: Array.from({ length: 101 }, () => ({ payload: {} })),
      }),
    },
  )
  expect(workerBatch.status).toBe(200)
  expect(isIpBlocked(clientIp)).toBe(false)
})

test("private JSON readers reject malformed bodies before mutating stores", async () => {
  const seedResponse = await server.request("/v1/code/sessions", {
    body: JSON.stringify({ title: "Malformed boundary seed" }),
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    method: "POST",
  })
  const sessionId = ((await seedResponse.json()) as { session: { id: string } })
    .session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    headers: bearer(GATEWAY_KEY),
    method: "POST",
  })
  const worker = (await bridge.json()) as {
    worker_epoch: number
    worker_jwt: string
  }
  const environmentId = `env_json_${crypto.randomUUID().replaceAll("-", "")}`
  const environmentResponse = await server.request("/v1/environments/bridge", {
    body: JSON.stringify({
      branch: "main",
      directory: String.raw`C:\repo`,
      environment_id: environmentId,
      machine_name: "json-boundary",
    }),
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    method: "POST",
  })
  expect(environmentResponse.status).toBe(200)

  const snapshots = {
    clientEvents: getClientEvents(sessionId, 0).length,
    environmentCount: listEnvironments().length,
    environmentQueue: getEnvironment(environmentId)?.workQueue.length,
    internalEvents: getInternalEvents(sessionId).length,
    sessionCount: listSessions().length,
    session: { ...getSession(sessionId) },
  }
  const marker = "peripheral-json-secret-marker"
  const logSpy = spyOn(consola, "info")

  try {
    const cases: Array<{
      headers: Record<string, string>
      method: string
      path: string
    }> = [
      {
        headers: bearer(GATEWAY_KEY),
        method: "POST",
        path: "/v1/code/sessions",
      },
      {
        headers: bearer(GATEWAY_KEY),
        method: "PATCH",
        path: `/v1/code/sessions/${sessionId}`,
      },
      {
        headers: bearer(worker.worker_jwt),
        method: "PUT",
        path: `/v1/code/sessions/${sessionId}/worker`,
      },
      {
        headers: bearer(worker.worker_jwt),
        method: "POST",
        path: `/v1/code/sessions/${sessionId}/worker/heartbeat`,
      },
      {
        headers: bearer(worker.worker_jwt),
        method: "POST",
        path: `/v1/code/sessions/${sessionId}/worker/events`,
      },
      {
        headers: bearer(worker.worker_jwt),
        method: "POST",
        path: `/v1/code/sessions/${sessionId}/worker/internal-events`,
      },
      {
        headers: bearer(GATEWAY_KEY),
        method: "POST",
        path: `/v1/code/sessions/${sessionId}/events`,
      },
      {
        headers: bearer(GATEWAY_KEY),
        method: "POST",
        path: "/v1/environments/bridge",
      },
      {
        headers: bearer(GATEWAY_KEY),
        method: "POST",
        path: `/v1/environments/${environmentId}/work`,
      },
    ]

    for (const testCase of cases) {
      const response = await server.request(testCase.path, {
        body: `{${marker}`,
        headers: {
          "content-type": "application/json",
          ...testCase.headers,
        },
        method: testCase.method,
      })
      const text = await response.text()
      expect(response.status).toBe(400)
      expect(text).toBe('{"error":"Invalid JSON"}')
      expect(text).not.toMatch(/SyntaxError|Unexpected|JSON Parse|Bun|Hono/)
    }
  } finally {
    const capturedLogs = JSON.stringify(logSpy.mock.calls)
    logSpy.mockRestore()
    expect(capturedLogs).not.toContain(marker)
    expect(capturedLogs).not.toMatch(
      /SyntaxError|Unexpected|JSON Parse|Bun|Hono/,
    )
  }

  expect(listSessions()).toHaveLength(snapshots.sessionCount)
  expect(listEnvironments()).toHaveLength(snapshots.environmentCount)
  expect(getEnvironment(environmentId)?.workQueue).toHaveLength(
    snapshots.environmentQueue ?? 0,
  )
  expect(getClientEvents(sessionId, 0)).toHaveLength(snapshots.clientEvents)
  expect(getInternalEvents(sessionId)).toHaveLength(snapshots.internalEvents)
  expect(getSession(sessionId)).toMatchObject(snapshots.session)
})

test("peripheral JSON boundaries preserve authentication and bodyless exceptions", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    body: JSON.stringify({ title: "Bodyless controls" }),
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    method: "POST",
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const bridge = await server.request(`/v1/code/sessions/${sessionId}/bridge`, {
    headers: bearer(GATEWAY_KEY),
    method: "POST",
  })
  const worker = (await bridge.json()) as {
    worker_epoch: number
    worker_jwt: string
  }

  const registration = await server.request(
    `/v1/code/sessions/${sessionId}/worker/register`,
    { headers: bearer(worker.worker_jwt), method: "POST" },
  )
  expect(registration.status).toBe(200)
  expect((await registration.json()) as { worker_epoch: number }).toMatchObject(
    {
      worker_epoch: worker.worker_epoch + 1,
    },
  )

  for (const path of ["/v1/code/sessions", "/v1/environments/bridge"]) {
    const response = await server.request(path, {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(response.status).toBe(401)
  }

  const environmentId = `env_empty_${crypto.randomUUID().replaceAll("-", "")}`
  const environmentResponse = await server.request("/v1/environments/bridge", {
    body: JSON.stringify({
      branch: "main",
      directory: String.raw`C:\repo`,
      environment_id: environmentId,
      machine_name: "empty-boundary",
    }),
    headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
    method: "POST",
  })
  expect(environmentResponse.status).toBe(200)

  for (const body of [undefined, "{}"] as const) {
    const beforeSessions = listSessions().length
    const beforeQueue = getEnvironment(environmentId)?.workQueue.length ?? 0
    const response = await server.request(
      `/v1/environments/${environmentId}/work`,
      {
        ...(body === undefined ? {} : { body }),
        headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
        method: "POST",
      },
    )
    expect(response.status).toBe(200)
    expect(listSessions()).toHaveLength(beforeSessions + 1)
    expect(getEnvironment(environmentId)?.workQueue).toHaveLength(
      beforeQueue + 1,
    )
  }

  const beforeWhitespaceSessions = listSessions().length
  const beforeWhitespaceQueue =
    getEnvironment(environmentId)?.workQueue.length ?? 0
  const whitespace = await server.request(
    `/v1/environments/${environmentId}/work`,
    {
      body: " ",
      headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
      method: "POST",
    },
  )
  expect(whitespace.status).toBe(400)
  expect(await whitespace.json()).toEqual({ error: "Invalid JSON" })
  expect(listSessions()).toHaveLength(beforeWhitespaceSessions)
  expect(getEnvironment(environmentId)?.workQueue).toHaveLength(
    beforeWhitespaceQueue,
  )

  const unknown = await server.request(
    "/v1/environments/env_missing_json_boundary/work",
    {
      body: "{",
      headers: { "content-type": "application/json", ...bearer(GATEWAY_KEY) },
      method: "POST",
    },
  )
  expect(unknown.status).toBe(404)
})
