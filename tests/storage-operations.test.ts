/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited; Bun's matcher types return void. */
import { afterEach, expect, spyOn, test } from "bun:test"

import type { MutationContext, SqlSession, Storage } from "~/lib/storage/types"

import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { migrateStorage } from "~/lib/storage/migrations"
import { withStorageDeadline } from "~/lib/storage/operation-budget"
import { getStoreRevision, runMutation } from "~/lib/storage/operations"

import { createSchemaFixture, faultStorage } from "./helpers/storage-schema"

const fixtures: Array<Awaited<ReturnType<typeof createSchemaFixture>>> = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})
async function fixture() {
  const value = await createSchemaFixture()
  fixtures.push(value)
  await migrateStorage(value.storage)
  return value.storage
}
function context(
  operationId = "change-1",
  expectedRevision = 0,
): MutationContext {
  return {
    operationId,
    expectedRevision,
    actorId: "verified-admin",
    kind: "settings.replace",
    inputDigest: "validated-input-digest",
  }
}
async function increment(session: SqlSession) {
  await session.execute({
    sql: "UPDATE capi_usage_lifetime SET request_count = request_count + 1 WHERE id = 1",
    args: [],
  })
  return { id: "counter-1" }
}
async function count(storage: Storage) {
  return storage.read(
    async (session) =>
      (
        await session.query({
          sql: "SELECT request_count FROM capi_usage_lifetime WHERE id = 1",
          args: [],
        })
      )[0]?.request_count,
  )
}

test("same expected revision admits exactly one mutation and one marker", async () => {
  const storage = await fixture()
  const results = await Promise.allSettled([
    runMutation(storage, context("one"), increment),
    runMutation(storage, context("two"), increment),
  ])
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  )
  expect(await count(storage)).toBe(1)
  expect(await getStoreRevision(storage)).toBe(1)
})

test("matching operation replay returns the original committed result without applying deltas", async () => {
  const storage = await fixture()
  const first = await runMutation(storage, context(), increment)
  expect(await runMutation(storage, context(), increment)).toEqual(first)
  expect(first).toEqual({ value: { id: "counter-1" }, revision: 1 })
  expect(await count(storage)).toBe(1)
})

test.each(["actorId", "kind", "inputDigest"] as const)(
  "operation replay rejects changed %s",
  async (key) => {
    const storage = await fixture()
    await runMutation(storage, context(), increment)
    await expect(
      runMutation(storage, { ...context(), [key]: "different" }, increment),
    ).rejects.toBeInstanceOf(StorageConflictError)
    expect(await count(storage)).toBe(1)
  },
)

test("failed work rolls back its changes, revision and operation marker", async () => {
  const storage = await fixture()
  await expect(
    runMutation(storage, context(), async (session) => {
      await increment(session)
      throw new Error("synthetic callback failure")
    }),
  ).rejects.toThrow("synthetic callback failure")
  expect(await count(storage)).toBe(0)
  expect(await getStoreRevision(storage)).toBe(0)
  expect(await runMutation(storage, context(), increment)).toEqual({
    value: { id: "counter-1" },
    revision: 1,
  })
})

test("lost commit response reconciles the durable marker without replaying work", async () => {
  const storage = await fixture()
  let once = true
  const injected = faultStorage(storage, {
    afterCommit: () => {
      if (once) {
        once = false
        throw new StorageCommitUnknownError()
      }
    },
  })
  expect(await runMutation(injected, context(), increment)).toEqual({
    value: { id: "counter-1" },
    revision: 1,
  })
  expect(await count(storage)).toBe(1)
})

test("unavailable reconciliation blocks dependent writes until original marker is confirmed", async () => {
  const storage = await fixture()
  let unavailable = true
  const injected = faultStorage(storage, {
    afterCommit: () => {
      throw new StorageCommitUnknownError()
    },
    beforeRead: () => {
      if (unavailable) throw new StorageUnavailableError()
    },
  })
  await expect(
    runMutation(injected, context(), increment),
  ).rejects.toMatchObject({ operationId: "change-1" })
  await expect(
    runMutation(injected, context("dependent", 1), increment),
  ).rejects.toMatchObject({ operationId: "change-1" })
  unavailable = false
  expect(await runMutation(injected, context(), increment)).toEqual({
    value: { id: "counter-1" },
    revision: 1,
  })
  expect(await count(storage)).toBe(1)
  expect(
    await runMutation(injected, context("dependent", 1), increment),
  ).toEqual({ value: { id: "counter-1" }, revision: 2 })
})

test("absent marker after an uncertain failure never blindly replays work", async () => {
  const storage = await fixture()
  const injected = faultStorage(storage, {
    beforeCommit: () => {
      throw new StorageCommitUnknownError()
    },
  })
  await expect(
    runMutation(injected, context(), increment),
  ).rejects.toBeInstanceOf(StorageCommitUnknownError)
  await expect(
    runMutation(injected, context(), increment),
  ).rejects.toBeInstanceOf(StorageCommitUnknownError)
  expect(await count(storage)).toBe(0)
  expect(await getStoreRevision(storage)).toBe(0)
})

test("definitely rolled back contention retries at most twice", async () => {
  const storage = await fixture()
  let failures = 0
  const injected = faultStorage(storage, {
    beforeCommit: () => {
      failures++
      throw new StorageConflictError("Contention", { retryable: true })
    },
  })
  await expect(
    runMutation(injected, context(), increment),
  ).rejects.toBeInstanceOf(StorageConflictError)
  expect(failures).toBe(3)
  expect(await count(storage)).toBe(0)
  expect(await getStoreRevision(storage)).toBe(0)
})

test("retries share one total deadline rather than starting another thirty seconds", async () => {
  const storage = await fixture()
  let elapsed = 0
  let attempts = 0
  const now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed)
  const injected = faultStorage(storage, {
    beforeCommit: () => {
      if (attempts === 1) {
        throw new StorageConflictError("Contention", { retryable: true })
      }
    },
  })
  try {
    await expect(
      runMutation(injected, context(), async (session) => {
        attempts++
        const value = await increment(session)
        elapsed += 20_000
        return value
      }),
    ).rejects.toMatchObject({ code: "storage_unavailable", reason: "timeout" })
    expect(attempts).toBe(2)
  } finally {
    clock.mockRestore()
  }
  expect(await count(storage)).toBe(0)
  expect(await getStoreRevision(storage)).toBe(0)
})

test("expired queue waiter never lets following mutations bypass its predecessor", async () => {
  const storage = await fixture()
  const gate = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  let followingEntered = false
  const first = runMutation(storage, context("first"), async (session) => {
    entered.resolve(undefined)
    await gate.promise
    return increment(session)
  })
  await entered.promise
  try {
    await expect(
      withStorageDeadline(Date.now() + 20, () =>
        runMutation(storage, context("expired", 1), increment),
      ),
    ).rejects.toMatchObject({ code: "storage_unavailable", reason: "timeout" })
    const following = runMutation(
      storage,
      context("following", 1),
      async (session) => {
        followingEntered = true
        return increment(session)
      },
    )
    await Bun.sleep(15)
    expect(followingEntered).toBe(false)
    gate.resolve(undefined)
    await first
    expect((await following).revision).toBe(2)
    expect(await count(storage)).toBe(2)
  } finally {
    gate.resolve(undefined)
    await first
  }
})

test("exhausted commit budget remains unknown instead of granting reconciliation a new deadline", async () => {
  const storage = await fixture()
  const now = Date.now()
  let elapsed = 0
  const clock = spyOn(Date, "now").mockImplementation(() => now + elapsed)
  const injected = faultStorage(storage, {
    afterCommit: () => {
      elapsed = 30_001
      throw new StorageCommitUnknownError()
    },
  })
  try {
    await expect(
      runMutation(injected, context(), increment),
    ).rejects.toMatchObject({
      code: "storage_commit_unknown",
      operationId: "change-1",
    })
  } finally {
    clock.mockRestore()
  }
  expect(await count(storage)).toBe(1)
  expect(await runMutation(injected, context(), increment)).toEqual({
    value: { id: "counter-1" },
    revision: 1,
  })
})

test.each([
  { token: "synthetic-forbidden-value" },
  { nested: { password: "synthetic-forbidden-value" } },
  { api_key: "synthetic-forbidden-value" },
  { value: undefined },
  { count: Number.NaN },
])("unsafe or lossy operation result rolls back", async (result) => {
  const storage = await fixture()
  await expect(
    runMutation(storage, context(), async (session) => {
      await increment(session)
      return result
    }),
  ).rejects.toThrow()
  expect(await count(storage)).toBe(0)
  expect(await getStoreRevision(storage)).toBe(0)
})

test("a different mutation recovers after the prior committed marker becomes readable", async () => {
  const storage = await fixture()
  let unavailable = false
  let first = true
  const injected = faultStorage(storage, {
    afterCommit: () => {
      if (first) {
        first = false
        unavailable = true
        throw new StorageCommitUnknownError()
      }
    },
    beforeRead: () => {
      if (unavailable) throw new StorageUnavailableError()
    },
  })
  await expect(
    runMutation(injected, context("uncertain"), increment),
  ).rejects.toMatchObject({ operationId: "uncertain" })
  unavailable = false
  expect(await runMutation(injected, context("new", 1), increment)).toEqual({
    value: { id: "counter-1" },
    revision: 2,
  })
  expect(await count(storage)).toBe(2)
  expect(await runMutation(injected, context("uncertain"), increment)).toEqual({
    value: { id: "counter-1" },
    revision: 1,
  })
  expect(await count(storage)).toBe(2)
})

test("recovery of an older receipt does not bypass the new mutation revision or identity", async () => {
  const storage = await fixture()
  let unavailable = false
  const injected = faultStorage(storage, {
    afterCommit: () => {
      unavailable = true
      throw new StorageCommitUnknownError()
    },
    beforeRead: () => {
      if (unavailable) throw new StorageUnavailableError()
    },
  })
  await expect(
    runMutation(injected, context("uncertain"), increment),
  ).rejects.toThrow()
  unavailable = false
  await expect(
    runMutation(injected, context("stale", 0), increment),
  ).rejects.toBeInstanceOf(StorageConflictError)
  await expect(
    runMutation(
      injected,
      { ...context("uncertain"), actorId: "wrong-actor" },
      increment,
    ),
  ).rejects.toBeInstanceOf(StorageConflictError)
  expect(await count(storage)).toBe(1)
})

test("parallel receipt reconciliation cannot erase a newer uncertain mutation", async () => {
  const storage = await fixture()
  const events = {
    failReads: false,
    delayReceipt: false,
    waiting: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
    lost: false,
  }
  const injected: Storage = {
    read: async (work) => {
      if (events.failReads) throw new StorageUnavailableError()
      if (events.delayReceipt) {
        events.delayReceipt = false
        const value = await storage.read(work)
        events.waiting.resolve(undefined)
        await events.release.promise
        return value
      }
      return storage.read(work)
    },
    transaction: async (work) => {
      const value = await storage.transaction(work)
      if (!events.lost) {
        events.lost = true
        events.failReads = true
        throw new StorageCommitUnknownError()
      }
      return value
    },
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: () => Promise.resolve(),
  }
  await expect(
    runMutation(injected, context("old"), increment),
  ).rejects.toThrow()
  events.failReads = false
  events.delayReceipt = true
  const { readCommittedMutation } = await import("~/lib/storage/operations")
  const staleLookup = readCommittedMutation(injected, context("old"))
  await events.waiting.promise
  // eslint-disable-next-line require-atomic-updates -- Explicit barrier schedules the next injected commit response loss.
  events.lost = false
  await expect(
    runMutation(injected, context("new", 1), increment),
  ).rejects.toMatchObject({ operationId: "new" })
  events.release.resolve(undefined)
  expect((await staleLookup)?.revision).toBe(1)
  await expect(
    runMutation(injected, context("next", 2), increment),
  ).rejects.toMatchObject({ operationId: "new" })
  expect(await count(storage)).toBe(2)
})
