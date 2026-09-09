import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  authenticateAdminRequest,
  issueAdminSetupCode,
  setupAdminAuth,
} from "~/lib/admin-auth"
import { withSettingsActor } from "~/lib/storage/domain-settings"
import { StorageUnavailableError } from "~/lib/storage/errors"
import { getStoreRevision } from "~/lib/storage/operations"
import {
  createProviderMutationContext,
  createProvidersRepository,
} from "~/lib/storage/providers-repository"
import { createDashboardProviderSecretRoutes } from "~/routes/dashboard/credentials"

import { createAuthStorageFixture } from "./helpers/auth-storage"

let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let app: Hono
let cookie: string
let csrf: string
const origin = "https://gateway.example.com"
const provider = {
  id: "fixture-provider",
  name: "Fixture",
  type: "openai-compatible" as const,
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-provider-api-key",
  headers: {
    "X-Custom": "fixture-custom-header",
    Authorization: "fixture-auth-header",
  },
  models: [{ id: "chat", kind: "chat" as const }],
}

beforeEach(async () => {
  process.env.COPILOT_ADMIN_ORIGIN = origin
  fixture = await createAuthStorageFixture()
  const setup = await setupAdminAuth(
    "fixture-gateway",
    "fixture-admin-password",
    (await issueAdminSetupCode()).code,
  )
  if (!("session" in setup)) throw new Error(setup.error)
  csrf = setup.session.csrfToken
  cookie = `${ADMIN_SESSION_COOKIE}=${setup.session.token}; ${ADMIN_CSRF_COOKIE}=${csrf}`
  app = new Hono()
  app.onError((error, c) => {
    if (!(error instanceof StorageUnavailableError)) throw error
    c.header("Cache-Control", "no-store")
    return c.json({ error: "Database storage is unavailable" }, 503)
  })
  app.use("*", async (c, next) => {
    const session = await authenticateAdminRequest(c.req.raw, {
      requireCsrf: c.req.method !== "GET",
    })
    if (!session) return c.json({ error: "Unauthorized" }, 401)
    return withSettingsActor(`admin:${session.tokenHash}`, next)
  })
  app.route("/custom-providers", createDashboardProviderSecretRoutes())
  await createProvidersRepository(fixture.storage).upsert(
    provider,
    await createProviderMutationContext(
      fixture.storage,
      "provider.upsert",
      provider,
      "admin:fixture",
    ),
  )
})

afterEach(async () => {
  await fixture.close()
  delete process.env.COPILOT_ADMIN_ORIGIN
})

function reveal(headers: Record<string, string> = {}, id = provider.id) {
  return app.request(`/custom-providers/${id}/reveal`, {
    method: "POST",
    headers: { cookie, origin, "x-copilot-csrf": csrf, ...headers },
  })
}

test("provider secrets require explicit authorized reveal and never enter lists or receipts", async () => {
  const revision = await getStoreRevision(fixture.storage)
  const response = await reveal()
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({
    id: provider.id,
    apiKey: provider.apiKey,
    headers: provider.headers,
    revision,
  })
  expect(await getStoreRevision(fixture.storage)).toBe(revision)
  const lists = JSON.stringify(
    await createProvidersRepository(fixture.storage).list(),
  )
  const receipts = JSON.stringify(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT result_json FROM capi_applied_operations",
        args: [],
      }),
    ),
  )
  for (const secret of [provider.apiKey, ...Object.values(provider.headers)]) {
    expect(lists).not.toContain(secret)
    expect(receipts).not.toContain(secret)
  }
})

test("provider reveal enforces session, CSRF, Origin and no-store error responses", async () => {
  const invalidHeaders: Array<Record<string, string>> = [
    { cookie: "" },
    { "x-copilot-csrf": "" },
    { "x-copilot-csrf": "wrong" },
    { origin: "https://untrusted.example" },
  ]
  for (const headers of invalidHeaders)
    expect((await reveal(headers)).status).toBe(401)
  const missing = await reveal({}, "missing")
  expect(missing.status).toBe(404)
  expect(missing.headers.get("cache-control")).toBe("no-store")
  fixture.failReads()
  const unavailable = await reveal()
  expect(unavailable.status).toBe(503)
  expect(await unavailable.text()).not.toContain(provider.apiKey)
})
