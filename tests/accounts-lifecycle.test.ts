/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression, require-atomic-updates -- Bun assertions are awaited; lifecycle fixture replacement is sequential. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"

process.env.DATA_DIR = path.resolve(
  import.meta.dir,
  "../.superpowers/test-data/accounts",
)

const { AccountsService, createAccountMutationContext, validateAccount } =
  await import("../src/lib/accounts-service")
const { LocalSqliteStorage } = await import("../src/lib/storage/local-sqlite")
const { migrateStorage } = await import("../src/lib/storage/migrations")
const { StorageCommitUnknownError, StorageUnavailableError } = await import(
  "../src/lib/storage/errors"
)
const { initializeStorageRuntime, closeStorageRuntime } = await import(
  "../src/lib/storage/runtime"
)

import type { AccountValidator } from "~/lib/accounts-service"
import type { Storage } from "~/lib/storage/types"

let storage: Storage
let service: InstanceType<typeof AccountsService>
let failValidation = false
const validator: AccountValidator = (input) => {
  if (failValidation) return Promise.reject(new Error("Upstream unavailable"))
  return Promise.resolve({
    persisted: {
      token: input.token,
      instanceDomain: input.instanceDomain ?? "github.com",
      login: input.token.split(":")[0],
      upstreamUserId: input.token.split(":")[0],
      label: input.label ?? null,
      accountType: "individual",
      modelCount: 1,
    },
    resolved: {
      baseUrl: "https://api.githubcopilot.com",
      token: input.token,
      accountSubject: `analytics:${input.token}`,
      models: { object: "list", data: [{ id: "model" }] as never },
    },
  })
}
const context = (kind: string) =>
  createAccountMutationContext(storage, kind, { kind }, "admin:test")
const add = async (token: string) =>
  (await service.create({ token }, await context("account.create"))).value

beforeEach(async () => {
  const dataDir = process.env.DATA_DIR ?? ""
  await mkdir(dataDir, { recursive: true })
  storage = new LocalSqliteStorage(path.join(dataDir, `${randomUUID()}.sqlite`))
  await migrateStorage(storage)
  await initializeStorageRuntime({
    storage,
    config: {
      kind: "sqlite",
      path: path.join(dataDir, "unused.sqlite"),
    },
  })
  service = new AccountsService(storage, { validate: validator })
  failValidation = false
})
afterEach(async () => {
  await service.whenIdle()
  await closeStorageRuntime()
})

test("IDs survive removals and restart without recycling, including imported zero", async () => {
  await storage.transaction(async (session) => {
    await session.execute({
      sql: "INSERT INTO capi_accounts (id,domain,upstream_user_id,login,created_at,updated_at) VALUES (0,'github.com','zero','zero',0,0)",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_account_credentials (account_id,oauth_value,updated_at) VALUES (0,'zero',0)",
      args: [],
    })
  })
  const a = await add("a")
  const b = await add("b")
  await service.remove(a.id, await context("account.remove"))
  await service.whenIdle()
  service = new AccountsService(storage, { validate: validator })
  await service.refreshRuntime()
  const c = await add("c")
  expect((await service.list()).some((account) => account.id === 0)).toBe(true)
  expect(c.id).toBeGreaterThan(b.id)
  expect((await service.repository.get(a.id)).token).toBeNull()
  const readded = await add("a")
  expect(readded.id).toBeGreaterThan(c.id)
})

test("disable retains credentials and drains preserve a detached snapshot", async () => {
  const account = await add("a:old")
  const selected = service.pool.getFirstHealthyAccount()
  if (!selected) throw new Error("Expected a healthy account")
  const lease = service.pool.acquireLease(selected)
  if (!lease) throw new Error("Expected an account lease")
  await service.setEnabled(account.id, false, await context("account.disable"))
  expect(service.pool.getFirstHealthyAccount()).toBeUndefined()
  expect((await service.repository.get(account.id)).token).toBe("a:old")
  await service.replaceCredential(
    account.id,
    "a:new",
    await context("account.reconnect"),
  )
  expect(lease.account.githubToken).toBe("a:old")
  expect(lease.account.copilotAccountSubject).toBe("analytics:a:old")
  await service.remove(account.id, await context("account.remove"))
  expect((await service.repository.get(account.id)).token).toBe("a:new")
  lease.release()
  lease.release()
  await service.whenIdle()
  expect((await service.repository.get(account.id)).token).toBeNull()
  expect(
    (await service.repository.get(account.id)).record.removedAt,
  ).not.toBeNull()
})

test("different identity, failed validation and conflict preserve credential/catalog", async () => {
  const account = await add("a:old")
  await expect(
    service.replaceCredential(
      account.id,
      "b:new",
      await context("account.reconnect"),
    ),
  ).rejects.toThrow("same GitHub identity")
  failValidation = true
  await expect(
    service.replaceCredential(
      account.id,
      "a:new",
      await context("account.reconnect"),
    ),
  ).rejects.toThrow("Upstream unavailable")
  failValidation = false
  const stale = await context("account.reconnect")
  await service.setEnabled(account.id, true, await context("account.enable"))
  await expect(
    service.replaceCredential(account.id, "a:new", stale),
  ).rejects.toThrow("revision changed")
  expect((await service.repository.get(account.id)).token).toBe("a:old")
  expect(service.pool.getFirstHealthyAccount()?.githubToken).toBe("a:old")
})

test("startup does not wait for upstream, unhealthy accounts remain repairable", async () => {
  await add("a")
  let finish: (() => void) | undefined
  service = new AccountsService(storage, {
    validate: async () =>
      new Promise((_resolve, reject) => {
        finish = () => reject(new Error("offline"))
      }),
  })
  await service.refreshRuntime()
  expect((await service.list())[0].healthy).toBe(false)
  expect(service.pool.size).toBe(1)
  finish?.()
  await service.whenIdle()
})

test("zero-account startup completes without upstream discovery", async () => {
  service = new AccountsService(storage, {
    validate: () => Promise.reject(new Error("must not call upstream")),
  })
  await service.refreshRuntime()
  expect(await service.list()).toEqual([])
  expect(service.pool.getAllModels().data).toEqual([])
})

test("startup finalizes an interrupted removal before publishing eligibility", async () => {
  const account = await add("a")
  await service.repository.beginRemoval(
    account.id,
    await context("account.remove"),
  )
  service = new AccountsService(storage, { validate: validator })
  await service.refreshRuntime()
  expect(service.pool.getFirstHealthyAccount()).toBeUndefined()
  await service.whenIdle()
  expect((await service.repository.get(account.id)).token).toBeNull()
})

test("a lease cannot be admitted from a stale credential revision", async () => {
  const account = await add("a:old")
  const selected = service.pool.getFirstHealthyAccount()
  if (!selected) throw new Error("Expected account")
  await service.replaceCredential(
    account.id,
    "a:new",
    await context("account.reconnect"),
  )
  expect(service.pool.acquireLease(selected)).toBeUndefined()
})

test("a database write failure preserves the previous runtime credential and catalog", async () => {
  const account = await add("a:old")
  const failureStorage: Storage = {
    read: (work) => storage.read(work),
    transaction: () =>
      Promise.reject(new Error("fixture database write failed")),
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: () => Promise.resolve(),
  }
  const failing = new AccountsService(failureStorage, {
    pool: service.pool,
    validate: validator,
  })
  await expect(
    failing.replaceCredential(
      account.id,
      "a:new",
      await context("account.reconnect"),
    ),
  ).rejects.toThrow("database write failed")
  expect((await service.repository.get(account.id)).token).toBe("a:old")
  expect(service.pool.getFirstHealthyAccount()?.githubToken).toBe("a:old")
  expect(service.pool.getAllModels().data.map((model) => model.id)).toEqual([
    "model",
  ])
})

test("copied operation context cannot replay another account target or update body", async () => {
  const first = await add("a")
  const second = await add("b")
  const mutation = await context("account.update")
  const disabled = await service.repository.update(
    first.id,
    { enabled: false },
    mutation,
  )
  expect(
    (
      await service.repository.update(
        first.id,
        { enabled: false },
        { ...mutation },
      )
    ).value,
  ).toEqual(disabled.value)
  await expect(
    service.repository.update(second.id, { enabled: false }, { ...mutation }),
  ).rejects.toThrow("conflict")
  await expect(
    service.repository.update(first.id, { enabled: true }, { ...mutation }),
  ).rejects.toThrow("conflict")
  await expect(
    service.repository.beginRemoval(first.id, { ...mutation }),
  ).rejects.toThrow("conflict")
  expect((await service.repository.get(second.id)).record.enabled).toBe(true)
  const removal = await context("account.remove")
  await service.repository.beginRemoval(first.id, removal)
  await expect(
    service.repository.beginRemoval(second.id, { ...removal }),
  ).rejects.toThrow("conflict")
  const finalization = await context("account.finalize-removal")
  await service.repository.finalizeRemoval(first.id, finalization)
  await expect(
    service.repository.finalizeRemoval(second.id, { ...finalization }),
  ).rejects.toThrow("conflict")
})

test("copied create or reconnect context cannot replay different validated credentials", async () => {
  const first = await validator({ token: "a:old" })
  const createContext = await context("account.create")
  const created = await service.repository.create(
    first.persisted,
    createContext,
  )
  const different = await validator({ token: "b:secret" })
  expect(
    await service.repository.create(first.persisted, { ...createContext }),
  ).toEqual(created)
  await expect(
    service.repository.create(different.persisted, { ...createContext }),
  ).rejects.toThrow("conflict")
  const next = await validator({ token: "a:new" })
  const replaceContext = await context("account.reconnect")
  await service.repository.replace(
    created.value.id,
    next.persisted,
    1,
    replaceContext,
  )
  await expect(
    service.repository.replace(
      created.value.id,
      { ...next.persisted, token: "a:other-secret" },
      1,
      { ...replaceContext },
    ),
  ).rejects.toThrow("conflict")
  expect((await service.repository.get(created.value.id)).token).toBe("a:new")
})

test("unknown reconnect commit reconciles cached validation without another upstream call", async () => {
  const account = await add("a:old")
  let failReads = false
  let loseCommit = true
  let validationCalls = 0
  const uncertain: Storage = {
    read: (work) =>
      failReads ?
        Promise.reject(new StorageUnavailableError())
      : storage.read(work),
    transaction: async (work) => {
      const value = await storage.transaction(work)
      if (loseCommit) {
        loseCommit = false
        failReads = true
        throw new StorageCommitUnknownError()
      }
      return value
    },
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: () => Promise.resolve(),
  }
  const reconciling = new AccountsService(uncertain, {
    pool: service.pool,
    validate: (input) => {
      validationCalls++
      return validator(input)
    },
  })
  const mutation = await context("account.reconnect")
  await expect(
    reconciling.replaceCredential(account.id, "a:new", mutation),
  ).rejects.toBeInstanceOf(StorageCommitUnknownError)
  expect(service.pool.getFirstHealthyAccount()?.githubToken).toBe("a:old")
  failReads = false
  await expect(
    reconciling.replaceCredential(account.id, "a:changed", { ...mutation }),
  ).rejects.toThrow("pending mutation")
  const committed = await reconciling.replaceCredential(account.id, "a:new", {
    ...mutation,
  })
  expect(committed.value.credentialRevision).toBe(2)
  expect(service.pool.getFirstHealthyAccount()?.githubToken).toBe("a:new")
  expect(validationCalls).toBe(1)
})

test("successful reconnect can replay through a fresh service without repeating the write", async () => {
  const account = await add("a:old")
  const mutation = await context("account.replace")
  const first = await service.replaceCredential(account.id, "a:new", mutation)
  const fresh = new AccountsService(storage, {
    validate: validator,
    pool: service.pool,
  })
  const replay = await fresh.replaceCredential(account.id, "a:new", {
    ...mutation,
  })
  expect(replay).toEqual(first)
  expect(
    (await service.repository.get(account.id)).record.credentialRevision,
  ).toBe(2)
})

test("OAuth validation uses immutable GitHub user ID separately from Copilot analytics", async () => {
  const originalFetch = globalThis.fetch
  const visited: Array<string> = []
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    visited.push(url)
    if (url.endsWith("/copilot_internal/user"))
      return Promise.resolve(
        Response.json({
          login: "renamable",
          analytics_tracking_id: "different-analytics-id",
          endpoints: { api: "https://copilot-api.msft.ghe.com" },
        }),
      )
    if (url.endsWith("/user"))
      return Promise.resolve(Response.json({ id: 123456, login: "renamable" }))
    if (url.endsWith("/models"))
      return Promise.resolve(Response.json({ object: "list", data: [] }))
    throw new Error("Unexpected upstream URL")
  }) as typeof fetch
  try {
    const result = await validateAccount({
      token: "fixture-oauth",
      instanceDomain: "HTTPS://MSFT.GHE.COM/",
    })
    expect(result.persisted.upstreamUserId).toBe("123456")
    expect(result.persisted.instanceDomain).toBe("msft.ghe.com")
    expect(result.resolved.accountSubject).toBe("different-analytics-id")
    expect(visited).toContain("https://api.msft.ghe.com/user")
    expect(visited).toContain("https://copilot-api.msft.ghe.com/models")
  } finally {
    globalThis.fetch = originalFetch
  }
})
