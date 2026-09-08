# Turso History and Runtime Disk Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist usage, routing and bounded activity/debug history in the selected database, removing handler log files and retaining bounded runtime buffers.
**Architecture:** Critical configuration/auth writes remain awaited transactions. A separate memory-only telemetry writer batches idempotent records, exposes loss/degradation, and never affects inference delivery.
**Tech Stack:** Bun/TypeScript, pinned Turso storage adapter, existing logging/diagnostics, Hono/React dashboard.
**Spec:** ../specs/2026-09-08-database-persistence-design.md
**Prerequisite:** Plan 1 schema/storage contracts; Plan 2 authorization for dashboard integration.
**Status:** Proposed; execute after complete plan approval.

## Global Constraints

- No JSON files, telemetry spool or logs directory. Local mode writes only selected SQLite DB/sidecars; remote mode creates no local persistence. Both optional Turso variables select remote; neither selects local; partial pair fails.
- Preserve all imported/committed usage minute buckets and lifetime totals. Reporting windows are not deletion windows.
- Preserve routing, session affinity, ForeignThinkingState, bridge execution and accepted payload sizes.
- Diagnostics never include gateway/upstream/database/session secrets.
- Diagnostic capture limits affect stored inspection/replay only, never provider requests, responses or bridge events.
- Acknowledged security/configuration changes never enter a lossy telemetry queue.
- Store failures never generate recursive database log traffic.
- Use strict TypeScript, existing UI, ~/* imports, approved registry and disjoint worker ownership.

## Files and interfaces

Create src/lib/storage/history-repository.ts, src/lib/telemetry-writer.ts, src/lib/debug-capture.ts, src/lib/shutdown.ts and src/routes/dashboard/activity.ts. Modify logger.ts, usage-tracker.ts, routing-telemetry.ts, llm-debug-log.ts, upstream capture call sites and dashboard history readers.

```ts
export interface HistoryRecord {
  id: string
  kind: "usage" | "routing" | "activity" | "debug" | "collection-gap"
  recordedAt: number
  generation: number
  payload: JsonValue
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
}
export interface HistoryRepository {
  applyBatch(batchId: string, records: ReadonlyArray<HistoryRecord>): Promise<void>
  clear(kind: "debug" | "activity"): Promise<number>
  prune(now: number): Promise<void>
}
export interface CapturedBody {
  body: string | null
  bytesObserved: number
  complete: boolean
  replayable: boolean
  omission: "none" | "too-large" | "redacted" | "unsupported" | "read-error"
}
```

JsonValue is from Plan 1. Production history APIs return existing usage/routing/debug DTOs plus additive status metadata; do not expose generic payload mutation endpoints.

### Task 1: Idempotent history writer and collection-gap state

**Files:** Create telemetry-writer.ts, storage/history-repository.ts; extend initial schema through a new numbered migration if Plan 1 has been applied; tests/telemetry-writer.test.ts, history-repository.test.ts.
**Consumes:** Storage, operation IDs and schema migration contract.
**Produces:** createTelemetryWriter(repository, clock): TelemetryWriter; durable run/gap metadata.

- [ ] Test confirmed commit, lost commit response, retry deduplication, overflow priority, maximum queue age, byte accounting, timer cancellation and failed shutdown.
```ts
test("a retried committed usage batch is counted once", async () => {
  const fixture = await createHistoryFixture()
  fixture.writer.enqueue(fixture.usageRecord("event-1", 7, 11))
  fixture.storage.loseNextCommitResponse()
  await fixture.writer.flush()
  await fixture.writer.flush()
  expect(await fixture.lifetime()).toMatchObject({
    inputTokens: 7, outputTokens: 11, requestCount: 1,
  })
})
```
createHistoryFixture in tests/helpers/history.ts uses real aggregation logic and deterministic adapter faults.
- [ ] Implement 1-second/100-item triggers, 2,000 record/16 MiB cap and 5-minute queue age. Coalesce usage/routing before batching; diagnostics are evicted first. Stable batch IDs stay fixed across retry; commit dedup marker, deltas and diagnostics atomically.
- [ ] Bound dedup retention longer than maximum possible retry/queue age and any outstanding timed-out transport; never reuse batch IDs. Prevent mutable queued payloads after enqueue.
- [ ] Persist capi_process_runs with start, cleanShutdown and lastFlush; known drop counts are sent when DB recovers. On next boot expose unclean prior run as an unknown collection gap. Do not infer exact lost requests.
- [ ] Keep rate-limited stderr diagnostics independent of writer. Expose status to authenticated dashboard; no credentials or opaque errors.
- [ ] Run queue/repository tests and remote lost-response/idempotency variants, typecheck/lint, review and commit.

### Task 2: Usage and routing history repositories

**Files:** Modify usage-tracker.ts, routing-telemetry.ts, routes/dashboard/api.ts, ui/src/screens/Usage.tsx, ui/src/lib/types.ts; tests/usage-tracker.test.ts, routing-telemetry.test.ts, dashboard-usage-routing.test.ts; add tests/usage-storage.test.ts.
**Consumes:** TelemetryWriter and HistoryRepository.
**Produces:** existing recordUsage/record-routing calls enqueue bounded deltas; async getUsageResponse/getRoutingTelemetrySnapshot query durable aggregates.

- [ ] Test full legacy v1/v2 bucket migration parser retention, lifetime sums, fresh-runtime history, multi-model dimensions, window boundaries and no duplicate pending/durable display.
```ts
test("old committed minute buckets are retained beyond reporting windows", async () => {
  const fixture = await createHistoryFixture()
  await fixture.seedUsageMinute({ ageDays: 90, requests: 4 })
  await fixture.repository.prune(fixture.clock.now())
  expect(await fixture.countUsageMinutes()).toBe(1)
  expect((await fixture.lifetime()).requestCount).toBe(4)
})
```
- [ ] Replace sync full-file writes with additive idempotent batch updates. Keep the existing utilization/reset response formulas; do not claim locally measured usage equals actual upstream quota.
- [ ] Query minute/time/model indexes and lifetime row; no loading lifetime history into memory. Overlay pending deltas only with a stable flush generation so a concurrently acknowledged batch is not double-counted.
- [ ] Persist routing's existing dimensions and 24-hour retention. Global configuration snapshot reload must not reset telemetry or fallback namespace revision.
- [ ] Add collection-degraded/gap indicators; committed totals are confirmed, new collection may be incomplete after an outage/crash.
- [ ] Run existing/focused usage/routing tests and UI typecheck; review and commit.

### Task 3: Sanitized database activity and removal of file log reporter

**Files:** Modify logger.ts and startup integration; create routes/dashboard/activity.ts, ui/src/screens/Activity.tsx; update dashboard registration/registry/Shell/types through coordinator. Add tests/activity-history.test.ts, logger-diskless.test.ts.
**Consumes:** TelemetryWriter, existing formatHandlerLogLine/descriptor-safe sanitizers.
**Produces:** stdout/stderr reporter plus selected-database activity records, GET /dashboard/api/activity with cursor pagination and DELETE for explicit clear.

- [ ] Test handler logging and logger import with filesystem-write tripwire; assert no mkdir/createWriteStream/writeFile, no early signal handlers and no raw secrets.
```ts
test("handler logging writes no application files", async () => {
  const fixture = await createDisklessLoggerFixture()
  fixture.logger.info("request complete", { model: "fixture-model" })
  await fixture.writer.flush()
  expect(fixture.fsWrites).toEqual([])
  expect(await fixture.activityCount()).toBe(1)
})
```
- [ ] Remove logs-directory construction, per-file streams/buffers and logger-owned process.exit signal handlers. Keep existing formatting/sanitization and console severity.
- [ ] Retain activity for seven days, max 50,000 rows/64 MiB, with timestamp/ID pagination and indexed expiry. Sanitized operator change events use IDs/field names, not secret values.
- [ ] Build a minimal Activity view with time/type filters, clear action and persistence status using existing components; no new UI framework.
- [ ] Test auth/CSRF, pagination without duplicates, eviction and clear-generation racing queued records. Run focused tests/UI typecheck, review and commit.

### Task 4: Bounded database debug capture and replay compatibility

**Files:** Create debug-capture.ts; modify llm-debug-log.ts, services/copilot/copilot-client.ts, custom-providers.ts, routes/dashboard/api.ts, llm-debug-replay.ts, ui/src/screens/LlmDebug.tsx, LlmReplay.tsx and associated detail components; tests/llm-debug-log.test.ts, llm-debug-dashboard.test.ts, llm-debug-detail-view.test.ts; add tests/debug-capture.test.ts, debug-storage.test.ts.
**Consumes:** HistoryRepository, TelemetryWriter, existing credential redactors and replay routing.
**Produces:** sanitizeDebugCapture(input): CapturedBody/metadata; async list/get/clear debug APIs; bounded pending overlay only.

- [ ] Replace old tests expecting raw auth retention with explicit secret-scrubbing tests. Test headers, URL userinfo/query, structured secret keys, known active secret literals, malformed JSON and error objects.
```ts
test("diagnostic truncation does not truncate the client response", async () => {
  const fixture = await createCaptureFixture({ bodyBytes: 2 * 1024 * 1024 })
  const response = await fixture.forward()
  expect((await response.arrayBuffer()).byteLength).toBe(2 * 1024 * 1024)
  const capture = await fixture.savedCapture()
  expect(capture.response.body).toBeNull()
  expect(capture.replayable).toBe(false)
})
```
- [ ] Implement streamed tee capture with 1 MiB per direction, bounded decoder memory and abort-safe cleanup; remove clone().text() unbounded diagnostics. Do not await capture/DB before sending inference bytes.
- [ ] Scrub before queue insertion. If body content changes due to redaction or is incomplete/unsupported, retain metadata and mark capture non-replayable. Preserve normal complete nonsecret payload and byte count when possible.
- [ ] Preserve current 10-minute complete/60-minute other TTL; enforce 2,000 rows/128 MiB global cap. Query only bounded pages/details. Use clear generation so in-flight completions cannot resurrect old captures.
- [ ] Replay uses current admin permission and current provider/account credentials, never persisted authorization. Missing/expired/truncated/redacted source requires explicit supplied replacement payload or returns existing compatible rejection.
- [ ] Test pending->complete/fail/abort, crash-unknown state, read-after-restart, clear race, replay ownership/routing and large request acceptance. Run protocol tests for all capture call sites; review and commit.

### Task 5: Shutdown, remaining transient state and no-disk proof

**Files:** Create shutdown.ts; modify src/start.ts, usage-tracker.ts, logger.ts, storage/runtime.ts, debug.ts; tests/diskless-runtime.test.ts, shutdown.test.ts, storage-readiness.test.ts.
**Consumes:** StorageRuntime, TelemetryWriter and existing Sentry flush.
**Produces:** coordinated stop admission, five-second history drain and storage close; no scattered immediate process exits.

- [ ] Test success/timeout shutdown, one signal handler, double-close idempotence and unavailable storage.
```ts
test("shutdown stops after bounded drain without a disk spool", async () => {
  const fixture = await createShutdownFixture({ storageNeverResolves: true })
  await fixture.stopWithFakeClock(5_000)
  expect(fixture.admissionStopped).toBe(true)
  expect(fixture.fsWrites).toEqual([])
  expect(fixture.reportedUnflushed).toBeGreaterThan(0)
})
```
- [ ] Keep live sockets/turns, bridge capabilities/work queues/events, IP leases/failures and fallback affinity volatile. Do not serialize maps into generic history and treat them as restartable runtime state.
- [ ] Assert unrelated setting/provider/account edit leaves fallback content revision and ForeignThinkingState unchanged; real fallback config change still clears correctly.
- [ ] In remote mode deny application filesystem writes throughout startup/setup/login/settings/inference/debug/export/shutdown. In local mode allow only selected DB and SQLite-managed sidecars; assert no JSON/log/spool writes. Run both actual adapter variants, allowing reads of shipped assets and explicit migration inputs.
- [ ] Run existing WS continuation/fallback/large-session-event suites, focused diskless/shutdown tests, typecheck/build/lint. Coordinator verifies no src runtime writeFile/appendFile/createWriteStream/Bun.write outside explicitly approved transfer tooling. Review and commit.

## Stage acceptance

R11-R13 and logging portions of R01/R10 pass on both backends. Historical buckets are retained after commit/import; queue/crash loss is explicit. Debug caps never change client/upstream payloads. Only local SQLite-managed persistence writes remain in local mode; remote mode has none. Volatile bridge/Responses work is not claimed resumable.
