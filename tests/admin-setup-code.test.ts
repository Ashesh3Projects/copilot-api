/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejects assertions require awaiting despite their typings. */
import { afterEach, beforeEach, expect, test } from "bun:test"

import * as auth from "../src/lib/admin-auth"
import { resolveCredential } from "../src/lib/credential-resolver"
import { getStorageRuntime } from "../src/lib/storage/runtime"
import { createAuthStorageFixture } from "./helpers/auth-storage"
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
beforeEach(async () => {
  fixture = await createAuthStorageFixture()
})
afterEach(async () => {
  auth.setAdminAuthClockForTest()
  await fixture.close()
})

test("setup requires an owner-issued code and atomically creates one administrator", async () => {
  expect("issueAdminSetupCode" in auth).toBe(true)
  const { code } = await auth.issueAdminSetupCode()
  const results = await Promise.all([
    auth.setupAdminAuth("first-gateway", "first-password", code),
    auth.setupAdminAuth("second-gateway", "second-password", code),
  ])
  expect(results.filter((value) => "session" in value)).toHaveLength(1)
  const counts = await getStorageRuntime().storage.read((session) =>
    session.query({
      sql: "SELECT (SELECT count(*) FROM capi_admin) AS admins, (SELECT count(*) FROM capi_gateway_credentials) AS gateways, (SELECT count(*) FROM capi_admin_sessions) AS sessions",
      args: [],
    }),
  )
  expect(counts[0]).toEqual({ admins: 1, gateways: 1, sessions: 1 })
})

test("reissuing a 32-byte setup code invalidates the previous code and expiry survives restart", async () => {
  const testClock = { current: Date.now() }
  auth.setAdminAuthClockForTest({ now: () => testClock.current })
  const first = await auth.issueAdminSetupCode()
  const second = await auth.issueAdminSetupCode()
  expect(Buffer.from(first.code, "base64url").byteLength).toBe(32)
  expect(second.expiresAt - testClock.current).toBe(15 * 60 * 1000)
  expect(await resolveCredential(second.code)).toBeNull()
  expect(
    await auth.setupAdminAuth(second.code, "password", second.code),
  ).toEqual({ error: "Authentication failed" })
  expect(await auth.setupAdminAuth("key", "password", first.code)).toEqual({
    error: "Authentication failed",
  })
  await fixture.restart()
  // eslint-disable-next-line require-atomic-updates -- the fixture clock is local to this serial test
  testClock.current = second.expiresAt
  expect(await auth.setupAdminAuth("key", "password", second.code)).toEqual({
    error: "Authentication failed",
  })
})

test("setup transaction failure rolls back code consumption, administrator, gateway and session", async () => {
  const { code } = await auth.issueAdminSetupCode()
  fixture.failWrites()
  await expect(
    auth.setupAdminAuth("key", "password", code),
  ).rejects.toMatchObject({ code: "storage_unavailable" })
  fixture.failWrites(false)
  expect(await auth.getAdminAuthStatus()).toEqual({
    configured: false,
    gatewayConfigured: false,
    passwordManagedExternally: false,
  })
  expect(await auth.setupAdminAuth("key", "password", code)).toHaveProperty(
    "session",
  )
  expect(await auth.setupAdminAuth("second", "password", code)).toHaveProperty(
    "error",
  )
})
