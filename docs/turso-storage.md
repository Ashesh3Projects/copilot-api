# Database storage: local SQLite and optional Turso

This checkout uses one selected database for runtime persistence. Accounts,
provider secrets, settings, administrator and client credentials, usage, and
bounded diagnostic history use the same schema in local SQLite and remote
Turso. JSON remains an API/export format and an explicit legacy import source;
it is no longer a parallel runtime store.

Commands below use `bun src/main.ts` from a source checkout. An installed build
exposes the same commands as `copilot-api`; the container entrypoint accepts
the command directly after the image or Compose service name.

## Storage selection

`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are both optional. They form a pair;
whitespace-only values count as unset.

| URL | Token | Selected storage |
| --- | --- | --- |
| Unset | Unset | Local SQLite in the data directory |
| Configured | Configured | Remote Turso database |
| Configured | Unset | Startup configuration error |
| Unset | Configured | Startup configuration error |

A configured remote connection failure never falls back to local SQLite.
Selection is fixed for the process. Changing these variables does not copy,
merge, or migrate data.

### Local SQLite

The database is `copilot-api.sqlite` under `DATA_DIR`, defaulting to
`~/.local/share/copilot-api`. Docker sets `DATA_DIR=/app/data`. Mount the whole
directory for the database and SQLite's WAL and SHM sidecars. Use local storage
suitable for SQLite WAL and restrict access: recoverable upstream and provider
credentials are sensitive database values. Do not remove sidecars while the
database is open.

Compose manages the named `copilot-api_copilot-data` volume automatically for
new installations. Existing volumes and legacy source files are not deleted
or imported automatically. Preserve the old volume while validating a migration.

### Optional remote Turso

Set both variables in the server environment:

```dotenv
TURSO_DATABASE_URL=turso://your-database.your-region.turso.io
TURSO_AUTH_TOKEN=your-database-token
```

The URL identifies the database; no database-name variable is needed. Supported
URL schemes are `turso://` and `https://`, without embedded credentials, query,
fragment, or application path. Keep the token server-side. The bundled
1Password/Varlock path can resolve this pair and other deployment settings.

The adapter uses the pinned `@tursodatabase/serverless` 1.4.0 driver. Readiness
requires the remote engine to expose both `sqlite_version()` and
`turso_version()`; an arbitrary SQLite-compatible HTTP endpoint is insufficient.

Turso mode does not open a local SQLite file or create local runtime JSON/log
files. It needs no application data volume and supports a read-only container
root filesystem. The default Compose volume may remain mounted unused. Remote
database access itself must permit migrations and writes. An operator-owned
backup output or explicit import input is separate from runtime persistence.

## Initial setup and credentials

Issue a code and start the server against the same selected database:

```sh
bun src/main.ts admin --setup-code
bun src/main.ts start --host 127.0.0.1
```

Open `/dashboard`. Supply the one-use code, a new long random gateway key, and
an administrator password. Codes expire after 15 minutes and are issued only
for an unconfigured database. Setup needs no GitHub account. Add GitHub.com or
GitHub Enterprise Cloud accounts, providers, and the optional Groq credential
through the dashboard. The database-backed `config` CLI also manages accounts,
replacements, and providers.

The accounts page provides **Refresh models** per account and **Refresh all
models** for the registry. Each account refresh has its own bounded operation;
bulk results identify successes and failures. Refresh preserves enablement and
routing policy, includes disabled accounts without enabling them, and excludes
accounts being removed. A failed refresh retains the previous catalog and
does not prevent the remaining accounts from refreshing.

Gateway and OAuth/inference secrets are stored as digests; administrator
passwords use Argon2id. Upstream/provider credentials must remain recoverable
for outbound authentication. Dashboard secret listings are write-only and show
configured status. Initial setup stores the gateway key; later keys can be
created and revoked through the dashboard. Inference credentials cannot become
administrator or gateway credentials through a matching key or digest literal.

`start` does not perform device authentication, load JSON credentials, or admit
credentials from `GITHUB_TOKENS`, `GH_TOKEN`, `COPILOT_API_KEY_AUTH`,
`COPILOT_INFERENCE_CREDENTIAL_SHA256S`, `COPILOT_ADMIN_PASSWORD_HASH`,
`GROQ_API_KEY`, or provider `apiKeyEnv`. The old `--github-token` and
`--api-key-auth` runtime flags are rejected. `auth` runs browser or device
authentication, validates the GitHub account and Copilot access, and saves the
account to the selected database. It reports saved account metadata without
printing the credential.

If the administrator password is lost, use the trusted local console:

```sh
bun src/main.ts admin --reset
```

This requires hidden interactive input and confirmation, replaces the password,
and revokes every dashboard session. It retains gateway credentials; login
still requires a valid gateway key. `admin --hash-password` prints an Argon2id
verifier for explicit legacy import, not an environment-managed runtime password.

## Explicit legacy import

Stop the legacy writer and retain its directory. Select a new, empty target
database before previewing. For local SQLite, set `DATA_DIR` to a separate
replacement directory and leave both Turso variables unset. For Turso, select
an empty database with its pair. Do not start the server against the replacement
before import: initialized application settings make it a non-empty target.

Preview reads the supported files without altering them:

```sh
bun src/main.ts storage import-legacy --from /absolute/legacy-data
```

The JSON result contains `sourceDigest`, `expectedTargetRevision`, counts, and
warnings. Review them, then apply with the exact preview values:

```sh
bun src/main.ts storage import-legacy --from /absolute/legacy-data \
  --apply --source-digest SOURCE_DIGEST --expected-revision TARGET_REVISION
```

Source drift, invalid input, duplicate/conflicting identities, non-empty targets,
and revision changes reject the transfer. Supported inputs include legacy
account, configuration, policy, OAuth, administrator, and usage files. Stable
account IDs and committed old minute/model usage are retained. Administrator
sessions are invalidated. No source file is rewritten or removed.

To include selected legacy environment credentials, add `--from-env` to both
preview and apply while preserving the same environment. It selects
`GITHUB_TOKENS` (or `GH_TOKEN`), `COPILOT_API_KEY_AUTH`,
`COPILOT_INFERENCE_CREDENTIAL_SHA256S`, `COPILOT_ADMIN_PASSWORD_HASH`,
`GROQ_API_KEY`, and the credential names referenced by imported providers'
`apiKeyEnv`. It does not import the entire process environment or the Turso
connection token. Referenced provider credentials must be present. Without
`--from-env`, these environment values do not participate.

After completion, start the server with the target selection and verify login,
account identity, provider configuration, readiness, and expected history before
retiring the old deployment. Source files are retained for rollback.

## Export, encrypted backup, and restore

The authenticated dashboard ZIP export is sanitized configuration. It omits
credential/history tables and redacts secret-like values. It is useful for
inspection but cannot restore credentials or replace a full backup.

Logical backup uses a password-derived key and authenticated AES-256-GCM
encryption. It streams to stdout or the authenticated dashboard response with
backpressure, without a server-side temporary file. The CLI requires an
interactive terminal for the hidden password prompt and refuses to write binary
backup data to the terminal. With a shell that preserves binary stdout:

```sh
bun src/main.ts storage backup > /operator-owned/copilot-api.backup
```

Backup and restore have a 30-minute transfer deadline. A backup holds a
consistent read snapshot while streaming; a slow download or destination keeps
that snapshot open until completion, cancellation, or timeout. On local SQLite,
concurrent writes can grow the WAL while that snapshot prevents checkpointing
past the reader. Allow disk headroom and schedule large backups during quieter
write periods; do not remove the WAL to reclaim space during a transfer.

Keep the password and backup protected. Do not pass the password in a command
argument or environment variable; neither is supported. Preserve binary output
when using shell redirection, especially with older Windows shells.

Restore requires an explicitly selected empty replacement database:

```sh
bun src/main.ts storage restore --input /operator-owned/copilot-api.backup
```

The password is entered interactively. The importer authenticates the backup,
validates its schema, records, and relationships, and refuses an occupied target.
Restore preserves account IDs and client credential state while invalidating
administrator sessions. Active bridge jobs, sockets, and connection-local
conversation state do not become resumable through backup/restore.

An interrupted import or restore leaves an incomplete-transfer marker that
blocks readiness. To abandon only that transfer, use its exact reported ID:

```sh
bun src/main.ts storage discard-incomplete --restore-id EXACT_TRANSFER_ID
```

This command is restricted to records owned by that incomplete empty-target
transfer. Retain the source and backup, then preview/apply or restore again.

To switch SQLite to Turso or Turso to SQLite: create a backup, select an empty
replacement target, restore, verify it, and only then change the serving
deployment's selection. Retain the old database/volume for rollback. Editing or
removing environment variables alone never transfers data.

## History, outages, and readiness

Committed usage minute/model buckets and lifetime counters are retained,
including imported old usage. Routing-minute detail retains 24 hours. Activity
retains seven days, up to 50,000 records or 64 MiB. Debug history retains
successful captures for ten minutes and failed/interrupted captures for one
hour, with caps of 2,000 records or 128 MiB. Count/byte pressure may remove older
diagnostics before their time limit.

LLM Debug sanitizes credential-bearing URLs, headers, structured fields, and
recognized literal secrets before enqueue. Capture bodies are bounded and may
be omitted or redacted; such captures cannot be replayed. Eligible replay gets
fresh server-side credentials. Prompts and non-secret response content can
still be sensitive.

The pending telemetry queue is bounded to 2,000 records, 16 MiB, and five
minutes. Outages or pressure can drop diagnostic bodies and records. The UI
reports collection gaps and uncertain intervals; committed history is not
silently represented as complete. Clearing diagnostic history advances its
generation so pending old records cannot reappear.

`GET /health` and `GET /health/health` are metadata-free liveness endpoints.
`GET /health/ready` returns `200` for an available selected database with no
incomplete transfer, or `503` otherwise. Docker and Compose healthchecks use
readiness. No local-file fallback is attempted after database failure.

## Container examples

For a new default SQLite deployment:

```sh
docker compose build
docker compose run --rm --no-deps copilot-api admin --setup-code
docker compose up -d
```

For optional remote mode, supply the same Turso pair to setup and the serving
container. A built image can run without a data volume:

```sh
docker run --rm -it --read-only --env-file ../copilot-api.env \
  copilot-api admin --setup-code
docker run -d --name copilot-api --read-only \
  -p 127.0.0.1:4141:4141 --env-file ../copilot-api.env copilot-api
```

The environment file should contain the pair, `COPILOT_HOST=0.0.0.0`, and any
required origin/proxy settings. These are usage examples for this checkout,
not evidence of a published release or a verified production deployment.

## Design and acceptance references

- [Execution overview](superpowers/plans/2026-09-08-database-persistence-index.md)
- [Architecture and acceptance criteria](superpowers/specs/2026-09-08-database-persistence-design.md)
- [Adapters, schema, and configuration](superpowers/plans/2026-09-08-turso-01-foundation.md)
- [Identity and dashboard](superpowers/plans/2026-09-08-turso-02-identity-dashboard.md)
- [History and removal of JSON/log files](superpowers/plans/2026-09-08-turso-03-history.md)
- [Import, export, deployment, and verification](superpowers/plans/2026-09-08-turso-04-transfer-cutover.md)
