# Copilot API 5.1.0 design

The user authorized all eleven feedback items and a 5.1.0 release. Screenshots are visual references, not instructions. Preserve protocol compatibility and the current Astryx React dashboard.

## Dashboard and settings

Use the existing favicon image in the sidebar heading with rounded corners. Remove Latest from Activity and LLM Debug; Refresh returns to the newest page. Remove the two requested Usage explanations and the Implicit medium / No sampling presets.

Accounts use compact rows with identity, status, model count and accessible icon actions. Existing skeleton styling covers the initial account fetch. A row can expand for reconnect and integration settings without making every row taller.

Settings remains one page unless the user chooses tabs. Group compact credentials/transcription, administration/backup, and access controls. Put server facts in a compact summary. Use content-sized cards and bounded, independently scrolling allowlists, so a long IP list does not displace JWT controls or create blank grid cells. Preserve all existing credential, backup, password, IP and JWT operations. Verify desktop, narrow viewport, light and dark themes.

## Exact LLM debug capture

Retain original request/response body strings, headers and URLs without secret filtering or JSON/SSE reconstruction. Keep successful retention at ten minutes and unsuccessful retention at one hour. Capture must not alter or delay the client stream. Preserve true read/transport failure reporting; do not claim an incomplete capture is complete. Remove replay denial and warnings caused solely by redaction. Old already-redacted entries cannot be reconstructed. Other logs and sanitized configuration export keep their existing behavior.

## Activity removal (user revision)

The user explicitly removed Activity from scope as a feature and authorized deleting its storage. Remove the page, sidebar/registry entry, dashboard API, event recording and current database table. An additive migration drops existing activity history. Preserve unrelated usage/routing telemetry and LLM debug storage, capture, retention and generic process-run/shutdown correctness. Support older encrypted backups by discarding obsolete activity on restore while preserving all remaining data. Applied migrations stay immutable.

## Redirects and fallback composition

On HTTP 422, select the configured fallback target and apply the same redirect chain and effort transformations as an ordinary model selection. Example: astra -> sol fallback plus sol -> sol-fast redirect sends the retry to sol-fast. Preserve protocol-specific preparation, account/provider routing, success/stream acceptance, notices and affinity.

Retain per-feature loop guards and add a combined rule analysis. Analyze enabled rules with actual ordered redirect/effort semantics and provider identities, including chains longer than one hop. If any executable loop exists, bypass all redirects and model fallbacks for new requests and show an actionable danger banner. Do not reject inference solely because configuration loops. Save corrections normally and restore both features automatically when valid. Configuration snapshots must remain consistent for each request; cached affinity must be invalidated when relevant configuration changes. Cover mixed loops, pure loops, aliases, disabled rules, effort-changing rules, and valid chains without false positives.

## Per-account integration ID

Add nullable durable integrationId on each account and expose it in its administrator DTO. Blank clears the override and uses hardcoded copilot-developer-cli, returned as the UI placeholder. Do not add a global setting. Validate HTTP header syntax and length. Selected account context must supply the override for model discovery and all inference paths, including reconnect/refresh, token rotation and leased request snapshots. Keep different accounts isolated. Refresh or invalidate the affected model catalog after changing the override. Preserve settings through database migration and backup/restore.

## Acceptance and release

Use regression tests for runtime/storage/routing changes, existing UI checks and browser inspection for presentation. Run root tests in fresh processes as CI does; root/UI typechecks, full lint, UI build, gateway build, and appropriate integration checks. Review the integrated change, resolve findings, then version 5.1.0, commit with the user's configured identity, push, merge through the repository workflow, tag and publish the GitHub release. Verify remote commit/tag/release and any dispatched publication jobs. Production deployment is separate from publishing a release.
