import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import path from "node:path"

import type { AccountValidator } from "~/lib/accounts-service"
import type { Model } from "~/services/copilot/get-models"

process.env.DATA_DIR = path.resolve(
  import.meta.dir,
  "../.superpowers/test-data/dashboard-accounts",
)
const { AccountsService, createAccountMutationContext } = await import(
  "../src/lib/accounts-service"
)
const { GitHubDeviceLoginService } = await import(
  "../src/lib/github-device-login"
)
const { createDashboardAccountRoutes } = await import(
  "../src/routes/dashboard/accounts"
)
const { createAuthStorageFixture } = await import("./helpers/auth-storage")
const {
  authenticateAdminRequest,
  issueAdminSetupCode,
  setupAdminAuth,
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
} = await import("../src/lib/admin-auth")
const { withSettingsActor } = await import("../src/lib/storage/domain-settings")
const { withStorageDeadline } = await import(
  "../src/lib/storage/operation-budget"
)
const { forwardError } = await import("../src/lib/error")
const { LocalSqliteStorage } = await import("../src/lib/storage/local-sqlite")

let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let accounts: InstanceType<typeof AccountsService>
let app: Hono
let cookie: string
let csrf: string
const origin = "https://gateway.example.com"
let catalog: Array<string> = ["old-model"]
let validationCalls = 0
const failures = new Set<string>()
let validationGate: Promise<void> | undefined
const validator: AccountValidator = async (input) => {
  validationCalls++
  await validationGate
  if (failures.has(input.token))
    throw new Error(`secret failure ${input.token}`)
  return {
    persisted: {
      token: input.token,
      instanceDomain: input.instanceDomain ?? "github.com",
      upstreamUserId: input.token.startsWith("other") ? "456" : "123",
      login: "fixture",
      label: input.label ?? null,
      accountType: "individual",
      modelCount: catalog.length,
    },
    resolved: {
      token: input.token,
      baseUrl: "https://api.githubcopilot.com",
      models: { object: "list", data: catalog.map((id) => ({ id }) as Model) },
    },
  }
}

beforeEach(async () => {
  catalog = ["old-model"]
  validationCalls = 0
  failures.clear()
  validationGate = undefined
  process.env.COPILOT_ADMIN_ORIGIN = origin
  fixture = await createAuthStorageFixture()
  accounts = new AccountsService(fixture.storage, { validate: validator })
  const setup = await setupAdminAuth(
    "fixture-gateway",
    "fixture-password",
    (await issueAdminSetupCode()).code,
  )
  if (!("session" in setup)) throw new Error(setup.error)
  csrf = setup.session.csrfToken
  cookie = `${ADMIN_SESSION_COOKIE}=${setup.session.token}; ${ADMIN_CSRF_COOKIE}=${csrf}`
  app = new Hono().onError((error, c) => forwardError(c, error))
  app.use("/accounts/*", async (c, next) => {
    const session = await authenticateAdminRequest(c.req.raw, {
      requireCsrf: c.req.method !== "GET",
    })
    if (!session) return c.json({ error: "Unauthorized" }, 401)
    return withSettingsActor(`admin:${session.tokenHash}`, next)
  })
  app.route(
    "/accounts",
    createDashboardAccountRoutes({
      accounts: () => accounts,
      device: () => new GitHubDeviceLoginService(accounts),
    }),
  )
})
afterEach(async () => {
  await accounts.whenIdle()
  await fixture.close()
  delete process.env.COPILOT_ADMIN_ORIGIN
})

function request(
  url: string,
  options: {
    method?: string
    body?: unknown
    csrf?: boolean
    headers?: Record<string, string>
  } = {},
) {
  return app.request(url, {
    method: options.method ?? "GET",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      ...(options.csrf === false ? {} : { "x-copilot-csrf": csrf }),
      ...options.headers,
    },
    ...(options.body === undefined ?
      {}
    : { body: JSON.stringify(options.body) }),
  })
}

test("account page revision stays paired with its rows when another connection edits", async () => {
  const created = await request("/accounts", {
    method: "POST",
    body: { token: "first-token", label: "original" },
  })
  const { account } = (await created.json()) as { account: { id: number } }
  const peer = new LocalSqliteStorage(fixture.config.path)
  const originalRead = fixture.storage.read.bind(fixture.storage)
  let changed = false
  const read = spyOn(fixture.storage, "read").mockImplementation((work) =>
    originalRead((session) =>
      work({
        execute: (statement) => session.execute(statement),
        query: async (statement) => {
          const rows = await session.query(statement)
          if (
            !changed
            && statement.sql === "SELECT * FROM capi_accounts ORDER BY id"
          ) {
            changed = true
            await peer.transaction(async (other) => {
              await other.execute({
                sql: "UPDATE capi_accounts SET label='concurrent' WHERE id=?",
                args: [account.id],
              })
              await other.execute({
                sql: "UPDATE capi_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='config_revision'",
                args: [],
              })
            })
          }
          return rows
        },
      }),
    ),
  )
  try {
    const listed = await request("/accounts")
    const page = (await listed.json()) as {
      accounts: Array<{ label: string }>
      revision: number
    }
    expect(changed).toBe(true)
    expect(page.accounts[0].label).toBe("original")
    const update = await request(`/accounts/${account.id}`, {
      method: "PATCH",
      body: { label: "stale editor" },
      headers: { "If-Match": String(page.revision) },
    })
    expect(update.status).toBe(409)
    expect((await accounts.repository.get(account.id)).record.label).toBe(
      "concurrent",
    )
  } finally {
    read.mockRestore()
    await peer.close()
  }
})

test("account routes enforce real admin session and CSRF", async () => {
  expect((await app.request("/accounts")).status).toBe(401)
  expect(
    (
      await request("/accounts", {
        method: "POST",
        body: { token: "fixture-oauth" },
        csrf: false,
      })
    ).status,
  ).toBe(401)
  expect(await accounts.list()).toEqual([])
})

test("account integration editor receives the default and saves, clears, and validates its override", async () => {
  const created = await request("/accounts", {
    method: "POST",
    body: { token: "fixture-oauth" },
  })
  const { account } = (await created.json()) as { account: { id: number } }
  const listed = await request("/accounts")
  const page = (await listed.json()) as {
    defaultIntegrationId: string
    revision: number
    accounts: Array<{ integrationId: string | null }>
  }
  expect(page.defaultIntegrationId).toBe("copilot-developer-cli")
  expect(page.accounts[0].integrationId).toBeNull()
  const saved = await request(`/accounts/${account.id}`, {
    method: "PATCH",
    body: { integrationId: "  assigned-integration  " },
    headers: { "If-Match": String(page.revision) },
  })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({
    account: { integrationId: "assigned-integration" },
  })
  await accounts.whenIdle()
  for (const integrationId of [
    "\tassigned-integration",
    "\r\n",
    "a".repeat(129),
    "你好",
    42,
  ]) {
    expect(
      (
        await request(`/accounts/${account.id}`, {
          method: "PATCH",
          body: { integrationId },
        })
      ).status,
    ).toBe(400)
  }
  for (const integrationId of ["   ", null]) {
    const cleared = await request(`/accounts/${account.id}`, {
      method: "PATCH",
      body: { integrationId },
    })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({
      account: { integrationId: null },
    })
    await accounts.whenIdle()
  }
})

test("lifecycle routes return metadata, enforce revisions and retain credentials on conflict", async () => {
  const created = await request("/accounts", {
    method: "POST",
    body: { token: "fixture-oauth", label: "Personal" },
  })
  expect(created.status).toBe(201)
  const body = (await created.json()) as {
    account: { id: number }
    revision: number
  }
  const list = await request("/accounts")
  expect(list.status).toBe(200)
  expect(list.headers.get("Cache-Control")).toBe("no-store")
  expect(await list.text()).not.toContain("fixture-oauth")
  const disable = await request(`/accounts/${body.account.id}`, {
    method: "PATCH",
    body: { enabled: false },
    headers: { "If-Match": String(body.revision) },
  })
  expect(disable.status).toBe(200)
  const stale = await request(`/accounts/${body.account.id}/credential`, {
    method: "PUT",
    body: { token: "fixture-new" },
    headers: { "If-Match": String(body.revision) },
  })
  expect(stale.status).toBe(409)
  expect((await accounts.repository.get(body.account.id)).token).toBe(
    "fixture-oauth",
  )
  const changed = await request(`/accounts/${body.account.id}/credential`, {
    method: "PUT",
    body: { token: "other-user" },
  })
  expect(changed.status).toBe(409)
})

test("database failure is unavailable with no leaked credentials", async () => {
  fixture.failReads()
  const response = await request("/accounts")
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain("fixture-gateway")
  fixture.failReads(false)
})

test("invalid account and device domains return bounded validation errors", async () => {
  expect(
    (
      await request("/accounts/-1", {
        method: "PATCH",
        body: { enabled: true },
      })
    ).status,
  ).toBe(400)
  const response = await request("/accounts/device-login", {
    method: "POST",
    body: { instanceDomain: "https://evil.example" },
  })
  expect(response.status).toBe(400)
  expect(response.headers.get("Cache-Control")).toBe("no-store")
})

async function createFixtureAccount(token = "fixture-oauth") {
  const created = await request("/accounts", {
    method: "POST",
    body: { token },
  })
  expect(created.status).toBe(201)
  return (await created.json()) as {
    account: { id: number; enabled: boolean; credentialRevision: number }
    revision: number
  }
}

test("model refresh replaces the catalog and is replay-safe without changing routing", async () => {
  const created = await createFixtureAccount()
  const routing = JSON.stringify({
    "old-model": { [created.account.id]: false },
  })
  await fixture.storage.transaction((s) =>
    s.execute({
      sql: "INSERT INTO capi_settings (namespace,value_json,revision) VALUES ('model_routing',?,0)",
      args: [routing],
    }),
  )
  catalog = ["new-model", "another-model"]
  const headers = {
    "Idempotency-Key": "refresh-one",
    "If-Match": String(created.revision),
  }
  const refreshed = await request(
    `/accounts/${created.account.id}/refresh-models`,
    { method: "POST", headers },
  )
  expect(refreshed.status).toBe(200)
  expect(await refreshed.json()).toMatchObject({
    account: { id: created.account.id, enabled: true },
    modelCount: 2,
  })
  expect(accounts.pool.getAllModels().data.map((m) => m.id)).toEqual(catalog)
  expect(
    (
      await fixture.storage.read((s) =>
        s.query({
          sql: "SELECT value_json FROM capi_settings WHERE namespace='model_routing'",
          args: [],
        }),
      )
    )[0].value_json,
  ).toBe(routing)
  const replay = await request(
    `/accounts/${created.account.id}/refresh-models`,
    { method: "POST", headers },
  )
  expect(replay.status).toBe(200)
  expect(validationCalls).toBe(2)
  expect(
    (await accounts.repository.get(created.account.id)).record
      .credentialRevision,
  ).toBe(2)
})

test("disabled account model refresh updates its catalog without enabling it", async () => {
  const created = await createFixtureAccount()
  expect(
    (
      await request(`/accounts/${created.account.id}`, {
        method: "PATCH",
        body: { enabled: false },
      })
    ).status,
  ).toBe(200)
  catalog = ["disabled-new"]
  const refreshed = await request(
    `/accounts/${created.account.id}/refresh-models`,
    { method: "POST" },
  )
  expect(refreshed.status).toBe(200)
  expect(await refreshed.json()).toMatchObject({
    account: { enabled: false },
    modelCount: 1,
  })
  expect(accounts.pool.getFirstHealthyAccount()).toBeUndefined()
  expect(accounts.pool.getAllAccounts()[0].models.has("disabled-new")).toBe(
    true,
  )
})

test("failed model refresh preserves the last healthy catalog and sanitizes errors", async () => {
  const created = await createFixtureAccount()
  failures.add("fixture-oauth")
  const failed = await request(
    `/accounts/${created.account.id}/refresh-models`,
    { method: "POST" },
  )
  expect(failed.status).toBe(502)
  expect(await failed.text()).not.toContain("fixture-oauth")
  expect(accounts.pool.getFirstHealthyAccount()?.models.has("old-model")).toBe(
    true,
  )
  expect(
    (await accounts.repository.get(created.account.id)).record
      .credentialRevision,
  ).toBe(1)
})

test("bulk model refresh continues after failure and uses distinct child revisions", async () => {
  const first = await createFixtureAccount()
  const second = await createFixtureAccount("other-token")
  failures.add("fixture-oauth")
  catalog = ["new-bulk-model"]
  const response = await request("/accounts/refresh-models", {
    method: "POST",
    headers: { "Idempotency-Key": "refresh-bulk" },
  })
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result).toMatchObject({
    refreshed: 1,
    failed: 1,
    results: [
      { id: first.account.id, status: "failed" },
      { id: second.account.id, status: "refreshed", modelCount: 1 },
    ],
  })
  expect(JSON.stringify(result)).not.toContain("fixture-oauth")
  expect(
    accounts.pool
      .getAllAccounts()
      .find((a) => a.id === first.account.id)
      ?.models.has("old-model"),
  ).toBe(true)
  const retry = await request("/accounts/refresh-models", {
    method: "POST",
    headers: { "Idempotency-Key": "refresh-bulk" },
  })
  expect(retry.status).toBe(200)
  expect(
    (await accounts.repository.get(second.account.id)).record
      .credentialRevision,
  ).toBe(2)
})

test("model refresh endpoints preserve admin and CSRF authentication", async () => {
  for (const path of [
    "/accounts/refresh-models",
    "/accounts/1/refresh-models",
  ]) {
    expect((await app.request(path, { method: "POST" })).status).toBe(401)
    expect((await request(path, { method: "POST", csrf: false })).status).toBe(
      401,
    )
  }
})

test("concurrent duplicate refresh operations share one validation", async () => {
  const created = await createFixtureAccount()
  const gate = Promise.withResolvers<undefined>()
  validationGate = gate.promise
  const headers = { "Idempotency-Key": "duplicate-refresh" }
  const first = request(`/accounts/${created.account.id}/refresh-models`, {
    method: "POST",
    headers,
  })
  const second = request(`/accounts/${created.account.id}/refresh-models`, {
    method: "POST",
    headers,
  })
  await Bun.sleep(20)
  gate.resolve(undefined)
  expect((await first).status).toBe(200)
  expect((await second).status).toBe(200)
  expect(validationCalls).toBe(2)
})

test("bulk exact replay keeps original target membership and new stale operations conflict", async () => {
  const first = await createFixtureAccount()
  const second = await createFixtureAccount("other-token")
  catalog = ["bulk-new"]
  const headers = {
    "Idempotency-Key": "stable-bulk",
    "If-Match": String(second.revision),
  }
  const refreshed = await request("/accounts/refresh-models", {
    method: "POST",
    headers,
  })
  expect(refreshed.status).toBe(200)
  expect(await refreshed.json()).toMatchObject({ refreshed: 2, failed: 0 })
  const added = await request("/accounts", {
    method: "POST",
    body: { token: "third-token", instanceDomain: "tenant.ghe.com" },
  })
  expect(added.status).toBe(201)
  const addedBody = (await added.json()) as { account: { id: number } }
  const calls = validationCalls
  const retry = await request("/accounts/refresh-models", {
    method: "POST",
    headers,
  })
  expect(retry.status).toBe(200)
  const result = (await retry.json()) as { results: Array<{ id: number }> }
  expect(result.results.map((item) => item.id)).toEqual([
    first.account.id,
    second.account.id,
  ])
  expect(result.results.some((item) => item.id === addedBody.account.id)).toBe(
    false,
  )
  expect(validationCalls).toBe(calls)
  const stale = await request("/accounts/refresh-models", {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": "new-stale-bulk" },
  })
  expect(stale.status).toBe(409)
  expect(validationCalls).toBe(calls)
})

test("a delayed refresh cannot overwrite a credential reconnected in parallel", async () => {
  const created = await createFixtureAccount()
  const gate = Promise.withResolvers<undefined>()
  validationGate = gate.promise
  const pending = request(`/accounts/${created.account.id}/refresh-models`, {
    method: "POST",
  })
  await Bun.sleep(20)
  validationGate = undefined
  catalog = ["reconnected-model"]
  const replacement = await request(
    `/accounts/${created.account.id}/credential`,
    { method: "PUT", body: { token: "fixture-new" } },
  )
  expect(replacement.status).toBe(200)
  gate.resolve(undefined)
  expect((await pending).status).toBe(409)
  expect((await accounts.repository.get(created.account.id)).token).toBe(
    "fixture-new",
  )
  expect(
    accounts.pool.getFirstHealthyAccount()?.models.has("reconnected-model"),
  ).toBe(true)
})

test("bulk excludes deleting accounts and refresh preserves removal during validation", async () => {
  const created = await createFixtureAccount()
  const selected = accounts.pool.getFirstHealthyAccount()
  if (!selected) throw new Error("Missing fixture account")
  const lease = accounts.pool.acquireLease(selected)
  if (!lease) throw new Error("Missing lease")
  const gate = Promise.withResolvers<undefined>()
  validationGate = gate.promise
  const pending = request(`/accounts/${created.account.id}/refresh-models`, {
    method: "POST",
  })
  await Bun.sleep(20)
  expect(
    (await request(`/accounts/${created.account.id}`, { method: "DELETE" }))
      .status,
  ).toBe(200)
  gate.resolve(undefined)
  expect((await pending).status).toBe(409)
  const bulk = await request("/accounts/refresh-models", { method: "POST" })
  expect(bulk.status).toBe(200)
  expect(await bulk.json()).toMatchObject({
    results: [],
    refreshed: 0,
    failed: 0,
  })
  expect(accounts.pool.getFirstHealthyAccount()).toBeUndefined()
  lease.release()
  await accounts.whenIdle()
})

test("expired refresh work cannot publish a later validation result", async () => {
  const created = await createFixtureAccount()
  const gate = Promise.withResolvers<undefined>()
  validationGate = gate.promise
  const context = await createAccountMutationContext(
    fixture.storage,
    "account.refresh-models",
    { id: created.account.id },
    "admin:test",
  )
  const pending = withStorageDeadline(Date.now() + 40, () =>
    accounts.refreshModels(created.account.id, context),
  )
  let caught: unknown
  try {
    await pending
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({
    code: "storage_unavailable",
    reason: "timeout",
  })
  catalog = ["too-late-model"]
  gate.resolve(undefined)
  await Bun.sleep(10)
  expect(accounts.pool.getFirstHealthyAccount()?.models.has("old-model")).toBe(
    true,
  )
  expect(
    (await accounts.repository.get(created.account.id)).record
      .credentialRevision,
  ).toBe(1)
})
