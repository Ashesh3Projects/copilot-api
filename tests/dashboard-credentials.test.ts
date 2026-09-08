import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import path from "node:path"

import type { Storage } from "~/lib/storage/types"

process.env.DATA_DIR = path.resolve(
  import.meta.dir,
  "../.superpowers/test-data/dashboard-credentials",
)
const { createAuthStorageFixture } = await import("./helpers/auth-storage")
const { createDashboardCredentialRoutes } = await import(
  "../src/routes/dashboard/credentials"
)
const { withSettingsActor } = await import("../src/lib/storage/domain-settings")
const { createProvidersRepository, createProviderMutationContext } =
  await import("../src/lib/storage/providers-repository")
const { createCredentialsRepository } = await import(
  "../src/lib/storage/credentials-repository"
)
const { getStoreRevision } = await import("../src/lib/storage/operations")
const {
  authenticateAdminRequest,
  issueAdminSetupCode,
  setupAdminAuth,
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
} = await import("../src/lib/admin-auth")
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let app: Hono
let cookie: string
let csrf: string
const origin = "https://gateway.example.com"
beforeEach(async () => {
  process.env.COPILOT_ADMIN_ORIGIN = origin
  fixture = await createAuthStorageFixture()
  const setup = await setupAdminAuth(
    "fixture-gateway",
    "fixture-password",
    (await issueAdminSetupCode()).code,
  )
  if (!("session" in setup)) throw new Error(setup.error)
  csrf = setup.session.csrfToken
  cookie = `${ADMIN_SESSION_COOKIE}=${setup.session.token}; ${ADMIN_CSRF_COOKIE}=${csrf}`
  app = new Hono()
  app.use("*", async (c, next) => {
    const session = await authenticateAdminRequest(c.req.raw, {
      requireCsrf: c.req.method !== "GET",
    })
    if (!session) return c.json({ error: "Unauthorized" }, 401)
    return withSettingsActor(`admin:${session.tokenHash}`, next)
  })
  app.route("/credentials", createDashboardCredentialRoutes())
})
afterEach(async () => {
  await fixture.close()
  delete process.env.COPILOT_ADMIN_ORIGIN
})
// eslint-disable-next-line max-params -- Test request fixture keeps HTTP method, payload and headers explicit.
function request(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/credentials${url}`, {
    method,
    headers: {
      cookie,
      origin,
      "x-copilot-csrf": csrf,
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test("gateway create shows a random credential once; metadata and markers never return it", async () => {
  const created = await request(
    "/gateway",
    "POST",
    { label: "Client" },
    { "Idempotency-Key": "gateway-test-create" },
  )
  expect(created.status).toBe(201)
  const value = (await created.json()) as { id: string; credential: string }
  expect(value.credential).toMatch(/^[\w-]{43}$/)
  const replay = await request(
    "/gateway",
    "POST",
    { label: "Client" },
    { "Idempotency-Key": "gateway-test-create" },
  )
  const replayed = (await replay.json()) as { id: string; credential?: string }
  expect(replayed.id).toBe(value.id)
  expect(replayed.credential).toBeUndefined()
  const listed = await (await request("/gateway")).text()
  expect(listed).not.toContain(value.credential)
  expect(listed).not.toContain("digest")
  const markers = await fixture.storage.read((session) =>
    session.query({
      sql: "SELECT result_json FROM capi_applied_operations",
      args: [],
    }),
  )
  expect(JSON.stringify(markers)).not.toContain(value.credential)
  expect((await request(`/gateway/${value.id}`, "DELETE")).status).toBe(200)
  const all = (await (await request("/gateway")).json()) as {
    credentials: Array<{ id: string; revokedAt: number | null }>
  }
  const remaining = all.credentials.find(
    (credential: { revokedAt: number | null }) => credential.revokedAt === null,
  )
  expect((await request(`/gateway/${remaining?.id}`, "DELETE")).status).toBe(
    409,
  )
})

test("credential routes require admin session and CSRF and reject stale revision", async () => {
  expect((await app.request("/credentials/gateway")).status).toBe(401)
  expect(
    (
      await request(
        "/gateway",
        "POST",
        { label: "Client" },
        { "x-copilot-csrf": "wrong" },
      )
    ).status,
  ).toBe(401)
  expect(
    (
      await request(
        "/gateway",
        "POST",
        { label: "Client" },
        { "If-Match": "0" },
      )
    ).status,
  ).toBe(409)
})

test("Groq status conceals secret and writes preserve blank fields", async () => {
  expect(
    (await request("/groq", "PUT", { apiKey: "fixture-groq-secret" })).status,
  ).toBe(200)
  expect((await request("/groq", "PUT", { apiKey: "" })).status).toBe(200)
  const status = (await (await request("/groq")).json()) as {
    apiKeyConfigured: boolean
  }
  expect(status.apiKeyConfigured).toBe(true)
  expect(JSON.stringify(status)).not.toContain("fixture-groq-secret")
  expect((await request("/groq", "PUT", { clearApiKey: true })).status).toBe(
    200,
  )
  expect(await (await request("/groq")).json()).toMatchObject({
    apiKeyConfigured: false,
  })
})

test("storage errors are unavailable, with sanitized response and retained credential", async () => {
  fixture.failWrites()
  const response = await request("/groq", "PUT", { apiKey: "private-unsaved" })
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain("private-unsaved")
  fixture.failWrites(false)
  expect(await (await request("/groq")).json()).toMatchObject({
    apiKeyConfigured: false,
  })
})

function commitAfterRead(
  match: string,
  commit: () => Promise<unknown>,
): () => void {
  const original = fixture.storage.read.bind(fixture.storage)
  let injected = false
  const read: Storage["read"] = async (work) => {
    const state = { matched: false }
    const result = await original((session) =>
      work({
        execute: (statement) => session.execute(statement),
        query: (statement) => {
          if (statement.sql.includes(match)) state.matched = true
          return session.query(statement)
        },
      }),
    )
    if (state.matched && !injected) {
      injected = true
      await commit()
    }
    return result
  }
  fixture.storage.read = read
  return () => {
    fixture.storage.read = original
  }
}

test("Groq status and its If-Match revision describe one database snapshot", async () => {
  const before = await getStoreRevision(fixture.storage)
  const input = { apiKey: "unseen-key" }
  const mutation = await createProviderMutationContext(
    fixture.storage,
    "groq.update",
    input,
    "admin:concurrent",
  )
  const restore = commitAfterRead("FROM capi_service_secrets", () =>
    createProvidersRepository(fixture.storage).setGroqSecret(input, mutation),
  )
  let status: { apiKeyConfigured: boolean; revision: number }
  try {
    status = (await (await request("/groq")).json()) as typeof status
  } finally {
    restore()
  }
  expect(status.apiKeyConfigured).toBe(false)
  expect(status.revision).toBe(before)
  const cleared = await request(
    "/groq",
    "PUT",
    { clearApiKey: true },
    { "If-Match": String(status.revision) },
  )
  expect(cleared.status).toBe(409)
  expect(await (await request("/groq")).json()).toMatchObject({
    apiKeyConfigured: true,
  })
})

test("gateway listing and its If-Match revision describe one database snapshot", async () => {
  const before = await getStoreRevision(fixture.storage)
  const mutation = await createProviderMutationContext(
    fixture.storage,
    "gateway.create",
    "unseen",
    "admin:concurrent",
  )
  const restore = commitAfterRead(
    "FROM capi_gateway_credentials ORDER BY",
    () =>
      createCredentialsRepository(fixture.storage).create("unseen", mutation),
  )
  let listed: { credentials: Array<{ label: string }>; revision: number }
  try {
    listed = (await (await request("/gateway")).json()) as typeof listed
  } finally {
    restore()
  }
  expect(listed.credentials).toHaveLength(1)
  expect(listed.revision).toBe(before)
  const edited = await request(
    "/gateway",
    "POST",
    { label: "subsequent" },
    { "If-Match": String(listed.revision) },
  )
  expect(edited.status).toBe(409)
})
