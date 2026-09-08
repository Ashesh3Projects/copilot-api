import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import { StorageUnavailableError } from "~/lib/storage/errors"
import { getStorageRuntime } from "~/lib/storage/runtime"

import { apiKeyGuard } from "../src/lib/api-key-guard"
import {
  resetIpAllowlistForTest,
  setIpAllowlistForTest,
} from "../src/lib/ip-allowlist"
import {
  isIpAllowedForTranscription,
  isIpBlocked,
  isIpWhitelisted,
  leaseIp,
  recordFailedAttempt,
  resetIpSecurityForTest,
  trustAuthenticatedIp,
} from "../src/lib/ip-blocker"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import { server } from "../src/server"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  TEST_GATEWAY_KEY,
  type TestAdminSession,
} from "./helpers/admin-session"

let admin: TestAdminSession

beforeEach(async () => {
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
  admin = await createTestAdminSession()
})

afterEach(async () => {
  resetIpSecurityForTest()
  await resetTestAdminSession()
})

test("dashboard reports the safely extracted current client IP", async () => {
  const response = await server.request("/dashboard/api/ip-allowlist/current", {
    headers: {
      ...adminHeaders(admin, false),
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": "198.51.100.81",
    },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ip: "198.51.100.81" })
})

test("dashboard collection clear requires CSRF and removes every allowlist entry", async () => {
  setIpAllowlistForTest([
    { ip: "198.51.100.82", enabled: true },
    { ip: "198.51.100.83", enabled: true },
  ])

  const rejected = await server.request("/dashboard/api/ip-allowlist", {
    method: "DELETE",
    headers: adminHeaders(admin, false),
  })
  expect(rejected.status).toBe(401)

  const cleared = await server.request("/dashboard/api/ip-allowlist", {
    method: "DELETE",
    headers: adminHeaders(admin),
  })
  expect(cleared.status).toBe(200)
  expect(await cleared.json()).toEqual({ success: true, cleared: 2 })

  const list = await server.request("/dashboard/api/ip-allowlist", {
    headers: adminHeaders(admin, false),
  })
  expect(await list.json()).toEqual([])
})

test("dashboard collection clear revokes volatile leases without durable rows", async () => {
  const leasedIp = "198.51.100.85"
  expect(leaseIp(leasedIp, 60_000)).toBe(true)
  expect(isIpWhitelisted(leasedIp)).toBe(true)

  const cleared = await server.request("/dashboard/api/ip-allowlist", {
    method: "DELETE",
    headers: adminHeaders(admin),
  })

  expect(cleared.status).toBe(200)
  expect(await cleared.json()).toEqual({ success: true, cleared: 0 })
  expect(isIpWhitelisted(leasedIp)).toBe(false)
})

test("trust ordered before disable leaves the IP disabled and revokes authenticated exemption", async () => {
  const ip = "198.51.100.88"

  expect(await trustAuthenticatedIp(ip)).toBe(true)
  const disable = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`,
    {
      method: "PATCH",
      headers: adminHeaders(admin),
      body: JSON.stringify({ enabled: false }),
    },
  )
  expect(disable.status).toBe(200)
  expect(await disable.json()).toMatchObject({ ip, enabled: false })
  expect(await isIpAllowedForTranscription(ip)).toBe(false)

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(true)
})

test("disable ordered before later valid auth re-enables and trusts the IP", async () => {
  const ip = "198.51.100.89"
  setIpAllowlistForTest([{ ip, enabled: true, source: "manual" }])

  const disable = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`,
    {
      method: "PATCH",
      headers: adminHeaders(admin),
      body: JSON.stringify({ enabled: false }),
    },
  )
  expect(await disable.json()).toMatchObject({
    ip,
    enabled: false,
    source: "manual",
  })
  expect(await trustAuthenticatedIp(ip)).toBe(true)
  expect(await isIpAllowedForTranscription(ip)).toBe(true)

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(false)
})

test("manual enable preserves source without inventing authenticated exemption", async () => {
  const ip = "198.51.100.90"
  setIpAllowlistForTest([{ ip, enabled: false, source: "dashboard" }])

  const enable = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`,
    {
      method: "PATCH",
      headers: adminHeaders(admin),
      body: JSON.stringify({ enabled: true }),
    },
  )
  expect(await enable.json()).toMatchObject({
    ip,
    enabled: true,
    source: "dashboard",
  })
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(true)
})

test("dashboard removal revokes authenticated trust so later failures can ban the IP", async () => {
  const ip = "198.51.100.84"
  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))

  expect(
    (
      await app.request("http://localhost/protected", {
        headers: { "x-api-key": TEST_GATEWAY_KEY, "x-copilot-peer-ip": ip },
      })
    ).status,
  ).toBe(200)

  const remove = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`,
    { method: "DELETE", headers: adminHeaders(admin) },
  )
  expect(remove.status).toBe(200)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(
      (
        await app.request("http://localhost/protected", {
          headers: { "x-api-key": "wrong-key", "x-copilot-peer-ip": ip },
        })
      ).status,
    ).toBe(401)
  }
  expect(isIpBlocked(ip)).toBe(true)
})

test("dashboard removal succeeds for a volatile-only lease", async () => {
  const ip = "198.51.100.87"
  expect(leaseIp(ip, 60_000)).toBe(true)

  const remove = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`,
    { method: "DELETE", headers: adminHeaders(admin) },
  )

  expect(remove.status).toBe(200)
  expect(await remove.json()).toEqual({ success: true })
  expect(isIpWhitelisted(ip)).toBe(false)
})

test("dashboard removal keeps volatile trust revoked when durable loading fails", async () => {
  const ip = "198.51.100.86"
  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))
  expect(
    (
      await app.request("http://localhost/protected", {
        headers: { "x-api-key": TEST_GATEWAY_KEY, "x-copilot-peer-ip": ip },
      })
    ).status,
  ).toBe(200)

  resetIpAllowlistForTest()
  const transaction = spyOn(
    getStorageRuntime().storage,
    "transaction",
  ).mockRejectedValue(new StorageUnavailableError())
  try {
    const remove = await server.request(
      `/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`,
      { method: "DELETE", headers: adminHeaders(admin) },
    )
    expect(remove.status).toBe(503)
  } finally {
    transaction.mockRestore()
  }

  setIpAllowlistForTest([])
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await app.request("http://localhost/protected", {
      headers: { "x-api-key": "wrong-key", "x-copilot-peer-ip": ip },
    })
  }
  expect(isIpBlocked(ip)).toBe(true)
})

test("dashboard login does not automatically trust the observed IP", async () => {
  const overviewResponse = await server.request("/dashboard/api/overview", {
    headers: {
      cookie: admin.cookie,
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": "198.51.100.20",
    },
  })
  expect(overviewResponse.status).toBe(200)

  const response = await server.request("/dashboard/api/ip-allowlist", {
    headers: adminHeaders(admin, false),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual([])
})

test("dashboard can add, disable, enable, and remove IPv6 allowlist entries", async () => {
  const ipv6 = "2406:7400:63:c69b:78ad:65b1:41f5:ccce"

  const addResponse = await server.request("/dashboard/api/ip-allowlist", {
    method: "POST",
    headers: adminHeaders(admin),
    body: JSON.stringify({ ip: ipv6 }),
  })
  expect(addResponse.status).toBe(200)

  const disableResponse = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ipv6)}`,
    {
      method: "PATCH",
      headers: adminHeaders(admin),
      body: JSON.stringify({ enabled: false }),
    },
  )
  expect(disableResponse.status).toBe(200)
  expect(await disableResponse.json()).toMatchObject({ enabled: false })

  const enableResponse = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ipv6)}`,
    {
      method: "PATCH",
      headers: adminHeaders(admin),
      body: JSON.stringify({ enabled: true }),
    },
  )
  expect(enableResponse.status).toBe(200)
  expect(await enableResponse.json()).toMatchObject({ enabled: true })

  const deleteResponse = await server.request(
    `/dashboard/api/ip-allowlist/${encodeURIComponent(ipv6)}`,
    { method: "DELETE", headers: adminHeaders(admin) },
  )
  expect(deleteResponse.status).toBe(200)
})

test("dashboard bundle ships manual IP allowlist controls only", () => {
  expect(DASHBOARD_HTML).toContain("IP Allowlist")
  expect(DASHBOARD_HTML).not.toContain("api4.ipify.org")
  expect(DASHBOARD_HTML).not.toContain("api6.ipify.org")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/ip-allowlist")
})
