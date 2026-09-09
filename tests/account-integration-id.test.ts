/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression, require-atomic-updates -- Bun promise matchers must be awaited; each test owns its sequential service lifecycle. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  withActiveAccount,
  withAccountLeaseScope,
  leaseAccount,
} from "~/lib/account-lease-context"
import { routedControlPlaneFetch, routedFetch } from "~/lib/account-router"
import {
  AccountsService,
  createAccountMutationContext,
} from "~/lib/accounts-service"
import { state } from "~/lib/state"
import { migrateStorage } from "~/lib/storage/migrations"
import {
  initializeStorageRuntime,
  closeStorageRuntime,
} from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { copilotHeaders } from "~/services/copilot/copilot-client"
import { getModels } from "~/services/copilot/get-models"
import { resolveCopilotOAuth } from "~/services/github/resolve-copilot-oauth"

import { createSchemaFixture } from "./helpers/storage-schema"

const originalFetch = globalThis.fetch
const originalIntegration = state.copilotIntegrationId
const originalMultiToken = state.isMultiToken
let fixture: Awaited<ReturnType<typeof createSchemaFixture>>
let service: AccountsService
const calls: Array<{
  token: string
  integrationId: string | null
  path: string
}> = []
let modelGate: ((integrationId: string | null) => Promise<void>) | undefined
let failedIntegration: string | undefined

function model(id: string): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "test",
    capabilities: {
      family: "test",
      object: "model_capabilities",
      tokenizer: "cl100k_base",
      type: "chat",
      supports: { streaming: true, tool_calls: true },
    },
    supported_endpoints: [
      "/chat/completions",
      "/responses",
      "/v1/messages",
      "/embeddings",
    ],
  }
}

beforeEach(async () => {
  calls.length = 0
  modelGate = undefined
  failedIntegration = undefined
  state.copilotIntegrationId = "legacy-global-must-not-leak"
  state.isMultiToken = true
  fixture = await createSchemaFixture()
  await migrateStorage(fixture.storage)
  await initializeStorageRuntime({
    storage: fixture.storage,
    config: { kind: "sqlite", path: fixture.path },
  })
  service = new AccountsService(fixture.storage, { pool: tokenPool })
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request ?
        new Request(input, init)
      : new Request(input.toString(), init)
    const url = new URL(request.url)
    const token = (request.headers.get("authorization") ?? "").replace(
      /^(?:Bearer|token) /,
      "",
    )
    if (url.pathname === "/user") {
      const id = token.startsWith("first") ? 1 : 2
      return Response.json({ id, login: `user-${id}` })
    }
    if (url.pathname === "/copilot_internal/user")
      return Response.json({
        endpoints: { api: "https://api.githubcopilot.com" },
        analytics_tracking_id: token.split(":")[0],
      })
    const integrationId = request.headers.get("Copilot-Integration-Id")
    calls.push({ token, integrationId, path: url.pathname })
    if (url.pathname === "/models") {
      await modelGate?.(integrationId)
      if (integrationId === failedIntegration)
        return new Response("Unavailable", { status: 503 })
      return Response.json({
        object: "list",
        data: [model("shared-model"), model(`catalog:${integrationId}`)],
      })
    }
    return Response.json({ token, integrationId })
  }) as typeof fetch
})

afterEach(async () => {
  await service.whenIdle()
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  globalThis.fetch = originalFetch
  state.copilotIntegrationId = originalIntegration
  state.isMultiToken = originalMultiToken
  await closeStorageRuntime()
  await fixture.close()
})

const context = (input: unknown = {}) =>
  createAccountMutationContext(
    fixture.storage,
    "account.update",
    input,
    "admin:integration-test",
  )
const add = async (token: string) =>
  (await service.create({ token }, await context({ token }))).value
const update = async (id: number, integrationId: string | null) =>
  service.update(id, { integrationId }, await context({ id, integrationId }))
const current = (id: number) => {
  const account = tokenPool.getAllAccounts().find((item) => item.id === id)
  if (!account) throw new Error("Missing fixture account")
  return account
}

test("unconfigured accounts discover models with the hardcoded default and expose its DTO placeholder", async () => {
  const account = await add("first:old")
  expect(calls.filter((call) => call.path === "/models")).toEqual([
    {
      token: "first:old",
      integrationId: "copilot-developer-cli",
      path: "/models",
    },
  ])
  expect(account.integrationId).toBeNull()
  const page = await service.listWithRevision()
  expect(page.defaultIntegrationId).toBe("copilot-developer-cli")
  expect(page.accounts[0].integrationId).toBeNull()
})

test("custom and cleared overrides persist across restart and refresh only the affected catalog", async () => {
  const first = await add("first:old")
  const second = await add("second:old")
  calls.length = 0
  await update(first.id, "  assigned-integration  ")
  await service.whenIdle()
  expect((await service.repository.get(first.id)).record.integrationId).toBe(
    "assigned-integration",
  )
  expect(current(first.id).models.has("catalog:assigned-integration")).toBe(
    true,
  )
  expect(current(second.id).models.has("catalog:copilot-developer-cli")).toBe(
    true,
  )
  expect(
    calls.filter((call) => call.path === "/models").map((call) => call.token),
  ).toEqual(["first:old"])
  const stableRevision = current(first.id).credentialRevision
  await update(first.id, "assigned-integration")
  await service.whenIdle()
  expect(current(first.id).credentialRevision).toBe(stableRevision)
  expect(calls.filter((call) => call.path === "/models")).toHaveLength(1)

  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  service = new AccountsService(fixture.storage, { pool: tokenPool })
  await service.refreshRuntime()
  await service.whenIdle()
  expect(current(first.id).integrationId).toBe("assigned-integration")
  expect(current(first.id).models.has("catalog:assigned-integration")).toBe(
    true,
  )

  await update(first.id, "   ")
  await service.whenIdle()
  expect(
    (await service.repository.get(first.id)).record.integrationId,
  ).toBeNull()
  expect(current(first.id).models.has("catalog:copilot-developer-cli")).toBe(
    true,
  )
  expect(current(first.id).models.has("catalog:assigned-integration")).toBe(
    false,
  )
})

test.each([
  "good\r\nX-Injected: yes",
  "\tgood",
  "good\u007f",
  "\n",
  "你好",
  "a".repeat(129),
])(
  "rejects an invalid integration header without changing committed account state: %j",
  async (integrationId) => {
    const account = await add("first:old")
    const before = await service.listWithRevision()
    await expect(update(account.id, integrationId)).rejects.toBeInstanceOf(
      TypeError,
    )
    expect((await service.listWithRevision()).revision).toBe(before.revision)
    expect(current(account.id).models).toEqual(
      new Set(["shared-model", "catalog:copilot-developer-cli"]),
    )
  },
)

test("override mutations are revision checked and idempotency binds the account and value", async () => {
  const first = await add("first:old")
  const second = await add("second:old")
  const mutation = await context({
    id: first.id,
    integrationId: "first-integration",
  })
  const stale = await context()
  const result = await service.update(
    first.id,
    { integrationId: "first-integration" },
    mutation,
  )
  await service.whenIdle()
  expect(
    await service.update(
      first.id,
      { integrationId: "first-integration" },
      mutation,
    ),
  ).toEqual(result)
  await expect(
    service.update(first.id, { integrationId: null }, stale),
  ).rejects.toThrow("revision changed")
  await expect(
    service.update(second.id, { integrationId: "first-integration" }, mutation),
  ).rejects.toThrow()
  await expect(
    service.update(first.id, { integrationId: "different" }, mutation),
  ).rejects.toThrow()
})

test("concurrent routed inference and model fetches retain each selected account's integration", async () => {
  const first = await add("first:old")
  const second = await add("second:old")
  await update(first.id, "first-integration")
  await service.whenIdle()
  await update(second.id, "second-integration")
  await service.whenIdle()
  calls.length = 0
  const paths = [
    "/chat/completions",
    "/responses",
    "/v1/messages",
    "/embeddings",
  ]
  await Promise.all(
    [first, second].flatMap((account) =>
      paths.map(async (path) => {
        const result = await routedFetch(
          path,
          { method: "POST", body: JSON.stringify({ model: "shared-model" }) },
          {
            modelId: "shared-model",
            routedAccountPin: { accountId: account.id },
          },
        )
        expect(await result.response.json()).toEqual({
          token: account.id === first.id ? "first:old" : "second:old",
          integrationId:
            account.id === first.id ?
              "first-integration"
            : "second-integration",
        })
      }),
    ),
  )
  await Promise.all(
    [first, second].map((account) =>
      withActiveAccount(current(account.id), getModels),
    ),
  )
  expect(calls).toHaveLength(10)
  for (const call of calls)
    expect(call.integrationId).toBe(
      call.token.startsWith("first") ?
        "first-integration"
      : "second-integration",
    )
})

test("discovery with explicit credentials cannot inherit a different active account's override", async () => {
  const first = await add("first:old")
  await update(first.id, "first-integration")
  await service.whenIdle()
  calls.length = 0
  await withActiveAccount(current(first.id), () =>
    resolveCopilotOAuth({
      accountType: "individual",
      githubToken: "second:old",
      instanceDomain: "github.com",
    }),
  )
  expect(calls).toEqual([
    {
      token: "second:old",
      integrationId: "copilot-developer-cli",
      path: "/models",
    },
  ])
})

test("reconnect and rotation keep overrides while existing leased turns retain their old identity", async () => {
  const first = await add("first:old")
  await update(first.id, "old-integration")
  await service.whenIdle()
  const previous = current(first.id)
  await withAccountLeaseScope(undefined, async () => {
    const leased = leaseAccount(previous)
    await update(first.id, "new-integration")
    await service.whenIdle()
    const rejectedLease = tokenPool.acquireLease(previous)
    rejectedLease?.release()
    expect(rejectedLease).toBeUndefined()
    await tokenPool.reinitializeAccount(leased)
    expect(
      withActiveAccount(leased, copilotHeaders)["Copilot-Integration-Id"],
    ).toBe("old-integration")
    expect(current(first.id).integrationId).toBe("new-integration")
    expect(current(first.id).models.has("catalog:new-integration")).toBe(true)
  })
  await service.reconnect(first.id, "first:new", await context())
  await service.whenIdle()
  expect(current(first.id).integrationId).toBe("new-integration")
  expect(current(first.id).githubToken).toBe("first:new")
  await tokenPool.reinitializeAccount(current(first.id))
  expect(
    calls
      .filter((call) => call.token === "first:new")
      .every((call) => call.integrationId === "new-integration"),
  ).toBe(true)
})

test("a delayed old catalog cannot overwrite a newer override, and failed refresh invalidates stale models", async () => {
  const first = await add("first:old")
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  modelGate = (integrationId) =>
    integrationId === "delayed-integration" ? blocked : Promise.resolve()
  try {
    await update(first.id, "delayed-integration")
    expect(current(first.id).models.size).toBe(0)
    await update(first.id, "latest-integration")
  } finally {
    release()
  }
  await service.whenIdle()
  expect(current(first.id).integrationId).toBe("latest-integration")
  expect(current(first.id).models.has("catalog:latest-integration")).toBe(true)
  failedIntegration = "unavailable-integration"
  await update(first.id, failedIntegration)
  await service.whenIdle()
  expect((await service.repository.get(first.id)).record.integrationId).toBe(
    "unavailable-integration",
  )
  expect(current(first.id).models.size).toBe(0)
  expect(current(first.id).healthy).toBe(false)
})

test("account DTO never pairs a newly committed integration with an obsolete healthy catalog", async () => {
  const first = await add("first:old")
  const mutation = await context({ integrationId: "external-integration" })
  const list = service.repository.listWithRevision.bind(service.repository)
  const spy = spyOn(
    service.repository,
    "listWithRevision",
  ).mockImplementationOnce(async () => {
    await service.repository.update(
      first.id,
      { integrationId: "external-integration" },
      mutation,
    )
    return list()
  })
  try {
    const page = await service.listWithRevision()
    expect(page.accounts[0]).toMatchObject({
      integrationId: "external-integration",
      modelCount: 0,
      healthy: false,
    })
    await service.refreshRuntime()
    await service.whenIdle()
    expect((await service.listWithRevision()).accounts[0]).toMatchObject({
      integrationId: "external-integration",
      modelCount: 2,
      healthy: true,
    })
  } finally {
    spy.mockRestore()
  }
})

test("single-account inference, tool turns, control-plane and clear use the leased integration", async () => {
  state.isMultiToken = false
  const first = await add("first:old")
  await update(first.id, "first-integration")
  await service.whenIdle()
  await withAccountLeaseScope(undefined, async () => {
    const result = await routedFetch("/responses", undefined, {
      modelId: "unknown-model",
    })
    expect(await result.response.json()).toMatchObject({
      integrationId: "first-integration",
    })
    await update(first.id, "next-integration")
    await service.whenIdle()
    const continued = await routedFetch("/responses", undefined, {
      modelId: "unknown-model",
    })
    expect(await continued.response.json()).toMatchObject({
      integrationId: "first-integration",
    })
  })
  const next = await routedControlPlaneFetch({ path: "/models/session" })
  expect(await next.response.json()).toMatchObject({
    integrationId: "next-integration",
  })
  await update(first.id, null)
  await service.whenIdle()
  const cleared = await routedFetch("/chat/completions", undefined, {
    modelId: "unknown-model",
  })
  expect(await cleared.response.json()).toMatchObject({
    integrationId: "copilot-developer-cli",
  })
})

test("concurrent token refresh does not coalesce different integration snapshots of one account", async () => {
  const first = await add("first:old")
  const account = current(first.id)
  const firstSnapshot = { ...account, integrationId: "first-integration" }
  const secondSnapshot = { ...account, integrationId: "second-integration" }
  calls.length = 0
  await Promise.all([
    tokenPool.reinitializeAccount(firstSnapshot),
    tokenPool.reinitializeAccount(secondSnapshot),
  ])
  expect(
    calls
      .filter((call) => call.path === "/models")
      .map((call) => call.integrationId)
      .sort(),
  ).toEqual(["first-integration", "second-integration"])
  expect(firstSnapshot.models.has("catalog:first-integration")).toBe(true)
  expect(secondSnapshot.models.has("catalog:second-integration")).toBe(true)
  expect(current(first.id).models.has("catalog:copilot-developer-cli")).toBe(
    true,
  )
})

test("account creation accepts the longest integration header and survives idempotent replay", async () => {
  const integrationId = "a".repeat(128)
  const input = { token: "first:old", integrationId }
  const mutation = await context(input)
  const created = await service.create(input, mutation)
  expect(created.value.integrationId).toBe(integrationId)
  expect(calls[0].integrationId).toBe(integrationId)
  expect(await service.create(input, mutation)).toEqual(created)
  await expect(
    service.create({ ...input, integrationId: "different" }, mutation),
  ).rejects.toThrow()
})
