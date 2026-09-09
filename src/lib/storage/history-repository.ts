import { createHash } from "node:crypto"

import type {
  JsonValue,
  SqlSession,
  SqlValue,
  Storage,
} from "~/lib/storage/types"
import type {
  HistoryRecord,
  PendingHistoryRecord,
} from "~/lib/telemetry-writer"

import { reconcileRuns, renewRun } from "~/lib/storage/history-lifecycle"

export function isHistoryRecordKind(
  value: unknown,
): value is HistoryRecord["kind"] {
  return value === "usage" || value === "routing" || value === "collection-gap"
}
export interface UsageHistory {
  buckets: Array<{
    timestamp: number
    model?: string
    inputTokens: number
    outputTokens: number
    requestCount: number
  }>
  lifetime: {
    inputTokens: number
    outputTokens: number
    requestCount: number
    firstRequestAt: number | null
  }
}
export interface CollectionStatus {
  knownLostRecords: number
  knownLostBytes: number
  unknownGaps: number
}
export interface CollectionStatusOptions {
  since?: number
  until?: number
}
export interface HistoryRepository {
  applyBatch(
    batchId: string,
    records: ReadonlyArray<HistoryRecord>,
  ): Promise<void>
  prune(now: number): Promise<void>
  startRun(id: string, now: number): Promise<void>
  heartbeatRun(id: string, now: number): Promise<void>
  endRun(id: string, now: number): Promise<void>
  collectionStatus(
    options?: CollectionStatusOptions,
    pending?: ReadonlyArray<PendingHistoryRecord>,
  ): Promise<CollectionStatus>
  readUsage(
    cutoff: number,
    pending?: ReadonlyArray<PendingHistoryRecord>,
  ): Promise<UsageHistory>
  readRouting(
    cutoff: number,
    pending?: ReadonlyArray<PendingHistoryRecord>,
  ): Promise<{
    buckets: Array<JsonValue>
    lifetime: JsonValue
    startedAt: number | null
  }>
}

export function historyObject(value: JsonValue): { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      value
    : {}
}
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0
const minute = (value: number) => Math.floor(value / 60_000) * 60_000

/** Counter trees have numeric leaves; dimension strings are immutable labels. */
export function sumHistoryCounters(
  left: JsonValue,
  right: JsonValue,
  depth = 0,
): JsonValue {
  if (typeof right === "number") return number(left) + right
  if (right === null || typeof right !== "object" || Array.isArray(right))
    return right
  const result = Object.assign(
    Object.create(null) as { [key: string]: JsonValue },
    historyObject(left),
  )
  for (const [key, value] of Object.entries(right)) {
    result[key] =
      key === "timestamp" && depth === 0 ?
        value
      : sumHistoryCounters(result[key] ?? null, value, depth + 1)
  }
  return result
}

async function uncommitted(
  session: SqlSession,
  pending: ReadonlyArray<PendingHistoryRecord>,
) {
  const batchIds = [
    ...new Set(pending.flatMap((item) => (item.batchId ? [item.batchId] : []))),
  ]
  const applied = new Set<string>()
  for (const id of batchIds) {
    const rows = await session.query({
      sql: "SELECT id FROM capi_applied_operations WHERE id = ? AND kind = 'history_batch'",
      args: [id],
    })
    if (rows.length > 0) applied.add(id)
  }
  return pending
    .filter((item) => !item.batchId || !applied.has(item.batchId))
    .map((item) => item.record)
}
function addUsage(data: UsageHistory, record: HistoryRecord, cutoff: number) {
  const p = historyObject(record.payload)
  const inputTokens = number(p.inputTokens),
    outputTokens = number(p.outputTokens),
    requestCount = number(p.requestCount)
  data.lifetime.inputTokens += inputTokens
  data.lifetime.outputTokens += outputTokens
  data.lifetime.requestCount += requestCount
  const first = number(p.firstRequestAt ?? record.recordedAt)
  data.lifetime.firstRequestAt =
    data.lifetime.firstRequestAt === null ?
      first
    : Math.min(first, data.lifetime.firstRequestAt)
  const timestamp = minute(number(p.timestamp ?? record.recordedAt))
  if (timestamp >= cutoff)
    data.buckets.push({
      timestamp,
      inputTokens,
      outputTokens,
      requestCount,
      ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
    })
}
async function applyUsageBatch(
  session: SqlSession,
  records: ReadonlyArray<HistoryRecord>,
) {
  const selected = records.filter((record) => record.kind === "usage")
  if (selected.length === 0) return
  let input = 0,
    output = 0,
    count = 0,
    first = Infinity
  const rows = selected.map((record) => {
    const p = historyObject(record.payload)
    const nextInput = number(p.inputTokens),
      nextOutput = number(p.outputTokens),
      nextCount = number(p.requestCount)
    input += nextInput
    output += nextOutput
    count += nextCount
    first = Math.min(first, number(p.firstRequestAt ?? record.recordedAt))
    return [
      minute(number(p.timestamp ?? record.recordedAt)),
      typeof p.model === "string" ? p.model : "",
      nextInput,
      nextOutput,
      nextCount,
    ]
  })
  for (let offset = 0; offset < rows.length; offset += 180) {
    const chunk = rows.slice(offset, offset + 180)
    await session.execute({
      sql: `INSERT INTO capi_usage_minutes (minute,model,input_tokens,output_tokens,request_count) VALUES ${chunk.map(() => "(?,?,?,?,?)").join(",")} ON CONFLICT(minute,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, request_count=request_count+excluded.request_count`,
      args: chunk.flat(),
    })
  }
  await session.execute({
    sql: "UPDATE capi_usage_lifetime SET input_tokens=input_tokens+?,output_tokens=output_tokens+?,request_count=request_count+?,first_request_at=CASE WHEN first_request_at IS NULL THEN ? ELSE MIN(first_request_at,?) END WHERE id=1",
    args: [input, output, count, first, first],
  })
}

async function applyRoutingBatch(
  session: SqlSession,
  records: ReadonlyArray<HistoryRecord>,
) {
  const selected = records.filter((record) => record.kind === "routing")
  if (selected.length === 0) return
  const timestamps = [
    ...new Set(
      selected.map((record) =>
        minute(
          number(historyObject(record.payload).timestamp ?? record.recordedAt),
        ),
      ),
    ),
  ]
  const stored = new Map<number, JsonValue>()
  for (let offset = 0; offset < timestamps.length; offset += 900) {
    const chunk = timestamps.slice(offset, offset + 900)
    const rows = await session.query({
      sql: `SELECT minute,payload_json FROM capi_routing_minutes WHERE dimension_key='aggregate' AND minute IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    })
    for (const row of rows)
      stored.set(
        number(row.minute),
        JSON.parse(String(row.payload_json)) as JsonValue,
      )
  }
  const lifetime = await session.query({
    sql: "SELECT value FROM capi_metadata WHERE key='history_routing_lifetime'",
    args: [],
  })
  let totals: JsonValue =
    lifetime.length > 0 ?
      (JSON.parse(String(lifetime[0].value)) as JsonValue)
    : {}
  for (const record of selected) {
    const p = historyObject(record.payload),
      timestamp = minute(number(p.timestamp ?? record.recordedAt))
    stored.set(timestamp, sumHistoryCounters(stored.get(timestamp) ?? {}, p))
    totals = sumHistoryCounters(totals, p.totals ?? {})
  }
  const rows = [...stored].map(([timestamp, value]) => [
    timestamp,
    JSON.stringify(value),
  ])
  for (let offset = 0; offset < rows.length; offset += 450) {
    const chunk = rows.slice(offset, offset + 450)
    await session.execute({
      sql: `INSERT INTO capi_routing_minutes (minute,dimension_key,payload_json) VALUES ${chunk.map(() => "(?,'aggregate',?)").join(",")} ON CONFLICT(minute,dimension_key) DO UPDATE SET payload_json=excluded.payload_json`,
      args: chunk.flat(),
    })
  }
  await session.execute({
    sql: "INSERT INTO capi_metadata(key,value) VALUES('history_routing_lifetime',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    args: [JSON.stringify(totals)],
  })
  await session.execute({
    sql: "INSERT INTO capi_metadata(key,value) VALUES('history_routing_started_at',?) ON CONFLICT(key) DO NOTHING",
    args: [String(selected[0].recordedAt)],
  })
}
async function pruneCounters(session: SqlSession, now: number): Promise<void> {
  await session.execute({
    sql: "DELETE FROM capi_routing_minutes WHERE minute < ?",
    args: [minute(now - 86400_000)],
  })
  // One day exceeds five-minute queue age and the adapters' 30-second deadline.
  await session.execute({
    sql: "DELETE FROM capi_applied_operations WHERE kind = 'history_batch' AND created_at < ?",
    args: [now - 86400_000],
  })
}

async function readCollectionStatus(
  session: SqlSession,
  options: CollectionStatusOptions & {
    pending: ReadonlyArray<PendingHistoryRecord>
  },
): Promise<CollectionStatus> {
  const clauses: Array<string> = [],
    args: Array<SqlValue> = []
  if (options.since !== undefined) {
    clauses.push("COALESCE(ended_at, started_at) >= ?")
    args.push(options.since)
  }
  if (options.until !== undefined) {
    clauses.push("started_at <= ?")
    args.push(options.until)
  }
  const rows = await session.query({
    sql: `SELECT COALESCE(SUM(lost_records), 0) AS records, COALESCE(SUM(lost_bytes), 0) AS bytes, COALESCE(SUM(CASE WHEN kind = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_count FROM capi_collection_gaps${clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""}`,
    args,
  })
  const status = {
    knownLostRecords: number(rows[0]?.records),
    knownLostBytes: number(rows[0]?.bytes),
    unknownGaps: number(rows[0]?.unknown_count),
  }
  for (const record of await uncommitted(session, options.pending)) {
    if (record.kind !== "collection-gap") continue
    const payload = historyObject(record.payload)
    if (
      (options.since !== undefined && record.recordedAt < options.since)
      || (options.until !== undefined
        && number(payload.startedAt ?? record.recordedAt) > options.until)
    )
      continue
    if (payload.unknown === true) status.unknownGaps++
    else {
      status.knownLostRecords += number(payload.lostRecords)
      status.knownLostBytes += number(payload.lostBytes)
    }
  }
  return status
}
// eslint-disable-next-line max-lines-per-function -- Repository methods share a backend and process-run identity.
export function createHistoryRepository(
  storage: Storage,
  options: { runId?: string; now?: () => number } = {},
): HistoryRepository {
  const clock = options.now ?? Date.now
  return {
    async applyBatch(batchId, records) {
      if (records.some((record) => !isHistoryRecordKind(record.kind)))
        throw new Error("Unsupported history record kind")
      const digest = createHash("sha256")
        .update(JSON.stringify(records))
        .digest("hex")
      await storage.transaction(async (session) => {
        const prior = await session.query({
          sql: "SELECT input_digest FROM capi_applied_operations WHERE id = ?",
          args: [batchId],
        })
        if (prior.length > 0) {
          if (prior[0].input_digest !== digest)
            throw new Error("History batch identity conflict")
          return
        }
        await applyUsageBatch(session, records)
        await applyRoutingBatch(session, records)
        for (const record of records) {
          if (record.kind !== "collection-gap") continue
          const p = historyObject(record.payload)
          await session.execute({
            sql: "INSERT INTO capi_collection_gaps (id, process_run_id, started_at, ended_at, kind, lost_records, lost_bytes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
            args: [
              record.id,
              options.runId ?? null,
              number(p.startedAt ?? record.recordedAt),
              record.recordedAt,
              p.unknown === true ? "unknown" : "known",
              p.unknown === true ? null : number(p.lostRecords),
              p.unknown === true ? null : number(p.lostBytes),
              JSON.stringify(p),
            ],
          })
        }
        const now = clock()
        await session.execute({
          sql: "INSERT INTO capi_applied_operations (id, kind, actor_id, input_digest, committed_revision, result_json, created_at) VALUES (?, 'history_batch', 'telemetry', ?, 0, '{}', ?)",
          args: [batchId, digest, now],
        })
        if (options.runId)
          await session.execute({
            sql: "UPDATE capi_process_runs SET last_flush_at = ? WHERE id = ?",
            args: [now, options.runId],
          })
        await pruneCounters(session, now)
      })
    },
    async prune(now) {
      await storage.transaction((session) => pruneCounters(session, now))
    },
    async startRun(id, now) {
      await storage.transaction(async (s) => {
        await reconcileRuns(s, id, now)
        await s.execute({
          sql: "INSERT INTO capi_process_runs (id, started_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
          args: [id, now],
        })
        await renewRun(s, id, now)
      })
    },
    async heartbeatRun(id, now) {
      await storage.transaction(async (s) => {
        await reconcileRuns(s, id, now)
        await renewRun(s, id, now)
        await pruneCounters(s, now)
      })
    },
    async endRun(id, now) {
      await storage.transaction(async (s) => {
        await s.execute({
          sql: "UPDATE capi_process_runs SET ended_at = ?, clean = 1 WHERE id = ?",
          args: [now, id],
        })
      })
    },
    async collectionStatus(options = {}, pending = []) {
      return storage.read((s) =>
        readCollectionStatus(s, { ...options, pending }),
      )
    },
    async readUsage(cutoff, pending = []) {
      return storage.read(async (s) => {
        const totals = (
          await s.query({
            sql: "SELECT * FROM capi_usage_lifetime WHERE id = 1",
            args: [],
          })
        )[0]
        const rows = await s.query({
          sql: "SELECT * FROM capi_usage_minutes WHERE minute >= ? ORDER BY minute, model",
          args: [cutoff],
        })
        const data: UsageHistory = {
          buckets: rows.map((row) => ({
            timestamp: number(row.minute),
            inputTokens: number(row.input_tokens),
            outputTokens: number(row.output_tokens),
            requestCount: number(row.request_count),
            ...(typeof row.model === "string" && row.model ?
              { model: row.model }
            : {}),
          })),
          lifetime: {
            inputTokens: number(totals.input_tokens),
            outputTokens: number(totals.output_tokens),
            requestCount: number(totals.request_count),
            firstRequestAt:
              totals.first_request_at === null ?
                null
              : number(totals.first_request_at),
          },
        }
        for (const record of await uncommitted(s, pending))
          if (record.kind === "usage") addUsage(data, record, cutoff)
        return data
      })
    },
    async readRouting(cutoff, pending = []) {
      return storage.read(async (s) => {
        const rows = await s.query({
          sql: "SELECT payload_json FROM capi_routing_minutes WHERE minute >= ? ORDER BY minute",
          args: [cutoff],
        })
        const metadata = await s.query({
          sql: "SELECT key, value FROM capi_metadata WHERE key IN ('history_routing_lifetime', 'history_routing_started_at')",
          args: [],
        })
        const values = new Map(metadata.map((row) => [row.key, row.value]))
        let lifetime: JsonValue = JSON.parse(
          typeof values.get("history_routing_lifetime") === "string" ?
            (values.get("history_routing_lifetime") as string)
          : "{}",
        ) as JsonValue
        let startedAt =
          values.has("history_routing_started_at") ?
            Number(values.get("history_routing_started_at"))
          : null
        const buckets = rows.map(
          (row) => JSON.parse(String(row.payload_json)) as JsonValue,
        )
        for (const record of await uncommitted(s, pending))
          if (record.kind === "routing") {
            if (minute(record.recordedAt) >= cutoff)
              buckets.push(record.payload)
            lifetime = sumHistoryCounters(
              lifetime,
              historyObject(record.payload).totals ?? {},
            )
            startedAt =
              startedAt === null ?
                record.recordedAt
              : Math.min(startedAt, record.recordedAt)
          }
        return { buckets, lifetime, startedAt }
      })
    },
  }
}
