import { randomUUID } from "node:crypto"

import { getHistoryRuntime, getTelemetryWriter } from "~/lib/telemetry-writer"

const STORAGE_VERSION = 2
const MINUTE_MS = 60_000
const SEVEN_DAY_MS = 7 * 24 * 60 * MINUTE_MS

interface LegacyUsageRecord {
  timestamp: number
  inputTokens: number
  outputTokens: number
  model?: string
}

export interface UsageBucket {
  timestamp: number
  inputTokens: number
  outputTokens: number
  requestCount: number
  model?: string
}

interface LifetimeUsage {
  inputTokens: number
  outputTokens: number
  requestCount: number
  firstRequestAt: number | null
}

export interface UsageData {
  version: typeof STORAGE_VERSION
  buckets: Array<UsageBucket>
  lifetime: LifetimeUsage
}

const EMPTY_LIFETIME: LifetimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  requestCount: 0,
  firstRequestAt: null,
}

let testData: UsageData | undefined

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      Math.floor(value)
    : null
}

function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const model = value.trim()
  return model || undefined
}

function normalizeTimestamp(value: unknown, now = Date.now()): number | null {
  const timestamp = finiteNonnegative(value)
  return timestamp !== null && timestamp <= now + MINUTE_MS ? timestamp : null
}

function emptyUsageData(): UsageData {
  return {
    version: STORAGE_VERSION,
    buckets: [],
    lifetime: { ...EMPTY_LIFETIME },
  }
}

function minuteFor(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS
}

function bucketKey(timestamp: number, model?: string): string {
  return `${timestamp}\0${model ?? ""}`
}

function aggregateRecords(
  records: Array<LegacyUsageRecord>,
): Array<UsageBucket> {
  const buckets = new Map<string, UsageBucket>()
  for (const record of records) {
    const timestamp = minuteFor(record.timestamp)
    const key = bucketKey(timestamp, record.model)
    const existing = buckets.get(key)
    if (existing) {
      existing.inputTokens += record.inputTokens
      existing.outputTokens += record.outputTokens
      existing.requestCount += 1
    } else {
      buckets.set(key, {
        timestamp,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        requestCount: 1,
        ...(record.model ? { model: record.model } : {}),
      })
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp)
}

function parseLegacyRecords(
  raw: unknown,
  now: number,
): Array<LegacyUsageRecord> {
  if (
    typeof raw !== "object"
    || raw === null
    || !("records" in raw)
    || !Array.isArray(raw.records)
  ) {
    return []
  }

  const records: Array<LegacyUsageRecord> = []
  for (const item of raw.records) {
    if (typeof item !== "object" || item === null) continue
    const value = item as Record<string, unknown>
    const timestamp = normalizeTimestamp(value.timestamp, now)
    const inputTokens = finiteNonnegative(value.inputTokens)
    const outputTokens = finiteNonnegative(value.outputTokens)
    if (timestamp === null || inputTokens === null || outputTokens === null) {
      continue
    }
    records.push({
      timestamp,
      inputTokens,
      outputTokens,
      ...(normalizeModel(value.model) ?
        { model: normalizeModel(value.model) }
      : {}),
    })
  }
  return records.sort((a, b) => a.timestamp - b.timestamp)
}

function normalizeBuckets(raw: unknown, now: number): Array<UsageBucket> {
  if (!Array.isArray(raw)) return []
  const buckets = new Map<string, UsageBucket>()
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const value = item as Record<string, unknown>
    const timestampRaw = normalizeTimestamp(value.timestamp, now)
    const inputTokens = finiteNonnegative(value.inputTokens)
    const outputTokens = finiteNonnegative(value.outputTokens)
    const requestCount = finiteNonnegative(value.requestCount)
    if (
      timestampRaw === null
      || inputTokens === null
      || outputTokens === null
      || requestCount === null
      || requestCount === 0
    ) {
      continue
    }
    const timestamp = minuteFor(timestampRaw)
    const model = normalizeModel(value.model)
    const key = bucketKey(timestamp, model)
    const existing = buckets.get(key)
    if (existing) {
      existing.inputTokens += inputTokens
      existing.outputTokens += outputTokens
      existing.requestCount += requestCount
    } else {
      buckets.set(key, {
        timestamp,
        inputTokens,
        outputTokens,
        requestCount,
        ...(model ? { model } : {}),
      })
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp)
}

function normalizeLifetime(raw: unknown, now: number): LifetimeUsage {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY_LIFETIME }
  const value = raw as Record<string, unknown>
  const inputTokens = finiteNonnegative(value.inputTokens)
  const outputTokens = finiteNonnegative(value.outputTokens)
  const requestCount = finiteNonnegative(value.requestCount)
  const firstRequestAt =
    value.firstRequestAt === null ?
      null
    : normalizeTimestamp(value.firstRequestAt, now)
  if (
    inputTokens === null
    || outputTokens === null
    || requestCount === null
    || (value.firstRequestAt !== null && firstRequestAt === null)
  ) {
    return { ...EMPTY_LIFETIME }
  }
  return { inputTokens, outputTokens, requestCount, firstRequestAt }
}

/** Parse v2 storage or migrate the old unbounded record list. */
export function parseUsageData(raw: unknown, now = Date.now()): UsageData {
  if (
    typeof raw === "object"
    && raw !== null
    && "version" in raw
    && raw.version === STORAGE_VERSION
  ) {
    const value = raw as Record<string, unknown>
    return {
      version: STORAGE_VERSION,
      buckets: normalizeBuckets(value.buckets, now),
      lifetime: normalizeLifetime(value.lifetime, now),
    }
  }

  const records = parseLegacyRecords(raw, now)
  if (records.length === 0) return emptyUsageData()
  return {
    version: STORAGE_VERSION,
    buckets: aggregateRecords(records),
    lifetime: {
      inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
      outputTokens: records.reduce(
        (sum, record) => sum + record.outputTokens,
        0,
      ),
      requestCount: records.length,
      firstRequestAt: records[0]?.timestamp ?? null,
    },
  }
}

export function flushUsage(): Promise<void> {
  return getTelemetryWriter()?.flush() ?? Promise.resolve()
}

export function recordUsage(
  inputTokens: number,
  outputTokens: number,
  model?: string,
): void {
  try {
    const input = finiteNonnegative(inputTokens),
      output = finiteNonnegative(outputTokens)
    if (input === null || output === null) return
    const now = Date.now(),
      normalizedModel = normalizeModel(model)
    const bucket = {
      timestamp: minuteFor(now),
      inputTokens: input,
      outputTokens: output,
      requestCount: 1,
      ...(normalizedModel ? { model: normalizedModel } : {}),
    }
    if (testData) {
      testData.buckets.push(bucket)
      testData.lifetime.inputTokens += input
      testData.lifetime.outputTokens += output
      testData.lifetime.requestCount++
      testData.lifetime.firstRequestAt ??= now
      return
    }
    getTelemetryWriter()?.enqueue({
      id: randomUUID(),
      kind: "usage",
      generation: 0,
      recordedAt: now,
      payload: { ...bucket, firstRequestAt: now },
    })
  } catch {
    /* Collection cannot interrupt inference. */
  }
}

function sumBuckets(buckets: Array<UsageBucket>): {
  tokens: number
  requests: number
} {
  return buckets.reduce(
    (sum, bucket) => ({
      tokens: sum.tokens + bucket.inputTokens + bucket.outputTokens,
      requests: sum.requests + bucket.requestCount,
    }),
    { tokens: 0, requests: 0 },
  )
}

export async function getUsageResponse(): Promise<Record<string, unknown>> {
  const now = Date.now()
  const runtime = testData ? undefined : getHistoryRuntime()
  const data =
    testData
    ?? (await getHistoryRuntime().writer.read((pending) =>
      getHistoryRuntime().repository.readUsage(
        minuteFor(now - SEVEN_DAY_MS),
        pending,
      ),
    ))

  const fiveHoursAgo = minuteFor(now - 5 * 60 * MINUTE_MS)
  const sevenDaysAgo = minuteFor(now - SEVEN_DAY_MS)
  const fiveHour = sumBuckets(
    data.buckets.filter((bucket) => bucket.timestamp >= fiveHoursAgo),
  )
  const sevenDay = sumBuckets(
    data.buckets.filter((bucket) => bucket.timestamp >= sevenDaysAgo),
  )
  const lifetimeTokens = data.lifetime.inputTokens + data.lifetime.outputTokens

  return {
    five_hour: {
      utilization: fiveHour.tokens / 10_000_000,
      resets_at: Math.floor((now + 5 * 60 * MINUTE_MS) / 1000),
      tokens_used: fiveHour.tokens,
      request_count: fiveHour.requests,
    },
    seven_day: {
      utilization: sevenDay.tokens / 50_000_000,
      resets_at: Math.floor((now + SEVEN_DAY_MS) / 1000),
      tokens_used: sevenDay.tokens,
      request_count: sevenDay.requests,
    },
    ...(runtime ?
      {
        collection: {
          ...runtime.writer.status(),
          ...(await runtime.repository.collectionStatus()),
        },
      }
    : {}),
    lifetime: {
      total_input_tokens: data.lifetime.inputTokens,
      total_output_tokens: data.lifetime.outputTokens,
      total_tokens: lifetimeTokens,
      total_requests: data.lifetime.requestCount,
      first_request_at:
        data.lifetime.firstRequestAt === null ?
          null
        : Math.floor(data.lifetime.firstRequestAt / 1000),
    },
  }
}

/** Explicit in-memory fixture only; production always uses the selected database. */
export function resetUsageForTest(): void {
  testData = emptyUsageData()
}
export function enableDatabaseUsageForTest(): void {
  testData = undefined
}
