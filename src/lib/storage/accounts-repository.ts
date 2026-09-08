import type {
  Committed,
  MutationContext,
  SqlSession,
  Storage,
} from "~/lib/storage/types"

import { normalizeGitHubDomain } from "~/lib/github-instance"
import { bindAccountMutation } from "~/lib/storage/account-mutation"
import { StorageConflictError, StorageSchemaError } from "~/lib/storage/errors"
import {
  readStoreRevision,
  runMutation,
  readCommittedMutation,
} from "~/lib/storage/operations"

export interface AccountRecord {
  id: number
  instanceDomain: string
  upstreamUserId: string | null
  login: string | null
  label: string | null
  enabled: boolean
  removedAt: number | null
  deleting: boolean
  credentialRevision: number
  accountType: string
}

export interface ValidatedAccount {
  instanceDomain: string
  upstreamUserId: string
  login: string
  token: string
  label: string | null
  accountType: string
  modelCount: number
}

export interface AccountWithCredential {
  record: AccountRecord
  token: string | null
}

// eslint-disable-next-line complexity -- Validate each SQL field explicitly at the storage trust boundary.
function decodeAccount(row: Record<string, unknown>): AccountRecord {
  if (
    typeof row.id !== "number"
    || !Number.isSafeInteger(row.id)
    || row.id < 0
    || typeof row.domain !== "string"
    || typeof row.credential_revision !== "number"
    || !Number.isSafeInteger(row.credential_revision)
    || row.credential_revision < 0
    || typeof row.validation_json !== "string"
    || (row.enabled !== 0 && row.enabled !== 1)
  )
    throw new StorageSchemaError("Invalid stored account")
  let validation: unknown
  try {
    validation = JSON.parse(row.validation_json)
    if (normalizeGitHubDomain(row.domain) !== row.domain)
      throw new Error("Invalid normalized domain")
  } catch {
    throw new StorageSchemaError("Invalid stored account metadata")
  }
  if (
    typeof validation !== "object"
    || validation === null
    || Array.isArray(validation)
  )
    throw new StorageSchemaError("Invalid account validation metadata")
  const accountType =
    "accountType" in validation && typeof validation.accountType === "string" ?
      validation.accountType
    : "individual"
  return {
    id: row.id,
    instanceDomain: row.domain,
    upstreamUserId:
      typeof row.upstream_user_id === "string" ? row.upstream_user_id : null,
    login: typeof row.login === "string" ? row.login : null,
    label: typeof row.label === "string" ? row.label : null,
    enabled: row.enabled === 1,
    removedAt: typeof row.deleted_at === "number" ? row.deleted_at : null,
    deleting: row.deleting_at !== null,
    credentialRevision: row.credential_revision,
    accountType,
  }
}

export async function readAccount(
  session: SqlSession,
  id: number,
): Promise<AccountRecord> {
  const rows = await session.query({
    sql: "SELECT * FROM capi_accounts WHERE id = ?",
    args: [id],
  })
  if (!rows[0]) throw new StorageConflictError("Account does not exist")
  return decodeAccount(rows[0])
}

/** Stable parent refresh targets are captured in the receipt's own transaction. */
export async function listRefreshableAccountIds(
  session: SqlSession,
): Promise<Array<number>> {
  const rows = await session.query({
    sql: "SELECT id FROM capi_accounts WHERE deleted_at IS NULL AND deleting_at IS NULL ORDER BY id",
    args: [],
  })
  return rows.map((row) => Number(row.id))
}

function assertActive(record: AccountRecord): void {
  if (record.deleting || record.removedAt !== null)
    throw new StorageConflictError("Account has been removed")
}

/** Used by device completion inside the same cancellation-guarded transaction. */
export async function insertValidatedAccount(
  session: SqlSession,
  input: ValidatedAccount,
): Promise<AccountRecord> {
  const now = Date.now()
  const rows = await session.query({
    sql: "INSERT INTO capi_accounts (domain, upstream_user_id, login, label, credential_revision, validation_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?) RETURNING id",
    args: [
      input.instanceDomain,
      input.upstreamUserId,
      input.login,
      input.label,
      JSON.stringify({
        accountType: input.accountType,
        modelCount: input.modelCount,
        validatedAt: now,
      }),
      now,
      now,
    ],
  })
  const id = rows[0]?.id
  if (typeof id !== "number")
    throw new StorageSchemaError("Account ID was not allocated")
  await session.execute({
    sql: "INSERT INTO capi_account_credentials (account_id, oauth_value, updated_at) VALUES (?, ?, ?)",
    args: [id, input.token, now],
  })
  return readAccount(session, id)
}

export class AccountsRepository {
  readonly storage: Storage
  constructor(storage: Storage) {
    this.storage = storage
  }

  replayCreate(
    input: {
      token: string
      instanceDomain: string
      label: string | null
      accountType: string
    },
    context: MutationContext,
  ): Promise<Committed<AccountRecord> | undefined> {
    return readCommittedMutation(
      this.storage,
      bindAccountMutation(context, "account.create", input),
    )
  }

  // eslint-disable-next-line max-params -- Keep the same credential/target binding and separate mutation identity as replace().
  replayReplace(
    id: number,
    token: string,
    instanceDomain: string,
    context: MutationContext,
  ): Promise<Committed<AccountRecord> | undefined> {
    return readCommittedMutation(
      this.storage,
      bindAccountMutation(context, "account.replace", {
        id,
        token,
        instanceDomain,
      }),
    )
  }

  list(): Promise<ReadonlyArray<AccountRecord>> {
    return this.storage.read(async (session) =>
      (
        await session.query({
          sql: "SELECT * FROM capi_accounts ORDER BY id",
          args: [],
        })
      ).map((row) => decodeAccount(row)),
    )
  }

  snapshot(): Promise<{
    revision: number
    accounts: Array<AccountWithCredential>
  }> {
    return this.storage.read(async (session) => {
      const revision = await readStoreRevision(session)
      const rows = await session.query({
        sql: "SELECT a.*, c.oauth_value FROM capi_accounts a LEFT JOIN capi_account_credentials c ON c.account_id = a.id ORDER BY a.id",
        args: [],
      })
      return {
        revision,
        accounts: rows.map((row) => ({
          record: decodeAccount(row),
          token: typeof row.oauth_value === "string" ? row.oauth_value : null,
        })),
      }
    })
  }

  get(id: number): Promise<AccountWithCredential> {
    return this.storage.read(async (session) => {
      const record = await readAccount(session, id)
      const rows = await session.query({
        sql: "SELECT oauth_value FROM capi_account_credentials WHERE account_id = ?",
        args: [id],
      })
      return {
        record,
        token:
          typeof rows[0]?.oauth_value === "string" ? rows[0].oauth_value : null,
      }
    })
  }

  create(
    input: ValidatedAccount,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    const bound = bindAccountMutation(context, "account.create", {
      token: input.token,
      instanceDomain: input.instanceDomain,
      label: input.label,
      accountType: input.accountType,
    })
    return runMutation(this.storage, bound, (session) =>
      insertValidatedAccount(session, input),
    )
  }

  update(
    id: number,
    input: { enabled?: boolean; label?: string | null },
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    const bound = bindAccountMutation(context, "account.update", {
      id,
      ...input,
    })
    return runMutation(this.storage, bound, async (session) => {
      const before = await readAccount(session, id)
      assertActive(before)
      await session.execute({
        sql: "UPDATE capi_accounts SET enabled = ?, label = ?, updated_at = ? WHERE id = ?",
        args: [
          Number(input.enabled ?? before.enabled),
          input.label === undefined ? before.label : input.label,
          Date.now(),
          id,
        ],
      })
      return readAccount(session, id)
    })
  }

  // eslint-disable-next-line max-params -- Credential CAS and configuration CAS are distinct required guards.
  replace(
    id: number,
    input: ValidatedAccount,
    expectedCredentialRevision: number,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    const bound = bindAccountMutation(context, "account.replace", {
      id,
      token: input.token,
      instanceDomain: input.instanceDomain,
    })
    return runMutation(this.storage, bound, async (session) => {
      const before = await readAccount(session, id)
      assertActive(before)
      if (
        before.instanceDomain !== input.instanceDomain
        || (before.upstreamUserId !== null
          && before.upstreamUserId !== input.upstreamUserId)
      )
        throw new StorageConflictError(
          "Reconnect requires the same GitHub identity and instance",
        )
      if (before.credentialRevision !== expectedCredentialRevision)
        throw new StorageConflictError("Account credential changed")
      const now = Date.now()
      await session.execute({
        sql: "UPDATE capi_accounts SET upstream_user_id = ?, login = ?, credential_revision = credential_revision + 1, validation_json = ?, updated_at = ? WHERE id = ?",
        args: [
          input.upstreamUserId,
          input.login,
          JSON.stringify({
            accountType: input.accountType,
            modelCount: input.modelCount,
            validatedAt: now,
          }),
          now,
          id,
        ],
      })
      await session.execute({
        sql: "INSERT INTO capi_account_credentials (account_id, oauth_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET oauth_value = excluded.oauth_value, updated_at = excluded.updated_at",
        args: [id, input.token, now],
      })
      return readAccount(session, id)
    })
  }

  beginRemoval(
    id: number,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    const bound = bindAccountMutation(context, "account.begin-removal", { id })
    return runMutation(this.storage, bound, async (session) => {
      const before = await readAccount(session, id)
      if (before.removedAt !== null || before.deleting) return before
      await session.execute({
        sql: "UPDATE capi_accounts SET enabled = 0, deleting_at = ?, updated_at = ? WHERE id = ?",
        args: [Date.now(), Date.now(), id],
      })
      return readAccount(session, id)
    })
  }

  finalizeRemoval(
    id: number,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    const bound = bindAccountMutation(context, "account.finalize-removal", {
      id,
    })
    return runMutation(this.storage, bound, async (session) => {
      const before = await readAccount(session, id)
      if (before.removedAt !== null) return before
      if (!before.deleting)
        throw new StorageConflictError("Account is not being removed")
      await session.execute({
        sql: "DELETE FROM capi_account_credentials WHERE account_id = ?",
        args: [id],
      })
      await session.execute({
        sql: "UPDATE capi_accounts SET deleted_at = ?, deleting_at = NULL, updated_at = ? WHERE id = ?",
        args: [Date.now(), Date.now(), id],
      })
      return readAccount(session, id)
    })
  }
}
