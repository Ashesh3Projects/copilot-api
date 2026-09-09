import { createHash, randomUUID } from "node:crypto"

import type { MutationContext, SqlSession, Storage } from "~/lib/storage/types"

import {
  isStoredGatewayCredential,
  maskSecret,
  normalizeGatewayCredential,
} from "~/lib/credential-value"
import {
  StorageConflictError,
  StorageNotFoundError,
  StorageSchemaError,
} from "~/lib/storage/errors"
import { readStoreRevision, runMutation } from "~/lib/storage/operations"

export interface GatewayCredentialSummary {
  id: string
  label: string
  createdAt: number
  revokedAt: number | null
  maskedValue: string
}

export interface GatewayCredentialInput {
  label: string
  credential: string
}

export function credentialDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function bindCredentialMutation(
  context: MutationContext,
  kind: string,
  input: unknown,
): MutationContext {
  return {
    ...context,
    kind,
    inputDigest: credentialDigest(
      JSON.stringify([context.kind, context.inputDigest, input]),
    ),
  }
}

function metadata(
  row: Record<string, unknown>,
): Omit<GatewayCredentialSummary, "maskedValue"> {
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

function storedSecret(row: Record<string, unknown>): string {
  if (
    !isStoredGatewayCredential(row.secret_value)
    || credentialDigest(row.secret_value) !== row.digest
  )
    throw new StorageSchemaError("Invalid gateway credential secret")
  return row.secret_value
}

export async function insertGatewayCredential(
  session: SqlSession,
  input: {
    id: string
    credential: string
    label: string
    createdAt: number
  },
): Promise<void> {
  const credential = normalizeGatewayCredential(input.credential)
  await session.execute({
    sql: "INSERT INTO capi_gateway_credentials (id,digest,label,created_at) VALUES (?,?,?,?)",
    args: [
      input.id,
      credentialDigest(credential),
      input.label,
      input.createdAt,
    ],
  })
  await session.execute({
    sql: "INSERT INTO capi_gateway_secrets(credential_id,secret_value,updated_at) VALUES(?,?,?)",
    args: [input.id, credential, input.createdAt],
  })
}

export async function isReservedGatewayCredential(
  session: SqlSession,
  credential: string,
): Promise<boolean> {
  const hex = credentialDigest(credential)
  const base64 = Buffer.from(hex, "hex").toString("base64url")
  const literal =
    /^[a-f\d]{64}$/i.test(credential) ? credential.toLowerCase() : credential
  const rows = await session.query({
    sql: "SELECT digest FROM capi_inference_credentials WHERE digest IN (?, ?, ?) UNION ALL SELECT digest FROM capi_gateway_credentials WHERE digest = ? LIMIT 1",
    args: [hex, base64, literal, literal],
  })
  return rows.length > 0
}

export async function findGatewayCredential(
  session: SqlSession,
  credential: string,
): Promise<string | null> {
  if (!isStoredGatewayCredential(credential)) return null
  const rows = await session.query({
    sql: "SELECT c.id FROM capi_gateway_credentials c JOIN capi_gateway_secrets s ON s.credential_id=c.id WHERE c.digest=? AND s.secret_value=? AND c.revoked_at IS NULL",
    args: [credentialDigest(credential), credential],
  })
  return rows[0] ? String(rows[0].id) : null
}

const gatewaySelect =
  "SELECT c.id,c.label,c.created_at,c.revoked_at,c.digest,s.secret_value FROM capi_gateway_credentials c JOIN capi_gateway_secrets s ON s.credential_id=c.id"

async function readGatewayCredentials(
  session: SqlSession,
): Promise<Array<GatewayCredentialSummary>> {
  return (
    await session.query({
      sql: `${gatewaySelect} WHERE c.revoked_at IS NULL ORDER BY c.created_at,c.id`,
      args: [],
    })
  ).map((row) => ({
    ...metadata(row),
    maskedValue: maskSecret(storedSecret(row)),
  }))
}

// eslint-disable-next-line max-lines-per-function -- related transaction operations share one explicit storage dependency
export function createCredentialsRepository(storage: Storage) {
  return {
    async hasActiveGatewayCredentials(): Promise<boolean> {
      return storage.read(
        async (session) => (await readGatewayCredentials(session)).length > 0,
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
        const id = await findGatewayCredential(session, raw)
        return id !== null ?
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
    async reveal(id: string) {
      return storage.read(async (session) => {
        const rows = await session.query({
          sql: `${gatewaySelect} WHERE c.id=? AND c.revoked_at IS NULL`,
          args: [id],
        })
        if (!rows[0]) return null
        return {
          id,
          credential: storedSecret(rows[0]),
          revision: await readStoreRevision(session),
        }
      })
    },
    async create(input: GatewayCredentialInput, context: MutationContext) {
      if (
        typeof input.label !== "string"
        || !input.label.trim()
        || input.label.length > 200
      )
        throw new TypeError("A gateway credential label is required")
      const label = input.label.trim()
      const credential = normalizeGatewayCredential(input.credential)
      const result = await runMutation(
        storage,
        bindCredentialMutation(context, "gateway.create", {
          label,
          credential,
        }),
        async (session) => {
          if (await isReservedGatewayCredential(session, credential))
            throw new StorageConflictError(
              "Gateway key conflicts with a reserved credential",
            )
          const duplicates = await session.query({
            sql: "SELECT id FROM capi_gateway_credentials WHERE digest=?",
            args: [credentialDigest(credential)],
          })
          if (duplicates.length > 0)
            throw new StorageConflictError("Gateway key already exists")
          const value = {
            id: randomUUID(),
            label,
            createdAt: Date.now(),
            revokedAt: null,
          }
          await insertGatewayCredential(session, {
            ...value,
            credential,
          })
          return value
        },
      )
      return {
        ...result,
        value: {
          ...result.value,
          maskedValue: maskSecret(credential),
        },
      }
    },
    async remove(id: string, context: MutationContext) {
      return runMutation(
        storage,
        bindCredentialMutation(context, "gateway.delete", id),
        async (session) => {
          const rows = await session.query({
            sql: "SELECT id,label,created_at,revoked_at FROM capi_gateway_credentials WHERE id = ?",
            args: [id],
          })
          if (!rows[0])
            throw new StorageNotFoundError("Gateway credential does not exist")
          const value = metadata(rows[0])
          const active = await readGatewayCredentials(session)
          if (value.revokedAt === null && active.length <= 1)
            throw new StorageConflictError(
              "Cannot delete the last gateway credential",
            )
          await session.execute({
            sql: "DELETE FROM capi_gateway_credentials WHERE id = ?",
            args: [id],
          })
          return value
        },
      )
    },
  }
}
