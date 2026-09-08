# Turso Configuration Migration Design

**Status:** Approved

## Goal

Import the legacy configuration export at
`F:\Downloads\copilot-api-config-08-09-2026-19-53` into the selected Turso
database as a one-time migration while preserving the target database's
existing GitHub accounts and all unrelated runtime state.

## Source and Target Constraints

The source contains these supported legacy files:

- `config.json`
- `feature_flags.json`
- `ip_allowlist.json`
- `model_redirects.json`
- `model_routing.json`
- `model_settings.json`
- `replacements.json`
- `statsig_overrides.json`

The source includes two custom providers with inline API keys and 29 IP
allowlist entries. It does not contain GitHub account credentials. Its model
routing document references account IDs `0`, `1`, and `2`, so those active
accounts and their credentials must already exist in the target.

The migration must not print the Turso token, provider API keys, account
credentials, or other secret values.

## Chosen Approach

Use a transactional configuration-only replacement.

A temporary local staging database will reuse the repository's legacy importer
and validators. An isolated copy of the source will receive three placeholder
accounts solely so the importer can validate routing references. Placeholder
accounts never leave staging and are never written to Turso.

The staged records copied to Turso are limited to:

- `capi_settings`
- `capi_providers`
- `capi_provider_secrets`
- `capi_ip_allowlist`

The target migration preserves accounts and account credentials, administrator
and gateway authentication, OAuth and inference credentials, usage, activity,
debug history, and every other table not listed above.

## Data Flow

1. Restore the repository's existing dependencies without changing dependency
   manifests.
2. Copy the eight source files to a temporary directory and add three
   non-production placeholder accounts.
3. Run the official legacy import into temporary SQLite to validate and
   normalize the source.
4. Read the staged settings, providers, provider secrets, and IP allowlist.
5. Inspect Turso without mutation:
   - validate the application schema;
   - capture the configuration revision;
   - verify active account IDs `0`, `1`, and `2` and their credential records;
   - capture hashes of preserved account rows and credentials;
   - reject source provider IDs that collide with previously deleted target
     provider IDs.
6. Produce a secret-free preview containing the source digest, expected target
   revision, affected counts, provider IDs, and settings namespaces.
7. Apply only when the exact preview digest and target revision are supplied.
8. Verify the committed result and remove all temporary staging artifacts.

## Replacement Semantics

The migration replaces all supported legacy settings namespaces:

- `app`
- `replacements`
- `model_redirects`
- `model_settings`
- `model_routing`
- `model_fallbacks`
- `feature_flags`
- `statsig_overrides`

Namespaces absent from the source are removed, so the absent
`model_fallbacks.json` clears any existing target fallback document. Imported
documents retain monotonically increasing document revisions.

Source providers are inserted or updated with their exact metadata and stored
secrets. Active target providers absent from the source are soft-deleted and
their secrets are removed, preserving debug-history foreign keys. A source ID
that matches a previously deleted provider aborts the migration rather than
reusing a retired identity.

The IP allowlist is replaced exactly with the normalized staged entries.

## Atomicity and Error Handling

The Turso write uses one `runMutation` operation with an explicit operation ID,
actor, source digest, and expected target revision. The transaction increments
the global configuration revision once and records an idempotent operation
receipt containing metadata only.

The migration commits all selected surfaces together or commits none of them.
It aborts before commit if:

- source validation fails;
- the source changes after preview;
- the target revision changes after preview;
- the target schema is invalid;
- account IDs `0`, `1`, or `2` or their credentials are missing;
- routing does not resolve against the preserved accounts;
- a source provider ID collides with a deleted target provider;
- any post-write validation inside the transaction fails.

The original export directory is read-only and remains available for rollback
or another attempt. This operation does not create a separate target backup.

## Verification

The staged result is expected to contain:

- seven settings documents;
- two active providers;
- two provider-secret records;
- 29 IP allowlist entries.

After commit, verification will:

- compare normalized hashes and counts for every replaced surface;
- confirm routing still resolves against account IDs `0`, `1`, and `2`;
- confirm preserved account rows and credential hashes are unchanged;
- confirm active provider IDs exactly match the source;
- confirm the global configuration revision advanced by one;
- confirm the matching operation receipt exists.

Verification output contains identifiers, counts, revisions, and hashes only.
It never includes secret values.

## Out of Scope

- Importing or changing GitHub account credentials
- Replacing administrator, gateway, OAuth, or inference credentials
- Migrating usage or history
- Changing application source code or committed dependency files
- Starting or reconfiguring the production deployment
