# Copilot API 5.1.0 implementation plan

> For agentic workers: use superpowers:subagent-driven-development. Work through each scoped deliverable and record verification before completion.

**Goal:** Complete the eleven dashboard/runtime improvements and publish 5.1.0.
**Architecture:** Keep existing UI and storage boundaries. Compose redirects with fallback resolution through one safety analysis, preserve raw diagnostic capture, and carry account-specific integration identity through the existing lease context.
**Tech stack:** Bun, TypeScript, Hono, SQLite/Turso, React, Astryx, Vite.
**Spec:** ../specs/2026-09-09-dashboard-v5.1-design.md

## Global constraints

- All work is authorized by the user's release request; proceed without repeated approval gates.
- Preserve protocol round trips and current storage backend selection.
- No new global integration setting or UI framework/dependency.
- npm registry: https://packagefeedproxy.microsoft.io/npm/.
- Git identity: Ashesh3 <3626859+Ashesh3@users.noreply.github.com>.
- Synthetic credentials in tests; never print live credentials.
- Workers edit only assigned files; no commits or generated UI changes until integration.

## Task 1: Debug capture and replay

Files: src/lib/debug-capture.ts, src/lib/llm-debug-log.ts, debug capture call sites, src/routes/dashboard/llm-debug-replay.ts, ui/src/screens/LlmDebug.tsx, debug UI helpers and debug tests.

- [ ] Add failing exact-body/header/URL tests including credentials, embedded JSON, SSE CRLF, non-JSON and large bodies.
- [ ] Remove payload filtering and preserve original capture through storage, detail, replay and exports.
- [ ] Remove Latest; Refresh resets the cursor. Keep true capture failure states and retention.
- [ ] Run each affected test file and report needed shared queue/storage changes to the coordinator.

## Task 2: Remove Activity (user revision)

Files: src/lib/logger.ts, src/lib/telemetry-writer.ts, src/lib/storage/history-repository.ts, history lifecycle call sites, ui/src/screens/Activity.tsx, activity/history tests.

- [ ] Remove Activity screen, sidebar/registry, dashboard routes and event recording.
- [ ] Add migration004 dropping capi_activity; preserve applied migrations and older backup restore compatibility.
- [ ] Remove obsolete Activity tests; retain debug/history cursor, queue and lifecycle regressions.
- [ ] Preserve generic raw debug queue/storage improvements and real process lifecycle accounting.
- [ ] Run affected tests and report migration acceptance.

## Task 3: Account integration overrides and compact rows

Files: accounts service/repository/schema, copilot header construction, account contexts, ui/src/screens/Accounts.tsx and account/integration tests.

- [ ] Test durable blank/default/custom integration IDs and account isolation.
- [ ] Implement migration, revision-checked account mutation, catalog refresh, and selected-account headers.
- [ ] Render initial skeleton, compact icon actions and expandable integration editor with default placeholder.
- [ ] Verify reconnect, credential rotation and leased requests preserve identity; test backup/restore compatibility.

## Task 4: Redirect/fallback composition and cycle safety

Files: src/lib/model-redirect.ts, model redirect store/validation, src/lib/model-fallback.ts, routing safety helper, dashboard redirect/fallback routes and screens, request handlers, routing/fallback tests.

- [ ] Add red regression for astra HTTP 422 -> sol -> sol-fast at actual upstream call.
- [ ] Implement one redirected fallback target and preserve effort/provider semantics.
- [ ] Analyze pure and combined executable cycles, guarding both features and invalidating stale affinity.
- [ ] Expose safety to both pages and show danger with loop path; saving corrected rules restores routing.
- [ ] Verify aliases, effort-specific/ordered/disabled rules, longer chains, config races, all protocols and next turns.

## Task 5: Remaining UI and Settings organization

Files: ui/src/Shell.tsx, ui/src/screens/Usage.tsx, ModelSettings.tsx, Settings.tsx, StoredCredentials.tsx, DatabaseBackup.tsx, CSS as necessary.

- [ ] Reuse favicon in rounded sidebar heading.
- [ ] Remove exactly the requested Usage copy and model preset buttons.
- [ ] Reorganize settings into compact coherent groups with bounded access lists.
- [ ] Preserve existing controls and test existing UI behavior, then inspect actual browser views.

## Task 6: Integrated verification and release

- [ ] Rebuild generated dashboard once integrated.
- [ ] Root/UI typecheck and full lint; fix change-related findings.
- [ ] Run root tests sequentially in fresh Bun processes and integration checks available in environment.
- [ ] Independent whole-diff review and corrections.
- [ ] Set package version 5.1.0; commit, push and create PR with problem/behavior/validation description.
- [ ] Complete required CI, merge under release authorization, publish tag/release and verify public latest state.

## Progress ledger

Initial state: clean c8f28dd on origin/master. Worktree: ../copilot-api-v5.1, branch codex/dashboard-v5.1.0.
Task boundaries: debug owns debug UI, activity owns shared history writer/repository, accounts owns Accounts UI and account storage, coordinator owns redirect/fallback and remaining UI. Generated dashboard is coordinator-only.
Ruling: capture-specific shared writer/storage changes must be coordinated with Activity worker to avoid overlapping edits.
Ruling: the user's explicit request to get all changes done and release authorizes implementation and publication; optional Settings layout preference can arrive while independent tasks proceed.
User revision: remove Activity entirely, including existing Activity storage; replace the initial Activity repair deliverable. Keep every other 5.1.0 item active.
Task 3 complete: per-account integration overrides, compact rows and migration003. Independent review found selection-to-dispatch pin gap during catalog refresh; scoped fix assigned to account reviewer.
Task 5 complete: grouped single-page Settings, favicon and requested copy/preset removals. Browser checked 1600 and 390 CSS pixel widths, both themes, no page or input overflow.
Task 1 implementation complete: raw payload/header/URL capture and exports, large-body spool, physical TTL review followup and bounded stream tap assigned to reviewer.
Task 2 complete: Activity removed via migration004; schema2/3 backups preserve other data and discard Activity. Generic debug queue/lifecycle fixes retained.
Task 4 review fixes: native Messages effort, custom-provider fallback target effort, Google target normalization and full cached multi-hop transformation path reproduced and repaired. Analyzer alias memoization and normalization assigned to reviewer. Snapshot and committed-save safety regressions pass.
Review followups: idle-WebSocket shutdown now reserves finalization time and can force-close remaining connections; old already-redacted captures explicitly marked incomplete. Deprecated capture assertions and compatibility docs updated to raw contract.
Validation in progress: 260 root test files in fresh processes; first failures were old redaction/string-copy expectations, corrected in targeted reruns. Docker build and 23 Nginx checks passed; production dependency audit checked 77 packages, no vulnerabilities. Repeat relevant/full acceptance after stream/router review changes before release.
All independent review findings resolved: alias/raw-name traversal and effort-normalization cache invalidation (13 regressions); native/custom/compact/WS fallback effort and full cached paths; account pin held during refresh (6 regressions, 24 legacy endpoint authority checks); bounded downstream-driven raw capture tap (3 regressions); idle physical pruning; bounded shutdown with real idle WebSocket; legacy filtered data notice. Raw, routing and account reviewers report scope ready.
Container acceptance passed with network disabled and read-only root plus tmpfs: administrator settings/version, Activity table absence, real local HTTP+WebSocket protocol paths and 3145797-byte exact raw capture/database equality. No production credentials or data used.
