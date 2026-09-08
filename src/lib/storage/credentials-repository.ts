import { createHash, randomBytes, randomUUID } from "node:crypto"

import type { MutationContext, SqlSession, Storage } from "~/lib/storage/types"

import { StorageConflictError, StorageSchemaError } from "~/lib/storage/errors"
import { readStoreRevision, runMutation } from "~/lib/storage/operations"

export interface GatewayCredentialSummary {
  id: string
  label: string
  createdAt: number
  revokedAt: number | null
}

export function credentialDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function bindCredentialMutation(
  context: MutationContext,
  kind: string,
  input: string,
): MutationContext {
  return {
    ...context,
    kind,
    inputDigest: credentialDigest(
      JSON.stringify([context.kind, context.inputDigest, input]),
    ),
  }
}

function summary(row: Record<string, unknown>): GatewayCredentialSummary {
  if (
    typeof row.id !== "string"
    || typeof row.label !== "string"
    || typeof row.created_at !== "number"
    || (row.revoked_at !== null && typeof row.revoked_at !== "number")
  )
    throw new StorageSchemaError("Invalid gateway credential record")
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}

export async function insertGatewayCredential(
  session: SqlSession,
  input: { id: string; digest: string; label: string; createdAt: number },
): Promise<void> {
  await session.execute({
    sql: "INSERT INTO capi_gateway_credentials (id,digest,label,created_at) VALUES (?,?,?,?)",
    args: [input.id, input.digest, input.label, input.createdAt],
  })
}

async function readGatewayCredentials(
  session: SqlSession,
): Promise<Array<GatewayCredentialSummary>> {
  return (
    await session.query({
      sql: "SELECT id,label,created_at,revoked_at FROM capi_gateway_credentials ORDER BY created_at,id",
      args: [],
    })
  ).map((row) => summary(row))
}

// eslint-disable-next-line max-lines-per-function -- related transaction operations share one explicit storage dependency
export function createCredentialsRepository(storage: Storage) {
  return {
    async hasActiveGatewayCredentials(): Promise<boolean> {
      return storage.read(
        async (session) =>
          (
            await session.query({
              sql: "SELECT id FROM capi_gateway_credentials WHERE revoked_at IS NULL LIMIT 1",
              args: [],
            })
          ).length > 0,
      )
    },
    async isDigestLiteral(value: string): Promise<boolean> {
      const literal = /^[a-f\d]{64}$/i.test(value) ? value.toLowerCase() : value
      return storage.read(
        async (session) =>
          (
            await session.query({
              sql: "SELECT digest FROM capi_gateway_credentials WHERE digest = ? UNION ALL SELECT digest FROM capi_inference_credentials WHERE digest = ? LIMIT 1",
              args: [literal, literal],
            })
          ).length > 0,
      )
    },
    async inference(raw: string) {
      const hex = credentialDigest(raw)
      const base64 = Buffer.from(hex, "hex").toString("base64url")
      return storage.read(async (session) => {
        const rows = await session.query({
          sql: "SELECT principal_id, enabled, revoked_at, scopes_json FROM capi_inference_credentials WHERE digest IN (?, ?)",
          args: [hex, base64],
        })
        if (rows.length === 0) return undefined
        if (rows.some((row) => row.enabled !== 1 || row.revoked_at !== null))
          return null
        const row = rows[0]
        if (
          typeof row.principal_id !== "string"
          || typeof row.scopes_json !== "string"
        )
          throw new StorageSchemaError("Invalid inference credential record")
        let scopes: unknown
        try {
          scopes = JSON.parse(row.scopes_json)
        } catch {
          throw new StorageSchemaError("Invalid inference credential scopes")
        }
        if (
          !Array.isArray(scopes)
          || !scopes.every((scope) => typeof scope === "string")
        )
          throw new StorageSchemaError("Invalid inference credential scopes")
        return {
          principalId: row.principal_id,
          scopes: scopes.filter(
            (scope: string) => scope === "user:inference",
          ) as Array<string>,
        }
      })
    },
    async gateway(raw: string): Promise<{ principalId: string } | null> {
      const digest = credentialDigest(raw)
      return storage.read(async (session) => {
        const rows = await session.query({
          sql: "SELECT id FROM capi_gateway_credentials WHERE digest = ? AND revoked_at IS NULL",
          args: [digest],
        })
        return rows.length > 0 ?
            { principalId: `gateway:${digest.slice(0, 16)}` }
          : null
      })
    },
    async list(): Promise<Array<GatewayCredentialSummary>> {
      return storage.read(readGatewayCredentials)
    },
    async listWithRevision(): Promise<{
      credentials: Array<GatewayCredentialSummary>
      revision: number
    }> {
      return storage.read(async (session) => ({
        credentials: await readGatewayCredentials(session),
        revision: await readStoreRevision(session),
      }))
    },
    async create(label: string, context: MutationContext) {
      if (!label.trim() || label.length > 200)
        throw new StorageConflictError("A gateway credential label is required")
      let credential: string | undefined
      let generatedId: string | undefined
      const result = await runMutation(
        storage,
        bindCredentialMutation(context, "gateway.create", label.trim()),
        async (session) => {
          credential = randomBytes(32).toString("base64url")
          const value: GatewayCredentialSummary = {
            id: randomUUID(),
            label: label.trim(),
            createdAt: Date.now(),
            revokedAt: null,
          }
          generatedId = value.id
          await insertGatewayCredential(session, {
            ...value,
            digest: credentialDigest(credential),
          })
          return value
        },
      )
      return {
        ...result,
        value: {
          ...result.value,
          ...(credential === undefined || generatedId !== result.value.id ?
            {}
          : { credential }),
        },
      }
    },
    async revoke(id: string, context: MutationContext) {
      return runMutation(
        storage,
        bindCredentialMutation(context, "gateway.revoke", id),
        async (session) => {
          const rows = await session.query({
            sql: "SELECT id,label,created_at,revoked_at FROM capi_gateway_credentials WHERE id = ?",
            args: [id],
          })
          if (!rows[0])
            throw new StorageConflictError("Gateway credential does not exist")
          const value = summary(rows[0])
          if (value.revokedAt !== null) return value
          const active = await session.query({
            sql: "SELECT count(*) AS total FROM capi_gateway_credentials WHERE revoked_at IS NULL",
            args: [],
          })
          if (Number(active[0]?.total) <= 1)
            throw new StorageConflictError(
              "Cannot revoke the last gateway credential",
            )
          value.revokedAt = Date.now()
          await session.execute({
            sql: "UPDATE capi_gateway_credentials SET revoked_at = ? WHERE id = ?",
            args: [value.revokedAt, id],
          })
          return value
        },
      )
    },
  }
}
