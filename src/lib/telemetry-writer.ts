import { randomUUID } from "node:crypto"

import type {
  DiagnosticKind,
  HistoryRepository,
} from "~/lib/storage/history-repository"
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
  kind: "usage" | "routing" | "activity" | "collection-gap"
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
  repository: HistoryRepository
  writer: TelemetryWriter
  generations: Record<DiagnosticKind, number>
  clear(kind: DiagnosticKind): Promise<number>
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
}
interface TelemetryWriterOptions {
  autoFlush?: boolean
  beforeFlush?: () => Promise<void>
  acceptDiagnostic?(kind: DiagnosticKind): boolean
  generationDegraded?(): boolean
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
    diagnostics: Array<HistoryRecord> = []
  for (const record of records) {
    if (record.kind !== "usage" && record.kind !== "routing") {
      diagnostics.push(record)
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
  return [...counters.values(), ...diagnostics]
}

// eslint-disable-next-line max-lines-per-function -- One closure owns queue, retry batch and admission state.
export function createTelemetryWriter(
  repository: HistoryRepository,
  clock: { now(): number } = { now: Date.now },
  options: TelemetryWriterOptions = {},
): TelemetryWriter {
  const queue: Array<Queued> = []
  let uncertainGap = false
  let active: Batch | undefined,
    pendingBytes = 0,
    droppedRecords = 0
  let gapRecords = 0,
    gapBytes = 0,
    gapStart = 0
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
  const drop = (item: Queued) => {
    pendingBytes -= item.bytes
    droppedRecords++
    gapRecords++
    gapBytes += item.bytes
    gapStart ||= item.enqueuedAt
    failed = true
  }
  const expire = () => {
    for (let i = queue.length - 1; i >= 0; i--)
      if (clock.now() - queue[i].enqueuedAt > MAX_AGE)
        drop(queue.splice(i, 1)[0])
    if (
      active
      && clock.now() - (active.items[0]?.enqueuedAt ?? clock.now()) > MAX_AGE
    ) {
      for (const item of active.items) {
        pendingBytes -= item.bytes
        droppedRecords++
      }
      // A response may have been lost after commit. Never assert an exact loss.
      uncertainGap = true
      failed = true
      active = undefined
    }
  }
  const snapshot = (): TelemetryStatus => ({
    pendingRecords: count(),
    pendingBytes,
    droppedRecords,
    lastSuccessfulFlush,
    degraded:
      failed
      || gapRecords > 0
      || uncertainGap
      || (options.generationDegraded?.() ?? false),
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
      if (items.length === 0 && !gapRecords && !uncertainGap) {
        failed = false
        return
      }
      const records = coalesce(items.map((item) => item.record))
      if (gapRecords) {
        records.push({
          id: randomUUID(),
          kind: "collection-gap",
          generation: 0,
          recordedAt: clock.now(),
          payload: {
            startedAt: gapStart,
            lostRecords: gapRecords,
            lostBytes: gapBytes,
          },
        })
        gapRecords = 0
        gapBytes = 0
        gapStart = 0
      }
      if (uncertainGap) {
        records.push({
          id: randomUUID(),
          kind: "collection-gap",
          generation: 0,
          recordedAt: clock.now(),
          payload: { unknown: true, reason: "expired-unconfirmed-batch" },
        })
        uncertainGap = false
      }
      active = { id: randomUUID(), items, records }
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
    // eslint-disable-next-line complexity -- Admission accounts independently for record, byte, priority and generation limits.
    enqueue(record) {
      if (closed || !isHistoryRecordKind(record.kind)) return false
      try {
        const serialized = JSON.stringify(record)
        const bytes = Buffer.byteLength(serialized),
          item = {
            record: JSON.parse(serialized) as HistoryRecord,
            bytes,
            enqueuedAt: clock.now(),
          }
        const generationBlocked =
          record.kind === "activity"
          && options.acceptDiagnostic?.(record.kind) === false
        if (bytes > MAX_BYTES || generationBlocked) {
          droppedRecords++
          gapRecords++
          gapBytes += bytes
          gapStart ||= clock.now()
          failed = true
          if (generationBlocked) void writer.flush()
          return false
        }
        while (count() >= MAX_RECORDS || pendingBytes + bytes > MAX_BYTES) {
          const index = queue.findIndex(
            (value) => value.record.kind === "activity",
          )
          let candidate = index
          if (
            candidate === -1
            && (record.kind === "usage" || record.kind === "routing")
          )
            candidate = 0
          if (candidate < 0 || queue.length === 0) {
            droppedRecords++
            gapRecords++
            gapBytes += bytes
            gapStart ||= clock.now()
            failed = true
            return false
          }
          drop(queue.splice(candidate, 1)[0])
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
          if (failed || (!count() && !gapRecords && !uncertainGap)) break
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
            } while (
              (count() || gapRecords || uncertainGap)
              && Date.now() < flushDeadline
            )
          }),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, Math.max(0, deadlineMs))
          }),
        ])
        if (deadline) clearTimeout(deadline)
        if (count() || gapRecords || uncertainGap || active) {
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
// eslint-disable-next-line max-lines-per-function -- One runtime owns generation reconciliation, ordered clears, and shutdown publication.
export async function createHistoryRuntime(
  storage: Storage,
  options: { now?: () => number; autoFlush?: boolean } = {},
): Promise<HistoryRuntime> {
  const now = options.now ?? Date.now,
    runId = randomUUID()
  const repository = createHistoryRepository(storage, { runId, now })
  await repository.startRun(runId, now())
  const generations = await repository.generations()
  const clearTails: Record<DiagnosticKind, Promise<unknown>> = {
    activity: Promise.resolve(),
  }
  const pendingClears: Record<DiagnosticKind, number> = {
    activity: 0,
  }
  const clearEpochs: Record<DiagnosticKind, number> = { activity: 0 }
  const unresolved = new Set<DiagnosticKind>()
  const reconcileGenerations = async () => {
    const needed = [...unresolved].filter((kind) => pendingClears[kind] === 0)
    if (needed.length === 0) return
    const observedEpochs = { ...clearEpochs }
    const confirmed = await repository.generations()
    for (const kind of needed) {
      // Another clear may have started while this read was in flight.
      if (
        pendingClears[kind] !== 0
        || observedEpochs[kind] !== clearEpochs[kind]
      )
        continue
      generations[kind] = Math.max(generations[kind], confirmed[kind])
      unresolved.delete(kind)
    }
  }
  const writer = createTelemetryWriter(
    repository,
    { now },
    {
      ...options,
      beforeFlush: reconcileGenerations,
      acceptDiagnostic: (kind) =>
        !unresolved.has(kind) && pendingClears[kind] === 0,
      generationDegraded: () =>
        unresolved.size > 0 || pendingClears.activity > 0,
    },
  )
  let closing: Promise<TelemetryStatus> | undefined
  const runtime: HistoryRuntime = {
    repository,
    writer,
    generations,
    clear(kind) {
      pendingClears[kind]++
      clearEpochs[kind]++
      const operation = clearTails[kind].then(async () => {
        try {
          const next = await repository.clear(kind)
          generations[kind] = Math.max(generations[kind], next)
          unresolved.delete(kind)
          return next
        } catch (error) {
          unresolved.add(kind)
          throw error
        } finally {
          pendingClears[kind]--
        }
      })
      clearTails[kind] = operation.catch(() => undefined)
      return operation
    },
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
