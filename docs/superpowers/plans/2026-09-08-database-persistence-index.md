# Database Persistence Implementation Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement the approved plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace runtime JSON persistence with default local SQLite and optional remote Turso, with database-backed dashboard management and history.
**Architecture:** A shared schema/repository layer targets bun:sqlite or @tursodatabase/serverless 1.4.0. Select one backend once at startup; preserve protocol/routing behavior.
**Tech Stack:** Bun, strict TypeScript, Hono, existing Astryx/React UI, SQLite/Turso.
**Spec:** ../specs/2026-09-08-database-persistence-design.md
**Status:** Implemented and reviewed on codex/database-persistence; see [final acceptance evidence](2026-09-08-database-persistence-acceptance.md).

## Latest user decisions

- TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are optional together.
- Neither set: local copilot-api.sqlite in DATA_DIR; Docker mounts /app/data as a named volume.
- Both set: remote Turso, no local application database/persistence writes.
- Exactly one set or invalid remote configuration: startup error.
- Remote outage never silently opens the local store.
- Both backends eliminate runtime JSON/log files; SQLite sidecars are allowed in local mode.
- Accounts/providers/authentication/settings/usage/activity use the selected database.
- Small runtime caches and active streams/sockets remain in memory.
- Keep config export and a distinct encrypted logical backup/restore.
- Smarter routing and durable bridge/conversation recovery remain outside this change.
- The two-variable draft uses database access protection for recoverable upstream credentials; no third encryption environment variable is required. A third key is an optional review choice, not silently assumed.

## Execution order

| Stage | Plan | Tasks | Deliverable |
| --- | --- | --- | --- |
| 1 | [Foundation](2026-09-08-turso-01-foundation.md) | 5 | Both adapters, schema, commit reconciliation, configuration repositories |
| 2 | [Identity/dashboard](2026-09-08-turso-02-identity-dashboard.md) | 6 | DB auth/OAuth, setup/password, account/provider/gateway controls |
| 3 | [History](2026-09-08-turso-03-history.md) | 5 | Usage/activity/debug persistence, no log files, bounded queue/shutdown |
| 4 | [Transfer/cutover](2026-09-08-turso-04-transfer-cutover.md) | 5 | Import/export/backup, local/remote docs/Compose, end-to-end acceptance |

Plan 1's adapter task has separate local and remote test loops; review both before repository work. Plans 2 and 3 may overlap only after foundation contracts are stable and with disjoint file ownership. Coordinator owns schema/startup/dashboard registration/generated UI integration. Do not concurrently edit those shared files.

## Approval and completion

- [x] Inspect current persistence, auth, account/routing, runtime history and deployment.
- [x] Verify published remote SDK API and Bun local transaction behavior without using deployment credentials.
- [x] Write architecture, acceptance map, four implementation plans and planned README/runbook notes.
- [x] Incorporate independent design review: secret-free operation markers, disable/delete distinction, first-setup authority, new WebSocket-turn authorization, fallback namespace revisions, single-account parity, explicit telemetry gaps and empty-target restore.
- [x] User approves this design and implementation plan set.
- [x] Execute with subagents and task reviews on an isolated baseline preserving unrelated work.
- [x] Verify both actual adapters plus full public-route/next-turn regressions, filesystem write boundaries, UI, build/lint/typecheck.
- [ ] Present completed branch and verified migration/runbook; production cutover and old-data deletion are separate actions.

The repository's current fallback changes are still moving in the shared checkout. Start implementation from the user's finalized commit or a reviewed exact isolated snapshot; do not reset or include unrelated edits accidentally. Planning files are safe to review independently.

README and the storage runbook now describe this implementation. Production deployment and legacy-data removal remain separate, unperformed operations.
