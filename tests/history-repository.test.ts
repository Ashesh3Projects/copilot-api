/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejection matchers must be awaited at runtime. */
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

test("idle runtimes renew their lease and closing one preserves the other run and its counters", async () => {
  const { storage } = await fixture()
  let now = Date.now()
  const first = await createHistoryRuntime(storage, {
    autoFlush: false,
    now: () => now,
  })
  cleanup.unshift(() => first.close(1000).then(() => undefined))
  first.writer.enqueue(usage(now))
  await first.writer.flush()
  now += 290_000
  await first.writer.flush()
  now += 20_000
  const second = await createHistoryRuntime(storage, {
    autoFlush: false,
    now: () => now,
  })
  cleanup.unshift(() => second.close(1000).then(() => undefined))
  second.writer.enqueue({ ...usage(now), id: "second-usage" })
  await second.writer.flush()
  expect((await second.repository.collectionStatus()).unknownGaps).toBe(0)
  await second.close(1000)
  const runs = await storage.read((session) =>
    session.query({
      sql: "SELECT clean, ended_at FROM capi_process_runs ORDER BY started_at",
      args: [],
    }),
  )
  expect(runs).toEqual([
    { clean: 0, ended_at: null },
    { clean: 1, ended_at: now },
  ])
  expect((await first.repository.readUsage(0)).lifetime.requestCount).toBe(2)
  await first.close(1000)
  const restarted = await createHistoryRuntime(storage, {
    autoFlush: false,
    now: () => now,
  })
  cleanup.unshift(() => restarted.close(1000).then(() => undefined))
  expect((await restarted.repository.collectionStatus()).unknownGaps).toBe(0)
})

test("collection loss stays durable across pruning and its time window matches pending records", async () => {
  const { repository } = await fixture()
  const now = Date.now()
  const losses: Array<HistoryRecord> = [
    {
      id: "usage-loss",
      kind: "collection-gap",
      generation: 0,
      recordedAt: now - 2 * 86400_000,
      payload: { historyKind: "usage", lostRecords: 2, lostBytes: 100 },
    },
    {
      id: "routing-loss",
      kind: "collection-gap",
      generation: 0,
      recordedAt: now,
      payload: { historyKind: "routing", lostRecords: 3, lostBytes: 200 },
    },
    {
      id: "unknown-loss",
      kind: "collection-gap",
      generation: 0,
      recordedAt: now + 1,
      payload: { unknown: true, reason: "expired-unconfirmed-batch" },
    },
  ]
  const pending = losses.map((record) => ({ record }))
  const window = { since: now - 1, until: now + 1 }
  expect(await repository.collectionStatus(window, pending)).toEqual({
    knownLostRecords: 3,
    knownLostBytes: 200,
    unknownGaps: 1,
  })
  await repository.applyBatch("losses", losses)
  expect(
    await repository.collectionStatus(
      window,
      losses.map((record) => ({ record, batchId: "losses" })),
    ),
  ).toEqual({ knownLostRecords: 3, knownLostBytes: 200, unknownGaps: 1 })
  await repository.prune(now + 8 * 86400_000)
  expect(await repository.collectionStatus()).toEqual({
    knownLostRecords: 5,
    knownLostBytes: 300,
    unknownGaps: 1,
  })
  expect(await repository.collectionStatus(window)).toEqual({
    knownLostRecords: 3,
    knownLostBytes: 200,
    unknownGaps: 1,
  })
})

test("legacy unknown loss is repaired only with clean-run evidence and genuine loss remains", async () => {
  const { storage, repository } = await fixture()
  const now = Date.now()
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_process_runs(id,started_at,ended_at,clean) VALUES('clean-legacy',?,?,1),('old-legacy',?,NULL,0),('recent-legacy',?,NULL,0)",
      args: [now - 1000, now - 500, now - 8 * 86400_000, now - 600_000],
    },
    {
      sql: "INSERT INTO capi_collection_gaps(id,process_run_id,started_at,kind) VALUES('unclean-clean-legacy','clean-legacy',?,'unknown'),('unclean-old-legacy','old-legacy',?,'unknown'),('unclean-recent-legacy','recent-legacy',?,'unknown')",
      args: [now - 1000, now - 8 * 86400_000, now - 600_000],
    },
    {
      sql: "INSERT INTO capi_collection_gaps(id,process_run_id,started_at,kind,payload_json) VALUES('real-clean-loss','clean-legacy',?,'unknown',?)",
      args: [
        now - 750,
        JSON.stringify({ reason: "expired-unconfirmed-batch" }),
      ],
    },
  ])
  await repository.startRun("current", now)
  expect((await repository.collectionStatus()).unknownGaps).toBe(3)
  await repository.startRun("next", now + 1)
  expect((await repository.collectionStatus()).unknownGaps).toBe(3)
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT id FROM capi_collection_gaps ORDER BY id",
        args: [],
      }),
    ),
  ).toEqual([
    { id: "real-clean-loss" },
    { id: "unclean-old-legacy" },
    { id: "unclean-recent-legacy" },
  ])
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

for (const kind of ["debug", "activity"]) {
  test(`durable history rejects retired ${kind} records before opening a transaction`, async () => {
    let transactions = 0
    const repository = createHistoryRepository({
      read: () => {
        throw new Error("Unexpected storage read")
      },
      transaction: () => {
        transactions++
        throw new Error("Unexpected storage transaction")
      },
      atomicBatch: async () => {},
      close: async () => {},
    })
    await expect(
      repository.applyBatch("retired", [
        {
          id: "retired",
          kind,
          generation: 0,
          recordedAt: Date.now(),
          get payload() {
            throw new Error("Retired payload must not be read")
          },
        } as unknown as HistoryRecord,
      ]),
    ).rejects.toThrow("Unsupported history record kind")
    expect(transactions).toBe(0)
  })
}

test("batched mixed counters commit all deltas once and conflicting batch reuse is rejected", async () => {
  const { repository } = await fixture()
  const now = Date.now()
  const records: Array<HistoryRecord> = Array.from({ length: 200 }, (_, i) => ({
    ...usage(now - i * 60_000),
    id: `usage-${i}`,
  }))
  records.push({
    id: "routing",
    kind: "routing",
    generation: 0,
    recordedAt: now,
    payload: { timestamp: now, totals: { requests: 3, upstreamCalls: 5 } },
  })
  await repository.applyBatch("counter-batch", records)
  await repository.applyBatch("counter-batch", records)
  expect((await repository.readUsage(0)).lifetime).toMatchObject({
    inputTokens: 1400,
    outputTokens: 2200,
    requestCount: 200,
  })
  expect((await repository.readUsage(0)).buckets).toHaveLength(200)
  expect((await repository.readRouting(0)).lifetime).toEqual({
    requests: 3,
    upstreamCalls: 5,
  })
  await expect(
    repository.applyBatch("counter-batch", [usage(now)]),
  ).rejects.toThrow("History batch identity conflict")
  expect((await repository.readUsage(0)).lifetime.requestCount).toBe(200)
})
