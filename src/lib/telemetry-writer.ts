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
  sumHistoryCounters,
} from "~/lib/storage/history-repository"
import { withStorageDeadline } from "~/lib/storage/operation-budget"

export interface HistoryRecord {
  id: string
  kind: "usage" | "routing" | "debug" | "collection-gap"
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
  status(kind?: DiagnosticKind): TelemetryStatus
  close(deadlineMs: number): Promise<TelemetryStatus>
  read<T>(
    work: (pending: ReadonlyArray<PendingHistoryRecord>) => Promise<T>,
  ): Promise<T>
}
export interface HistoryRuntime {
  storage: Storage
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
  createdAt: number
}
interface TelemetryWriterOptions {
  runId?: string
  autoFlush?: boolean
  beforeFlush?: () => Promise<void>
  acceptDiagnostic?(kind: DiagnosticKind): boolean
  generationDegraded?(): boolean
}
const MAX_RECORDS = 2000,
  MAX_BYTES = 128 * 1024 * 1024,
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
  const loss = (item: Queued, unknown = false, generationUncertain = false) => {
    const key = JSON.stringify([
      item.record.kind,
      generationUncertain ? null : item.record.generation,
      unknown,
    ])
    const prior = gaps.get(key)
    const payload =
      prior ?
        historyObject(prior.payload)
      : {
          historyKind: item.record.kind,
          ...(generationUncertain ?
            {}
          : { generation: item.record.generation }),
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
  const snapshot = (kind?: DiagnosticKind): TelemetryStatus => ({
    pendingRecords:
      kind ?
        [...queue, ...(active?.items ?? [])].filter(
          (item) => item.record.kind === kind,
        ).length
      : count(),
    pendingBytes:
      kind ?
        [...queue, ...(active?.items ?? [])]
          .filter((item) => item.record.kind === kind)
          .reduce((sum, item) => sum + item.bytes, 0)
      : pendingBytes,
    droppedRecords,
    lastSuccessfulFlush,
    degraded:
      failed || gaps.size > 0 || (options.generationDegraded?.() ?? false),
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
      // A large debug entry is committed by itself. Preserve small loss reports
      // for the next batch instead of appending to an already oversized write.
      if (batchBytes <= 1024 * 1024) {
        records.push(...gaps.values())
        gaps.clear()
      }
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
    // eslint-disable-next-line complexity -- Admission accounts for record, byte and priority limits without changing captured payloads.
    enqueue(record) {
      if (closed) return false
      try {
        const owned =
          record.kind === "debug" && options.runId ?
            {
              ...record,
              payload: {
                ...historyObject(record.payload),
                _historyRunId: options.runId,
              },
            }
          : record
        const serialized = JSON.stringify(owned)
        const bytes = Buffer.byteLength(serialized),
          item = {
            record: JSON.parse(serialized) as HistoryRecord,
            bytes,
            enqueuedAt: clock.now(),
          }
        if (record.kind === "debug") {
          const updatedAt = Number(
            historyObject(item.record.payload).updatedAt
              ?? item.record.recordedAt,
          )
          const prior = queue.find(
            (queued) =>
              queued.record.kind === "debug"
              && queued.record.id === record.id
              && queued.record.generation === record.generation,
          )
          if (
            prior
            && Number(
              historyObject(prior.record.payload).updatedAt
                ?? prior.record.recordedAt,
            ) > updatedAt
          )
            return true
          for (let index = queue.length - 1; index >= 0; index--) {
            const queued = queue[index]
            if (
              queued.record.kind === "debug"
              && queued.record.id === record.id
              && queued.record.generation === record.generation
            ) {
              pendingBytes -= queued.bytes
              queue.splice(index, 1)
            }
          }
        }
        const generationBlocked =
          record.kind === "debug"
          && options.acceptDiagnostic?.(record.kind) === false
        const oversizedAlone =
          record.kind === "debug"
          && item.bytes > MAX_BYTES
          && count() === 0
          && !active
        if ((item.bytes > MAX_BYTES && !oversizedAlone) || generationBlocked) {
          droppedRecords++
          loss(item, false, generationBlocked)
          if (generationBlocked) void writer.flush()
          return false
        }
        while (
          !oversizedAlone
          && (count() >= MAX_RECORDS || pendingBytes + item.bytes > MAX_BYTES)
        ) {
          const index = queue.findIndex(
            (value) => value.record.kind === "debug",
          )
          let candidate = index
          if (
            candidate === -1
            && (record.kind === "usage" || record.kind === "routing")
          )
            candidate = 0
          if (candidate < 0 || queue.length === 0) {
            droppedRecords++
            loss(item)
            return false
          }
          drop(queue.splice(candidate, 1)[0])
        }
        queue.push(item)
        pendingBytes += item.bytes
        if (
          options.autoFlush !== false
          && (queue.length >= 100 || oversizedAlone)
        )
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
// eslint-disable-next-line max-lines-per-function -- One runtime owns generation reconciliation, ordered clears, and shutdown publication.
export async function createHistoryRuntime(
  storage: Storage,
  options: { now?: () => number; autoFlush?: boolean } = {},
): Promise<HistoryRuntime> {
  const now = options.now ?? Date.now,
    runId = randomUUID()
  const repository = createHistoryRepository(storage, { runId, now })
  const generations = await repository.generations()
  await repository.startRun(runId, now())
  const clearTails: Record<DiagnosticKind, Promise<unknown>> = {
    debug: Promise.resolve(),
  }
  const pendingClears: Record<DiagnosticKind, number> = {
    debug: 0,
  }
  const clearEpochs: Record<DiagnosticKind, number> = { debug: 0 }
  const unresolved = new Set<DiagnosticKind>()
  let lastHeartbeat = now()
  const reconcileGenerations = async () => {
    if (now() - lastHeartbeat >= 30_000) {
      await repository.heartbeatRun(runId, now())
      // eslint-disable-next-line require-atomic-updates -- Only the writer's serialized flush owner invokes this callback.
      lastHeartbeat = now()
      const confirmed = await repository.generations()
      for (const kind of ["debug"] as const)
        if (!pendingClears[kind])
          generations[kind] = Math.max(generations[kind], confirmed[kind])
    }
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
      runId,
      beforeFlush: reconcileGenerations,
      acceptDiagnostic: (kind) =>
        !unresolved.has(kind) && pendingClears[kind] === 0,
      generationDegraded: () => unresolved.size > 0 || pendingClears.debug > 0,
    },
  )
  let closing: Promise<TelemetryStatus> | undefined
  const runtime: HistoryRuntime = {
    storage,
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
