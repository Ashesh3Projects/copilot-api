/* eslint-disable require-atomic-updates, @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise rejection assertions are awaited at runtime. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"

import type { AccountValidator } from "~/lib/accounts-service"
import type { AccessTokenResponse } from "~/services/github/poll-access-token"

const dataDir = path.resolve(
  import.meta.dir,
  "../.superpowers/test-data/device-login",
)
process.env.DATA_DIR = dataDir
const { AccountsService, createAccountMutationContext } = await import(
  "../src/lib/accounts-service"
)
const { GitHubDeviceLoginService } = await import(
  "../src/lib/github-device-login"
)
const { LocalSqliteStorage } = await import("../src/lib/storage/local-sqlite")
const { initializeStorageRuntime, closeStorageRuntime } = await import(
  "../src/lib/storage/runtime"
)

let accounts: InstanceType<typeof AccountsService>
let device: InstanceType<typeof GitHubDeviceLoginService>
let now = 100_000
let pollCount = 0
let codeCount = 0
let response: AccessTokenResponse = { error: "authorization_pending" }
let poll: () => Promise<AccessTokenResponse>
const validator: AccountValidator = (input) =>
  Promise.resolve({
    persisted: {
      token: input.token,
      instanceDomain: input.instanceDomain ?? "github.com",
      upstreamUserId: "123",
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
  })
const context = (kind: string) =>
  createAccountMutationContext(
    accounts.repository.storage,
    kind,
    {},
    "admin:owner",
  )
const start = async () =>
  device.start(
    { instanceDomain: "github.com" },
    "admin:owner",
    await context("device.start"),
  )
function freshDevice() {
  return new GitHubDeviceLoginService(accounts, {
    now: () => now,
    getCode: () => {
      codeCount++
      return Promise.resolve({
        device_code: "secret-device",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 60,
        interval: 5,
      })
    },
    pollToken: () => {
      pollCount++
      return poll()
    },
  })
}
beforeEach(async () => {
  const databasePath = path.join(dataDir, `${randomUUID()}.sqlite`)
  const storage = new LocalSqliteStorage(databasePath)
  await initializeStorageRuntime({
    storage,
    config: { kind: "sqlite", path: databasePath },
  })
  await storage.transaction((session) =>
    session.execute({
      sql: "INSERT INTO capi_admin (id,password_hash,session_version,created_at,updated_at) VALUES (1,'fixture-hash',1,0,0)",
      args: [],
    }),
  )
  await storage.transaction((session) =>
    session.execute({
      sql: "INSERT INTO capi_admin_sessions (token_hash,csrf_hash,session_version,created_at,last_seen_at,expires_at) VALUES ('owner','csrf',1,0,0,9999999999999)",
      args: [],
    }),
  )
  accounts = new AccountsService(storage, { validate: validator })
  now = 100_000
  pollCount = 0
  codeCount = 0
  response = { error: "authorization_pending" }
  poll = () => Promise.resolve(response)
  device = freshDevice()
})
afterEach(async () => {
  await accounts.whenIdle()
  await closeStorageRuntime()
})

test("identical device start reuses committed intent across service reload", async () => {
  const mutation = await context("device.start")
  const first = await device.start(
    { instanceDomain: "github.com" },
    "admin:owner",
    mutation,
  )
  now += 1000
  const replay = await freshDevice().start(
    { instanceDomain: "github.com" },
    "admin:owner",
    { ...mutation },
  )
  expect(replay.id).toBe(first.id)
  expect(replay.expiresAt).toBe(first.expiresAt)
  expect(codeCount).toBe(1)
})

test("uncertain device start reconciles before asking GitHub for another code", async () => {
  const { StorageCommitUnknownError, StorageUnavailableError } = await import(
    "../src/lib/storage/errors"
  )
  const underlying = accounts.repository.storage
  let failReads = false
  let uncertain = true
  const storage = {
    read: <T>(work: Parameters<typeof underlying.read<T>>[0]) =>
      failReads ?
        Promise.reject(new StorageUnavailableError())
      : underlying.read(work),
    transaction: async <T>(
      work: Parameters<typeof underlying.transaction<T>>[0],
    ) => {
      const result = await underlying.transaction(work)
      if (uncertain) {
        uncertain = false
        failReads = true
        throw new StorageCommitUnknownError()
      }
      return result
    },
    atomicBatch: underlying.atomicBatch.bind(underlying),
    close: underlying.close.bind(underlying),
  }
  accounts = new AccountsService(storage, { validate: validator })
  device = freshDevice()
  const mutation = await context("device.start")
  await expect(
    device.start({ instanceDomain: "github.com" }, "admin:owner", mutation),
  ).rejects.toBeInstanceOf(StorageCommitUnknownError)
  failReads = false
  const recovered = await freshDevice().start(
    { instanceDomain: "github.com" },
    "admin:owner",
    { ...mutation },
  )
  expect(recovered.status).toBe("pending")
  expect(codeCount).toBe(1)
})

test("durable intent resumes after reload and respects pending/slow-down timing", async () => {
  const intent = await start()
  expect(JSON.stringify(intent)).not.toContain("secret-device")
  expect(intent.userCode).toBe("ABCD-EFGH")
  await device.poll(intent.id, "admin:owner")
  expect(pollCount).toBe(0)
  now += 6000
  await device.poll(intent.id, "admin:owner")
  expect(pollCount).toBe(1)
  device = freshDevice()
  response = { error: "slow_down" }
  now += 6000
  expect((await device.poll(intent.id, "admin:owner")).intervalSeconds).toBe(11)
  now += 10_000
  await device.poll(intent.id, "admin:owner")
  expect(pollCount).toBe(2)
  now += 1000
  response = { access_token: "fixture-oauth" }
  const completed = await device.poll(intent.id, "admin:owner")
  expect(completed.status).toBe("complete")
  expect(completed.userCode).toBeUndefined()
  expect(await accounts.list()).toHaveLength(1)
  expect(JSON.stringify(completed)).not.toContain("fixture-oauth")
  await device.poll(intent.id, "admin:owner")
  expect(await accounts.list()).toHaveLength(1)
})

test("cancel stops a late upstream success from persisting credentials", async () => {
  const intent = await start()
  const pending = Promise.withResolvers<AccessTokenResponse>()
  const entered = Promise.withResolvers<undefined>()
  poll = () => {
    entered.resolve(undefined)
    return pending.promise
  }
  now += 6000
  const completing = device.poll(intent.id, "admin:owner")
  await entered.promise
  await device.cancel(intent.id, "admin:owner", await context("device.cancel"))
  pending.resolve({ access_token: "late-oauth" })
  expect((await completing).status).toBe("canceled")
  expect(await accounts.list()).toEqual([])
  expect(
    (await device.repository.get(intent.id, "admin:owner")).deviceCode,
  ).toBe("")
})

test("expiry, terminal denial and a foreign admin session never create accounts", async () => {
  const intent = await start()
  await expect(device.poll(intent.id, "admin:other")).rejects.toThrow(
    "another administrator",
  )
  now += 60_000
  expect((await device.poll(intent.id, "admin:owner")).status).toBe("expired")
  expect(pollCount).toBe(0)
  const second = await start()
  now += 6000
  response = {
    error: "access_denied",
    error_description: "secret-upstream-error",
  }
  expect((await device.poll(second.id, "admin:owner")).status).toBe("failed")
  expect(await accounts.list()).toEqual([])
})

test("concurrent polling has one active upstream lease", async () => {
  const intent = await start()
  const pending = Promise.withResolvers<AccessTokenResponse>()
  const entered = Promise.withResolvers<undefined>()
  poll = () => {
    entered.resolve(undefined)
    return pending.promise
  }
  now += 6000
  const first = device.poll(intent.id, "admin:owner")
  await entered.promise
  expect((await freshDevice().poll(intent.id, "admin:owner")).status).toBe(
    "pending",
  )
  expect(pollCount).toBe(1)
  pending.resolve({ access_token: "fixture-oauth" })
  expect((await first).status).toBe("complete")
})

test("session revocation during upstream polling prevents account persistence", async () => {
  const intent = await start()
  const pending = Promise.withResolvers<AccessTokenResponse>()
  const entered = Promise.withResolvers<undefined>()
  poll = () => {
    entered.resolve(undefined)
    return pending.promise
  }
  now += 6000
  const completing = device.poll(intent.id, "admin:owner")
  await entered.promise
  await accounts.repository.storage.transaction((session) =>
    session.execute({
      sql: "DELETE FROM capi_admin_sessions WHERE token_hash = 'owner'",
      args: [],
    }),
  )
  pending.resolve({ access_token: "late-oauth" })
  await completing
  expect(await accounts.list()).toEqual([])
})

test("device completion replay binds intent owner, domain and validated credential", async () => {
  const created = await start()
  now += 6000
  const intent = await device.repository.claim(created.id, "admin:owner", now)
  if (!intent) throw new Error("Expected device lease")
  const validated = await validator({ token: "fixture-oauth" })
  const mutation = await context("account.device-complete")
  const committed = await device.repository.complete(
    intent,
    validated.persisted,
    () => now,
    mutation,
  )
  const replay = await device.repository.complete(
    intent,
    validated.persisted,
    () => now,
    { ...mutation },
  )
  expect(replay).toEqual(committed)
  await expect(
    device.repository.complete(
      { ...intent, payload: { ...intent.payload, owner: "admin:other" } },
      validated.persisted,
      () => now,
      { ...mutation },
    ),
  ).rejects.toThrow("conflict")
  await expect(
    device.repository.complete(
      { ...intent, instanceDomain: "msft.ghe.com" },
      validated.persisted,
      () => now,
      { ...mutation },
    ),
  ).rejects.toThrow("conflict")
  await expect(
    device.repository.complete(
      intent,
      { ...validated.persisted, token: "different-secret" },
      () => now,
      { ...mutation },
    ),
  ).rejects.toThrow("conflict")
})

test("device cancel replay cannot target another intent", async () => {
  const first = await start()
  const second = await start()
  const mutation = await context("account.device-cancel")
  await device.repository.cancel(first.id, "admin:owner", now, mutation)
  await expect(
    device.repository.cancel(second.id, "admin:owner", now, { ...mutation }),
  ).rejects.toThrow("conflict")
  expect(
    (await device.repository.get(second.id, "admin:owner")).canceledAt,
  ).toBeNull()
})

test("device start replay binds client fields and ignores regenerated server credentials", async () => {
  const input = {
    id: "intent-fixed",
    owner: "admin:owner",
    instanceDomain: "github.com",
    label: null,
    accountType: "individual",
    now,
    code: {
      device_code: "device-secret",
      user_code: "ABCD",
      verification_uri: "https://github.com/login/device",
      expires_in: 60,
      interval: 5,
    },
  }
  const mutation = await context("account.device-start")
  const created = await device.repository.create(input, mutation)
  expect(await device.repository.create(input, { ...mutation })).toEqual(
    created,
  )
  await expect(
    device.repository.create(
      { ...input, owner: "admin:other" },
      { ...mutation },
    ),
  ).rejects.toThrow("conflict")
  await expect(
    device.repository.create(
      { ...input, instanceDomain: "msft.ghe.com" },
      { ...mutation },
    ),
  ).rejects.toThrow("conflict")
  expect(
    await device.repository.create(
      { ...input, code: { ...input.code, device_code: "different-secret" } },
      { ...mutation },
    ),
  ).toEqual(created)
})
