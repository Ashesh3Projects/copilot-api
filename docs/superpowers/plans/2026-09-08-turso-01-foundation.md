# Turso Foundation and Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish local SQLite by default and optional remote Turso behind one typed persistence interface, replacing non-authentication configuration files.
**Architecture:** A deterministic selector chooses one local bun:sqlite or remote Turso adapter. Shared repositories/migrations own SQL and publish immutable snapshots only after durable commit.
**Tech Stack:** Bun 1.4.0+, strict TypeScript, @tursodatabase/serverless 1.4.0, existing Zod/Hono and Bun tests.
**Spec:** ../specs/2026-09-08-database-persistence-design.md
**Status:** Implemented and reviewed. Final evidence and operational limits: [acceptance record](2026-09-08-database-persistence-acceptance.md).

## Global Constraints

- One gateway process per deployment; TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are optional as a pair. Neither selects local SQLite; both select Turso; partial configuration fails.
- No runtime JSON files, logs or disk spool. Local mode writes only copilot-api.sqlite and SQLite-managed sidecars in DATA_DIR; remote mode writes no local database or persistence directory. Never switch backends after a runtime error.
- No application-level credential encryption in the two-variable draft; passwords/digests remain protected by their existing one-way representations.
- Remote storage errors never mean empty configuration or invalid credentials.
- Preserve routing algorithms, protocol shapes, OAuth semantics and all current model-fallback behavior.
- Use strict TypeScript, ~/* source imports, and https://packagefeedproxy.microsoft.io/npm/ for package operations.
- Do not capture secrets in source/tests/logs/tool output. Never paste the conversation's database token into a command.
- Preserve unrelated working changes. Execution begins from an isolated, verified baseline containing the intended existing fallback changes; no reset/stash/cleanup of caller files.
- Task completion requires focused tests and review; final integrated gates occur in Plan 4.

## File structure and shared contracts

Create src/lib/storage/{types,errors,config,client,local-sqlite,turso,migrations,operations,settings-repository,snapshot,readiness}.ts and src/lib/storage/migrations/001-initial.ts. client.ts is the small factory; adapter details stay in local-sqlite.ts/turso.ts. Keep existing domain validators; replace persistence internals rather than moving protocol logic.

```ts
export type SqlValue = null | string | number | bigint | Uint8Array
export interface SqlStatement { sql: string; args: ReadonlyArray<SqlValue> }
export interface SqlSession {
  query(statement: SqlStatement): Promise<ReadonlyArray<Record<string, unknown>>>
  execute(statement: SqlStatement): Promise<{ rowsAffected: number }>
}
export interface Storage {
  read<T>(work: (session: SqlSession) => Promise<T>): Promise<T>
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T>
  atomicBatch(statements: ReadonlyArray<SqlStatement>): Promise<void>
  close(): Promise<void>
}
export interface MutationContext {
  operationId: string
  expectedRevision: number
  actorId: string
  kind: string
  inputDigest: string
}
export interface Committed<T> { value: T; revision: number }
export type JsonValue = null | boolean | number | string | JsonValue[] |
  { [key: string]: JsonValue }
export type SettingsNamespace = "app" | "replacements" | "model_redirects" |
  "model_settings" | "model_routing" | "model_fallbacks" | "feature_flags" |
  "statsig_overrides"
export interface SettingsDocument {
  namespace: SettingsNamespace; value: JsonValue; revision: number
}
export interface SettingsRepository {
  loadAll(): Promise<ReadonlyArray<SettingsDocument>>
  replace(namespace: SettingsNamespace, value: JsonValue,
    context: MutationContext): Promise<Committed<SettingsDocument>>
}
export interface RuntimeSnapshot {
  revision: number
  documents: ReadonlyMap<SettingsNamespace, SettingsDocument>
}
export interface SnapshotManager {
  get(): RuntimeSnapshot
  refreshIfChanged(): Promise<void>
  publish(snapshot: RuntimeSnapshot): void
}
```

These are adapter-facing contracts; domain getters return the project's existing AppConfig, ReplacementRule, ModelSettings and other types after validation. Do not add any implicit cast from an SDK result into a trusted domain object.

### Task 1: Backend selection, local SQLite and pinned remote adapter

**Files:** Create storage/types.ts, errors.ts, config.ts, client.ts, local-sqlite.ts, turso.ts, readiness.ts; tests/storage-selection.test.ts, local-sqlite.test.ts, storage-contract.test.ts, turso-client.test.ts, turso-config.test.ts, turso-remote-contract.test.ts. Modify package.json, bun.lock.
**Consumes:** Optional Turso pair, optional local DATA_DIR, injected fetch for remote tests.
**Produces:** createStorage(config): Storage; StorageUnavailableError, StorageConflictError, StorageSchemaError, StorageCommitUnknownError; probeStorage(storage) with sanitized engine/readiness result.

- [ ] Add selector tests for missing/empty/whitespace pair, valid pair, partial configuration and invalid remote URL. Prove a remote authentication/network error never opens a local DB. Add local file reopen, FK/cascade/rollback, concurrency and exact sidecar tests. Add real-SDK/fake-fetch tests for URL normalization, bound string/binary/null parameters, atomic batch structure, session ownership, timeouts and no automatic write replay.
```ts
test("a lost commit response is not silently replayed", async () => {
  const remote = createFakeTursoFetch({ loseFirstCommitResponse: true })
  const storage = createStorage(testConfig(remote.fetch))
  await expect(storage.atomicBatch([
    { sql: "INSERT INTO capi_probe(id) VALUES (?)", args: ["op-1"] },
  ])).rejects.toBeInstanceOf(StorageCommitUnknownError)
  expect(remote.committedWritesFor("op-1")).toBe(1)
})
```
createFakeTursoFetch and testConfig are test helpers created in tests/helpers/turso-transport.ts; they model Hrana request/response shapes of the pinned SDK, not a substitute production SQL implementation.
- [ ] Run bun test tests/turso-client.test.ts tests/turso-config.test.ts; confirm intended missing behavior.
- [ ] Implement resolveStorageConfig as a discriminated union: {kind:"sqlite",path} or {kind:"turso",url,authToken}. Trim pair, validate both-or-neither, freeze selection. DATA_DIR defaults to ~/.local/share/copilot-api, Docker /app/data, filename copilot-api.sqlite. Remote selection must not create/open DATA_DIR.
- [ ] Implement bun:sqlite adapter with strict bindings, verified WAL/FK/FULL/5000ms busy_timeout. Mount/create the directory, not only the database file. Use POSIX restrictive modes or existing Windows ACLs; no recursive permission edits. Mutex serializes ALL access to the shared connection, including reads; transaction-scoped helpers bypass reacquisition. Explicit BEGIN IMMEDIATE/await callback/COMMIT with rollback on rejection; never db.transaction(async...). Reject nested/leaked transaction handles. Add regression throwing after await rolls back both pre/post-await writes. Use isolated read-only snapshot connection for long backup; no unrelated network calls inside transactions.
- [ ] Install exact SDK with approved registry and verify lockfile resolution; local adapter uses built-in Bun and adds no package. Normalize integers/BLOB/null results identically across both.
- [ ] Implement owned-session transactions: configure+verify FK before BEGIN, use bound SQL, roll back known failures, dispose uncertain sessions. Fixed atomic batches use explicit "immediate"; reject internal statements containing transaction control at the adapter boundary. Implement 10-second call / 30-second operation deadlines.
- [ ] Implement SELECT 1, separate SELECT turso_version(), and SQLite compatibility/version probes. Unsupported-engine, authentication/network/quota and absent application schema are distinct outcomes. Never log SDK request/header objects.
- [ ] After approval, run opt-in remote contract probes in a separate test database, or exact UUID-prefixed tables in the configured database; retain an allowlist of created names and drop only those. Prove invalid FK rejection, uniqueness, DDL/batch rollback, concurrency, immediate fresh-connection read-after-write and reconnect. Do not modify capi_ production tables during this probe.
- [ ] Run shared Storage contract suite against actual file-backed local SQLite and opt-in Turso, plus focused tests/typecheck/changed-file lint. Verify local WAL/SHM lifecycle and permission/read-only failures. Review and commit only task paths.

### Task 2: Schema, migration checksums and idempotent committed operations

**Files:** Create storage/migrations.ts, storage/migrations/001-initial.ts, storage/operations.ts; tests/storage-migrations.test.ts, tests/storage-operations.test.ts.
**Consumes:** Storage, SqlSession and typed storage errors.
**Produces:** migrateStorage(storage): Promise<void>; runMutation<T>(storage, context, work): Promise<Committed<T>>; getStoreRevision(storage): Promise<number>.

Use all table groups in spec section 5, with foreign keys declared before their dependent table. Validate row counts and required metadata values after migration. Commit schema checksum and version with its DDL. If transaction rollback cannot be proven against the chosen remote engine, stop that engine's migration rather than implementing partial DDL recovery by guesswork.

```sql
CREATE TABLE capi_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE capi_schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE TABLE capi_applied_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  committed_revision INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE capi_settings (
  namespace TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
```

Operation results contain only safe identifiers/revision/metadata, never newly minted bearer values, passwords or database tokens. Operations that return a generated secret must generate it before the transaction and retain it only within the live request; if that response is lost, the caller creates/rotates a replacement rather than retrieving plaintext from an operation record.

- [ ] Test fresh schema, repeated migration, altered checksum, newer schema, DDL failure rollback and missing metadata. Use remote tests for actual constraints.
- [ ] Test two mutations with the same expectedRevision: exactly one commits; replay of an existing operation ID does not reapply deltas. A mismatched actor, operation kind or input digest for an existing ID is a conflict. Actor ID comes from verified admin/owner authority, never untrusted request fields.
```ts
test("reconciliation publishes only a confirmed committed operation", async () => {
  const fixture = await createStorageFixture()
  fixture.transport.loseNextCommitResponse()
  const outcome = await fixture.mutateSettings("model_settings", [], "change-1")
  expect(outcome.revision).toBe(1)
  expect(await fixture.countAppliedOperations("change-1")).toBe(1)
})
```
createStorageFixture in tests/helpers/storage.ts supplies an injected Storage fake with deterministic transaction faults; remote variants exercise actual adapter SQL.
- [ ] Implement stable operation IDs, input digests, metadata revision compare/update, safe result encoding and reconciliation on a fresh connection. Unknown and unreconciled outcomes return a typed error with an operation ID, not success; prohibit further dependent mutations until reconciled.
- [ ] Implement bounded contention retries only when rollback is known; test unavailable database during reconciliation separately.
- [ ] Run focused suites/typecheck/lint; review and commit schema plus helper contracts.

### Task 3: Typed settings repository and commit-before-publication snapshot

**Files:** Create storage/settings-repository.ts, storage/snapshot.ts; tests/settings-repository.test.ts, tests/settings-snapshot.test.ts. Modify src/lib/config.ts.
**Consumes:** Storage, MutationContext, runMutation and existing AppConfig/default merging validators.
**Produces:** createSettingsRepository(storage): SettingsRepository; initializeSnapshot(repository): Promise<SnapshotManager>; async writeConfig/updateConfig backed by repository; existing getConfig reads initialized snapshot.

- [ ] Test defaults only for truly absent app record, malformed persisted document rejection, failed commit preserving current value/revision, and a complete snapshot read in one read transaction.
```ts
test("failed settings save does not publish a new runtime value", async () => {
  const app = await createSettingsFixture({ smallModel: "before" })
  app.storage.failNextCommit()
  await expect(app.update({ smallModel: "after" })).rejects.toThrow()
  expect(app.get().smallModel).toBe("before")
  expect(app.snapshot.get().revision).toBe(0)
})
```
createSettingsFixture is defined in tests/helpers/storage.ts using the real repository and injected Storage.
- [ ] Implement versioned namespace values, validate on read/write, persist intentional default merges in a transaction. Never return fallback defaults after timeout, malformed JSON, permission or schema failures.
- [ ] Convert writeConfig and updateConfig callers to await persistence. Serialize local publication and apply only the confirmed revision. Expose no mutable snapshot reference.
- [ ] Implement refreshIfChanged using indexed metadata read plus one consistent document load when changed. Bind a snapshot at each HTTP request/new WebSocket turn; do not switch inside an admitted request. Keep per-namespace content revision: unrelated edits never increment fallback revision or clear ForeignThinkingState.
- [ ] Update config consumers/tests and run focused tests plus typecheck; review and commit.

### Task 4: Replace remaining configuration and policy file stores

**Files:** Modify src/lib/auto-replace.ts, model-redirect.ts, model-settings.ts, model-routing.ts, model-fallback-config.ts, ip-allowlist.ts, trusted-jwt-digests.ts; src/routes/feature-flags/store.ts, src/routes/statsig-overrides/store.ts, src/routes/dashboard/api.ts, fallbacks.ts, src/config.ts. Create storage/policy-repository.ts. Update their existing tests and add tests/storage-config-coverage.test.ts.
**Consumes:** SettingsRepository, SnapshotManager, policy repository backed by same Storage and mutations.
**Produces:** Existing domain APIs backed by selected SQLite/Turso storage; asynchronous mutation signatures and unchanged getter/result semantics where snapshots suffice.

- [ ] Build a table-driven persistence fixture for all namespaces. Test round-trip ordering, normalization, invalid document failure and failed save leaves state/revision unchanged.
```ts
test.each([
  "replacements", "model_redirects", "model_settings", "model_routing",
  "model_fallbacks", "feature_flags", "statsig_overrides",
] as const)("%s survives a fresh service instance", async (namespace) => {
  const fixture = await createNamespaceFixture(namespace)
  await fixture.save(fixture.validValue)
  expect(await fixture.freshRead()).toEqual(fixture.validValue)
})
```
createNamespaceFixture maps each namespace to its existing validator and a concrete valid nonempty sample in tests/helpers/settings-fixtures.ts.
- [ ] Replace all file read/write/temporary-rename/chmod code with repositories. Keep IP allowlist/trusted digests relational and authorization lookups async. Preserve security scope restrictions and digest-text-is-not-a-credential handling.
- [ ] Retain current fallback validation/defaults, committed configuration revision invalidation, cache-clear epoch and ForeignThinkingState runtime behavior. Never publish before commit or persist its transient cache.
- [ ] Update routes/CLI to await mutation results; add 409 revision-conflict handling without claiming a saved value.
- [ ] Run bun test tests/storage-config-coverage.test.ts tests/model-fallback-config.test.ts tests/dashboard-fallbacks.test.ts tests/statsig-overrides-store.test.ts tests/feature-flags-store-security.test.ts tests/dashboard-model-routing.test.ts tests/dashboard-ip-allowlist.test.ts plus the existing digest/redirect/settings/replacement suites; run typecheck/lint, review and commit.

### Task 5: Initial runtime wiring and database status

**Files:** Modify src/start.ts, src/server.ts, src/routes/health/route.ts, src/debug.ts, src/lib/paths.ts; create src/lib/storage/runtime.ts; tests/storage-startup.test.ts, tests/storage-readiness.test.ts.
**Consumes:** migrateStorage, repositories, SnapshotManager; authentication initialization added in Plan 2.
**Produces:** initializeStorageRuntime(): Promise<StorageRuntime>; getStorageRuntime(): StorageRuntime; stopStorageRuntime(): Promise<void>; minimal readiness route and authenticated detailed status.

```ts
export interface StorageRuntime {
  storage: Storage
  settings: SettingsRepository
  snapshot: SnapshotManager
  close(): Promise<void>
}
```

- [ ] Test both absent=>local default, both present=>remote, partial pair=>configuration error, local read-only/corruption failure, remote file/:memory: URL rejection, timeout/bad schema and intentional empty database initialization. Neither backend failure switches stores.
- [ ] Wire storage initialization before any configuration/auth loads. Static import must not read files, query the DB or create timers that leak between tests.
- [ ] Keep /health and /health/health response shape; add /health/ready with only ready/unavailable status. Detailed database type/revision/queue status is administrator-only.
- [ ] Replace PATHS/ensurePaths state-file handling with the local adapter's sole fixed DB path. Authentication/history legacy writers are removed in Plans 2 and 3 before release. In Turso mode, no directory is created. Do not present intermediate stage as JSON-free.
- [ ] Run startup/readiness tests, typecheck/build and task review. Commit; hand precise StorageRuntime and schema contracts to Plans 2 and 3.

## Stage acceptance

R02 and the configuration portions of R01/R03/R04/R17 pass. No migration to production, release or deployment occurs at this stage. Remaining authentication/history writers must be removed before final acceptance. Plan 2 and Plan 3 can proceed after shared contracts are reviewed, with coordinator ownership of startup/schema/dashboard registration.
