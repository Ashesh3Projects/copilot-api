import { randomBytes, randomUUID } from "node:crypto"

import type {
  AuthorizationCodeExchangeResult,
  ExchangeAuthorizationCodeInput,
  IssueAuthorizationCodeInput,
  IssuedOAuthTokens,
  RefreshAccessTokenInput,
  RefreshAccessTokenResult,
  StoredCredential,
} from "~/lib/oauth-store"
import type { SqlSession, Storage } from "~/lib/storage/types"

import {
  createPkceChallenge,
  hashOAuthSecret,
  OAUTH_AUTHORIZATION_CODE_TTL_MS,
  OAUTH_CLIENT_TOKEN_LIFETIME_SECONDS,
} from "~/lib/oauth-store"
import { SerialQueue } from "~/lib/storage/adapter-utils"
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

const knownScopes = new Set([
  "user:inference",
  "user:profile",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "org:create_api_key",
])
const states = new WeakMap<
  Storage,
  { queue: SerialQueue; pending?: Operation }
>()
function setPending(
  state: { pending?: Operation },
  operation: Operation | undefined,
): void {
  state.pending = operation
}
interface Operation {
  id: string
  kind: string
  actor: string
  digest: string
}
interface Outcome<T> {
  value: T
  changed: boolean
}
interface Grant extends StoredCredential {
  familyId: string
  clientId: string
  createdAt: number
  revokedAt: number | null
  consumedAt: number | null
}

function invalid(): never {
  throw new StorageSchemaError("Invalid OAuth token store record")
}
function text(value: unknown): string {
  if (typeof value !== "string") return invalid()
  return value
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalid()
  return value
}
function optionalTimestamp(value: unknown): number | null {
  return value === null ? null : timestamp(value)
}
function lifetime(row: Record<string, unknown>): number {
  const createdAt = timestamp(row.created_at)
  const expiresAt = optionalTimestamp(row.expires_at)
  if (expiresAt !== null && expiresAt < createdAt) invalid()
  optionalTimestamp(row.revoked_at)
  return createdAt
}
function scopes(value: unknown): Array<string> {
  let decoded: unknown
  try {
    decoded = JSON.parse(text(value))
  } catch {
    return invalid()
  }
  if (
    !Array.isArray(decoded)
    || decoded.length === 0
    || decoded.length > knownScopes.size
    || decoded.some(
      (scope: unknown) => typeof scope !== "string" || !knownScopes.has(scope),
    )
    || new Set(decoded).size !== decoded.length
  )
    return invalid()
  return decoded as Array<string>
}
function inputScopes(value: ReadonlyArray<string>): Array<string> {
  return scopes(JSON.stringify([...new Set(value)]))
}
function grant(row: Record<string, unknown>): Grant {
  return {
    principalId: text(row.principal_id),
    familyId: text(row.family_id),
    clientId: text(row.client_id),
    scopes: scopes(row.scopes_json),
    createdAt: lifetime(row),
    revokedAt: optionalTimestamp(row.revoked_at),
    consumedAt:
      row.consumed_at === undefined ? null : optionalTimestamp(row.consumed_at),
  }
}
function rawSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`
}
function unchanged<T>(value: T): Outcome<T> {
  return { value, changed: false }
}
function changed<T>(value: T): Outcome<T> {
  return { value, changed: true }
}

async function hasMarker(
  storage: Storage,
  operation: Operation,
): Promise<boolean> {
  const rows = await storage.read((session) =>
    session.query({
      sql: "SELECT kind, actor_id, input_digest, result_json FROM capi_applied_operations WHERE id = ?",
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
    throw new StorageSchemaError("Invalid OAuth operation marker")
  return true
}

/** OAuth commits do not change configuration; only safe completion metadata is recorded. */
async function mutate<T>(
  storage: Storage,
  mutation: { kind: string; actor: string; input: unknown },
  work: (session: SqlSession) => Promise<Outcome<T>>,
): Promise<T> {
  let state = states.get(storage)
  if (!state) {
    state = { queue: new SerialQueue() }
    states.set(storage, state)
  }
  const owned = state
  const operation = {
    id: randomUUID(),
    kind: `oauth.${mutation.kind}`,
    actor: `oauth:${hashOAuthSecret(mutation.actor)}`,
    digest: hashOAuthSecret(JSON.stringify(mutation.input)),
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
        setPending(owned, undefined)
      }
      for (let attempt = 0; ; attempt++) {
        let result: Outcome<T> | undefined
        try {
          return await storage.transaction(async (session) => {
            result = await work(session)
            if (result.changed) {
              const revision = await readStoreRevision(session)
              await session.execute({
                sql: "INSERT INTO capi_applied_operations (id, kind, actor_id, input_digest, committed_revision, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
            return result.value
          })
        } catch (error) {
          if (error instanceof StorageCommitUnknownError) {
            if (result && !result.changed) return result.value
            setPending(owned, operation)
            let confirmed = false
            try {
              confirmed = await hasMarker(storage, operation)
            } catch {
              /* No write replay after uncertain commit. */
            }
            if (confirmed && result) {
              setPending(owned, undefined)
              return result.value
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

async function activeFamily(session: SqlSession, id: string): Promise<boolean> {
  const rows = await session.query({
    sql: "SELECT created_at, expires_at, revoked_at FROM capi_oauth_families WHERE id = ?",
    args: [id],
  })
  if (!rows[0]) return false
  lifetime(rows[0])
  return rows[0].revoked_at === null
}
async function insertAccess(
  session: SqlSession,
  record: Grant,
  input: { now: number; digest: string; selectedScopes: ReadonlyArray<string> },
) {
  await session.execute({
    sql: "INSERT INTO capi_oauth_access (digest, family_id, principal_id, client_id, scopes_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [
      input.digest,
      record.familyId,
      record.principalId,
      record.clientId,
      JSON.stringify(input.selectedScopes),
      input.now,
    ],
  })
}
function tokenResult(
  accessToken: string,
  refreshToken: string,
  selectedScopes: ReadonlyArray<string>,
): IssuedOAuthTokens {
  return {
    accessToken,
    refreshToken,
    scopes: [...selectedScopes],
    expiresIn: OAUTH_CLIENT_TOKEN_LIFETIME_SECONDS,
    refreshTokenExpiresIn: OAUTH_CLIENT_TOKEN_LIFETIME_SECONDS,
  }
}

async function mintFamily(
  session: SqlSession,
  input: { clientId: string; selectedScopes: Array<string>; now: number },
): Promise<Outcome<AuthorizationCodeExchangeResult>> {
  const familyId = randomUUID()
  const principalId = `oauth:${randomUUID()}`
  const accessToken = rawSecret("cc_at_")
  const refreshToken = rawSecret("cc_rt_")
  const record: Grant = {
    familyId,
    principalId,
    clientId: input.clientId,
    scopes: input.selectedScopes,
    createdAt: input.now,
    revokedAt: null,
    consumedAt: null,
  }
  await session.execute({
    sql: "INSERT INTO capi_oauth_families (id, principal_id, client_id, scopes_json, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [
      familyId,
      principalId,
      input.clientId,
      JSON.stringify(input.selectedScopes),
      input.now,
    ],
  })
  await insertAccess(session, record, {
    now: input.now,
    digest: hashOAuthSecret(accessToken),
    selectedScopes: input.selectedScopes,
  })
  await session.execute({
    sql: "INSERT INTO capi_oauth_refresh (digest, family_id, principal_id, client_id, scopes_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [
      hashOAuthSecret(refreshToken),
      familyId,
      principalId,
      input.clientId,
      JSON.stringify(input.selectedScopes),
      input.now,
    ],
  })
  return changed<AuthorizationCodeExchangeResult>({
    status: "ok",
    tokens: tokenResult(accessToken, refreshToken, input.selectedScopes),
  })
}

export class OAuthRepository {
  private readonly storage: Storage

  constructor(storage: Storage) {
    this.storage = storage
  }

  async issueAuthorizationCode(
    input: IssueAuthorizationCodeInput,
  ): Promise<string> {
    const now = timestamp(input.now ?? Date.now())
    const selectedScopes = inputScopes(input.scopes)
    const code = rawSecret("cc_code_")
    const record = {
      clientId: text(input.clientId),
      redirectUri: text(input.redirectUri),
      state: text(input.state),
      challenge: text(input.codeChallenge),
    }
    return mutate(
      this.storage,
      {
        kind: "issue-code",
        actor: record.clientId,
        input: {
          ...record,
          selectedScopes,
          now,
          digest: hashOAuthSecret(code),
        },
      },
      async (session) => {
        await session.execute({
          sql: "INSERT INTO capi_oauth_codes (digest, client_id, redirect_uri, scopes_json, state, code_challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            hashOAuthSecret(code),
            record.clientId,
            record.redirectUri,
            JSON.stringify(selectedScopes),
            record.state,
            record.challenge,
            now,
            now + OAUTH_AUTHORIZATION_CODE_TTL_MS,
          ],
        })
        return changed(code)
      },
    )
  }

  async exchangeAuthorizationCode(
    input: ExchangeAuthorizationCodeInput,
  ): Promise<AuthorizationCodeExchangeResult> {
    const digest = hashOAuthSecret(input.code)
    const now = timestamp(input.now ?? Date.now())
    const binding = {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      state: input.state,
      challenge: createPkceChallenge(input.codeVerifier),
    }
    return mutate(
      this.storage,
      {
        kind: "exchange",
        actor: input.clientId,
        input: { digest, ...binding, now },
      },
      async (session) => {
        const rows = await session.query({
          sql: "SELECT client_id, redirect_uri, scopes_json, state, code_challenge, created_at, expires_at, consumed_at FROM capi_oauth_codes WHERE digest = ?",
          args: [digest],
        })
        const row = rows.at(0)
        if (!row)
          return unchanged<AuthorizationCodeExchangeResult>({
            status: "invalid_grant",
          })
        const createdAt = timestamp(row.created_at)
        const expiresAt = timestamp(row.expires_at)
        if (expiresAt < createdAt) invalid()
        const selectedScopes = scopes(row.scopes_json)
        const consumed = optionalTimestamp(row.consumed_at)
        if (consumed !== null)
          return unchanged<AuthorizationCodeExchangeResult>({
            status: "invalid_grant",
          })
        if (expiresAt <= now) {
          await session.execute({
            sql: "DELETE FROM capi_oauth_codes WHERE digest = ?",
            args: [digest],
          })
          return changed<AuthorizationCodeExchangeResult>({
            status: "invalid_grant",
          })
        }
        if (
          text(row.client_id) !== binding.clientId
          || text(row.redirect_uri) !== binding.redirectUri
          || text(row.state) !== binding.state
          || text(row.code_challenge) !== binding.challenge
        )
          return unchanged<AuthorizationCodeExchangeResult>({
            status: "invalid_grant",
          })
        const consumedCode = await session.execute({
          sql: "UPDATE capi_oauth_codes SET consumed_at = ? WHERE digest = ? AND consumed_at IS NULL",
          args: [now, digest],
        })
        if (consumedCode.rowsAffected !== 1)
          return unchanged<AuthorizationCodeExchangeResult>({
            status: "invalid_grant",
          })
        return mintFamily(session, {
          clientId: binding.clientId,
          selectedScopes,
          now,
        })
      },
    )
  }

  async refreshAccessToken(
    input: RefreshAccessTokenInput,
  ): Promise<RefreshAccessTokenResult> {
    const digest = hashOAuthSecret(input.refreshToken)
    const now = timestamp(input.now ?? Date.now())
    const requested =
      input.scopes === undefined ? undefined : [...new Set(input.scopes)]
    return mutate(
      this.storage,
      {
        kind: "refresh",
        actor: input.clientId,
        input: { digest, clientId: input.clientId, requested, now },
      },
      async (session) => {
        const rows = await session.query({
          sql: "SELECT family_id, principal_id, client_id, scopes_json, created_at, expires_at, revoked_at, consumed_at FROM capi_oauth_refresh WHERE digest = ?",
          args: [digest],
        })
        if (!rows[0])
          return unchanged<RefreshAccessTokenResult>({
            status: "invalid_grant",
          })
        const record = grant(rows[0])
        if (
          record.clientId !== input.clientId
          || record.revokedAt !== null
          || record.consumedAt !== null
          || !(await activeFamily(session, record.familyId))
        )
          return unchanged<RefreshAccessTokenResult>({
            status: "invalid_grant",
          })
        const selectedScopes = requested ?? record.scopes
        if (
          selectedScopes.length === 0
          || selectedScopes.some((scope) => !record.scopes.includes(scope))
        )
          return unchanged<RefreshAccessTokenResult>({
            status: "invalid_scope",
          })
        const accessToken = rawSecret("cc_at_")
        await insertAccess(session, record, {
          now,
          digest: hashOAuthSecret(accessToken),
          selectedScopes,
        })
        // Refresh is deliberately reusable, including concurrent and retried calls.
        return changed<RefreshAccessTokenResult>({
          status: "ok",
          tokens: tokenResult(accessToken, input.refreshToken, selectedScopes),
        })
      },
    )
  }

  async mintInferenceCredential(now: number): Promise<string> {
    timestamp(now)
    const key = rawSecret("sk-copilot-")
    const digest = hashOAuthSecret(key)
    const id = randomUUID()
    const principalId = `inference:${randomUUID()}`
    return mutate(
      this.storage,
      {
        kind: "mint-inference",
        actor: principalId,
        input: { digest, id, now },
      },
      async (session) => {
        await session.execute({
          sql: "INSERT INTO capi_inference_credentials (digest, id, kind, principal_id, scopes_json, created_at, updated_at) VALUES (?, ?, 'oauth', ?, '[\"user:inference\"]', ?, ?)",
          args: [digest, id, principalId, now, now],
        })
        return changed(key)
      },
    )
  }

  resolveAccessToken(rawToken: string): Promise<StoredCredential | null> {
    return this.storage.read(async (session) => {
      const rows = await session.query({
        sql: "SELECT family_id, principal_id, client_id, scopes_json, created_at, expires_at, revoked_at FROM capi_oauth_access WHERE digest = ?",
        args: [hashOAuthSecret(rawToken)],
      })
      if (!rows[0]) return null
      const record = grant(rows[0])
      if (
        record.revokedAt !== null
        || !(await activeFamily(session, record.familyId))
      )
        return null
      return { principalId: record.principalId, scopes: [...record.scopes] }
    })
  }

  resolveInferenceCredential(rawKey: string): Promise<StoredCredential | null> {
    return this.storage.read(async (session) => {
      const rows = await session.query({
        sql: "SELECT id, kind, principal_id, enabled, scopes_json, created_at, updated_at, revoked_at FROM capi_inference_credentials WHERE digest = ?",
        args: [hashOAuthSecret(rawKey)],
      })
      const row = rows.at(0)
      if (!row) return null
      text(row.id)
      text(row.kind)
      const principalId = text(row.principal_id)
      const selectedScopes = scopes(row.scopes_json)
      if (selectedScopes.length !== 1 || selectedScopes[0] !== "user:inference")
        invalid()
      timestamp(row.created_at)
      timestamp(row.updated_at)
      const revokedAt = optionalTimestamp(row.revoked_at)
      if (row.enabled !== 0 && row.enabled !== 1) invalid()
      if (!row.enabled || revokedAt !== null) return null
      return { principalId, scopes: selectedScopes }
    })
  }

  async revokeToken(rawToken: string, now: number): Promise<void> {
    timestamp(now)
    const digest = hashOAuthSecret(rawToken)
    await mutate(
      this.storage,
      { kind: "revoke", actor: digest, input: { digest, now } },
      async (session) => {
        const rows = await session.query({
          sql: "SELECT family_id FROM capi_oauth_refresh WHERE digest = ? UNION ALL SELECT family_id FROM capi_oauth_access WHERE digest = ? LIMIT 1",
          args: [digest, digest],
        })
        if (rows[0]) {
          const familyId = text(rows[0].family_id)
          await session.execute({
            sql: "UPDATE capi_oauth_families SET revoked_at = ? WHERE id = ?",
            args: [now, familyId],
          })
          await session.execute({
            sql: "UPDATE capi_oauth_access SET revoked_at = ? WHERE family_id = ?",
            args: [now, familyId],
          })
          await session.execute({
            sql: "UPDATE capi_oauth_refresh SET revoked_at = ? WHERE family_id = ?",
            args: [now, familyId],
          })
          return changed(undefined)
        }
        const revoked = await session.execute({
          sql: "UPDATE capi_inference_credentials SET revoked_at = ?, updated_at = ? WHERE digest = ?",
          args: [now, now, digest],
        })
        return { value: undefined, changed: revoked.rowsAffected > 0 }
      },
    )
  }
}
