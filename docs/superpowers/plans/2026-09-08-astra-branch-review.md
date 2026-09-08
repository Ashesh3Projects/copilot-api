# 4.0.0 independent Astra branch review

Reviewed the complete database-persistence branch from b3da081 through 216f22a, then reviewed remediation before integration. Three independent Astra domain seats covered storage/data integrity, identity/accounts, and protocols/runtime. Additional independent rechecks covered storage promotion, mutation recovery/UI behavior, hosted-tool account continuity, and CI/release packaging.

## Confirmed issues repaired

1. Normally initialized app defaults made a full backup fail restore validation. Defaults and empty legacy-shadow compatibility now agree, tested through setup, backup, restore and login.
2. Restore cancellation during final verification was ignored. Promotion rechecks cancellation before/after destructive final writes.
3. A lost restore commit response falsely claimed the target remained incomplete. Exact nonsecret completion receipts support reconciliation or a truthful unknown outcome.
4. Account listings could return older metadata with a newer revision. Metadata and revision now share one database snapshot.
5. First setup did not repeat the inference-credential reservation check in its transaction. It now uses the same final reservation rule as login before consuming the setup code.
6. Single-account durable debug replay lacked its account ID. Recorded replay now retains the selected immutable account, including ID zero.
7. Voice WebSocket transcription did not recheck storage/authorization before a later turn. Admission now captures current authority/config, while already admitted transcription retains its snapshot.
8. WebSocket upgrade storage errors escaped as generic server failures. The upgrade boundary now returns typed, sanitized, non-cacheable storage failures.
9. MCP search and public quota usage still relied on removed global token state. They now use database account credentials and the selected instance/lease.
10. Hosted search's model follow-up could change identity after account removal. The admitted turn retains the final selected account, including an allowed initial failover, without making that choice durable across client turns.
11. New mutation IDs could remain blocked after an earlier uncertain commit became readable. Recovery checks the prior saved receipt without replaying its body or bypassing new revision/actor checks.
12. Browser retry IDs could be discarded or cleared by an older overlapping response. Bounded hash-only retry metadata and identity-checked settlement preserve the correct attempt.
13. A replayed key creation can return metadata without its one-time secret. The dashboard now explains recovery and offers exact unused-key revocation rather than silently succeeding.
14. Provider editing could adopt a newer list revision without refreshing the edited data. Forms retain their original revision and require a fresh edit after conflict.
15. Redacted/omitted captures could not open the deliberate replacement-body replay editor. The editor now requires reviewed replacement input instead of automatically replaying incomplete content.
16. Nightly smoke startup used removed token flags and unstored dummy keys. It now provisions an isolated database and uses a generated test key. Missing CLI installations fail CI instead of silently skipping every client.

Every substantive correction has focused regression coverage. Independent rechecks distinguished mocked upstream behavior from actual database/network paths, and did not treat prior green tests as clearance.

## Validation and scope

Final local validation: **3,954 passed, 0 failed, 26 explicit opt-in skips across 247 fresh-process files.** The PR records hosted CI results and the final merge revision. Full lint, backend/dashboard typechecks and builds, dependency audit, Nginx route tests, local read-only-root container startup/restart, actual dashboard backup/restore/login, and isolated live Turso contracts were exercised. Real Turso testing uses randomized checked SQL namespaces, never production application tables. External model responses in protocol tests are synthetic; live subscription inference is not inferred from those checks.

The test suite's supported CI invocation runs each file in a fresh Bun process because legacy tests mutate process singletons. Combined-file fixture contamination is not presented as a production failure or as a successful full-suite invocation.

## Deliberate limits

- v4.0.0 is a breaking persistence/configuration migration. Import into an empty replacement, verify, then switch serving; retain the original for rollback.
- Optional Turso selection never falls back to local storage on failure.
- Upstream credentials are recoverable sensitive database values; protect database access. Passwords and gateway-verified secrets retain hashes/digests.
- Diagnostic queues are bounded and expose loss. Crash recovery does not resurrect active streams, sockets or bridge execution state.
- Eight MiB is a transfer-frame bound, not a logical-value cap. Large individual values remain losslessly transferable; current drivers/decoder require memory for the largest logical row/field.
- No production deployment, artifact publication, or legacy-data deletion is part of the merge.
