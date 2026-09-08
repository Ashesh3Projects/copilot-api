# Database persistence implementation acceptance

Implementation baseline: `b3da081` (PR111 fallback chains and PR110 compatibility), isolated branch `codex/database-persistence`.

## Delivered

- Default file-backed SQLite (`DATA_DIR/copilot-api.sqlite`) or remote Turso when both optional variables are configured. Partial pairs fail; remote failure never selects local storage.
- Shared migrations/repositories, transactional operation receipts, indexed authorization, immutable admission snapshots, database-backed accounts/providers/Groq/gateway/admin/OAuth/policies/settings.
- One-use setup code, password change/reset, durable account/device-login management, per-account and global model refresh, and matching Copilot favicon.
- Bounded memory-only history collection with durable usage, explicit collection gaps, sanitized debug captures, paging, clear generations and shutdown draining.
- Explicit read-only legacy import; sanitized configuration ZIP; password-encrypted logical backup/restore to an empty replacement; managed local-volume and read-only remote examples.
- Manual-only isolated Turso CI workflow using dedicated test database secrets. Production cutover and old-data deletion are not performed.

## Verification performed

| Area | Evidence |
| --- | --- |
| Offline regression suite | 3,914 passed, 0 failed, 26 opt-in skips across 241 files, each in a fresh process. Two subsequently added SQL-boundary/public-protocol tests also passed. All affected files rerun after final changes. |
| Build and types | Backend build, dashboard build, root TypeScript and dashboard TypeScript passed. |
| Lint | Full lint passed with 0 errors; five pre-existing warnings remain. |
| Local Docker | Read-only root, writable named SQLite directory, readiness healthy, restart successful; only SQLite database/WAL/SHM persisted. Partial Turso configuration exits nonzero. |
| Actual Turso contracts | Transaction/schema contract, concurrent OAuth issuance/refresh/revocation, and SQLite-to-Turso-to-SQLite encrypted transfer passed using exact randomized test table namespaces. |
| Actual remote container | No data volume, read-only filesystem: setup, login, session, protected models/accounts, batched diagnostics/counters, receipt replay, clear generations and clean shutdown passed with no local persistence. |
| Public protocols on actual remote DB | Chat, Messages, Responses, HTTP next-turn input, real Responses WebSocket continuation and credential revocation before a later turn passed. Only synthetic upstream model responses were mocked; database/auth/routing paths were real. |
| Browser | Per-account refresh changed model count; global refresh reported three successes and one failure; disabled account stayed disabled; failed account retained its old catalog. The inline adaptive SVG favicon was present in rendered HTML. |
| Public ingress | 23 Nginx compatibility tests passed. |
| Fault/security | Unknown commits, stale revisions, account reconnect/removal races, expired/cancelled device login, invalid schemas, interrupted/tampered restores, counter replay, bounded capture and authorization outage cases passed. |

The 26 skips are explicit opt-in cases. The actual Turso and Nginx cases were run separately. Live GitHub/Copilot inference integration requiring an explicit `GH_TOKEN` was not run; local public-route and remote-database protocol tests use synthetic upstream responses. No claim is made about a deployed gateway, GitHub Actions run, or a live Copilot subscription.

## Review repairs

Independent reviews covered adapters/schema/snapshots, auth/OAuth/policies, accounts/providers, history/debug, transfer, and the integrated runtime. Confirmed findings were fixed with regression tests, including:

- Storage mutation deadline/reconciliation ownership, mutable SQL inputs and transaction poison handling.
- Old admitted policy snapshots corrupting the shared model eligibility index.
- Account lease acquisition after cancellation and credential refresh/replacement publication races.
- Case-insensitive provider header rotation, explicit secret clearing and coherent list revisions.
- Capture redaction/stream memory bounds and history clear-generation races.
- Missing default config-export entries, row-by-row backup/restore throughput, and remote history batches exceeding their deadline.
- Exact global refresh retry with original idempotency key and revision, preserving its original target set.

## Operational limits

Recoverable upstream credentials are sensitive database values; protect local files or remote database access. Backup passwords are separate and not stored. Uncommitted telemetry can be lost on crash and is reported as a gap, not guaranteed complete delivery. Active connections/bridge execution state are not restart-resumable. Transfers have a 30-minute limit; a long SQLite backup snapshot can hold WAL pages. Smarter scheduling remains deferred.

See [the operational runbook](../../turso-storage.md) for setup, import, backup/restore, backend switching and rollback.
