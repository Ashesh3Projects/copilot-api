# Dashboard Credential Controls

## Goal and approved scope

Authenticated administrators can create custom gateway keys, reveal and copy
stored keys at any time, and permanently delete keys except the last active
key. The same administrator boundary allows revealing and editing custom
providers' stored API keys and custom-header values.

The user approved raw database storage, a dedicated gateway-secret table,
on-demand reveal endpoints, optional editable generation, hard deletion,
last-key protection, and replacement of all existing digest-only gateway
credentials with one operator-supplied credential labeled `API Key`.

The bootstrap value must never appear in repository files, tests, commits,
documentation, operation receipts, logs, or command output. It is an input to
the one-time deployment operation, not application configuration or a default.

## Storage and migration

Keep migration `001` immutable. Add migration `002` and sequential,
checksum-verified migration handling for local SQLite and Turso.

The new `capi_gateway_secrets` table contains:

- `credential_id`: primary key and foreign key to
  `capi_gateway_credentials.id`, with cascading deletion.
- `secret_value`: non-null recoverable gateway key.
- `updated_at`: non-null timestamp.

Gateway metadata continues to contain an indexed SHA-256 digest, label,
identity, and timestamps. Every valid credential must have a corresponding
raw secret whose digest matches. Authentication joins the metadata and secret
tables. Digest-only records never authorize requests or dashboard sign-in.

Migration removes existing digest-only gateway rows, including previously
revoked rows. There is no legacy reveal state, hash-only authentication
fallback, placeholder secret, password-only login, or automatic random
bootstrap. The deployment inserts the supplied custom key before restarting.

Fresh administrator setup, custom creation, and explicit legacy import with
actual raw credentials write both rows atomically. A hard delete removes both
rows. The repository prohibits deleting the final active credential inside
the same transaction as deletion.

Provider secrets remain in `capi_provider_secrets`; their schema does not
change. Existing provider metadata, identity, enabled state, and history
relationships remain intact.

## Backup and import boundaries

The current schema registry and logical transfer definitions include the
gateway-secret table in dependency order. Encrypted backup and restore
preserve both gateway tables. Validation rejects missing secrets,
raw-value/digest mismatches, duplicate identities, or malformed credentials.

Schema-version-1 backups containing only gateway digests are not silently
accepted as schema-version-2 backups and never revive digest-only gateway
access. Explicit legacy JSON/environment import remains available only when
it supplies the actual raw keys and writes both rows.

Configuration exports remain redacted and exclude recoverable gateway and
provider secrets. The new database state contains raw secrets, and encrypted
backups contain them inside the encrypted payload.

## Gateway API

All gateway endpoints remain under
`/dashboard/api/credentials/gateway`, behind existing administrator-session
authentication. Mutations and reveal require existing CSRF and Origin checks.
Gateway credentials alone and inference-only credentials cannot access them.

`GET /dashboard/api/credentials/gateway` returns metadata, the configuration
revision, and a server-computed mask. Values longer than ten characters show
their first five and last five characters separated by a fixed mask. Short
values use a fixed mask instead of exposing the entire secret.

`POST /dashboard/api/credentials/gateway` requires a label and custom
`credential`. It trims surrounding whitespace, requires a nonempty
header-safe visible-ASCII value of at most 4096 characters, and retains
existing reserved-credential and inference/gateway separation rules.
The existing nonempty, 200-character label limit remains.

Creation writes metadata and raw value in one idempotent, revision-checked
transaction. Duplicate keys conflict. Responses contain metadata and mask,
not the raw value. Replaying a creation operation neither generates another
key nor creates a lost-one-time-value situation.

`POST /dashboard/api/credentials/gateway/:id/reveal` returns that key's raw
value only to the verified administrator. It is read-only, does not advance
configuration revision, and creates no mutation receipt.

`DELETE /dashboard/api/credentials/gateway/:id` permanently deletes the key
and metadata after enforcing the last-key rule. It returns non-secret
metadata. Revocation-only UI and one-time-display recovery logic are removed.

## Provider API and editing

`POST /dashboard/api/custom-providers/:id/reveal` returns the current stored
API key, all custom-header values, and the configuration revision from one
database snapshot. It permits disabled but non-deleted providers, and rejects
missing or deleted providers. No provider model or upstream request is issued.

Routine provider lists remain metadata-only. Existing API callers retain
their current blank/omitted-secret preservation and header-merge behavior.
Add explicit full-header replacement semantics for the editor: when header
rows change, the submitted complete header map replaces the stored map.
Removing one header row therefore removes that stored header. Unchanged
secrets are omitted from ordinary metadata saves.

Changing a provider key does not alter gateway keys. Clearing a provider key
or all headers remains an explicit operation. A reveal failure never lets an
empty form masquerade as successfully loaded credentials.

## Dashboard UX

Settings' gateway credential section has Label and Key inputs, an eye toggle,
an optional Generate button, and Add. Generation uses browser cryptographic
randomness to fill an editable `cop-`-prefixed value. It does not create or save
a key until the administrator submits the form.

Each row shows its label, masked value, eye toggle, Copy, and Delete. Reveal
fetches only the selected key. Copy uses the exact raw value, requesting it
through the same authorized endpoint if necessary. Deletion requires
confirmation, and the sole key is protected with a visible explanation.

Hiding a gateway key, refreshing/replacing its row, or leaving the page clears
the raw value from component state. A late reveal response must not restore a
hidden, deleted, or unmounted row's value. Raw values are not placed in browser
storage or persisted in polling caches.

Opening an existing provider's edit dialog explicitly loads its secrets.
API-key and header inputs show masks by default with eye/copy controls and
allow editing. Short secrets use fixed masks. Mask placeholders are never
submitted as credentials. The form retains originals only while open to
identify changed fields and submit explicit header replacements.

Closing the dialog clears raw values and pending reveal state. Editing a
different provider never reuses another provider's secrets. New-provider
forms start empty. Saving with a stale configuration revision conflicts
rather than overwriting a concurrent secret update.

## Errors and secret handling

Credential responses use `Cache-Control: no-store`. Raw secrets are never
included in URLs, ordinary list responses, error messages, operation result
JSON, application logs, request diagnostics, or Sentry payloads.

Validation failures return `400`. Missing keys/providers return `404`.
Duplicates, stale revisions, and last-key deletion return `409`. Storage
errors retain generic `503`/`500` behavior. Reveals never return
success-shaped placeholders or masked data in place of the real value.

Any one-time bootstrap operation uses the selected database and an explicit
operator-supplied secret. It must not alter the administrator password,
existing administrator sessions, accounts, providers, OAuth/inference
credentials, routing, usage, or history.

## Verification and deployment

Use the existing Bun test runner, TypeScript checks, lint configuration, and
UI/backend build commands. Tests cover migration `001` to `002`, unchanged
historical checksums, transactional failure, fresh setup, and repeat startup.

Gateway coverage includes custom create, duplicate/reserved inputs, list
masking, reveal, hard deletion, final-key protection under concurrent
requests, idempotent replay, digest-only rejection, missing secret records,
and the existing administrator/inference boundary.

Provider coverage includes API-key/header reveal, disabled/deleted provider
handling, explicit header replacement, unchanged-secret preservation, stale
revisions, and editing/removing individual stored headers.

Both reveal routes are exercised with missing/invalid administrator sessions,
missing/invalid CSRF tokens, and wrong origins. Tests prove secrets do not
appear in lists, operation receipts, errors, diagnostics, or redacted exports.
Encrypted backup/restore and legacy raw-input import are covered end to end.

UI coverage exercises mask/eye/copy behavior, custom/generated inputs, late
response handling, dialog closure, last-key protection, and removal of the
one-time-only display flow. Rebuild the generated dashboard page using the
existing UI build; never edit the generated bundle manually.

Deploy with only the gateway service stopped. Apply the schema migration and
atomically seed the sole supplied `API Key`, then restart the updated image.
Confirm exactly one gateway key, successful authentication with its actual
value, reveal equality without printing it, healthy readiness, and unchanged
provider configuration.

Update `README.md`, `SECURITY.md`, and directly affected storage documentation
to describe raw recoverability, administrator-only reveal, changed deletion
semantics, and the required replacement of pre-upgrade gateway keys.

## Non-goals

No provider model/routing changes, password-only authentication, encryption
master-key management, Groq reveal feature, inference/JWT digest redesign,
legacy digest recovery, or unrelated cleanup.

The user separately approved pinning only Hono to `4.13.5` on September 9, 2026,
after the unchanged dependency failed the production audit in CI. No other
dependency upgrades are included.
