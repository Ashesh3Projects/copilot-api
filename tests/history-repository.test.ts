import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HistoryRecord } from "~/lib/telemetry-writer"

import { createHistoryRepository } from "~/lib/storage/history-repository"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import { TursoStorage } from "~/lib/storage/turso"
import {
  createHistoryRuntime,
  createTelemetryWriter,
} from "~/lib/telemetry-writer"

import { createFakeTursoFetch, testConfig } from "./helpers/turso-transport"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

test("uncertain clear blocks new diagnostics with visible loss until generation recovery", async () => {
  const { storage } = await fixture()
  let loseClear = false
  let unavailable = false
  const runtime = await createHistoryRuntime(
    {
      read: (work) =>
        unavailable ?
          Promise.reject(new Error("unavailable"))
        : storage.read(work),
      atomicBatch: (statements) => storage.atomicBatch(statements),
      close: () => storage.close(),
      async transaction(work) {
        const result = await storage.transaction(work)
        if (loseClear) {
          loseClear = false
          unavailable = true
          throw new Error("lost response")
        }
        return result
      },
    },
    { autoFlush: false },
  )
  const diagnostic = (id: string): HistoryRecord => ({
    id,
    kind: "debug",
    recordedAt: Date.now(),
    generation: runtime.generations.debug,
    payload: { type: "info", message: "safe" },
  })
  const preClear = diagnostic("old-capture")
  try {
    loseClear = true
    let rejected = false
    try {
      await runtime.clear("debug")
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    expect(runtime.writer.status().degraded).toBe(true)
    expect(runtime.writer.enqueue(diagnostic("during-unknown"))).toBe(false)
    expect(runtime.writer.status().droppedRecords).toBe(1)
    await runtime.writer.flush()
    expect(runtime.writer.status().degraded).toBe(true)
    unavailable = false
    await runtime.writer.flush()
    expect(runtime.generations.debug).toBe(1)
    runtime.writer.enqueue(preClear)
    expect(runtime.writer.enqueue(diagnostic("after-recovery"))).toBe(true)
    await runtime.writer.flush()
    expect(
      (await runtime.repository.list("debug")).records.map(
        (record) => record.id,
      ),
    ).toEqual(["after-recovery"])
    expect((await runtime.repository.collectionStatus()).knownLostRecords).toBe(
      1,
    )
    expect(runtime.writer.status().degraded).toBe(false)
  } finally {
    unavailable = false
    await runtime.close(500)
  }
})

test("concurrent clear response delays cannot move the cached generation backwards", async () => {
  const { storage } = await fixture()
  const committed = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let delay = false
  let transactions = 0
  const runtime = await createHistoryRuntime(
    {
      read: (work) => storage.read(work),
      atomicBatch: (statements) => storage.atomicBatch(statements),
      close: () => storage.close(),
      async transaction(work) {
        transactions++
        const result = await storage.transaction(work)
        if (delay) {
          delay = false
          committed.resolve(undefined)
          await release.promise
        }
        return result
      },
    },
    { autoFlush: false },
  )
  try {
    const initialTransactions = transactions
    delay = true
    const first = runtime.clear("debug")
    await committed.promise
    const second = runtime.clear("debug")
    await Bun.sleep(20)
    expect(transactions).toBe(initialTransactions + 1)
    release.resolve(undefined)
    expect(await first).toBe(1)
    expect(await second).toBe(2)
    expect(runtime.generations.debug).toBe(2)
  } finally {
    release.resolve(undefined)
    await runtime.close(500)
  }
})

test("Turso SDK transport retries a lost history commit without duplicate usage", async () => {
  const options = { loseFirstCommitResponse: false }
  const transport = createFakeTursoFetch(options)
  const storage = new TursoStorage(testConfig())
  const repository = createHistoryRepository(storage)
  const writer = createTelemetryWriter(
    repository,
    { now: Date.now },
    { autoFlush: false },
  )
  try {
    await migrateStorage(storage)
    options.loseFirstCommitResponse = true
    writer.enqueue(usage(Date.now()))
    await writer.flush()
    expect(writer.status().pendingRecords).toBe(1)
    expect(
      (await writer.read((pending) => repository.readUsage(0, pending)))
        .lifetime.requestCount,
    ).toBe(1)
    await writer.flush()
    expect(writer.status().pendingRecords).toBe(0)
    expect((await repository.readUsage(0)).lifetime.requestCount).toBe(1)
  } finally {
    await writer.close(500)
    await storage.close()
    transport.close()
  }
})

test("clear reconciles its receipt after a lost commit response", async () => {
  const { storage } = await fixture()
  let lose = true
  const repository = createHistoryRepository({
    read: (work) => storage.read(work),
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: () => storage.close(),
    async transaction(work) {
      const value = await storage.transaction(work)
      if (lose) {
        lose = false
        throw new Error("commit response lost")
      }
      return value
    },
  })
  expect(await repository.clear("debug")).toBe(1)
  expect(await repository.generations()).toMatchObject({ debug: 1 })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "capi-history-"))
  const storage = new LocalSqliteStorage(join(directory, "fixture.sqlite"))
  cleanup.push(async () => {
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  await migrateStorage(storage)
  return { storage, repository: createHistoryRepository(storage) }
}

function usage(now: number): HistoryRecord {
  return {
    id: "usage-1",
    kind: "usage",
    generation: 0,
    recordedAt: now,
    payload: {
      timestamp: Math.floor(now / 60_000) * 60_000,
      model: "model-a",
      inputTokens: 7,
      outputTokens: 11,
      requestCount: 1,
      firstRequestAt: now,
    },
  }
}

test("usage receipt and all deltas commit atomically and replay exactly once", async () => {
  const { repository, storage } = await fixture()
  const now = Date.now()
  await repository.applyBatch("batch-1", [usage(now)])
  await repository.applyBatch("batch-1", [usage(now)])
  const data = await repository.readUsage(now - 60_000)
  expect(data.lifetime).toMatchObject({
    inputTokens: 7,
    outputTokens: 11,
    requestCount: 1,
  })
  expect(data.buckets).toHaveLength(1)
  const revision = await storage.read((s) =>
    s.query({
      sql: "SELECT value FROM capi_metadata WHERE key = 'config_revision'",
      args: [],
    }),
  )
  expect(revision[0]?.value).toBe("0")
})

test("pruning retains old usage minutes and lifetime totals", async () => {
  const { repository } = await fixture()
  const now = Date.now()
  await repository.applyBatch("old", [usage(now - 90 * 86400_000)])
  await repository.prune(now)
  expect((await repository.readUsage(0)).buckets).toHaveLength(1)
  expect((await repository.readUsage(now)).lifetime.requestCount).toBe(1)
})

test("clear generation prevents queued debug from resurrecting", async () => {
  const { repository } = await fixture()
  const record: HistoryRecord = {
    id: "a",
    kind: "debug",
    generation: 0,
    recordedAt: Date.now(),
    payload: { type: "info", message: "safe" },
  }
  await repository.applyBatch("first", [record])
  expect((await repository.list("debug")).records).toHaveLength(1)
  expect(await repository.clear("debug")).toBe(1)
  await repository.applyBatch("delayed", [{ ...record, id: "b" }])
  expect((await repository.list("debug")).records).toHaveLength(0)
})

test("only stale unclosed runs create one unknown gap, not concurrently healthy or clean runs", async () => {
  const { storage } = await fixture()
  let now = Date.now()
  const repository = createHistoryRepository(storage, { now: () => now })
  await repository.startRun("first", now)
  await repository.startRun("second", now)
  expect((await repository.collectionStatus()).unknownGaps).toBe(0)
  await repository.endRun("second", now)
  now += 300_001
  await repository.startRun("third", now)
  await repository.startRun("fourth", now)
  expect(await repository.collectionStatus()).toMatchObject({
    knownLostRecords: 0,
    unknownGaps: 1,
  })
})

test("idle runtimes renew their lease and closing only interrupts their own unfinished captures", async () => {
  const { storage } = await fixture()
  let now = Date.now()
  const first = await createHistoryRuntime(storage, {
    autoFlush: false,
    now: () => now,
  })
  const capture = (id: string): HistoryRecord => ({
    id,
    kind: "debug",
    generation: 0,
    recordedAt: now,
    payload: {
      status: "streaming",
      replayable: true,
      request: { body: "exact fixture" },
    },
  })
  first.writer.enqueue(capture("first-capture"))
  await first.writer.flush()
  now += 290_000
  await first.writer.flush()
  now += 20_000
  const second = await createHistoryRuntime(storage, {
    autoFlush: false,
    now: () => now,
  })
  try {
    second.writer.enqueue(capture("second-capture"))
    await second.writer.flush()
    expect((await second.repository.collectionStatus()).unknownGaps).toBe(0)
    expect(
      (await second.repository.get("debug", "first-capture"))?.payload,
    ).toMatchObject({ status: "streaming" })
    await second.close(1000)
    expect(
      (await first.repository.get("debug", "first-capture"))?.payload,
    ).toMatchObject({ status: "streaming" })
    expect(
      (await first.repository.get("debug", "second-capture"))?.payload,
    ).toMatchObject({ status: "interrupted", replayable: false })
  } finally {
    await second.close(1000)
    await first.close(1000)
  }
  const restarted = await createHistoryRuntime(storage, {
    autoFlush: false,
    now: () => now,
  })
  expect((await restarted.repository.collectionStatus()).unknownGaps).toBe(0)
  await restarted.close(1000)
})

test("debug gaps follow retention and clear generations while usage loss stays visible", async () => {
  const { storage } = await fixture()
  let now = Date.now()
  const repository = createHistoryRepository(storage, { now: () => now })
  const gap = (
    id: string,
    historyKind: string,
    generation: number,
  ): HistoryRecord => ({
    id,
    kind: "collection-gap",
    generation,
    recordedAt: now,
    payload: { historyKind, generation, lostRecords: 2, lostBytes: 100 },
  })
  await repository.applyBatch("losses", [
    { ...gap("expired", "debug", 0), recordedAt: now - 2 * 3600_000 },
    gap("debug", "debug", 0),
    gap("usage", "usage", 0),
  ])
  expect(
    (await repository.collectionStatus({ kind: "debug" })).knownLostRecords,
  ).toBe(2)
  now++
  await repository.clear("debug")
  expect(
    (await repository.collectionStatus({ kind: "debug" })).knownLostRecords,
  ).toBe(0)
  expect((await repository.collectionStatus()).knownLostRecords).toBe(6)
  await repository.applyBatch("late-cleared-loss", [gap("delayed", "debug", 0)])
  expect(
    (await repository.collectionStatus({ kind: "debug" })).knownLostRecords,
  ).toBe(0)
  await repository.applyBatch("new-loss", [gap("new", "debug", 1)])
  expect(
    (await repository.collectionStatus({ kind: "debug" })).knownLostRecords,
  ).toBe(2)
})

test("legacy unknown gaps are bounded, clearable, and repaired only with evidence of a clean run", async () => {
  const { storage } = await fixture()
  let now = Date.now()
  const repository = createHistoryRepository(storage, { now: () => now })
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_process_runs(id,started_at,ended_at,clean) VALUES('clean-legacy',?,?,1),('old-legacy',?,NULL,0),('recent-legacy',?,NULL,0)",
      args: [now - 1000, now - 500, now - 8 * 86400_000, now - 600_000],
    },
    {
      sql: "INSERT INTO capi_collection_gaps(id,process_run_id,started_at,kind) VALUES('unclean-clean-legacy','clean-legacy',?,'unknown'),('unclean-old-legacy','old-legacy',?,'unknown'),('unclean-recent-legacy','recent-legacy',?,'unknown')",
      args: [now - 1000, now - 8 * 86400_000, now - 600_000],
    },
  ])
  await repository.startRun("current", now)
  expect(
    (await repository.collectionStatus({ kind: "debug" })).unknownGaps,
  ).toBe(1)
  expect((await repository.collectionStatus()).unknownGaps).toBe(2)
  now++
  await repository.clear("debug")
  await repository.startRun("next", now)
  expect(
    (await repository.collectionStatus({ kind: "debug" })).unknownGaps,
  ).toBe(0)
  expect((await repository.collectionStatus()).unknownGaps).toBe(2)
})

test("routing aggregation preserves prototype-like route keys as data", async () => {
  const { repository } = await fixture()
  const now = Date.now()
  const payload = {
    timestamp: 0,
    totals: { requests: 1 },
    routes: Object.fromEntries([
      ["__proto__", { requests: 1, upstreamCalls: 0 }],
    ]),
  }
  payload.timestamp = Math.floor(now / 60000) * 60000
  const routing: HistoryRecord = {
    id: "r",
    kind: "routing",
    generation: 0,
    recordedAt: now,
    payload,
  }
  await repository.applyBatch("special1", [routing])
  await repository.applyBatch("special2", [routing])
  expect(JSON.stringify((await repository.readRouting(0)).buckets)).toContain(
    '"__proto__":{"requests":2',
  )
})

test("pending diagnostic completion removes the old status-filtered version", async () => {
  const { repository } = await fixture()
  const now = Date.now()
  const record: HistoryRecord = {
    id: "debug-update",
    kind: "debug",
    generation: 0,
    recordedAt: now,
    payload: { status: "pending", updatedAt: now },
  }
  await repository.applyBatch("debug-start", [record])
  const pending = [
    {
      record: {
        ...record,
        payload: { status: "complete", updatedAt: now + 1 },
      },
    },
  ]
  expect(
    (await repository.list("debug", { type: "pending" }, pending)).records,
  ).toHaveLength(0)
  expect(
    (await repository.list("debug", { type: "complete" }, pending)).records,
  ).toHaveLength(1)
})

test("expired pending completion suppresses the older unfinished diagnostic", async () => {
  const { repository } = await fixture()
  const now = Date.now()
  const record: HistoryRecord = {
    id: "debug-expired",
    kind: "debug",
    generation: 0,
    recordedAt: now - 11 * 60000,
    payload: {
      status: "pending",
      startedAtMs: now - 11 * 60000,
      updatedAt: now,
    },
  }
  await repository.applyBatch("expired-start", [record])
  const pending = [
    {
      record: {
        ...record,
        payload: {
          status: "complete",
          startedAtMs: now - 11 * 60000,
          updatedAt: now + 1,
        },
      },
    },
  ]
  expect((await repository.list("debug", {}, pending)).records).toHaveLength(0)
  expect(await repository.get("debug", record.id, pending)).toBeNull()
})

test("debug expiry and row caps are applied while usage remains intact", async () => {
  const { repository, storage } = await fixture()
  const now = Date.now()
  await storage.transaction(async (s) => {
    await s.execute({
      sql: `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 2002) INSERT INTO capi_debug (id, generation, created_at, updated_at, expires_at, status, payload_json, payload_bytes) SELECT printf('%06d', n), 0, ?, 0, ?, 'pending', '{}', 2 FROM ids`,
      args: [now, now + 86400_000],
    })
  })
  await repository.prune(now)
  const rows = await storage.read((s) =>
    s.query({
      sql: "SELECT COUNT(*) AS count, MIN(id) AS oldest FROM capi_debug",
      args: [],
    }),
  )
  expect(rows[0]).toEqual({ count: 2000, oldest: "000003" })
  await repository.prune(now + 2 * 86400_000)
  expect((await repository.list("debug")).records).toHaveLength(0)
})

test("batched debug updates keep newest completion, respect clear generations, and deduplicate receipts", async () => {
  const { repository, storage } = await fixture()
  const now = Date.now()
  const debug = (
    id: string,
    updatedAt: number,
    status: string,
  ): HistoryRecord => ({
    id,
    kind: "debug",
    generation: 0,
    recordedAt: now,
    payload: { startedAtMs: now, updatedAt, status, replayable: false },
  })
  const batch = [
    ...Array.from({ length: 110 }, (_, i) =>
      debug(`batch-${i}`, now, "pending"),
    ),
    debug("batch-0", now + 2, "complete"),
    debug("batch-0", now + 1, "pending"),
  ]
  await repository.applyBatch("debug-batch", batch)
  await repository.applyBatch("debug-batch", batch)
  expect((await repository.get("debug", "batch-0"))?.payload).toMatchObject({
    status: "complete",
    updatedAt: now + 2,
  })
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT count(*) AS count FROM capi_debug",
        args: [],
      }),
    ),
  ).toEqual([{ count: 110 }])
  await repository.clear("debug")
  await repository.applyBatch("debug-after-clear", [
    debug("stale", now, "pending"),
    { ...debug("current", now, "complete"), generation: 1 },
  ])
  expect(
    (await repository.list("debug")).records.map((record) => record.id),
  ).toEqual(["current"])
})
