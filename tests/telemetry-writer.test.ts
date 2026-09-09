import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createHistoryRepository } from "~/lib/storage/history-repository"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import {
  createTelemetryWriter,
  type HistoryRecord,
  type TelemetryWriter,
} from "~/lib/telemetry-writer"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
function record(
  id: string,
  now: number,
  kind: HistoryRecord["kind"] = "usage",
): HistoryRecord {
  return {
    id,
    kind,
    recordedAt: now,
    generation: 0,
    payload:
      kind === "usage" ?
        {
          timestamp: Math.floor(now / 60_000) * 60_000,
          inputTokens: 7,
          outputTokens: 11,
          requestCount: 1,
          firstRequestAt: now,
        }
      : {
          timestamp: Math.floor(now / 60_000) * 60_000,
          totals: { requests: 1, upstreamCalls: 2 },
        },
  }
}
async function fixture(
  options: {
    fail?: boolean
    lose?: boolean
    now?: number
    autoFlush?: boolean
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "capi-writer-"))
  const storage = new LocalSqliteStorage(join(directory, "fixture.sqlite"))
  await migrateStorage(storage)
  const repository = createHistoryRepository(storage)
  let fail = options.fail ?? false
  let lose = options.lose ?? false
  let now = options.now ?? Date.now()
  const ids: Array<string> = []
  const writer: TelemetryWriter = createTelemetryWriter(
    {
      ...repository,
      async applyBatch(id, records) {
        ids.push(id)
        if (fail) throw new Error("private transport failure")
        await repository.applyBatch(id, records)
        if (lose) {
          lose = false
          throw new Error("lost commit response")
        }
      },
    },
    { now: () => now },
    { autoFlush: options.autoFlush ?? false },
  )
  cleanup.push(async () => {
    await writer.close(50)
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    writer,
    repository,
    ids,
    recover: () => {
      fail = false
    },
    tick: (ms: number) => {
      now += ms
    },
    now,
  }
}

test("a committed batch with a lost response retries with the same id once", async () => {
  const f = await fixture({ lose: true })
  f.writer.enqueue(record("event", f.now))
  await f.writer.flush()
  expect(f.writer.status().pendingRecords).toBe(1)
  const during = await f.writer.read((pending) =>
    f.repository.readUsage(0, pending),
  )
  expect(during.lifetime.requestCount).toBe(1)
  await f.writer.flush()
  expect(f.ids[0]).toBe(f.ids[1])
  expect(f.writer.status().pendingRecords).toBe(0)
  expect((await f.repository.readUsage(0)).lifetime).toMatchObject({
    inputTokens: 7,
    outputTokens: 11,
    requestCount: 1,
  })
})

test("queue owns immutable counter snapshots and records loss when its record cap evicts the oldest", async () => {
  const f = await fixture({ fail: true })
  for (let i = 0; i < 2000; i++)
    f.writer.enqueue(record(`counter-${i}`, f.now, i % 2 ? "routing" : "usage"))
  const value = record("latest", f.now)
  expect(f.writer.enqueue(value)).toBe(true)
  value.payload = null
  expect(f.writer.status()).toMatchObject({
    pendingRecords: 2000,
    droppedRecords: 1,
    degraded: true,
  })
  f.recover()
  await f.writer.flush()
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1000)
  expect((await f.repository.readRouting(0)).lifetime).toMatchObject({
    requests: 1000,
    upstreamCalls: 2000,
  })
  expect((await f.repository.collectionStatus()).knownLostRecords).toBe(1)
})

test("expired pending records expose loss and byte accounting stays bounded", async () => {
  const f = await fixture({ fail: true })
  f.writer.enqueue(record("expired", f.now))
  f.tick(300_001)
  await f.writer.flush()
  expect(f.writer.status()).toMatchObject({
    pendingRecords: 0,
    pendingBytes: 0,
    droppedRecords: 1,
    degraded: true,
  })
  f.recover()
  await f.writer.flush()
  expect((await f.repository.collectionStatus()).knownLostRecords).toBe(1)
})

test("shutdown stops admission and returns at its deadline on storage failure", async () => {
  const f = await fixture({ fail: true })
  f.writer.enqueue(record("left", f.now))
  const result = await f.writer.close(10)
  expect(result.pendingRecords).toBe(1)
  expect(f.writer.enqueue(record("late", f.now))).toBe(false)
})

test("shutdown drains counters queued after an uncertain batch", async () => {
  const f = await fixture({ lose: true })
  f.writer.enqueue(record("first", f.now))
  await f.writer.flush()
  f.writer.enqueue(record("second", f.now))
  const status = await f.writer.close(500)
  expect(status.pendingRecords).toBe(0)
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(2)
})

test("the 16 MiB cap rejects an oversized counter and preserves queued telemetry and loss evidence", async () => {
  const f = await fixture()
  f.writer.enqueue(record("counter", f.now))
  const oversized = {
    ...record("huge", f.now),
    payload: { model: "x".repeat(16 * 1024 * 1024), requestCount: 1 },
  }
  expect(f.writer.enqueue(oversized)).toBe(false)
  expect(f.writer.status().pendingBytes).toBeLessThan(16 * 1024 * 1024)
  await f.writer.flush()
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1)
  expect(await f.repository.collectionStatus()).toMatchObject({
    knownLostRecords: 1,
    knownLostBytes: Buffer.byteLength(JSON.stringify(oversized)),
  })
})

test("the one-second trigger is canceled on close", async () => {
  const f = await fixture({ autoFlush: true })
  f.writer.enqueue(record("timer", f.now))
  await Bun.sleep(1100)
  expect(f.writer.status().pendingRecords).toBe(0)
  await f.writer.close(500)
  const calls = f.ids.length
  await Bun.sleep(1100)
  expect(f.ids).toHaveLength(calls)
})

test("one hundred records trigger a flush without waiting for the timer", async () => {
  const f = await fixture({ autoFlush: true })
  for (let i = 0; i < 100; i++) f.writer.enqueue(record(String(i), f.now))
  await f.writer.read(async () => {})
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(100)
})

test("expiring a batch with unknown commit outcome never claims exact loss", async () => {
  const f = await fixture({ lose: true })
  f.writer.enqueue(record("unknown", f.now))
  await f.writer.flush()
  f.tick(300_001)
  await f.writer.flush()
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1)
  expect(await f.repository.collectionStatus()).toMatchObject({
    knownLostRecords: 0,
    unknownGaps: 1,
  })
})

test("a failed counter batch remains immutable while newer counters use bounded queue capacity", async () => {
  const f = await fixture({ fail: true })
  for (let i = 0; i < 2000; i++) f.writer.enqueue(record(`counter-${i}`, f.now))
  await f.writer.flush()
  expect(f.writer.enqueue(record("latest", f.now))).toBe(true)
  f.recover()
  await f.writer.close(1000)
  expect(f.ids[0]).toBe(f.ids[1])
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(2000)
  expect((await f.repository.collectionStatus()).knownLostRecords).toBe(1)
})

test("byte pressure evicts whole counters without rewriting the retained payloads", async () => {
  const f = await fixture()
  const model = "x".repeat(4 * 1024 * 1024)
  for (let i = 0; i < 5; i++)
    f.writer.enqueue({
      ...record(`large-${i}`, f.now),
      payload: { timestamp: f.now, model: `${i}-${model}`, requestCount: 1 },
    })
  expect(f.writer.status()).toMatchObject({
    pendingRecords: 3,
    droppedRecords: 2,
  })
  expect(f.writer.status().pendingBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
  const retained = await f.writer.read((pending) =>
    Promise.resolve(pending.filter((item) => item.record.kind === "usage")),
  )
  expect(retained.map((item) => item.record.id)).toEqual([
    "large-2",
    "large-3",
    "large-4",
  ])
  expect((retained[0].record.payload as { model: string }).model).toBe(
    `2-${model}`,
  )
  await f.writer.flush()
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(3)
  expect((await f.repository.collectionStatus()).knownLostRecords).toBe(2)
})

for (const kind of ["debug", "activity"]) {
  test(`telemetry refuses retired ${kind} records before retaining or serializing their payload`, async () => {
    const f = await fixture()
    const retired = {
      ...record("retired", f.now),
      kind,
      get payload() {
        throw new Error("Retired payload must not be read")
      },
    } as unknown as HistoryRecord
    expect(f.writer.enqueue(retired)).toBe(false)
    expect(f.writer.status()).toMatchObject({
      pendingRecords: 0,
      pendingBytes: 0,
      droppedRecords: 0,
      degraded: false,
    })
    expect(await f.writer.read((pending) => Promise.resolve(pending))).toEqual(
      [],
    )
    f.writer.enqueue(record("after-retired", f.now))
    await f.writer.flush()
    expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1)
  })
}

test("mixed unique usage and routing counters flush at 30ms SQL latency without loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capi-history-latency-"))
  const storage = new LocalSqliteStorage(join(directory, "fixture.sqlite"))
  await migrateStorage(storage)
  let queries = 0
  const delayed = (
    session: import("~/lib/storage/types").SqlSession,
  ): import("~/lib/storage/types").SqlSession => ({
    query: async (statement) => {
      queries++
      await Bun.sleep(30)
      return session.query(statement)
    },
    execute: async (statement) => {
      queries++
      await Bun.sleep(30)
      return session.execute(statement)
    },
  })
  const repository = createHistoryRepository({
    read: (work) => storage.read((session) => work(delayed(session))),
    transaction: (work) =>
      storage.transaction((session) => work(delayed(session))),
    atomicBatch: (statements) => storage.atomicBatch(statements),
    close: () => Promise.resolve(),
  })
  const writer = createTelemetryWriter(
    repository,
    { now: Date.now },
    { autoFlush: false },
  )
  cleanup.push(async () => {
    await writer.close(1)
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  const now = Date.now()
  for (let i = 0; i < 100; i++) {
    const event = record(
      `counter-${i}`,
      now - i * 60_000,
      i % 2 ? "usage" : "routing",
    )
    event.payload =
      i % 2 ?
        {
          timestamp: now - i * 60_000,
          model: `model-${i}`,
          inputTokens: 7,
          outputTokens: 11,
          requestCount: 1,
          firstRequestAt: now - i * 60_000,
        }
      : {
          timestamp: now - i * 60_000,
          totals: { requests: 1, upstreamCalls: 2 },
          models: { [`model-${i}`]: { requests: 1 } },
        }
    writer.enqueue(event)
  }
  await writer.flush()
  expect(writer.status()).toMatchObject({ pendingRecords: 0, degraded: false })
  expect(queries).toBeLessThan(30)
  expect((await repository.readUsage(0)).lifetime).toMatchObject({
    inputTokens: 350,
    outputTokens: 550,
    requestCount: 50,
  })
  expect((await repository.readUsage(0)).buckets).toHaveLength(50)
  expect((await repository.readRouting(0)).lifetime).toMatchObject({
    requests: 50,
    upstreamCalls: 100,
  })
  expect((await repository.readRouting(0)).buckets).toHaveLength(50)
}, 15000)
