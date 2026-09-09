import { createHash, randomUUID } from "node:crypto"

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

export type DiagnosticKind = "activity"
export function isHistoryRecordKind(
  value: unknown,
): value is HistoryRecord["kind"] {
  return (
    value === "usage"
    || value === "routing"
    || value === "activity"
    || value === "collection-gap"
  )
}
export interface HistoryPageOptions {
  limit?: number
  cursor?: string
  since?: number
  until?: number
  type?: string
  now?: number
}
export interface HistoryPage {
  records: Array<HistoryRecord>
  cursor: string | null
  generation: number
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
export interface HistoryRepository {
  applyBatch(
    batchId: string,
    records: ReadonlyArray<HistoryRecord>,
  ): Promise<void>
  clear(kind: DiagnosticKind): Promise<number>
  prune(now: number): Promise<void>
  generations(): Promise<Record<DiagnosticKind, number>>
  startRun(id: string, now: number): Promise<void>
  endRun(id: string, now: number): Promise<void>
  collectionStatus(): Promise<CollectionStatus>
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
  list(
    kind: DiagnosticKind,
    options?: HistoryPageOptions,
    pending?: ReadonlyArray<PendingHistoryRecord>,
  ): Promise<HistoryPage>
  get(
    kind: DiagnosticKind,
    id: string,
    pending?: ReadonlyArray<PendingHistoryRecord>,
    now?: number,
  ): Promise<HistoryRecord | null>
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

async function generation(
  session: SqlSession,
  kind: DiagnosticKind,
): Promise<number> {
  const rows = await session.query({
    sql: "SELECT value FROM capi_metadata WHERE key = ?",
    args: [`history_${kind}_generation`],
  })
  return Number(rows[0]?.value ?? 0)
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
function diagnosticExpiry(record: HistoryRecord): number {
  return record.recordedAt + 7 * 86400_000
}
function validateDiagnosticKind(kind: unknown): void {
  if (kind !== "activity") throw new Error("Unsupported diagnostic kind")
}
async function applyDiagnostics(
  session: SqlSession,
  records: ReadonlyArray<HistoryRecord>,
) {
  const selected = records.filter((record) => record.kind === "activity")
  if (selected.length === 0) return
  const current = await generation(session, "activity")
  const rows = selected
    .filter((record) => record.generation === current)
    .map((record) => {
      const payload = JSON.stringify(record.payload)
      const bytes = Buffer.byteLength(payload)
      const p = historyObject(record.payload)
      return [
        record.id,
        record.generation,
        record.recordedAt,
        diagnosticExpiry(record),
        typeof p.type === "string" ? p.type : "info",
        payload,
        bytes,
      ]
    })
  const columns =
    "id,generation,created_at,expires_at,kind,payload_json,payload_bytes"
  const width = columns.split(",").length
  const chunkSize = Math.floor(900 / width)
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize)
    const placeholders = chunk
      .map(() => `(${Array.from({ length: width }, () => "?").join(",")})`)
      .join(",")
    await session.execute({
      sql: `INSERT INTO capi_activity (${columns}) VALUES ${placeholders} ON CONFLICT(id) DO NOTHING`,
      args: chunk.flat(),
    })
  }
}
async function pruneDiagnostics(session: SqlSession, now: number) {
  const cap = 50_000,
    bytes = 64 * 1024 * 1024
  await session.execute({
    sql: "DELETE FROM capi_activity WHERE expires_at <= ?",
    args: [now],
  })
  await session.execute({
    sql: "DELETE FROM capi_activity WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS position, SUM(payload_bytes) OVER (ORDER BY created_at DESC, id DESC) AS total_bytes FROM capi_activity) WHERE position > ? OR total_bytes > ?)",
    args: [cap, bytes],
  })
}
function fromRow(
  row: Record<string, unknown>,
  kind: DiagnosticKind,
): HistoryRecord {
  return {
    id: String(row.id),
    kind,
    recordedAt: Number(row.created_at),
    generation: Number(row.generation),
    payload: JSON.parse(String(row.payload_json)) as JsonValue,
  }
}
function compareRecords(a: HistoryRecord, b: HistoryRecord): number {
  if (a.recordedAt !== b.recordedAt) return b.recordedAt - a.recordedAt
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}
function decodeCursor(
  cursor?: string,
): { timestamp: number; id: string } | undefined {
  if (!cursor) return undefined
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      timestamp?: unknown
      id?: unknown
    }
    if (
      typeof value.timestamp === "number"
      && Number.isSafeInteger(value.timestamp)
      && typeof value.id === "string"
      && value.id.length <= 200
    )
      return { timestamp: value.timestamp, id: value.id }
  } catch {
    /* Invalid cursors are rejected without exposing parser errors. */
  }
  throw new Error("Invalid history cursor")
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
        await applyDiagnostics(session, records)
        for (const record of records) {
          switch (record.kind) {
            case "usage": {
              break
            }
            case "routing": {
              break
            }
            case "activity": {
              break
            }
            default: {
              const p = historyObject(record.payload)
              await session.execute({
                sql: "INSERT INTO capi_collection_gaps (id, process_run_id, started_at, ended_at, kind, lost_records, lost_bytes) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
                args: [
                  record.id,
                  options.runId ?? null,
                  number(p.startedAt ?? record.recordedAt),
                  record.recordedAt,
                  p.unknown === true ? "unknown" : "known",
                  p.unknown === true ? null : number(p.lostRecords),
                  p.unknown === true ? null : number(p.lostBytes),
                ],
              })
            }
          }
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
        await pruneDiagnostics(session, now)
        await session.execute({
          sql: "DELETE FROM capi_routing_minutes WHERE minute < ?",
          args: [minute(now - 86400_000)],
        })
        // One day exceeds five-minute queue age and the adapters' 30-second deadline.
        await session.execute({
          sql: "DELETE FROM capi_applied_operations WHERE kind = 'history_batch' AND created_at < ?",
          args: [now - 86400_000],
        })
      })
    },
    async generations() {
      return storage.read(async (s) => ({
        activity: await generation(s, "activity"),
      }))
    },
    async clear(kind) {
      validateDiagnosticKind(kind)
      const id = randomUUID()
      try {
        return await storage.transaction(async (s) => {
          const next = (await generation(s, kind)) + 1
          await s.execute({
            sql: "UPDATE capi_metadata SET value = ? WHERE key = ?",
            args: [String(next), `history_${kind}_generation`],
          })
          await s.execute({
            sql: "DELETE FROM capi_activity",
            args: [],
          })
          // A clear has its own receipt; it never advances configuration revision.
          await s.execute({
            sql: "INSERT INTO capi_applied_operations (id, kind, actor_id, input_digest, committed_revision, result_json, created_at) VALUES (?, 'history_clear', 'admin', ?, 0, ?, ?)",
            args: [id, kind, JSON.stringify({ generation: next }), clock()],
          })
          return next
        })
      } catch (error) {
        const receipt = await storage.read((s) =>
          s.query({
            sql: "SELECT result_json FROM capi_applied_operations WHERE id = ? AND kind = 'history_clear'",
            args: [id],
          }),
        )
        if (receipt.length === 0) throw error
        const result = JSON.parse(String(receipt[0].result_json)) as {
          generation: number
        }
        return result.generation
      }
    },
    async prune(now) {
      await storage.transaction(async (s) => {
        await pruneDiagnostics(s, now)
        await s.execute({
          sql: "DELETE FROM capi_routing_minutes WHERE minute < ?",
          args: [minute(now - 86400_000)],
        })
      })
    },
    async startRun(id, now) {
      await storage.transaction(async (s) => {
        await s.execute({
          sql: "INSERT INTO capi_collection_gaps (id, process_run_id, started_at, kind) SELECT 'unclean-' || id, id, COALESCE(last_flush_at, started_at), 'unknown' FROM capi_process_runs WHERE clean = 0 AND id <> ? ON CONFLICT(id) DO NOTHING",
          args: [id],
        })
        await s.execute({
          sql: "INSERT INTO capi_process_runs (id, started_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
          args: [id, now],
        })
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
    async collectionStatus() {
      return storage.read(async (s) => {
        const rows = await s.query({
          sql: "SELECT COALESCE(SUM(lost_records), 0) AS records, COALESCE(SUM(lost_bytes), 0) AS bytes, COALESCE(SUM(CASE WHEN kind = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_count FROM capi_collection_gaps",
          args: [],
        })
        return {
          knownLostRecords: number(rows[0]?.records),
          knownLostBytes: number(rows[0]?.bytes),
          unknownGaps: number(rows[0]?.unknown_count),
        }
      })
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
    async list(kind, opts = {}, pending = []) {
      validateDiagnosticKind(kind)
      // eslint-disable-next-line complexity -- SQL and pending overlay apply the same independent optional filters.
      return storage.read(async (s) => {
        const current = await generation(s, kind),
          now = opts.now ?? clock(),
          cursor = decodeCursor(opts.cursor)
        const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)))
        const clauses = ["generation = ?", "expires_at > ?"],
          args: Array<SqlValue> = [current, now]
        if (opts.since !== undefined) {
          clauses.push("created_at >= ?")
          args.push(opts.since)
        }
        if (opts.until !== undefined) {
          clauses.push("created_at <= ?")
          args.push(opts.until)
        }
        if (opts.type) {
          clauses.push("kind = ?")
          args.push(opts.type)
        }
        if (cursor) {
          clauses.push("(created_at < ? OR (created_at = ? AND id < ?))")
          args.push(cursor.timestamp, cursor.timestamp, cursor.id)
        }
        const rows = await s.query({
          sql: `SELECT * FROM capi_activity WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
          // Pending completions can remove matching stored rows; overread the
          // bounded queue size so pagination still reaches older matches.
          args: [...args, limit + 1 + pending.length],
        })
        const byId = new Map(
          rows.map((row) => {
            const record = fromRow(row, kind)
            return [record.id, record]
          }),
        )
        for (const record of await uncommitted(s, pending))
          if (record.kind === kind && record.generation === current) {
            byId.delete(record.id)
            if (diagnosticExpiry(record) <= now) continue
            const p = historyObject(record.payload)
            if (
              (opts.since !== undefined && record.recordedAt < opts.since)
              || (opts.until !== undefined && record.recordedAt > opts.until)
              || (opts.type && p.type !== opts.type)
              || (cursor
                && (record.recordedAt > cursor.timestamp
                  || (record.recordedAt === cursor.timestamp
                    && record.id >= cursor.id)))
            )
              continue
            byId.set(record.id, record)
          }
        const all = [...byId.values()].sort(compareRecords),
          records = all.slice(0, limit),
          last = records.at(-1)
        return {
          records,
          generation: current,
          cursor:
            all.length > limit && last ?
              Buffer.from(
                JSON.stringify({ timestamp: last.recordedAt, id: last.id }),
              ).toString("base64url")
            : null,
        }
      })
    },
    // eslint-disable-next-line max-params -- Caller supplies optional fixture time independently of pending overlay.
    async get(kind, id, pending = [], now = clock()) {
      validateDiagnosticKind(kind)
      return storage.read(async (s) => {
        const current = await generation(s, kind)
        const rows = await s.query({
          sql: "SELECT * FROM capi_activity WHERE id = ? AND generation = ? AND expires_at > ?",
          args: [id, current, now],
        })
        let result = rows[0] ? fromRow(rows[0], kind) : null
        for (const record of await uncommitted(s, pending))
          if (
            record.kind === kind
            && record.id === id
            && record.generation === current
          )
            result = diagnosticExpiry(record) > now ? record : null
        return result
      })
    },
  }
}
