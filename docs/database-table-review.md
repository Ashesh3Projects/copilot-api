# Database table review

This source audit covers the 29 application tables in schema 2. Schema 3 removes
`capi_debug`, leaving 28 application tables. Version 5.1.0 schema 5 also removes
`capi_activity`, leaving 27 tables, and schema 4 adds per-account integration IDs. The table definitions come from
[migration 001](../src/lib/storage/migrations/001-initial.ts),
[migration 002](../src/lib/storage/migrations/002-gateway-secrets.ts), and the
[current schema](../src/lib/storage/schema.ts).

Tables are created regardless of whether their associated feature is used.
Their existence does not establish live use or stored row counts. No live
database was queried for this review. SQLite/Turso system objects and indexes
are excluded from the count. Every baseline application table has a source
consumer; none is wholly unused.

The LLM Debug persistence correction and Activity removal are implemented. Broader cleanup below
is proposed for review and has not been performed. "Keep" means needed for the
current feature and behavior; it does not mean every installation uses that
feature.

| Table | Why it exists / what it stores | Actual retention | Review direction |
| --- | --- | --- | --- |
| [capi_metadata](../src/lib/storage/migrations.ts) | Store identity, schema/config revisions, Activity clear generation, transfer markers, and routing lifetime counters. Startup and configuration reads/writes use these values. | Persistent small set; temporary transfer markers removed on completion. | Keep. Remove only retired keys through migrations. |
| [capi_schema_migrations](../src/lib/storage/migrations.ts) | Applied migration versions, names, checksums, and timestamps. Startup checks database compatibility. | One row per applied migration. | Keep. |
| [capi_applied_operations](../src/lib/storage/operations.ts) | Mutation receipts: operation ID, actor, input digest, committed revision, and safe result metadata. Used to reconcile uncertain commits and avoid duplicate writes. | History-batch receipts pruned after 24 hours during flush; other receipts have no routine cleanup. | Keep the mechanism; review a bounded receipt lifetime. |
| [capi_settings](../src/lib/storage/settings-repository.ts) | Current app configuration, replacements, model redirects/settings/routing/fallbacks, feature flags, and Statsig overrides, with revisions. | Current values overwritten; persistent. | Keep. Already consolidates eight settings domains. |
| [capi_accounts](../src/lib/storage/accounts-repository.ts) | Stable upstream account IDs, domain/user/login/label, enabled/deletion state, and validation/credential revisions. Used by account management and routing. | Persistent; deleted accounts leave metadata tombstones. | Keep for Copilot accounts. Stable IDs preserve associations. |
| [capi_account_credentials](../src/lib/storage/accounts-repository.ts) | Recoverable upstream OAuth token for each account. Loaded into the account pool for upstream authentication. | Replaced on credential changes; deleted on account removal. | Keep data. Separate table permits metadata reads without tokens. |
| [capi_providers](../src/lib/storage/providers-repository.ts) | Custom provider identity, base URL, model/alias configuration, enabled/deleted state, and revision. Used by routing and provider settings. | Persistent; removal leaves a metadata tombstone. | Keep if custom providers are wanted. |
| [capi_provider_secrets](../src/lib/storage/providers-repository.ts) | Recoverable provider API key and custom header values. Used for outgoing calls and explicit credential reveal. | Replaced on edit; deleted when provider removed. | Keep data for custom providers; separate metadata/secret access is useful. |
| [capi_service_secrets](../src/lib/storage/providers-repository.ts) | Service credentials; currently only the Groq transcription key. | Until replaced or explicitly cleared. | Optional feature; possible shared-secret-table candidate. |
| [capi_gateway_credentials](../src/lib/storage/credentials-repository.ts) | Gateway-key IDs, digests, labels, and timestamps. Used for gateway authentication and credential management. | Until explicitly deleted; the last active key cannot be deleted. | Keep for gateway access. `last_used_at` is currently unused. |
| [capi_gateway_secrets](../src/lib/storage/credentials-repository.ts) | Recoverable gateway-key values linked to metadata, supporting reveal/copy and current authentication checks. | Deleted with the parent gateway credential. | Keep for current behavior. A digest cannot provide reveal/copy. |
| [capi_inference_credentials](../src/lib/storage/policy-repository.ts) | Hashed inference-only credentials, principal/scopes, kind, label, and enabled/revoked state. Used for managed JWT digests and OAuth-issued API keys. | No expiry; explicit revocation. Managed entries can be deleted. | Keep if these client credentials are wanted. Already shares two credential kinds. |
| [capi_ip_allowlist](../src/lib/storage/policy-repository.ts) | Allowed IPs, enabled/source state, and timestamps. Read by access policy and updated by administrators or authenticated promotion. | Until removed/cleared; no automatic expiry. | Keep if retaining IP allowlisting. |
| [capi_admin](../src/lib/storage/admin-repository.ts) | Singleton administrator password hash and session version. Used by dashboard setup/login/password changes. | Persistent singleton. | Keep for administrator authentication. |
| [capi_admin_sessions](../src/lib/storage/admin-repository.ts) | Hashed session/CSRF tokens, session version, and expiry. Used for dashboard authentication, logout, and invalidation. | Rolling 30-day validity; login deletes expired/old-version rows, logout deletes its row, password change deletes all. | Keep for restart-persistent logins; memory-only would require login after restart. |
| [capi_setup_codes](../src/lib/storage/admin-repository.ts) | Hashed one-time CLI setup codes and consumed/invalidated timestamps. Connects a separate CLI setup command to the dashboard. | Valid 15 minutes; expired/consumed rows have no routine cleanup. Restore clears them. | Keep cross-process setup; prune completed/expired records. |
| [capi_device_login_intents](../src/lib/storage/device-login-repository.ts) | Pending GitHub device-login codes, owner, polling lease, expiry, and resulting account. Used by dashboard account onboarding. | Upstream-defined expiry; codes cleared on completion/cancel/failure. Expired codes clear only if revisited by polling; rows have no routine cleanup. | Candidate for memory-only pending state, or keep coordination with prompt cleanup. |
| [capi_oauth_codes](../src/lib/storage/oauth-repository.ts) | Hashed temporary authorization codes, client/redirect/scopes/state, and PKCE binding. Used for code exchange. | Valid 2 minutes and single-use. Consumed rows remain; expired unconsumed rows delete only if presented again. | Keep OAuth exchange; prune or make pending grants transient. |
| [capi_oauth_families](../src/lib/storage/oauth-repository.ts) | Groups related access/refresh tokens under one client/principal/grant for collective revocation. | Until revoked; revoked rows retained. | Keep grant grouping if OAuth remains. |
| [capi_oauth_access](../src/lib/storage/oauth-repository.ts) | Access-token digests with family/client/principal/scopes. Used to authorize OAuth clients. | Valid until explicit revocation; each refresh adds an access token; no cleanup. | Keep data; consider combining access and refresh rows in a typed-token table. |
| [capi_oauth_refresh](../src/lib/storage/oauth-repository.ts) | Refresh-token digests and grant binding. Used to issue additional access tokens. | Deliberately reusable until explicit revocation; no cleanup. | Possible consolidation with access tokens while preserving their distinct authority. |
| [capi_usage_minutes](../src/lib/storage/history-repository.ts) | Minute/model input/output token totals and request counts. Powers 5-hour and 7-day usage summaries; no request/response bodies. | All committed buckets retained, including imported history; the runtime usage reader requests only 7 days. | Keep counters; decide whether older minute detail is useful. |
| [capi_usage_lifetime](../src/lib/storage/history-repository.ts) | Singleton lifetime token/request totals and first-request time. Used by usage summaries. | Persistent singleton. | Keep if lifetime totals are wanted; permits independent pruning of old minute detail. |
| [capi_routing_minutes](../src/lib/storage/history-repository.ts) | Minute aggregates of calls, retries, failovers, outcomes, models, routes, and accounts. Powers the routing dashboard. | 24-hour detail, pruned during history flushes; lifetime totals retained in metadata. | Optional analytics. Simplify unused dimension/account columns if kept. |
| [capi_activity](../src/lib/logger.ts) | Sanitized handler log level, handler, message, timestamps, clear generation, and size. Used by the separate Activity page; does not contain LLM Debug body captures. | 7 days, at most 50,000 records or 64 MiB; pressure can evict sooner. Explicit clear; expiry deletes during history flushes. | Optional durable diagnostics; memory-only would lose Activity history on restart. |
| [capi_debug](../src/lib/storage/migrations/003-memory-only-debug.ts) | Schema-2 LLM Debug request/response captures and replay details. This was the source of debug-page SQL reads. | Schema 3 drops the table. Captures now live in memory: success 10 minutes, all other statuses 1 hour from `startedAt`, at most 2,000 entries with a shared 16 MiB capture budget. | Removed from persistence. Clear removes captures immediately; restart loses them. |
| [capi_imports](../src/lib/storage/legacy-import.ts) | Completed legacy-import receipt with source digest, revision, timestamp, and counts. Prevents duplicate import of the same source. | Permanent; used by import commands. | Could move into metadata or an existing receipt store while preserving deduplication. |
| [capi_process_runs](../src/lib/storage/history-repository.ts) | History-collector startup, last flush, clean shutdown, and end timestamps. Detects potentially unflushed prior runs. | One row per startup; no cleanup. | Could consolidate with collection-gap state or retain only necessary recent runs. |
| [capi_collection_gaps](../src/lib/storage/history-repository.ts) | Lost-record/byte counts and unknown intervals after queue drops, uncertain writes, or unclean shutdowns. Feeds collection-status indicators. | No cleanup; reader sums all rows. | Could compact into counters plus recent incident detail while retaining incomplete-history reporting. |

## Cleanup proposals for review

1. **Expire temporary records physically.** Delete completed/expired device-login
   intents, setup codes, and OAuth codes after an agreed reconciliation window.
   Today expiry usually stops their use without deleting the row. Moving device
   login and OAuth codes into memory would also remove their tables, but pending
   sign-ins would fail across restart or another server instance. Setup codes
   still need shared state because their CLI issuer is a separate process.
2. **Choose usage-detail retention.** The
   [usage reader](../src/lib/usage-tracker.ts) only requests seven days. Pruning
   older minute/model buckets would retain those summaries and lifetime totals,
   but remove historical detail from future backups. Indefinite retention is
   currently documented behavior, so this is a product decision.
3. **Bound operational bookkeeping.** Keep mutation receipts long enough to
   reconcile retries and uncertain commits; removing them too early can permit
   duplicate operations. Compact old process runs and collection gaps into
   aggregate loss counters plus recent incidents. Current UI consumers need
   collection totals, not an unlimited incident ledger.
4. **Reduce tables where it simplifies the model.** Import receipts could use
   existing metadata. OAuth access and refresh records could share one typed
   table while keeping scope checks and family revocation. A shared secret store
   could replace several one-to-one secret tables, but requires careful access,
   deletion, export, and restore rules and saves little compared with pruning
   accumulated rows.
5. **Decide whether optional history should survive restart.** Activity and
   routing analytics have active readers but could be memory-only if their
   history is disposable. LLM Debug is already memory-only under schema 3.

Small schema candidates also exist: the routing writer always uses
`dimension_key='aggregate'` and never fills SQL `account_id`; account breakdown
is inside the aggregate JSON. Activity never fills its SQL `account_id` either.
Their account indexes and gateway `last_used_at` have no current runtime use.
These should be changed through a schema migration with their consumers, since
startup validates the expected schema.

OAuth access/refresh/family records intentionally remain valid until explicit
revocation, even when imported expiry metadata exists; see the
[OAuth contract](../src/lib/oauth-store.ts). Pruning active tokens based only on
age would change client compatibility. Keep gateway credentials separate from
inference-only authority even if their storage is later consolidated.

Activity expiry is enforced on reads, but physical pruning occurs during
nonempty history flushes. The repository's standalone `prune()` method has no
production caller, so an idle database can retain expired Activity rows until
the next flush.

## LLM Debug correction and upgrade

The [capture store](../src/lib/llm-debug-log.ts) and
[capture budget](../src/lib/debug-capture.ts) now use process memory. Migration
003 drops the old table and its generation metadata when the upgraded server
initializes the selected SQLite or Turso database. New backups exclude debug
captures; [restore](../src/lib/storage/restore.ts) accepts schema-2 backups while
skipping their retired debug records and generation metadata.

This does not erase existing backup files, database-provider snapshots, or
provider retention copies. A checked-out code change does not establish that a
deployment has run the migration. Console and Sentry payload logging retain
their requested behavior; the correction covers the LLM Debug page and its
database storage. Historical design documents remain unchanged as records of
the earlier implementation.
