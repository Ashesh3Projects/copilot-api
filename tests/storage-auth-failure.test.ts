import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"

import { apiKeyGuard } from "../src/lib/api-key-guard"
import { resolveCredential } from "../src/lib/credential-resolver"
import { forwardError } from "../src/lib/error"
import { isIpBlocked, resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { createAuthMiddleware } from "../src/lib/request-auth"
import { state } from "../src/lib/state"
import { createAuthStorageFixture } from "./helpers/auth-storage"

let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  resetIpSecurityForTest()
})
afterEach(async () => {
  state.apiKeyAuth = undefined
  resetIpSecurityForTest()
  await fixture.close()
})

test("initialized database ignores legacy gateway authority", async () => {
  state.apiKeyAuth = "legacy-environment-key"
  expect(await resolveCredential("legacy-environment-key")).toBeNull()
})

test("an empty database does not open inference anonymously", async () => {
  const app = new Hono()
    .use("*", createAuthMiddleware())
    .get("/models", (c) => c.json({ ok: true }))
  expect((await app.request("/models")).status).toBe(401)
})

test("inference guard database failures produce no-store 503 without IP strikes", async () => {
  const app = new Hono()
    .onError((error, c) => forwardError(c, error))
    .use("*", apiKeyGuard)
    .get("/models", (c) => c.json({ ok: true }))
  fixture.failReads()
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await app.request("/models", {
      headers: {
        authorization: "Bearer fixture-gateway",
        "x-copilot-peer-ip": "198.51.100.10",
      },
    })
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
  }
  expect(isIpBlocked("198.51.100.10")).toBe(false)
})
