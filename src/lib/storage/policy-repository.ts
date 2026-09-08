import { createHash, randomUUID } from "node:crypto"
import { isIP } from "node:net"

import type { IpAllowlistEntry } from "~/lib/ip-allowlist"
import type { MutationContext, SqlSession, Storage } from "~/lib/storage/types"
import type { TrustedJwtDigestEntry } from "~/lib/trusted-jwt-digests"

import { getSettingsActorId } from "~/lib/storage/domain-settings"
import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import {
  deadlinePromise,
  getStorageDeadline,
  remainingStorageMs,
  withStorageDeadline,
} from "~/lib/storage/operation-budget"
import { getStoreRevision, runMutation } from "~/lib/storage/operations"
import { getRequestSnapshot } from "~/lib/storage/request-snapshot"

const queues = new WeakMap<Storage, Promise<void>>()
const pending = new WeakMap<Storage, MutationContext>()

/** Policy writes share revision, actor and unknown-commit reconciliation rules. */
// eslint-disable-next-line max-params -- mutation identity and transaction body are separate inputs
async function mutate<T>(
  storage: Storage,
  kind: string,
  input: unknown,
  work: (session: SqlSession) => Promise<T>,
  actorId?: string,
): Promise<T> {
  const actor =
    actorId
    ?? getSettingsActorId()
    ?? (getRequestSnapshot() ? undefined : "system:startup-cli")
  if (!actor)
    throw new StorageConflictError("A verified policy actor is required")
  return withStorageDeadline(Date.now() + 30_000, async () => {
    const deadline = getStorageDeadline()
    if (deadline === undefined) throw new StorageUnavailableError("timeout")
    const previous = queues.get(storage) ?? Promise.resolve()
    const slot = Promise.withResolvers<undefined>()
    queues.set(storage, slot.promise)
    let admitted = false
    try {
      await deadlinePromise(previous, deadline)
      if (remainingStorageMs() <= 0)
        throw new StorageUnavailableError("timeout")
      admitted = true
      const unresolved = pending.get(storage)
      if (unresolved) {
        await runMutation(storage, unresolved, () => Promise.resolve(null))
        pending.delete(storage)
      }
      const context: MutationContext = {
        operationId: randomUUID(),
        expectedRevision: await getStoreRevision(storage),
        actorId: actor,
        kind,
        inputDigest: createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex"),
      }
      try {
        return (await runMutation(storage, context, work)).value
      } catch (error) {
        if (
          error instanceof StorageCommitUnknownError
          && error.operationId === context.operationId
        )
          pending.set(storage, context)
        throw error
      }
    } finally {
      if (admitted) slot.resolve(undefined)
      else
        void previous.then(
          () => slot.resolve(undefined),
          () => slot.resolve(undefined),
        )
    }
  })
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || !Number.isFinite(new Date(value).getTime())
  )
    throw new StorageSchemaError("Invalid policy timestamp")
  return new Date(value).toISOString()
}
function decodeIp(row: Record<string, unknown>): IpAllowlistEntry {
  if (
    typeof row.ip !== "string"
    || isIP(row.ip) === 0
    || (row.enabled !== 0 && row.enabled !== 1)
    || (row.source !== "authenticated"
      && row.source !== "dashboard"
      && row.source !== "manual")
  )
    throw new StorageSchemaError("Invalid IP policy record")
  return {
    ip: row.ip,
    enabled: row.enabled === 1,
    source: row.source,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(row.last_seen_at === null ?
      {}
    : { lastSeenAt: timestamp(row.last_seen_at) }),
  }
}
function decodeDigest(row: Record<string, unknown>): TrustedJwtDigestEntry {
  if (
    typeof row.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      row.id,
    )
    || typeof row.label !== "string"
    || !row.label.trim()
    || row.label.length > 80
    || Array.from(row.label).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || code === 127
    })
    || typeof row.digest !== "string"
    || !/^[a-f\d]{64}$/.test(row.digest)
    || (row.enabled !== 0 && row.enabled !== 1)
  )
    throw new StorageSchemaError("Invalid managed credential record")
  return {
    id: row.id,
    label: row.label,
    digest: row.digest,
    enabled: row.enabled === 1 && row.revoked_at === null,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}
async function findIp(session: SqlSession, ip: string) {
  const rows = await session.query({
    sql: "SELECT ip,enabled,source,created_at,updated_at,last_seen_at FROM capi_ip_allowlist WHERE ip = ?",
    args: [ip],
  })
  return rows[0] ? decodeIp(rows[0]) : null
}
const digestColumns = "id,label,digest,enabled,created_at,updated_at,revoked_at"

// eslint-disable-next-line max-lines-per-function -- cohesive policy operations share an explicit selected storage dependency
export function createPolicyRepository(storage: Storage) {
  return {
    listIps: () =>
      storage.read(async (session) =>
        (
          await session.query({
            sql: "SELECT ip,enabled,source,created_at,updated_at,last_seen_at FROM capi_ip_allowlist ORDER BY ip",
            args: [],
          })
        ).map((row) => decodeIp(row)),
      ),
    findIp: (ip: string) => storage.read((session) => findIp(session, ip)),
    async upsertIp(
      ip: string,
      options: {
        enabled?: boolean
        source?: IpAllowlistEntry["source"]
        seen?: boolean
      },
      promote = false,
    ): Promise<IpAllowlistEntry> {
      return withStorageDeadline(Date.now() + 30_000, async () => {
        if (promote) {
          const existing = await storage.read((session) => findIp(session, ip))
          if (existing?.enabled && existing.lastSeenAt !== undefined)
            return existing
        }
        return mutate(
          storage,
          promote ? "policy.ip.promote" : "policy.ip.upsert",
          { ip, options },
          // eslint-disable-next-line complexity -- preserve existing fields and authenticated-source promotion semantics
          async (session) => {
            const existing = await findIp(session, ip)
            if (
              promote
              && existing?.enabled
              && existing.lastSeenAt !== undefined
            )
              return existing
            const now = Date.now()
            const createdAt = existing ? Date.parse(existing.createdAt) : now
            const source =
              promote ?
                (existing?.source ?? "authenticated")
              : (options.source ?? existing?.source ?? "manual")
            const enabled =
              promote ? true : (options.enabled ?? existing?.enabled ?? true)
            let lastSeen =
              existing?.lastSeenAt ? Date.parse(existing.lastSeenAt) : null
            if (promote || options.seen) lastSeen = now
            await session.execute({
              sql: "INSERT INTO capi_ip_allowlist (ip,enabled,source,created_at,updated_at,last_seen_at) VALUES (?,?,?,?,?,?) ON CONFLICT(ip) DO UPDATE SET enabled=excluded.enabled,source=excluded.source,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at",
              args: [ip, Number(enabled), source, createdAt, now, lastSeen],
            })
            return {
              ip,
              enabled,
              source,
              createdAt: timestamp(createdAt),
              updatedAt: timestamp(now),
              ...(lastSeen === null ? {} : { lastSeenAt: timestamp(lastSeen) }),
            }
          },
          promote ? "system:authenticated-ip" : undefined,
        )
      })
    },
    removeIp: (ip: string) =>
      mutate(
        storage,
        "policy.ip.remove",
        { ip },
        async (session) =>
          (
            await session.execute({
              sql: "DELETE FROM capi_ip_allowlist WHERE ip = ?",
              args: [ip],
            })
          ).rowsAffected > 0,
      ),
    async clearIps(): Promise<Array<IpAllowlistEntry>> {
      let removed: Array<IpAllowlistEntry> = []
      await mutate(storage, "policy.ip.clear", {}, async (session) => {
        removed = (
          await session.query({
            sql: "SELECT ip,enabled,source,created_at,updated_at,last_seen_at FROM capi_ip_allowlist ORDER BY ip",
            args: [],
          })
        ).map((row) => decodeIp(row))
        await session.execute({
          sql: "DELETE FROM capi_ip_allowlist",
          args: [],
        })
        return { count: removed.length }
      })
      return removed
    },
    listDigests: () =>
      storage.read(async (session) =>
        (
          await session.query({
            sql: `SELECT ${digestColumns} FROM capi_inference_credentials WHERE kind = 'managed' ORDER BY created_at,id`,
            args: [],
          })
        ).map((row) => decodeDigest(row)),
      ),
    findDigest: (digest: string) =>
      storage.read(async (session) => {
        const rows = await session.query({
          sql: `SELECT ${digestColumns} FROM capi_inference_credentials WHERE digest = ? AND kind = 'managed'`,
          args: [digest],
        })
        return rows[0] ? decodeDigest(rows[0]) : null
      }),
    async addDigest(entry: TrustedJwtDigestEntry): Promise<void> {
      await mutate(storage, "policy.digest.add", entry, async (session) => {
        const existing = await session.query({
          sql: "SELECT id FROM capi_inference_credentials WHERE digest = ?",
          args: [entry.digest],
        })
        if (existing.length > 0)
          throw new StorageConflictError("Digest is already registered")
        await session.execute({
          sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,label,enabled,scopes_json,created_at,updated_at) VALUES (?,?,'managed',?,?,1,?,?,?)",
          args: [
            entry.digest,
            entry.id,
            `inference-managed:${entry.id}`,
            entry.label,
            '["user:inference"]',
            Date.parse(entry.createdAt),
            Date.parse(entry.updatedAt),
          ],
        })
        return { id: entry.id }
      })
    },
    async setDigestEnabled(
      id: string,
      enabled: boolean,
    ): Promise<TrustedJwtDigestEntry | null> {
      return withStorageDeadline(Date.now() + 30_000, async () => {
        await mutate(
          storage,
          "policy.digest.enable",
          { id, enabled },
          async (session) => {
            const result = await session.execute({
              sql: "UPDATE capi_inference_credentials SET enabled = ?,updated_at = ? WHERE id = ? AND kind = 'managed'",
              args: [Number(enabled), Date.now(), id],
            })
            return { id, changed: result.rowsAffected > 0 }
          },
        )
        return storage.read(async (session) => {
          const rows = await session.query({
            sql: `SELECT ${digestColumns} FROM capi_inference_credentials WHERE id = ? AND kind = 'managed'`,
            args: [id],
          })
          return rows[0] ? decodeDigest(rows[0]) : null
        })
      })
    },
    removeDigest: (id: string) =>
      mutate(
        storage,
        "policy.digest.remove",
        { id },
        async (session) =>
          (
            await session.execute({
              sql: "DELETE FROM capi_inference_credentials WHERE id = ? AND kind = 'managed'",
              args: [id],
            })
          ).rowsAffected > 0,
      ),
  }
}
