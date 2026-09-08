/* eslint-disable @typescript-eslint/require-await -- Async fixture callbacks preserve the real network service interface. */
import { afterEach, beforeEach, expect, test } from "bun:test"

import { routedFetch, routedControlPlaneFetch } from "~/lib/account-router"
import {
  AccountsService,
  createAccountMutationContext,
} from "~/lib/accounts-service"
import { getAccountsService } from "~/lib/accounts-service"
import { mergeConfigWithDefaults } from "~/lib/config"
import { initializeStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { enableCopilotModelPolicy } from "~/services/copilot/control-plane"

import { createRuntimeStorage } from "./helpers/runtime-storage"

let fixture: Awaited<ReturnType<typeof createRuntimeStorage>>
let service: AccountsService
const originalFetch = globalThis.fetch
beforeEach(async () => {
  fixture = await createRuntimeStorage()
  await initializeStorageRuntime(fixture)
  await mergeConfigWithDefaults()
  service = new AccountsService(fixture.storage, {
    pool: tokenPool,
    validate: async (input) => ({
      persisted: {
        token: input.token,
        instanceDomain: "github.com",
        upstreamUserId: input.token,
        login: "fixture",
        label: null,
        accountType: "individual",
        modelCount: 0,
      },
      resolved: {
        token: input.token,
        baseUrl: "https://api.githubcopilot.com",
        models: { object: "list", data: [] },
      },
    }),
  })
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  await fixture.close()
})
test("database single account forwards unknown models and keeps its selected credential during removal", async () => {
  const context = await createAccountMutationContext(
    fixture.storage,
    "account.create",
    {},
    "owner:test",
  )
  const added = await service.create({ token: "fixture-only-account" }, context)
  await getAccountsService().refreshRuntime()
  const source = new TransformStream<Uint8Array, Uint8Array>()
  let authorization = ""
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    authorization = new Headers(init?.headers).get("authorization") ?? ""
    return new Response(source.readable)
  }) as unknown as typeof fetch
  const pending = await routedFetch(
    "/chat/completions",
    { method: "POST", body: JSON.stringify({ model: "unknown" }) },
    { modelId: "unknown" },
  )
  expect(authorization).toBe("Bearer fixture-only-account")
  expect(pending.account?.id).toBe(added.value.id)
  const removal = await createAccountMutationContext(
    fixture.storage,
    "account.remove",
    { id: added.value.id },
    "owner:test",
  )
  await service.remove(added.value.id, removal)
  expect((await service.repository.get(added.value.id)).token).toBe(
    "fixture-only-account",
  )
  const reading = pending.response.text()
  const writer = source.writable.getWriter()
  await writer.write(new TextEncoder().encode("done"))
  await writer.close()
  expect(await reading).toBe("done")
  await service.whenIdle()
  expect((await service.repository.get(added.value.id)).token).toBeNull()
})
test("zero database accounts produce service unavailable without forwarding", async () => {
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response("unexpected")
  }) as unknown as typeof fetch
  try {
    await routedFetch("/chat/completions", undefined, { modelId: "unknown" })
    throw new Error("Expected account unavailable")
  } catch (error) {
    expect(error).toMatchObject({ response: { status: 503 } })
  }
  expect(called).toBe(false)
})

test("control-plane selection ignores a disabled healthy account and policy response releases its lease", async () => {
  const first = await service.create(
    { token: "first" },
    await createAccountMutationContext(
      fixture.storage,
      "account.create",
      { token: "first" },
      "owner:test",
    ),
  )
  const second = await service.create(
    { token: "second" },
    await createAccountMutationContext(
      fixture.storage,
      "account.create",
      { token: "second" },
      "owner:test",
    ),
  )
  await service.setEnabled(
    first.value.id,
    false,
    await createAccountMutationContext(
      fixture.storage,
      "account.disable",
      { id: first.value.id },
      "owner:test",
    ),
  )
  let used = ""
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    used = new Headers(init?.headers).get("authorization") ?? ""
    return Response.json({ ok: true })
  }) as unknown as typeof fetch
  const result = await routedControlPlaneFetch({ path: "/models/session" })
  expect(used).toBe("Bearer second")
  await result.response.body?.cancel()
  const account = tokenPool.getFirstHealthyAccount()
  if (!account) throw new Error("Missing account")
  account.models.add("fixture-model")
  const policy = await enableCopilotModelPolicy("fixture-model")
  expect(policy.success).toBe(true)
  let drained = false
  void tokenPool.waitForDrain(second.value.id).then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(true)
})
