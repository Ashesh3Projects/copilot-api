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

test("custom gateway keys stay revealable while metadata and operation receipts conceal values", async () => {
  const raw = "cop-fixture-client-key-for-persistent-reveal"
  const input = { label: "Client", credential: raw }
  const created = await request("/gateway", "POST", input, {
    "Idempotency-Key": "gateway-test-create",
  })
  expect(created.status).toBe(201)
  const value = (await created.json()) as {
    id: string
    credential?: string
    maskedValue: string
  }
  expect(value.credential).toBeUndefined()
  expect(value.maskedValue).toBe("cop-f...eveal")
  const replay = await request("/gateway", "POST", input, {
    "Idempotency-Key": "gateway-test-create",
  })
  const replayed = (await replay.json()) as { id: string; credential?: string }
  expect(replayed.id).toBe(value.id)
  expect(replayed.credential).toBeUndefined()
  const listed = await (await request("/gateway")).text()
  expect(listed).not.toContain(raw)
  expect(listed).not.toContain("digest")
  const beforeReveal = await getStoreRevision(fixture.storage)
  for (let attempt = 0; attempt < 2; attempt++) {
    const revealed = await request(`/gateway/${value.id}/reveal`, "POST")
    expect(revealed.status).toBe(200)
    expect(revealed.headers.get("cache-control")).toBe("no-store")
    expect(await revealed.json()).toMatchObject({ credential: raw })
  }
  expect(await getStoreRevision(fixture.storage)).toBe(beforeReveal)
  const markers = await fixture.storage.read((session) =>
    session.query({
      sql: "SELECT result_json FROM capi_applied_operations",
      args: [],
    }),
  )
  expect(JSON.stringify(markers)).not.toContain(raw)
  expect((await request(`/gateway/${value.id}`, "DELETE")).status).toBe(200)
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT credential_id FROM capi_gateway_secrets WHERE credential_id=?",
        args: [value.id],
      }),
    ),
  ).toEqual([])
  expect((await request(`/gateway/${value.id}/reveal`, "POST")).status).toBe(
    404,
  )
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
        { label: "Client", credential: "fixture-new-client" },
        { "x-copilot-csrf": "wrong" },
      )
    ).status,
  ).toBe(401)
  expect(
    (
      await request(
        "/gateway",
        "POST",
        { label: "Client", credential: "fixture-new-client" },
        { "If-Match": "0" },
      )
    ).status,
  ).toBe(409)
})

test("gateway reveal requires the administrator session, correct CSRF, and exact origin", async () => {
  const listed = (await (await request("/gateway")).json()) as {
    credentials: Array<{ id: string }>
  }
  const url = `/gateway/${listed.credentials[0].id}/reveal`
  expect(
    (await app.request(`/credentials${url}`, { method: "POST" })).status,
  ).toBe(401)
  const invalidHeaders: Array<Record<string, string>> = [
    { "x-copilot-csrf": "" },
    { "x-copilot-csrf": "wrong" },
    { origin: "https://wrong.example" },
  ]
  for (const headers of invalidHeaders)
    expect((await request(url, "POST", undefined, headers)).status).toBe(401)
  expect((await request(url, "GET")).status).toBe(404)
})

test("custom key validation never generates a fallback and duplicates conflict", async () => {
  for (const body of [
    { label: "Missing" },
    { label: "Empty", credential: "" },
    { label: "Unsafe", credential: "key with whitespace" },
    { label: "Wrong type", credential: 123 },
  ])
    expect((await request("/gateway", "POST", body)).status).toBe(400)
  const duplicate = await request("/gateway", "POST", {
    label: "Duplicate",
    credential: "fixture-gateway",
  })
  expect(duplicate.status).toBe(409)
  expect(await duplicate.text()).not.toContain("fixture-gateway")
  expect((await request("/gateway/missing", "DELETE")).status).toBe(404)
})

test("competing hard deletes cannot remove every active gateway key", async () => {
  await request("/gateway", "POST", {
    label: "Second",
    credential: "fixture-second-key",
  })
  const page = (await (await request("/gateway")).json()) as {
    revision: number
    credentials: Array<{ id: string }>
  }
  const responses = await Promise.all(
    page.credentials.map((key) =>
      Promise.resolve(
        request(`/gateway/${key.id}`, "DELETE", undefined, {
          "If-Match": String(page.revision),
        }),
      ),
    ),
  )
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ])
  const counts = await fixture.storage.read((session) =>
    session.query({
      sql: "SELECT (SELECT count(*) FROM capi_gateway_credentials) AS metadata,(SELECT count(*) FROM capi_gateway_secrets) AS secrets",
      args: [],
    }),
  )
  expect(counts).toEqual([{ metadata: 1, secrets: 1 }])
})

test("an uncertain custom-key create is recoverable through idempotent replay and reveal", async () => {
  const input = { label: "Retry", credential: "eyJabc.fixture-persistent-key" }
  const headers = { "Idempotency-Key": "fixture-lost-gateway-create" }
  fixture.loseNextCommitResponse({ failReads: true })
  const uncertain = await request("/gateway", "POST", input, headers)
  expect(uncertain.status).toBe(503)
  expect(await uncertain.text()).not.toContain(input.credential)
  fixture.failReads(false)
  const created = await request("/gateway", "POST", input, headers)
  expect(created.status).toBe(201)
  const value = (await created.json()) as { id: string }
  expect(
    await (await request(`/gateway/${value.id}/reveal`, "POST")).json(),
  ).toMatchObject({ credential: input.credential })
  const page = (await (await request("/gateway")).json()) as {
    credentials: Array<{ id: string }>
  }
  expect(page.credentials).toHaveLength(2)
})

test("creating a custom gateway key cannot elevate an existing inference credential", async () => {
  const { credentialDigest } = await import(
    "../src/lib/storage/credentials-repository"
  )
  const credential = "fixture-existing-inference"
  await fixture.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_inference_credentials(digest,id,kind,principal_id,enabled,scopes_json,created_at,updated_at) VALUES(?,'reserved','managed','inference:reserved',0,'[\"user:inference\"]',0,0)",
      args: [credentialDigest(credential)],
    },
  ])
  for (const value of [credential, credentialDigest(credential)])
    expect(
      (
        await request("/gateway", "POST", {
          label: "Forbidden",
          credential: value,
        })
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

test("the stored Groq key is masked in status and revealable only with admin CSRF authority", async () => {
  const credential = "gsk-fixture-current-transcription-key"
  await request("/groq", "PUT", { apiKey: credential })
  const before = await getStoreRevision(fixture.storage)
  const status = await request("/groq")
  const summary = await status.json()
  expect(summary).toMatchObject({
    apiKeyConfigured: true,
    maskedValue: "gsk-f...n-key",
    revision: before,
  })
  expect(JSON.stringify(summary)).not.toContain(credential)
  const revealed = await request("/groq/reveal", "POST")
  expect(revealed.status).toBe(200)
  expect(revealed.headers.get("cache-control")).toBe("no-store")
  expect(await revealed.json()).toEqual({ credential, revision: before })
  expect(await getStoreRevision(fixture.storage)).toBe(before)
  expect(
    (await request("/groq/reveal", "POST", undefined, { "x-copilot-csrf": "" }))
      .status,
  ).toBe(401)
  expect(
    (
      await request("/groq/reveal", "POST", undefined, {
        origin: "https://wrong.example",
      })
    ).status,
  ).toBe(401)
  await request("/groq", "PUT", { clearApiKey: true })
  expect((await request("/groq/reveal", "POST")).status).toBe(404)
  expect(await (await request("/groq")).json()).toMatchObject({
    apiKeyConfigured: false,
    maskedValue: null,
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
  const restore = commitAfterRead("FROM capi_gateway_credentials c", () =>
    createCredentialsRepository(fixture.storage).create(
      { label: "unseen", credential: "fixture-unseen-gateway" },
      mutation,
    ),
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
    { label: "subsequent", credential: "fixture-subsequent-gateway" },
    { "If-Match": String(listed.revision) },
  )
  expect(edited.status).toBe(409)
})
