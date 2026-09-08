# Database storage: local SQLite and optional Turso

Status: design and implementation plans prepared for approval on 2026-09-08.
This behavior is not implemented in the current application yet. The migration
will replace runtime JSON persistence with the following database selection.

## Storage selection

`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are **both optional**. They work as a
pair; whitespace-only values count as unset.

| URL | Token | Selected storage |
| --- | --- | --- |
| Unset | Unset | Local SQLite in the data volume |
| Configured | Configured | Remote Turso database |
| Configured | Unset | Startup configuration error |
| Unset | Configured | Startup configuration error |

A configured Turso connection failure never falls back to local SQLite.
Selection occurs at startup and remains fixed for the process. This prevents an
outage from opening a different database with different accounts/settings.

## Local SQLite: default

No Turso account or database credentials are required. The database file is
`copilot-api.sqlite` under `DATA_DIR`, defaulting to
`~/.local/share/copilot-api`. Docker uses `/app/data` mounted as a named volume.

Mount the whole directory so SQLite can maintain its database, WAL and SHM
files. Use suitable local storage; WAL is not intended for an NFS/SMB share.
Keep directory access restricted because the database contains credentials.
Do not delete SQLite sidecar files while the application is running.

The Docker Compose implementation will provide a managed named volume for new
installations. Existing installations retain their current volume and import
the old JSON state explicitly; migration never deletes that volume or source
files automatically.

## Optional remote Turso

Configure both variables in the deployment environment:

```dotenv
TURSO_DATABASE_URL=turso://your-database.your-region.turso.io
TURSO_AUTH_TOKEN=your-database-token
```

The URL already identifies the database; no separate database-name variable is
needed. The token is server-only and must not be placed in frontend code or
source control. Existing 1Password/Varlock delivery can supply this pair.

In Turso mode the application does not open a local SQLite file or create local
JSON/log persistence. An app data volume is unnecessary. A volume left mounted
by the default Compose setup remains unused by application persistence in this
mode. Optional bind/proxy/origin/TLS/instrumentation settings remain independent
of this storage choice.

## Same application features in either mode

Both adapters use the same repositories/schema for accounts, upstream provider
credentials, settings, administrator password/session records, gateway/OAuth
credentials, usage and activity history. Passwords and gateway-verified secrets
retain hashes/digests; recoverable upstream credentials remain sensitive
database values under the proposed two-variable design.

Small configuration/catalog caches and active streams/sockets remain in memory.
JSON is still used for API payloads and downloaded configuration exports, but
the gateway will not maintain separate runtime JSON state files.

First-time setup will use an explicitly requested one-use CLI setup code and
the dashboard, with no GitHub accounts required to open setup. GitHub/provider
credentials will then be managed through database-backed dashboard controls.

## Migration, export and switching storage

The implementation includes explicit legacy import, sanitized JSON config
export and a separate password-encrypted logical backup. Export/download is
generated directly to HTTP/stdout, without server-side temporary files.

Changing or removing the Turso variables **does not transfer data**. To switch
between local SQLite and Turso, create a backup and restore it into an empty
target, verify it, then change the deployment configuration and restart. Keep
the old database/volume until the new one has been verified. The same logical
format supports both directions.

Sanitized config export excludes credentials and cannot fully restore them.
Full backup/restore preserves stable account IDs and client credential state,
while invalidating administrator sessions. Active bridge jobs, sockets and
connection-local conversation state are not made resumable by a storage move.

## Design and execution plans

- [Approval and execution overview](superpowers/plans/2026-09-08-database-persistence-index.md)
- [Architecture and acceptance criteria](superpowers/specs/2026-09-08-database-persistence-design.md)
- [1. Adapters, schema and configuration](superpowers/plans/2026-09-08-turso-01-foundation.md)
- [2. Identity and dashboard](superpowers/plans/2026-09-08-turso-02-identity-dashboard.md)
- [3. History and removal of JSON/log files](superpowers/plans/2026-09-08-turso-03-history.md)
- [4. Import, export, deployment and verification](superpowers/plans/2026-09-08-turso-04-transfer-cutover.md)

After implementation, this runbook and the README will describe shipped
behavior, include exact verified CLI/Compose commands, and remove the planned
status notice. Current releases still use the README's existing JSON stores.
