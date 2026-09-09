import { randomUUID } from "node:crypto"

import type { HistoryRepository } from "~/lib/storage/history-repository"
import type { JsonValue, Storage } from "~/lib/storage/types"

import { StorageUnavailableError } from "~/lib/storage/errors"
import {
  createHistoryRepository,
  historyObject,
  isHistoryRecordKind,
  sumHistoryCounters,
} from "~/lib/storage/history-repository"
import { withStorageDeadline } from "~/lib/storage/operation-budget"

export interface HistoryRecord {
  id: string
  kind: "usage" | "routing" | "collection-gap"
  recordedAt: number
  generation: number
  payload: JsonValue
}
export interface PendingHistoryRecord {
  record: HistoryRecord
  batchId?: string
}
export interface TelemetryStatus {
  pendingRecords: number
  pendingBytes: number
  droppedRecords: number
  lastSuccessfulFlush: number | null
  degraded: boolean
}
export interface TelemetryWriter {
  enqueue(record: HistoryRecord): boolean
  flush(): Promise<void>
  status(): TelemetryStatus
  close(deadlineMs: number): Promise<TelemetryStatus>
  read<T>(
    work: (pending: ReadonlyArray<PendingHistoryRecord>) => Promise<T>,
  ): Promise<T>
}
export interface HistoryRuntime {
  storage: Storage
  repository: HistoryRepository
  writer: TelemetryWriter
  close(deadlineMs: number): Promise<TelemetryStatus>
}
interface Queued {
  record: HistoryRecord
  bytes: number
  enqueuedAt: number
}
interface Batch {
  id: string
  items: Array<Queued>
  records: Array<HistoryRecord>
  createdAt: number
}
interface TelemetryWriterOptions {
  autoFlush?: boolean
  beforeFlush?: () => Promise<void>
}
const MAX_RECORDS = 2000,
  MAX_BYTES = 16 * 1024 * 1024,
  MAX_AGE = 300_000
let lastWarning = -Infinity
export function reportTelemetryFailure(): void {
  if (Date.now() - lastWarning < 60_000) return
  lastWarning = Date.now()
  process.stderr.write(
    "History collection is degraded; buffered records may be lost.\n",
  )
}

function coalesce(records: ReadonlyArray<HistoryRecord>): Array<HistoryRecord> {
  const counters = new Map<string, HistoryRecord>(),
    collectionGaps: Array<HistoryRecord> = []
  for (const record of records) {
    if (record.kind !== "usage" && record.kind !== "routing") {
      collectionGaps.push(record)
      continue
    }
    const p = historyObject(record.payload)
    const key = JSON.stringify([
      record.kind,
      p.timestamp,
      record.kind === "usage" ? (p.model ?? "") : "",
    ])
    const prior = counters.get(key)
    if (!prior) {
      counters.set(key, structuredClone(record))
      continue
    }
    const old = historyObject(prior.payload)
    prior.payload = sumHistoryCounters(prior.payload, record.payload)
    if (record.kind === "usage")
      historyObject(prior.payload).firstRequestAt = Math.min(
        Number(old.firstRequestAt ?? prior.recordedAt),
        Number(p.firstRequestAt ?? record.recordedAt),
      )
  }
  return [...counters.values(), ...collectionGaps]
}

// eslint-disable-next-line max-lines-per-function -- One closure owns queue, retry batch and admission state.
export function createTelemetryWriter(
  repository: HistoryRepository,
  clock: { now(): number } = { now: Date.now },
  options: TelemetryWriterOptions = {},
): TelemetryWriter {
  const queue: Array<Queued> = []
  const gaps = new Map<string, HistoryRecord>()
  let active: Batch | undefined,
    pendingBytes = 0,
    droppedRecords = 0
  let lastSuccessfulFlush: number | null = null,
    failed = false,
    closed = false
  let closing: Promise<TelemetryStatus> | undefined
  let flushing: Promise<void> | undefined
  let flushDeadline = Infinity
  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work)
    tail = result.catch(() => undefined)
    return result
  }
  const count = () => queue.length + (active?.items.length ?? 0)
  const loss = (item: Queued, unknown = false) => {
    const key = JSON.stringify([item.record.kind, unknown])
    const prior = gaps.get(key)
    const payload =
      prior ?
        historyObject(prior.payload)
      : {
          historyKind: item.record.kind,
          startedAt: item.enqueuedAt,
          ...(unknown ?
            { unknown: true, reason: "expired-unconfirmed-batch" }
          : { lostRecords: 0, lostBytes: 0 }),
        }
    if (!unknown) {
      payload.lostRecords = Number(payload.lostRecords) + 1
      payload.lostBytes = Number(payload.lostBytes) + item.bytes
    }
    gaps.set(key, {
      id: prior?.id ?? randomUUID(),
      kind: "collection-gap",
      generation: item.record.generation,
      recordedAt: clock.now(),
      payload,
    })
    failed = true
  }
  const drop = (item: Queued) => {
    pendingBytes -= item.bytes
    droppedRecords++
    loss(item)
  }
  const expire = () => {
    for (let i = queue.length - 1; i >= 0; i--)
      if (clock.now() - queue[i].enqueuedAt > MAX_AGE)
        drop(queue.splice(i, 1)[0])
    if (active && clock.now() - active.createdAt > MAX_AGE) {
      for (const item of active.items) {
        pendingBytes -= item.bytes
        droppedRecords++
        loss(item, true)
      }
      // A response may have been lost after commit. Never assert an exact loss.
      for (const record of active.records)
        if (record.kind === "collection-gap") {
          const payload = historyObject(record.payload)
          gaps.set(record.id, {
            ...record,
            id: randomUUID(),
            recordedAt: clock.now(),
            payload: {
              ...payload,
              unknown: true,
              reason: "expired-unconfirmed-batch",
            },
          })
        }
      failed = true
      active = undefined
    }
  }
  const snapshot = (): TelemetryStatus => ({
    pendingRecords: count(),
    pendingBytes,
    droppedRecords,
    lastSuccessfulFlush,
    degraded: failed || gaps.size > 0,
  })
  const flushOnce = async () => {
    try {
      if (options.beforeFlush)
        await withStorageDeadline(
          Math.min(Date.now() + 5000, flushDeadline),
          options.beforeFlush,
        )
    } catch {
      failed = true
      reportTelemetryFailure()
      return
    }
    expire()
    if (!active) {
      const items: Array<Queued> = []
      let batchBytes = 0
      while (
        queue.length > 0
        && items.length < 100
        && (items.length === 0 || batchBytes + queue[0].bytes <= 1024 * 1024)
      ) {
        const item = queue.shift()
        if (!item) break
        items.push(item)
        batchBytes += item.bytes
      }
      if (items.length === 0 && gaps.size === 0) {
        failed = false
        return
      }
      const records = coalesce(items.map((item) => item.record))
      records.push(...gaps.values())
      gaps.clear()
      active = { id: randomUUID(), items, records, createdAt: clock.now() }
    }
    try {
      const batch = active
      await withStorageDeadline(
        Math.min(Date.now() + 5000, flushDeadline),
        () => repository.applyBatch(batch.id, batch.records),
      )
      for (const item of active.items) pendingBytes -= item.bytes
      active = undefined
      lastSuccessfulFlush = clock.now()
      failed = false
    } catch {
      failed = true
      reportTelemetryFailure()
    }
  }
  const timer =
    options.autoFlush === false ?
      undefined
    : setInterval(() => {
        if (!closed) void writer.flush()
      }, 1000)
  timer?.unref()
  const writer: TelemetryWriter = {
    enqueue(record) {
      if (closed || !isHistoryRecordKind(record.kind)) return false
      try {
        const serialized = JSON.stringify(record)
        const bytes = Buffer.byteLength(serialized)
        const item: Queued = {
          record: JSON.parse(serialized) as HistoryRecord,
          bytes,
          enqueuedAt: clock.now(),
        }
        if (bytes > MAX_BYTES) {
          droppedRecords++
          loss(item)
          return false
        }
        while (count() >= MAX_RECORDS || pendingBytes + bytes > MAX_BYTES) {
          const oldest = queue.shift()
          if (!oldest) {
            droppedRecords++
            loss(item)
            return false
          }
          drop(oldest)
        }
        queue.push(item)
        pendingBytes += bytes
        if (options.autoFlush !== false && queue.length >= 100)
          void writer.flush()
        return true
      } catch {
        failed = true
        reportTelemetryFailure()
        return false
      }
    },
    flush() {
      flushing ??= serialize(async () => {
        for (let batch = 0; batch < 20; batch++) {
          await flushOnce()
          if (failed || (!count() && gaps.size === 0)) break
        }
      }).finally(() => {
        flushing = undefined
      })
      return flushing
    },
    status: snapshot,
    read(work) {
      return serialize(() =>
        work([
          ...(active?.items.map((item) => ({
            record: structuredClone(item.record),
            batchId: active?.id,
          })) ?? []),
          ...queue.map((item) => ({ record: structuredClone(item.record) })),
          ...(active?.records
            .filter((record) => record.kind === "collection-gap")
            .map((record) => ({
              record: structuredClone(record),
              batchId: active?.id,
            })) ?? []),
          ...[...gaps.values()].map((record) => ({
            record: structuredClone(record),
          })),
        ]),
      )
    },
    close(deadlineMs) {
      if (closing) return closing
      closed = true
      flushDeadline = Date.now() + Math.max(0, deadlineMs)
      if (timer) clearInterval(timer)
      closing = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          serialize(async () => {
            do {
              await flushOnce()
              if (failed) break
            } while ((count() || gaps.size > 0) && Date.now() < flushDeadline)
          }),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, Math.max(0, deadlineMs))
          }),
        ])
        if (deadline) clearTimeout(deadline)
        if (count() || gaps.size > 0 || active) {
          failed = true
          reportTelemetryFailure()
        }
        return snapshot()
      })()
      return closing
    },
  }
  return writer
}

let current: HistoryRuntime | undefined

export async function createHistoryRuntime(
  storage: Storage,
  options: { now?: () => number; autoFlush?: boolean } = {},
): Promise<HistoryRuntime> {
  const now = options.now ?? Date.now,
    runId = randomUUID()
  const repository = createHistoryRepository(storage, { runId, now })
  await repository.startRun(runId, now())
  let lastHeartbeat = now()
  const writer = createTelemetryWriter(
    repository,
    { now },
    {
      autoFlush: options.autoFlush,
      async beforeFlush() {
        if (now() - lastHeartbeat < 30_000) return
        await repository.heartbeatRun(runId, now())
        // eslint-disable-next-line require-atomic-updates -- Only the writer's serialized flush owner invokes this callback.
        lastHeartbeat = now()
      },
    },
  )
  let closing: Promise<TelemetryStatus> | undefined
  const runtime: HistoryRuntime = {
    storage,
    repository,
    writer,
    close(deadlineMs) {
      closing ??= (async () => {
        const started = Date.now()
        const status = await writer.close(deadlineMs)
        if (!status.pendingRecords && !status.degraded) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            withStorageDeadline(started + deadlineMs, () =>
              repository.endRun(runId, now()),
            ).catch(() => {
              status.degraded = true
            }),
            new Promise<void>((resolve) => {
              timer = setTimeout(
                () => {
                  status.degraded = true
                  resolve()
                },
                Math.max(0, deadlineMs - (Date.now() - started)),
              )
            }),
          ])
          if (timer) clearTimeout(timer)
        }
        if (current === runtime) current = undefined
        return status
      })()
      return closing
    },
  }
  current = runtime
  return runtime
}
export function peekHistoryRuntime(): HistoryRuntime | undefined {
  return current
}
export function getHistoryRuntime(): HistoryRuntime {
  if (!current) throw new StorageUnavailableError()
  return current
}
export function getTelemetryWriter(): TelemetryWriter | undefined {
  return current?.writer
}
