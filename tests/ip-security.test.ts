/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async matchers have void types but must be awaited. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

import type { Storage } from "~/lib/storage/types"

import { apiKeyGuard } from "~/lib/api-key-guard"
import {
  listIpAllowlist,
  upsertIpAllowlistEntry,
  promoteAuthenticatedIpAllowlistEntry,
  isManagedIpAllowed,
  isManagedIpAllowedForTransparentProxy,
  removeIpAllowlistEntry,
  clearIpAllowlist,
  normalizeIpAddress,
  resetIpAllowlistForTest,
  setIpAllowlistForTest,
} from "~/lib/ip-allowlist"
import {
  extractClientIp,
  isIpBlocked,
  isIpAllowedForTransparentProxy,
  isIpAllowedForTranscription,
  isIpAllowedForWhitelistedRoute,
  isIpWhitelisted,
  leaseIp,
  clearIpSecurityPolicy,
  recordFailedAttempt,
  removeIpSecurityPolicy,
  resetIpSecurityForTest,
  setIpSecurityPolicyEnabled,
  trustAuthenticatedIp,
  unwhitelistIp,
} from "~/lib/ip-blocker"
import { createAuthMiddleware } from "~/lib/request-auth"
import { credentialDigest } from "~/lib/storage/credentials-repository"
import { withSettingsActor } from "~/lib/storage/domain-settings"
import { StorageUnavailableError } from "~/lib/storage/errors"
import { getStoreRevision } from "~/lib/storage/operations"
import {
  closeStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"

import { createAuthStorageFixture } from "./helpers/auth-storage"

const originalTrustedProxies = process.env.COPILOT_TRUSTED_PROXY_CIDRS
const originalDateNow = Date.now
let authFixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
const DAY_MS = 24 * 60 * 60 * 1000
let currentTime = 0

beforeEach(async () => {
  authFixture = await createAuthStorageFixture()
  await authFixture.storage.transaction((session) =>
    session.execute({
      sql: "INSERT INTO capi_gateway_credentials (id,digest,label,created_at) VALUES (?,?,?,?)",
      args: [
        randomUUID(),
        credentialDigest("gateway-secret"),
        "Test gateway",
        Date.now(),
      ],
    }),
  )
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
})

function setCurrentTime(timestamp: number): void {
  currentTime = timestamp
  Date.now = () => currentTime
}

function createIpApp(): Hono {
  const app = new Hono()
  app.get("/", (c) => c.json({ ip: extractClientIp(c) }))
  return app
}

afterEach(async () => {
  Date.now = originalDateNow
  if (originalTrustedProxies === undefined) {
    delete process.env.COPILOT_TRUSTED_PROXY_CIDRS
  } else {
    process.env.COPILOT_TRUSTED_PROXY_CIDRS = originalTrustedProxies
  }
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
  await authFixture.close()
})

test("fails closed without Bun socket-peer metadata", async () => {
  const response = await createIpApp().request("http://localhost/", {
    headers: {
      "x-real-ip": "198.51.100.10",
      "x-forwarded-for": "198.51.100.11",
    },
  })
  expect(await response.json()).toEqual({ ip: null })
})

test("ignores spoofed forwarding headers from an untrusted socket peer", async () => {
  process.env.COPILOT_TRUSTED_PROXY_CIDRS = "127.0.0.1/32"
  const response = await createIpApp().request("http://localhost/", {
    headers: {
      "x-copilot-peer-ip": "203.0.113.9",
      "x-real-ip": "198.51.100.10",
      "x-forwarded-for": "198.51.100.11",
    },
  })
  expect(await response.json()).toEqual({ ip: "203.0.113.9" })
})

test("accepts forwarding metadata only from exact configured proxy CIDRs", async () => {
  process.env.COPILOT_TRUSTED_PROXY_CIDRS = "10.10.0.0/16,2001:db8::/32"
  const app = createIpApp()
  const ipv4 = await app.request("http://localhost/", {
    headers: {
      "x-copilot-peer-ip": "10.10.4.5",
      "x-real-ip": "198.51.100.10",
      "x-forwarded-for": "198.51.100.11, 10.10.4.5",
    },
  })
  expect(await ipv4.json()).toEqual({ ip: "198.51.100.10" })

  const ipv6 = await app.request("http://localhost/", {
    headers: {
      "x-copilot-peer-ip": "2001:db8::5",
      "x-forwarded-for": "2001:db9::42",
    },
  })
  expect(await ipv6.json()).toEqual({ ip: "2001:db9::42" })
})

test("normalizes addresses and gives disabled managed entries precedence", async () => {
  expect(normalizeIpAddress("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1")
  expect(normalizeIpAddress("::ffff:192.0.2.1")).toBe("192.0.2.1")
  expect(normalizeIpAddress("not-an-ip")).toBeNull()

  setIpAllowlistForTest([{ ip: "2001:db8::1", enabled: false }])
  expect(leaseIp("2001:0db8::1", 60_000)).toBe(true)
  expect(await isIpAllowedForWhitelistedRoute("2001:db8::1")).toBe(false)
})

test("authenticated durable entries authorize transcription but no other credential-free IP gate", async () => {
  const ip = "198.51.100.41"
  setIpAllowlistForTest([{ ip, enabled: true, source: "authenticated" }])

  expect(await isIpAllowedForTranscription(ip)).toBe(true)
  expect(await isIpAllowedForWhitelistedRoute(ip)).toBe(false)
})

test("temporary leases expire and do not create persistent allowlist entries", async () => {
  setIpAllowlistForTest([])
  expect(leaseIp("198.51.100.40", 50)).toBe(true)
  expect(await isIpAllowedForWhitelistedRoute("198.51.100.40")).toBe(true)
  await Bun.sleep(75)
  expect(await isIpAllowedForWhitelistedRoute("198.51.100.40")).toBe(false)
})

test("bans an IP after its third failure inside a rolling 24-hour window", () => {
  const ip = "198.51.100.50"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  expect(recordFailedAttempt(ip)).toBe(1)
  currentTime += 12 * 60 * 60 * 1000
  expect(recordFailedAttempt(ip)).toBe(2)
  currentTime += 11 * 60 * 60 * 1000
  expect(recordFailedAttempt(ip)).toBe(3)

  expect(isIpBlocked(ip)).toBe(true)
})

test("keeps a ban active until exactly 24 hours after the third failure", () => {
  const ip = "198.51.100.51"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)

  currentTime += DAY_MS - 1
  expect(isIpBlocked(ip)).toBe(true)
  currentTime += 1
  expect(isIpBlocked(ip)).toBe(false)
})

test("prunes failures that are at least 24 hours old", () => {
  const ip = "198.51.100.52"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  expect(recordFailedAttempt(ip)).toBe(1)
  expect(recordFailedAttempt(ip)).toBe(2)
  currentTime += DAY_MS

  expect(recordFailedAttempt(ip)).toBe(1)
  expect(isIpBlocked(ip)).toBe(false)
})

test("leases bypass a ban without clearing its failure history", () => {
  const ip = "198.51.100.53"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(true)

  expect(leaseIp(ip, 60_000)).toBe(true)
  expect(isIpBlocked(ip)).toBe(false)

  expect(unwhitelistIp(ip)).toBe(true)
  expect(isIpBlocked(ip)).toBe(true)
})

test("does not extend an active ban after a fourth failure", () => {
  const ip = "198.51.100.54"
  setCurrentTime(Date.UTC(2026, 0, 1, 12))

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)

  currentTime += 12 * 60 * 60 * 1000
  recordFailedAttempt(ip)

  currentTime += 12 * 60 * 60 * 1000 - 1
  expect(isIpBlocked(ip)).toBe(true)
  currentTime += 1
  expect(isIpBlocked(ip)).toBe(false)
})

test("route-permitted allowlist bypass does not record a failure", async () => {
  const ip = "198.51.100.55"
  setIpAllowlistForTest([{ ip, enabled: true }])
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)

  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.all("*", (c) => c.json({ ok: true }))

  const response = await app.request(
    "https://api.anthropic.com/upstream/path",
    {
      headers: {
        host: "api.anthropic.com",
        "x-copilot-peer-ip": ip,
      },
    },
  )
  expect(response.status).toBe(200)

  setIpAllowlistForTest([])
  expect(isIpBlocked(ip)).toBe(false)
})

test("credential-free transparent proxy allowlists bypass bans without clearing history", async () => {
  const managedIp = "198.51.100.57"
  const leasedIp = "198.51.100.58"

  for (const ip of [managedIp, leasedIp]) {
    recordFailedAttempt(ip)
    recordFailedAttempt(ip)
    recordFailedAttempt(ip)
  }
  setIpAllowlistForTest([{ ip: managedIp, enabled: true }])
  leaseIp(leasedIp, 60_000)

  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.all("*", (c) => c.json({ ok: true }))

  for (const ip of [managedIp, leasedIp]) {
    const response = await app.request(
      "https://api.anthropic.com/upstream/path",
      {
        headers: {
          host: "api.anthropic.com",
          "x-copilot-peer-ip": ip,
        },
      },
    )
    expect(response.status).toBe(200)
  }

  setIpAllowlistForTest([])
  expect(unwhitelistIp(leasedIp)).toBe(true)
  expect(isIpBlocked(managedIp)).toBe(true)
  expect(isIpBlocked(leasedIp)).toBe(true)
})

test("global API-key guard accepts a valid credential from an actively leased banned IP", async () => {
  const ip = "198.51.100.60"
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  leaseIp(ip, 60_000)

  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))

  const response = await app.request("http://localhost/protected", {
    headers: {
      "x-api-key": "gateway-secret",
      "x-copilot-peer-ip": ip,
    },
  })

  expect(response.status).toBe(200)
})

test("global API-key guard records missing credentials from an actively leased banned IP", async () => {
  const ip = "198.51.100.61"
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  leaseIp(ip, 60_000)
  expect(isIpBlocked(ip)).toBe(false)

  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))

  const response = await app.request("http://localhost/protected", {
    headers: { "x-copilot-peer-ip": ip },
  })

  expect(response.status).toBe(401)
  expect(recordFailedAttempt(ip)).toBe(5)
})

test("a valid gateway credential permanently exempts its normalized client IP from ban counting", async () => {
  const ip = "2001:0db8:0:0:0:0:0:70"

  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))

  const valid = await app.request("http://localhost/protected", {
    headers: { "x-api-key": "gateway-secret", "x-copilot-peer-ip": ip },
  })
  expect(valid.status).toBe(200)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const invalid = await app.request("http://localhost/protected", {
      headers: { "x-api-key": "wrong-key", "x-copilot-peer-ip": ip },
    })
    expect(invalid.status).toBe(401)
  }

  expect(isIpBlocked("2001:db8::70")).toBe(false)
  expect(await listIpAllowlist()).toMatchObject([
    { ip: "2001:db8::70", enabled: true, source: "authenticated" },
  ])
  expect((await listIpAllowlist())[0]?.lastSeenAt).toBeDefined()
})

test("a valid gateway credential recovers an IP already banned by failed attempts", async () => {
  const ip = "198.51.100.71"
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(true)

  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))
  const response = await app.request("http://localhost/protected", {
    headers: { "x-api-key": "gateway-secret", "x-copilot-peer-ip": ip },
  })

  expect(response.status).toBe(200)
  expect(isIpBlocked(ip)).toBe(false)
})

test("authenticated trust is limited to the client IP that proved the credential", async () => {
  const trustedIp = "198.51.100.72"
  const untrustedIp = "198.51.100.73"
  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))

  expect(
    (
      await app.request("http://localhost/protected", {
        headers: {
          "x-api-key": "gateway-secret",
          "x-copilot-peer-ip": trustedIp,
        },
      })
    ).status,
  ).toBe(200)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(
      (
        await app.request("http://localhost/protected", {
          headers: {
            "x-api-key": "wrong-key",
            "x-copilot-peer-ip": untrustedIp,
          },
        })
      ).status,
    ).toBe(401)
  }
  expect(isIpBlocked(untrustedIp)).toBe(true)
  expect(isIpBlocked(trustedIp)).toBe(false)
})

test("successful gateway authentication re-enables an operator IP without replacing its source", async () => {
  const ip = "198.51.100.74"
  setIpAllowlistForTest([{ ip, enabled: false, source: "manual" }])
  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))

  expect(
    (
      await app.request("http://localhost/protected", {
        headers: { "x-api-key": "gateway-secret", "x-copilot-peer-ip": ip },
      })
    ).status,
  ).toBe(200)
  expect(await listIpAllowlist()).toMatchObject([
    { ip, enabled: true, source: "manual" },
  ])
  expect(await isIpAllowedForTransparentProxy(ip)).toBe(true)
})

test("authenticated promotion preserves a dashboard-created source", async () => {
  const ip = "198.51.100.75"
  setIpAllowlistForTest([{ ip, enabled: false, source: "dashboard" }])

  expect(await trustAuthenticatedIp(ip)).toBe(true)
  expect(await listIpAllowlist()).toMatchObject([
    { ip, enabled: true, source: "dashboard" },
  ])
  expect(await isIpAllowedForTransparentProxy(ip)).toBe(true)
})

test("concurrent authenticated allowlist promotions retain every IP", async () => {
  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))
  const ips = ["198.51.100.75", "198.51.100.76", "198.51.100.77"]

  const responses = await Promise.all(
    ips.map(
      async (ip) =>
        await app.request("http://localhost/protected", {
          headers: { "x-api-key": "gateway-secret", "x-copilot-peer-ip": ip },
        }),
    ),
  )

  expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
  expect((await listIpAllowlist()).map((entry) => entry.ip)).toEqual(ips)
})

test("repeated authentication of an already trusted IP does not rewrite its durable entry", async () => {
  const ip = "198.51.100.78"
  setIpAllowlistForTest([])

  expect(await trustAuthenticatedIp(ip)).toBe(true)
  const first = await listIpAllowlist()
  await Bun.sleep(5)
  expect(await trustAuthenticatedIp(ip)).toBe(true)
  const second = await listIpAllowlist()

  expect(second).toEqual(first)
})

test("an untrusted peer cannot promote its spoofed forwarded client IP", async () => {
  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.get("/protected", (c) => c.json({ ok: true }))

  expect(
    (
      await app.request("http://localhost/protected", {
        headers: {
          "x-api-key": "gateway-secret",
          "x-copilot-peer-ip": "203.0.113.78",
          "x-forwarded-for": "198.51.100.78",
        },
      })
    ).status,
  ).toBe(200)
  expect(await listIpAllowlist()).toMatchObject([
    { ip: "203.0.113.78", source: "authenticated" },
  ])
})

async function withPolicyDatabase(
  work: (storage: Storage, databasePath: string) => Promise<void>,
): Promise<void> {
  const directory = resolve(
    ".superpowers/test-data",
    `ip-policy-${randomUUID()}`,
  )
  await mkdir(directory, { recursive: true })
  await closeStorageRuntime()
  const databasePath = resolve(directory, "copilot-api.sqlite")
  const runtime = await initializeStorageRuntime({
    config: { kind: "sqlite", path: databasePath },
  })
  resetIpAllowlistForTest()
  try {
    await withSettingsActor("admin:ip-policy-test", () =>
      work(runtime.storage, databasePath),
    )
  } finally {
    await closeStorageRuntime()
    setIpAllowlistForTest([])
    await rm(directory, { recursive: true, force: true })
  }
}

test("database IP policies normalize and persist across reopen with source-specific access", async () => {
  await withPolicyDatabase(async (storage, databasePath) => {
    const entry = await upsertIpAllowlistEntry("[2001:0DB8::1]", {
      source: "dashboard",
      seen: true,
    })
    if (!entry) throw new Error("Expected normalized IP entry")
    expect(entry).toMatchObject({
      ip: "2001:db8::1",
      source: "dashboard",
      enabled: true,
    })
    const rows = await storage.read((session) =>
      session.query({ sql: "SELECT * FROM capi_ip_allowlist", args: [] }),
    )
    expect(rows[0]?.created_at).toBe(Date.parse(entry.createdAt))
    await closeStorageRuntime()
    await initializeStorageRuntime({
      config: { kind: "sqlite", path: databasePath },
    })
    expect(await listIpAllowlist()).toEqual([entry])
    expect(await isManagedIpAllowedForTransparentProxy("2001:db8::1")).toBe(
      true,
    )
    await promoteAuthenticatedIpAllowlistEntry("198.51.100.55")
    expect(await isManagedIpAllowed("198.51.100.55")).toBe(true)
    expect(await isManagedIpAllowedForTransparentProxy("198.51.100.55")).toBe(
      false,
    )
  })
})

test("database IP authorization observes external disable and removal immediately", async () => {
  await withPolicyDatabase(async (storage) => {
    await upsertIpAllowlistEntry("198.51.100.56")
    expect(await isManagedIpAllowed("198.51.100.56")).toBe(true)
    await storage.transaction((session) =>
      session.execute({
        sql: "UPDATE capi_ip_allowlist SET enabled = 0 WHERE ip = ?",
        args: ["198.51.100.56"],
      }),
    )
    expect(await isManagedIpAllowed("198.51.100.56")).toBe(false)
    await removeIpAllowlistEntry("198.51.100.56")
    expect(await listIpAllowlist()).toEqual([])
  })
})

test("database failed IP mutations leave durable policy and revision unchanged", async () => {
  await withPolicyDatabase(async (storage) => {
    const entry = await upsertIpAllowlistEntry("198.51.100.57", {
      source: "manual",
    })
    if (!entry) throw new Error("Expected durable IP entry")
    const revision = await getStoreRevision(storage)
    const transaction = spyOn(storage, "transaction").mockRejectedValue(
      new StorageUnavailableError(),
    )
    try {
      await expect(
        upsertIpAllowlistEntry("198.51.100.57", { enabled: false }),
      ).rejects.toBeInstanceOf(StorageUnavailableError)
      await expect(clearIpAllowlist()).rejects.toBeInstanceOf(
        StorageUnavailableError,
      )
      await expect(
        removeIpAllowlistEntry("198.51.100.57"),
      ).rejects.toBeInstanceOf(StorageUnavailableError)
    } finally {
      transaction.mockRestore()
    }
    expect(await listIpAllowlist()).toEqual([entry])
    expect(await getStoreRevision(storage)).toBe(revision)
  })
})

test("database failed authenticated persistence retries and retains volatile trust", async () => {
  await withPolicyDatabase(async (storage) => {
    const ip = "198.51.100.58"
    const transaction = spyOn(storage, "transaction").mockRejectedValueOnce(
      new StorageUnavailableError(),
    )
    expect(await trustAuthenticatedIp(ip)).toBe(true)
    transaction.mockRestore()
    expect(await listIpAllowlist()).toEqual([])
    expect(isIpBlocked(ip)).toBe(false)
    expect(await trustAuthenticatedIp(ip)).toBe(true)
    const entry = (await listIpAllowlist())[0]
    expect(entry).toMatchObject({ ip, source: "authenticated", enabled: true })
    const revision = await getStoreRevision(storage)
    await trustAuthenticatedIp(ip)
    expect((await listIpAllowlist())[0]).toEqual(entry)
    expect(await getStoreRevision(storage)).toBe(revision)
  })
})

test("operator removal succeeds for a volatile-only lease", async () => {
  const ip = "198.51.100.86"
  expect(leaseIp(ip, 60_000)).toBe(true)

  expect(await removeIpSecurityPolicy(ip)).toBe(true)
  expect(isIpWhitelisted(ip)).toBe(false)
})

test("operator removal ordered after authentication removes durable and volatile trust", async () => {
  const ip = "198.51.100.80"
  setIpAllowlistForTest([])

  const promotion = trustAuthenticatedIp(ip)
  const removal = removeIpSecurityPolicy(ip)
  expect(await promotion).toBe(true)
  expect(await removal).toBe(true)

  expect(await listIpAllowlist()).toEqual([])
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(true)
})

test("authentication ordered after operator removal creates newer durable and volatile trust", async () => {
  const ip = "198.51.100.81"
  setIpAllowlistForTest([{ ip, enabled: true, source: "authenticated" }])

  const removal = removeIpSecurityPolicy(ip)
  const promotion = trustAuthenticatedIp(ip)
  expect(await removal).toBe(true)
  expect(await promotion).toBe(true)

  expect(await listIpAllowlist()).toMatchObject([
    { ip, enabled: true, source: "authenticated" },
  ])
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(false)
})

test("operator clear and authentication obey call order across durable and volatile state", async () => {
  const clearedIp = "198.51.100.82"
  const newerIp = "198.51.100.83"
  setIpAllowlistForTest([])

  const oldPromotion = trustAuthenticatedIp(clearedIp)
  const clear = clearIpSecurityPolicy()
  const newPromotion = trustAuthenticatedIp(newerIp)
  expect(await oldPromotion).toBe(true)
  expect(await clear).toBe(1)
  expect(await newPromotion).toBe(true)

  expect(await listIpAllowlist()).toMatchObject([
    { ip: newerIp, enabled: true, source: "authenticated" },
  ])
  recordFailedAttempt(clearedIp)
  recordFailedAttempt(clearedIp)
  recordFailedAttempt(clearedIp)
  expect(isIpBlocked(clearedIp)).toBe(true)
  recordFailedAttempt(newerIp)
  recordFailedAttempt(newerIp)
  recordFailedAttempt(newerIp)
  expect(isIpBlocked(newerIp)).toBe(false)
})

test("authenticated trust queued before disable ends disabled and revocable", async () => {
  const ip = "198.51.100.87"

  const trust = trustAuthenticatedIp(ip)
  const disable = setIpSecurityPolicyEnabled(ip, false)
  expect(await trust).toBe(true)
  expect(await disable).toMatchObject({ ip, enabled: false })
  expect(await isIpAllowedForTranscription(ip)).toBe(false)

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(true)
})

test("disable queued before authenticated trust ends enabled and exempt", async () => {
  const ip = "198.51.100.88"
  setIpAllowlistForTest([{ ip, enabled: true, source: "manual" }])

  const disable = setIpSecurityPolicyEnabled(ip, false)
  const trust = trustAuthenticatedIp(ip)
  expect(await disable).toMatchObject({
    ip,
    enabled: false,
    source: "manual",
  })
  expect(await trust).toBe(true)
  expect(await isIpAllowedForTranscription(ip)).toBe(true)

  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  expect(isIpBlocked(ip)).toBe(false)
})

test("invalid supplied credential cannot use transparent-proxy allowlist", async () => {
  const ip = "198.51.100.59"
  setIpAllowlistForTest([{ ip, enabled: true }])

  const app = new Hono()
  app.use("*", apiKeyGuard)
  app.all("*", (c) => c.json({ ok: true }))

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app.request(
      "https://api.anthropic.com/upstream/path",
      {
        headers: {
          host: "api.anthropic.com",
          "x-copilot-gateway-key": "wrong-key",
          "x-copilot-peer-ip": ip,
        },
      },
    )
    expect(response.status).toBe(401)
  }

  setIpAllowlistForTest([])
  expect(isIpBlocked(ip)).toBe(true)
})

test("config-based global auth records failed credentials", async () => {
  const ip = "198.51.100.56"
  const app = new Hono()
  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => ["config-secret"],
      allowUnauthenticatedPaths: [],
    }),
  )
  app.get("/protected", (c) => c.json({ ok: true }))

  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(
      (
        await app.request("http://localhost/protected", {
          headers: {
            "x-api-key": "wrong-key",
            "x-copilot-peer-ip": ip,
          },
        })
      ).status,
    ).toBe(401)
  }
  expect(isIpBlocked(ip)).toBe(true)
  expect(
    (
      await app.request("http://localhost/protected", {
        headers: {
          "x-api-key": "config-secret",
          "x-copilot-peer-ip": ip,
        },
      })
    ).status,
  ).toBe(200)
  expect(isIpBlocked(ip)).toBe(false)
})
