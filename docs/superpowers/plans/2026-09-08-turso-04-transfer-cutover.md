# Turso Transfer, Cutover and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide explicit legacy migration and streamed exports/backups, document local SQLite default plus optional Turso, and verify both backends without JSON persistence.
**Architecture:** Migration reads explicitly supplied legacy inputs once into an empty target. Exports stream from a consistent database snapshot; encrypted restore writes only to a replacement empty database and cannot become ready before complete verification.
**Tech Stack:** Bun/TypeScript, Turso repositories, existing fflate, node:crypto streaming AES-256-GCM/scrypt, Hono, Docker/Compose, Bun tests.
**Spec:** ../specs/2026-09-08-database-persistence-design.md
**Prerequisite:** Plans 1-3 integrated and reviewed.
**Status:** Implemented and reviewed. Final evidence and operational limits: [acceptance record](2026-09-08-database-persistence-acceptance.md).

## Global Constraints

- No automatic import on start and no local JSON/log/spool/transfer temporary files. Local mode uses the volume-mounted SQLite DB/sidecars; remote mode creates no local persistence.
- Explicit legacy import may read an operator-supplied directory; it never edits/deletes source files or the existing Docker volume.
- Normal export redacts secrets and is not a complete backup.
- Backup password is entered per operation, never logged/persisted; it is not a deployment environment variable.
- Restore targets an empty new database; the serving database remains untouched for rollback.
- Preserve account IDs, routing references, imported/committed usage, OAuth credential families and protocol compatibility.
- TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are optional as a pair: neither selects local SQLite; both select Turso; partial configuration fails. Runtime failure never selects a different backend. Optional DATA_DIR/deployment controls/1Password remain.
- Use approved package registry and effective commit identity Ashesh3 <3626859+Ashesh3@users.noreply.github.com>.
- No production deployment or destructive cleanup is implicit in producing the implementation branch.

## Files and transfer interfaces

Create src/storage.ts, src/lib/storage/{legacy-import,transfer-records,restore}.ts, src/lib/config-backup.ts; modify main.ts, config-export.ts, dashboard/settings-export.ts and UI Settings; add a focused docs/turso-storage.md runbook.

```ts
export interface TransferManifest {
  formatVersion: 1
  schemaVersion: number
  sourceStoreId: string
  recordCounts: Readonly<Record<string, number>>
  recordsSha256: string
}
export interface ImportPreview {
  sourceDigest: string
  expectedTargetRevision: number
  counts: Readonly<Record<string, number>>
  warnings: ReadonlyArray<string>
}
export interface LegacyImportInput {
  directory: string
  includeEnvironment: boolean
}
export interface TransferRecord {
  table: string
  key: string
  value: JsonValue
}
export interface TransferProgress {
  operationId: string
  phase: "reading" | "writing" | "verifying" | "complete" | "failed"
  records: number
}
```

Table names are decoded through a fixed allowlist into repository import functions, never interpolated from input SQL. JsonValue and MutationContext come from Plan 1. Transfer progress never includes credential or record contents.

### Task 1: Explicit read-only legacy import and preview

**Files:** Create src/storage.ts, storage/legacy-import.ts, storage/transfer-records.ts; modify main.ts; tests/legacy-import.test.ts, legacy-import-credentials.test.ts, storage-cli.test.ts.
**Consumes:** All repositories and existing legacy validation/parsers.
**Produces:** previewLegacyImport(input): Promise<ImportPreview>; applyLegacyImport(input, preview): Promise<TransferProgress>; CLI storage import-legacy --from <directory> [--from-env] with preview then --apply --source-digest <digest> --expected-revision <number>.

- [ ] Build secret-safe synthetic fixtures for every existing JSON/token store, including empty/missing/invalid files, single-token legacy, one/many env tokens, provider apiKeyEnv, admin environment marker and v1/v2 usage.
```ts
test("legacy import preserves account routing IDs and all old usage", async () => {
  const fixture = await createLegacyImportFixture({
    accountIds: [0, 1], usageAgeDays: 90,
  })
  const preview = await fixture.preview()
  await fixture.apply(preview)
  expect(await fixture.accountIds()).toEqual([0, 1])
  expect(await fixture.routeAccountId("fixture-model")).toBe(1)
  expect(await fixture.oldUsageRows()).toBe(1)
  expect(fixture.sourceWrites).toEqual([])
})
```
createLegacyImportFixture in tests/helpers/legacy-storage.ts uses temporary user-input fixtures only; production import is read-only and explicitly invoked.
- [ ] Read only named known files within the checked supplied directory. Reject unsafe symlinks/path traversal and unexpected authority inputs. Do not enumerate/copy arbitrary files.
- [ ] Resolve selected credential env inputs in memory; never echo values. Preserve original positional IDs and references. Migrate existing gateway keys to digests and actual admin Argon2id hash unchanged; fingerprint-only admin marker is insufficient and must fail preview.
- [ ] Import all OAuth records without changing reusable refresh/principal/family semantics. Invalidate imported admin sessions when changing source authority. Do not copy runtime bridge/fallback maps.
- [ ] Validate all inputs/references before write; show counts and sanitized warnings. Empty-target requirement, source manifest digest, expected revision and committed import marker make application idempotent. Same manifest repeats safely; different nonempty import fails.
- [ ] Run tests with filesystem-write tripwire on inputs and fault mid-import; verify no partially ready target. Review and commit.

### Task 2: Consistent configuration export without source files

**Files:** Modify config-export.ts, routes/dashboard/settings-export.ts, ui/src/screens/Settings.tsx; tests/dashboard-config-export.test.ts; add tests/config-export-storage.test.ts.
**Consumes:** Typed settings/accounts/provider read APIs in one consistent snapshot.
**Produces:** Existing createConfigExportZip result/HTTP filename contract, with manifest and sanitized metadata.

- [ ] Retain date filename formatting/current nine named JSON entries; add manifest.json and sanitized accounts.json. Existing consumer-visible file names and JSON shapes remain where possible.
```ts
test("export uses committed DB state and contains no secret records", async () => {
  const fixture = await createExportStorageFixture()
  const archive = await fixture.export()
  const entries = unzipSync(archive.zip)
  expect(entries["model_fallbacks.json"]).toBeDefined()
  expect(entries["manifest.json"]).toBeDefined()
  expect(entries["oauth_tokens.json"]).toBeUndefined()
  expect(fixture.archiveText(entries)).not.toContain("fixture-upstream-secret")
  expect(fixture.fsWrites).toEqual([])
})
```
- [ ] Implement database snapshot read, existing recursive redaction plus metadata allowlisting. Never include gateway/admin/OAuth/session/trusted-digest tables or provider secret headers. Fail safely on invalid stored data.
- [ ] Generate ZIP in memory for bounded config only and return no-store attachment response. No temporary files; browser download is operator-owned.
- [ ] Test concurrent configuration edit yields one consistent version and missing optional namespaces follow existing export semantics. Run export/UI tests, review and commit.

### Task 3: Streaming encrypted backup and empty-target restore

**Files:** Create config-backup.ts, storage/restore.ts; extend storage.ts and transfer-records.ts; create routes/dashboard/settings-backup.ts; modify Settings UI/route registration. Tests/config-backup.test.ts, storage-restore.test.ts, dashboard-backup.test.ts.
**Consumes:** Consistent transfer record iterator, fixed table allowlist, Storage and migration version.
**Produces:** createBackupStream(password, signal): ReadableStream<Uint8Array>; restoreBackup(stream, password, target, signal): Promise<TransferProgress>; administrator download and owner CLI restore --input <explicit backup file>.

Wire format v1:
- UTF-8 magic CAPI-BACKUP followed by version byte 1, fixed 16-byte salt and 12-byte IV.
- Header is AES-GCM AAD; derive 32-byte key with scrypt N=32768,r=8,p=1,maxmem=64 MiB; reject any unsupported version before key derivation.
- One AES-256-GCM encrypted stream, final 16-byte auth tag. Decryptor holds only the last 16 ciphertext bytes while streaming.
- Plaintext consists of UTF-8 NDJSON logical records with an authenticated final manifest. Each record has monotonic sequence, fixed table kind, key and value. Terminal manifest contains exact record counts and SHA-256 of preceding record bytes; reject duplicate key, missing/reordered sequence or missing terminal record.
- A decoded record is at most 8 MiB. Fields larger than that are encoded as ordered bounded continuation records for a named allowlisted field, with original length/checksum; no application setting/request limit is imposed by transfer framing. Limit frame allocation before parsing.
- Transfer deadline 30 minutes, cancelable, individual database calls remain 10 seconds. No unbounded memory history snapshot and no local staging.
- Per-table record ordering and continuation kinds are fixed in transfer-records.ts; reject unrecognized kinds instead of executing input SQL.

- [ ] Add encryption round-trip, wrong password, modified header/ciphertext/tag, truncated input, missing terminal manifest, duplicate/out-of-order record, enormous frame, unknown table/version and cancellation tests.
```ts
test("truncated backup never makes the target ready", async () => {
  const fixture = await createBackupFixture()
  const bytes = await fixture.smallBackup("fixture-password")
  const target = await fixture.emptyTarget()
  await expect(target.restore(bytes.subarray(0, bytes.length - 17),
    "fixture-password")).rejects.toThrow()
  expect(await target.readiness()).toBe("restore-incomplete")
  expect(await fixture.sourceUnchanged()).toBe(true)
})
```
- [ ] Stream a consistent logical read transaction with paging; records cover durable config/identity/OAuth/usage/history, exclude Turso credentials/setup/device intents/active runtime state. Input password lives only for operation.
- [ ] Authenticate dashboard backup with admin session, CSRF and current admin password before streaming. Do not put backup password or auth values in URL/query/logs; use explicit POST body.
- [ ] Target restore requires empty application data and marks restore ID incomplete before any records. Write bounded batches; do not start normal gateway against incomplete marker. After authentication tag/manifest/count/reference verification, transaction clears marker, invalidates admin sessions/setup codes and makes target ready. Preserve gateway/OAuth client credentials.
- [ ] On failure/cancel, leave target unready. Explicit cleanup/retry validates exact restore ID and deletes only records owned by it. No production database deletion. Operators can abandon target safely.
- [ ] Run crypto/fault/large-stream tests and opt-in remote round trip. Compare logical checksums and fresh auth/inference behavior after restore. Review and commit.

### Task 4: Deployment configuration, CLI and runbook cutover

**Files:** Modify .env.schema, generated env.d.ts, entrypoint.sh, Dockerfile, docker-compose.yml, .github/workflows/ci.yml, nightly-smoke.yml, README.md, src/start.ts, auth.ts, config.ts, check-usage.ts, debug.ts, lib/paths.ts; create docs/turso-storage.md; update relevant env/CLI/Docker tests.
**Consumes:** Complete dual-backend runtime plus transfer commands.
**Produces:** local named-volume default, optional Turso without required volume, no legacy credential env override, documented first boot/import/restore/backend switch.

- [ ] Mark BOTH TURSO_DATABASE_URL and sensitive TURSO_AUTH_TOKEN @optional in .env.schema; validate pair at startup rather than marking either required. Retain DATA_DIR and optional 1Password/deployment controls. Remove legacy credential variables from normal runtime schema; importer reads explicit legacy env separately. Regenerate env.d.ts with existing Varlock workflow. Test schema/doc optionality matches selector truth table.
- [ ] Retain DATA_DIR=/app/data and named-volume directory mount for default local SQLite. For new installs Compose manages the named volume; no manual external-volume prerequisite. Preserve existing deployment volume data: provide explicit mapping/import steps rather than replacing or deleting it. Add a remote Compose example with optional Turso pair set and no app data volume; default mounted volume, if left attached in Turso mode, remains unused by app persistence.
- [ ] Remove GH_TOKEN shell argument construction and --api-key-auth env bootstrap from entrypoint; use argv-safe forwarding. Avoid runtime bunx downloads that require writable package caches: include needed Varlock launcher at image build time or invoke the verified existing installed command. Image runtime must work read-only.
- [ ] Update auth/config/admin/check-usage/debug commands to use database services and redacted status. Old token flags produce actionable import instructions instead of silently taking precedence.
- [ ] Document BOTH optional Turso values in README configuration/env table, Docker/Compose section, docs/turso-storage.md, CLI help and relevant deployment docs. Include neither/both/one truth table; local filename, whole-directory volume, supported local filesystem/WAL and permissions; Turso example without volume; no runtime failover; backend selection alone never transfers data. Include setup-code, browser accounts/password, secret storage tradeoff, owner reset, explicit import, normal export versus encrypted backup and both-direction backend transfer/rollback.
- [ ] Update CI with mandatory real file-backed local SQLite contract/E2E tests and opt-in isolated Turso lane, never production values. Keep mock tests offline; remote verification must be explicitly reported if unconfigured, not implied by local tests.
- [ ] Run env-schema/CLI/nightly/Docker config tests; verify generated schema and build output, review and commit.

### Task 5: Whole-change acceptance and independent review

**Files:** Add tests/turso-gateway-e2e.test.ts, tests/diskless-runtime.test.ts, tests/turso-restore-e2e.test.ts; review all modified paths.
**Consumes:** Plans 1-4 and acceptance R01-R18.
**Produces:** validated implementation branch and concise evidence/runbook; no automatic production rollout.

- [ ] Run the same E2E sequence against file-backed local SQLite and separate remote test database/exact checked namespace: migrations -> setup-code -> zero-account dashboard -> public/Enterprise mocked auth onboarding -> one/many inference -> provider/Groq -> credential replacement -> restart -> existing OAuth client -> password change/reset -> disable/enable/remove -> export/backup/restore. Prove logical local-to-Turso and Turso-to-local restore without changing IDs/credentials.
- [ ] Exercise actual public Hono and WebSocket routes and next turns, including existing socket new turn after credential revoke/DB outage, explicit account pins, ordinary affinity membership change, single-account unknown/disabled-model behavior, 421 and 401/403, model fallback/ForeignThinkingState, custom providers, Messages/Chat/Responses/Google.
- [ ] Inject unknown commit outcomes, DB offline startup/running service, invalid schema/newer schema, failed import/restore, queue overflow/crash/unclean run, history clear races. Assert no false successful save, no auth bans from DB error, no duplicate usage and no credential exposure.
- [ ] Run remote subprocess/Docker with --read-only and no app data mount; assert zero local app persistence. Run local image with read-only root and one writable named data directory; assert only copilot-api.sqlite and SQLite-managed sidecars, no JSON/log/temp exports. Restart container against same volume and prove persistence; test default pair absent, pair present, partial config and unreachable Turso never switching to local. Inputs may be read-only mounted, exports go HTTP/stdout.
- [ ] Run sequential fresh validation: bun test; bun run typecheck; bun run lint:all; bun run build; UI npm run typecheck and npm run build from ui with approved registry; git diff --check. Record preexisting/environment failures separately, resolve relevant failures and rerun only affected gates after changes.
- [ ] Run a whole-change independent review against spec R01-R18 and all deferred task findings. Use subagent-driven-development task/whole-change review process; repair substantive findings, then repeat required affected checks.
- [ ] Verify effective Git author/committer before final commits. Preserve unrelated files. Present exact test results, remote contract evidence, remaining known limits, migration/runbook and approval-ready branch. Ask separately before production cutover/deleting old data if not explicitly authorized later.

## Final acceptance

Every R01-R18 row has evidence for applicable local/remote paths. No claim of Turso readiness based solely on local tests/fakes, and no deployment claim from commits. No production JSON/volume deletion occurs. Completion requires default local SQLite, optional Turso pair, both-mode dashboard/migration/artifact parity, no JSON persistence and full compatibility checks.
