import { createHash, randomUUID } from "node:crypto"

import type { SqlSession, Storage } from "~/lib/storage/types"

import { SerialQueue } from "~/lib/storage/adapter-utils"
import { insertGatewayCredential } from "~/lib/storage/credentials-repository"
import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import {
  remainingStorageMs,
  withStorageDeadline,
} from "~/lib/storage/operation-budget"
import { readStoreRevision } from "~/lib/storage/operations"

interface AdminOperation {
  id: string
  kind: string
  actor: string
  digest: string
}
interface MutationState {
  queue: SerialQueue
  pending?: AdminOperation
}
const mutationStates = new WeakMap<Storage, MutationState>()
function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}
function setPending(state: MutationState, operation?: AdminOperation): void {
  state.pending = operation
}
async function hasMarker(
  storage: Storage,
  operation: AdminOperation,
): Promise<boolean> {
  const rows = await storage.read((session) =>
    session.query({
      sql: "SELECT kind,actor_id,input_digest,result_json FROM capi_applied_operations WHERE id = ?",
      args: [operation.id],
    }),
  )
  const row = rows.at(0)
  if (!row) return false
  if (
    row.kind !== operation.kind
    || row.actor_id !== operation.actor
    || row.input_digest !== operation.digest
    || row.result_json !== '{"status":"committed"}'
  )
    throw new StorageSchemaError("Invalid administrator operation marker")
  return true
}

/** The marker stores completion only; secrets remain in the originating invocation. */
// eslint-disable-next-line max-params -- storage, identity, work and changed predicate are separate mutation boundaries
async function mutate<T>(
  storage: Storage,
  mutation: { kind: string; actor: string; input: unknown },
  work: (session: SqlSession) => Promise<T>,
  isChanged: (value: T) => boolean = () => true,
): Promise<T> {
  let state = mutationStates.get(storage)
  if (!state) {
    state = { queue: new SerialQueue() }
    mutationStates.set(storage, state)
  }
  const owned = state
  const operation: AdminOperation = {
    id: randomUUID(),
    kind: `admin.${mutation.kind}`,
    actor: `admin:${digest(mutation.actor)}`,
    digest: digest(JSON.stringify(mutation.input)),
  }
  return withStorageDeadline(Date.now() + 30_000, () =>
    owned.queue.run(async () => {
      if (owned.pending) {
        let confirmed = false
        try {
          confirmed = await hasMarker(storage, owned.pending)
        } catch {
          /* Keep the uncertain mutation blocked. */
        }
        if (!confirmed) throw new StorageCommitUnknownError(owned.pending.id)
        setPending(owned)
      }
      for (let attempt = 0; ; attempt++) {
        let completed: { value: T; changed: boolean } | undefined
        try {
          return await storage.transaction(async (session) => {
            const value = await work(session)
            completed = { value, changed: isChanged(value) }
            if (completed.changed) {
              const revision = await readStoreRevision(session)
              await session.execute({
                sql: "INSERT INTO capi_applied_operations (id,kind,actor_id,input_digest,committed_revision,result_json,created_at) VALUES (?,?,?,?,?,?,?)",
                args: [
                  operation.id,
                  operation.kind,
                  operation.actor,
                  operation.digest,
                  revision,
                  '{"status":"committed"}',
                  Date.now(),
                ],
              })
            }
            return value
          })
        } catch (error) {
          if (error instanceof StorageCommitUnknownError) {
            if (completed && !completed.changed) return completed.value
            setPending(owned, operation)
            let confirmed = false
            try {
              confirmed = await hasMarker(storage, operation)
            } catch {
              /* Never replay an uncertain write. */
            }
            if (confirmed && completed) {
              setPending(owned)
              return completed.value
            }
            throw new StorageCommitUnknownError(operation.id)
          }
          if (
            !(error instanceof StorageConflictError)
            || !error.retryable
            || attempt >= 2
          )
            throw error
          const delay = 25 * (attempt + 1)
          if (remainingStorageMs() <= delay)
            throw new StorageUnavailableError("timeout")
          await Bun.sleep(delay)
        }
      }
    }),
  )
}

export interface AdminRecord {
  passwordHash: string
  sessionVersion: number
}
export interface AdminSessionRecord {
  tokenHash: string
  csrfHash: string
  sessionVersion: number
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

async function readAdmin(session: SqlSession): Promise<AdminRecord | null> {
  const rows = await session.query({
    sql: "SELECT password_hash,session_version FROM capi_admin WHERE id = 1",
    args: [],
  })
  if (rows.length === 0) return null
  const row = rows[0]
  if (
    typeof row.password_hash !== "string"
    || !Number.isSafeInteger(row.session_version)
    || Number(row.session_version) < 1
  )
    throw new StorageSchemaError("Invalid administrator record")
  return {
    passwordHash: row.password_hash,
    sessionVersion: Number(row.session_version),
  }
}

async function advanceRevision(session: SqlSession): Promise<void> {
  const revision = await readStoreRevision(session)
  if (revision >= Number.MAX_SAFE_INTEGER)
    throw new StorageSchemaError("Configuration revision exhausted")
  await session.execute({
    sql: "UPDATE capi_metadata SET value = ? WHERE key = 'config_revision'",
    args: [String(revision + 1)],
  })
}

async function insertSession(
  session: SqlSession,
  value: AdminSessionRecord,
): Promise<void> {
  await session.execute({
    sql: "INSERT INTO capi_admin_sessions (token_hash,csrf_hash,session_version,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?)",
    args: [
      value.tokenHash,
      value.csrfHash,
      value.sessionVersion,
      value.createdAt,
      value.lastSeenAt,
      value.expiresAt,
    ],
  })
}

function sessionRecord(row: Record<string, unknown>): AdminSessionRecord {
  if (
    typeof row.token_hash !== "string"
    || typeof row.csrf_hash !== "string"
    || ![
      row.session_version,
      row.created_at,
      row.last_seen_at,
      row.expires_at,
    ].every((value) => Number.isSafeInteger(value))
  )
    throw new StorageSchemaError("Invalid administrator session")
  return {
    tokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    sessionVersion: Number(row.session_version),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    expiresAt: Number(row.expires_at),
  }
}

// eslint-disable-next-line max-lines-per-function -- related transaction operations share one explicit storage dependency
export function createAdminRepository(storage: Storage) {
  return {
    get(): Promise<AdminRecord | null> {
      return storage.read(readAdmin)
    },
    async issueSetupCode(input: {
      digest: string
      now: number
      expiresAt: number
    }): Promise<void> {
      await mutate(
        storage,
        { kind: "setup-code.issue", actor: "owner-cli", input },
        async (session) => {
          if (await readAdmin(session))
            throw new StorageConflictError(
              "Administrator authentication is already configured",
            )
          await session.execute({
            sql: "UPDATE capi_setup_codes SET invalidated_at = ? WHERE consumed_at IS NULL AND invalidated_at IS NULL",
            args: [input.now],
          })
          await session.execute({
            sql: "INSERT INTO capi_setup_codes (digest,created_at,expires_at) VALUES (?,?,?)",
            args: [input.digest, input.now, input.expiresAt],
          })
        },
      )
    },
    async setup(input: {
      codeDigest: string
      passwordHash: string
      gateway: { id: string; digest: string; label: string; createdAt: number }
      session: AdminSessionRecord
    }): Promise<"ok" | "configured" | "invalid"> {
      return mutate(
        storage,
        { kind: "setup", actor: input.codeDigest, input },
        async (session) => {
          if (await readAdmin(session)) return "configured"
          const consumed = await session.execute({
            sql: "UPDATE capi_setup_codes SET consumed_at = ? WHERE digest = ? AND expires_at > ? AND consumed_at IS NULL AND invalidated_at IS NULL",
            args: [
              input.session.createdAt,
              input.codeDigest,
              input.session.createdAt,
            ],
          })
          if (consumed.rowsAffected !== 1) return "invalid"
          await session.execute({
            sql: "INSERT INTO capi_admin (id,password_hash,session_version,created_at,updated_at) VALUES (1,?,1,?,?)",
            args: [
              input.passwordHash,
              input.session.createdAt,
              input.session.createdAt,
            ],
          })
          await insertGatewayCredential(session, input.gateway)
          await insertSession(session, input.session)
          await session.execute({
            sql: "UPDATE capi_setup_codes SET invalidated_at = ? WHERE consumed_at IS NULL AND invalidated_at IS NULL",
            args: [input.session.createdAt],
          })
          await advanceRevision(session)
          return "ok"
        },
        (value) => value === "ok",
      )
    },
    async createSession(input: {
      admin: AdminRecord
      gatewayDigest: string
      gatewayLiteral: string
      session: AdminSessionRecord
    }): Promise<boolean> {
      return mutate(
        storage,
        { kind: "session.create", actor: input.gatewayDigest, input },
        async (session) => {
          const current = await readAdmin(session)
          if (
            !current
            || current.passwordHash !== input.admin.passwordHash
            || current.sessionVersion !== input.admin.sessionVersion
          )
            return false
          const gateway = await session.query({
            sql: "SELECT id FROM capi_gateway_credentials WHERE digest = ? AND revoked_at IS NULL",
            args: [input.gatewayDigest],
          })
          if (gateway.length === 0) return false
          const base64 = Buffer.from(input.gatewayDigest, "hex").toString(
            "base64url",
          )
          const literal =
            /^[a-f\d]{64}$/i.test(input.gatewayLiteral) ?
              input.gatewayLiteral.toLowerCase()
            : input.gatewayLiteral
          const reserved = await session.query({
            sql: "SELECT digest FROM capi_inference_credentials WHERE digest IN (?, ?, ?) UNION ALL SELECT digest FROM capi_gateway_credentials WHERE digest = ? LIMIT 1",
            args: [input.gatewayDigest, base64, literal, literal],
          })
          if (reserved.length > 0) return false
          await session.execute({
            sql: "DELETE FROM capi_admin_sessions WHERE expires_at <= ? OR session_version <> ?",
            args: [input.session.createdAt, current.sessionVersion],
          })
          await insertSession(session, input.session)
          return true
        },
        (value) => value,
      )
    },
    async session(
      tokenHash: string,
      now: number,
    ): Promise<AdminSessionRecord | null> {
      return storage.read(async (session) => {
        const rows = await session.query({
          sql: "SELECT s.* FROM capi_admin_sessions s JOIN capi_admin a ON a.id = s.admin_id AND a.session_version = s.session_version WHERE s.token_hash = ? AND s.expires_at > ?",
          args: [tokenHash, now],
        })
        return rows[0] ? sessionRecord(rows[0]) : null
      })
    },
    async refreshSession(
      record: AdminSessionRecord,
      now: number,
      ttl: number,
    ): Promise<boolean> {
      return mutate(
        storage,
        {
          kind: "session.refresh",
          actor: record.tokenHash,
          input: { record, now, ttl },
        },
        async (session) => {
          const updated = await session.execute({
            sql: "UPDATE capi_admin_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ? AND session_version = ? AND expires_at > ? AND session_version = (SELECT session_version FROM capi_admin WHERE id = 1)",
            args: [
              now,
              now + ttl,
              record.tokenHash,
              record.sessionVersion,
              now,
            ],
          })
          return updated.rowsAffected === 1
        },
        (value) => value,
      )
    },
    async logout(tokenHash: string): Promise<void> {
      await mutate(
        storage,
        { kind: "session.logout", actor: tokenHash, input: { tokenHash } },
        async (session) => {
          await session.execute({
            sql: "DELETE FROM capi_admin_sessions WHERE token_hash = ?",
            args: [tokenHash],
          })
        },
      )
    },
    async changePassword(input: {
      expected: AdminRecord
      tokenHash?: string
      passwordHash: string
      now: number
      replacement?: AdminSessionRecord
    }): Promise<boolean> {
      return mutate(
        storage,
        {
          kind: "password.change",
          actor: input.tokenHash ?? "owner-cli",
          input,
        },
        async (session) => {
          const current = await readAdmin(session)
          if (
            !current
            || current.passwordHash !== input.expected.passwordHash
            || current.sessionVersion !== input.expected.sessionVersion
          )
            return false
          if (input.tokenHash) {
            const active = await session.query({
              sql: "SELECT token_hash FROM capi_admin_sessions WHERE token_hash = ? AND session_version = ? AND expires_at > ?",
              args: [input.tokenHash, current.sessionVersion, input.now],
            })
            if (active.length === 0) return false
          }
          await session.execute({
            sql: "UPDATE capi_admin SET password_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = 1",
            args: [input.passwordHash, input.now],
          })
          await session.execute({
            sql: "DELETE FROM capi_admin_sessions",
            args: [],
          })
          if (input.replacement) await insertSession(session, input.replacement)
          await advanceRevision(session)
          return true
        },
        (value) => value,
      )
    },
  }
}
