import { randomUUID } from "node:crypto"

import type {
  AccountRecord,
  ValidatedAccount,
} from "~/lib/storage/accounts-repository"
import type {
  Committed,
  MutationContext,
  SqlSession,
  Storage,
} from "~/lib/storage/types"
import type { DeviceCodeResponse } from "~/services/github/get-device-code"

import { bindAccountMutation } from "~/lib/storage/account-mutation"
import { insertValidatedAccount } from "~/lib/storage/accounts-repository"
import { StorageConflictError, StorageSchemaError } from "~/lib/storage/errors"
import { runMutation, readCommittedMutation } from "~/lib/storage/operations"

export type DeviceLoginStatus =
  | "pending"
  | "complete"
  | "canceled"
  | "expired"
  | "failed"
interface IntentPayload {
  owner: string
  label: string | null
  accountType: string
  nextPollAt: number
  leaseId: string | null
  leaseUntil: number
  failure: boolean
}
export interface DeviceLoginIntent {
  id: string
  instanceDomain: string
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresAt: number
  canceledAt: number | null
  completedAt: number | null
  accountId: number | null
  payload: IntentPayload
}

// eslint-disable-next-line complexity -- Validate durable control-plane state field by field before trusting it.
function decode(row: Record<string, unknown>): DeviceLoginIntent {
  if (
    typeof row.id !== "string"
    || typeof row.domain !== "string"
    || typeof row.device_code !== "string"
    || typeof row.user_code !== "string"
    || typeof row.verification_uri !== "string"
    || typeof row.interval_seconds !== "number"
    || typeof row.expires_at !== "number"
    || typeof row.payload_json !== "string"
  )
    throw new StorageSchemaError("Invalid device login intent")
  let payload: unknown
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    throw new StorageSchemaError("Invalid device login payload")
  }
  if (
    typeof payload !== "object"
    || !payload
    || !("owner" in payload)
    || typeof payload.owner !== "string"
    || !("nextPollAt" in payload)
    || typeof payload.nextPollAt !== "number"
    || !("leaseUntil" in payload)
    || typeof payload.leaseUntil !== "number"
    || !("leaseId" in payload)
    || (payload.leaseId !== null && typeof payload.leaseId !== "string")
    || !("failure" in payload)
    || typeof payload.failure !== "boolean"
    || !("accountType" in payload)
    || typeof payload.accountType !== "string"
    || !("label" in payload)
    || (payload.label !== null && typeof payload.label !== "string")
  )
    throw new StorageSchemaError("Invalid device login owner")
  return {
    id: row.id,
    instanceDomain: row.domain,
    deviceCode: row.device_code,
    userCode: row.user_code,
    verificationUri: row.verification_uri,
    intervalSeconds: row.interval_seconds,
    expiresAt: row.expires_at,
    canceledAt: row.canceled_at as number | null,
    completedAt: row.completed_at as number | null,
    accountId: row.account_id as number | null,
    payload: payload as IntentPayload,
  }
}

async function readIntent(
  session: SqlSession,
  id: string,
  owner: string,
): Promise<DeviceLoginIntent> {
  const rows = await session.query({
    sql: "SELECT * FROM capi_device_login_intents WHERE id = ?",
    args: [id],
  })
  if (!rows[0]) throw new StorageConflictError("Device login does not exist")
  const intent = decode(rows[0])
  if (intent.payload.owner !== owner)
    throw new StorageConflictError(
      "Device login belongs to another administrator session",
    )
  return intent
}

export function deviceLoginStatus(
  intent: DeviceLoginIntent,
  now: number,
): DeviceLoginStatus {
  if (intent.completedAt !== null) return "complete"
  if (intent.canceledAt !== null) return "canceled"
  if (intent.expiresAt <= now) return "expired"
  if (intent.payload.failure) return "failed"
  return "pending"
}

export class DeviceLoginRepository {
  readonly storage: Storage
  constructor(storage: Storage) {
    this.storage = storage
  }

  get(id: string, owner: string): Promise<DeviceLoginIntent> {
    return this.storage.read((session) => readIntent(session, id, owner))
  }

  replayStart(
    input: {
      owner: string
      instanceDomain: string
      label: string | null
      accountType: string
    },
    context: MutationContext,
  ): Promise<Committed<{ id: string }> | undefined> {
    return readCommittedMutation(
      this.storage,
      bindAccountMutation(context, "account.device-start", input),
    )
  }

  create(
    input: {
      id: string
      owner: string
      instanceDomain: string
      label: string | null
      accountType: string
      code: DeviceCodeResponse
      now: number
    },
    context: MutationContext,
  ): Promise<Committed<{ id: string }>> {
    const bound = bindAccountMutation(context, "account.device-start", {
      owner: input.owner,
      instanceDomain: input.instanceDomain,
      label: input.label,
      accountType: input.accountType,
    })
    return runMutation(this.storage, bound, async (session) => {
      const interval = Math.ceil(input.code.interval * 1.2)
      const payload: IntentPayload = {
        owner: input.owner,
        label: input.label,
        accountType: input.accountType,
        nextPollAt: input.now + interval * 1000,
        leaseId: null,
        leaseUntil: 0,
        failure: false,
      }
      await session.execute({
        sql: "INSERT INTO capi_device_login_intents (id,admin_id,domain,device_code,user_code,verification_uri,interval_seconds,created_at,expires_at,payload_json) VALUES (?,1,?,?,?,?,?,?,?,?)",
        args: [
          input.id,
          input.instanceDomain,
          input.code.device_code,
          input.code.user_code,
          input.code.verification_uri,
          interval,
          input.now,
          input.now + input.code.expires_in * 1000,
          JSON.stringify(payload),
        ],
      })
      return { id: input.id }
    })
  }

  // eslint-disable-next-line max-params -- Cancellation binds identity, owner, expiry clock and mutation identity.
  cancel(
    id: string,
    owner: string,
    now: number,
    context: MutationContext,
  ): Promise<Committed<{ id: string; canceled: boolean }>> {
    const bound = bindAccountMutation(context, "account.device-cancel", {
      id,
      owner,
    })
    return runMutation(this.storage, bound, async (session) => {
      const intent = await readIntent(session, id, owner)
      if (intent.completedAt !== null) return { id, canceled: false }
      await session.execute({
        sql: "UPDATE capi_device_login_intents SET canceled_at = ?, device_code = '', payload_json = ? WHERE id = ?",
        args: [
          now,
          JSON.stringify({ ...intent.payload, leaseId: null, leaseUntil: 0 }),
          id,
        ],
      })
      return { id, canceled: true }
    })
  }

  claim(
    id: string,
    owner: string,
    now: number,
  ): Promise<DeviceLoginIntent | undefined> {
    return this.storage.transaction(async (session) => {
      const intent = await readIntent(session, id, owner)
      if (deviceLoginStatus(intent, now) === "expired" && intent.deviceCode) {
        await session.execute({
          sql: "UPDATE capi_device_login_intents SET device_code = '' WHERE id = ?",
          args: [id],
        })
      }
      if (
        deviceLoginStatus(intent, now) !== "pending"
        || intent.payload.nextPollAt > now
        || intent.payload.leaseUntil > now
      )
        return undefined
      intent.payload = {
        ...intent.payload,
        leaseId: randomUUID(),
        leaseUntil: now + 120_000,
        nextPollAt: now + intent.intervalSeconds * 1000,
      }
      await session.execute({
        sql: "UPDATE capi_device_login_intents SET payload_json = ? WHERE id = ?",
        args: [JSON.stringify(intent.payload), id],
      })
      return intent
    })
  }

  release(
    intent: DeviceLoginIntent,
    now: number,
    result: { slowDown?: number; failed?: boolean } = {},
  ): Promise<void> {
    return this.storage.transaction(async (session) => {
      const current = await readIntent(session, intent.id, intent.payload.owner)
      if (
        current.payload.leaseId !== intent.payload.leaseId
        || deviceLoginStatus(current, now) !== "pending"
      )
        return
      const interval =
        result.slowDown === undefined ?
          current.intervalSeconds
        : Math.min(
            60,
            Math.ceil(Math.max(current.intervalSeconds + 5, result.slowDown)),
          )
      const payload = {
        ...current.payload,
        nextPollAt: now + interval * 1000,
        leaseId: null,
        leaseUntil: 0,
        failure: result.failed ?? false,
      }
      await session.execute({
        sql: "UPDATE capi_device_login_intents SET interval_seconds = ?, payload_json = ?, device_code = ? WHERE id = ?",
        args: [
          interval,
          JSON.stringify(payload),
          result.failed ? "" : current.deviceCode,
          intent.id,
        ],
      })
    })
  }

  // eslint-disable-next-line max-params -- Completion binds validated credentials to the active intent lease and mutation.
  complete(
    intent: DeviceLoginIntent,
    input: ValidatedAccount,
    clock: () => number,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    const bound = bindAccountMutation(context, "account.device-complete", {
      id: intent.id,
      owner: intent.payload.owner,
      instanceDomain: intent.instanceDomain,
      leaseId: intent.payload.leaseId,
      input,
    })
    return runMutation(this.storage, bound, async (session) => {
      const current = await readIntent(session, intent.id, intent.payload.owner)
      const now = clock()
      const ownerHash = intent.payload.owner.slice("admin:".length)
      const sessions = await session.query({
        sql: "SELECT s.token_hash FROM capi_admin_sessions s JOIN capi_admin a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.session_version = a.session_version AND s.expires_at > ?",
        args: [ownerHash, now],
      })
      if (
        deviceLoginStatus(current, now) !== "pending"
        || current.payload.leaseId !== intent.payload.leaseId
        || current.payload.leaseUntil <= now
        || sessions.length !== 1
      )
        throw new StorageConflictError("Device login is no longer active")
      const record = await insertValidatedAccount(session, input)
      await session.execute({
        sql: "UPDATE capi_device_login_intents SET completed_at = ?, account_id = ?, device_code = '', payload_json = ? WHERE id = ?",
        args: [
          now,
          record.id,
          JSON.stringify({ ...current.payload, leaseId: null, leaseUntil: 0 }),
          intent.id,
        ],
      })
      return record
    })
  }
}
