import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"

import type { CustomProviderConfig } from "~/lib/config"
import type { MutationContext, SqlSession, Storage } from "~/lib/storage/types"

import { StorageSchemaError } from "~/lib/storage/errors"
import {
  getStoreRevision,
  readStoreRevision,
  runMutation,
} from "~/lib/storage/operations"

export interface ProviderSnapshot {
  readonly providers: Array<CustomProviderConfig>
  readonly groqApiKey?: string
}

export interface ProviderInput extends CustomProviderConfig {
  enabled?: boolean
  clearApiKey?: boolean
  clearHeaders?: boolean
}

export interface ProviderSummary
  extends Omit<CustomProviderConfig, "apiKey" | "apiKeyEnv" | "headers"> {
  enabled: boolean
  apiKeyConfigured: boolean
  headerNames: Array<string>
  revision: number
}

const modelSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(["chat", "embedding"]),
  aliases: z.array(z.string().trim().min(1)).optional(),
  dimensions: z.number().int().positive().optional(),
  supportsStreaming: z.boolean().optional(),
  passReasoningEffort: z.boolean().optional(),
})
const metadataSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  type: z.literal("openai-compatible"),
  baseUrl: z.url().refine((value) => /^https?:\/\//.test(value)),
  models: z.array(modelSchema).min(1),
  passReasoningEffort: z.boolean().optional(),
})
const headersSchema = z.record(z.string().trim().min(1), z.string())
const providerInputSchema = metadataSchema.extend({
  apiKey: z.string().optional(),
  apiKeyEnv: z.never().optional(),
  headers: headersSchema.optional(),
  enabled: z.boolean().optional(),
  clearApiKey: z.boolean().optional(),
  clearHeaders: z.boolean().optional(),
})

function parseInput(input: unknown): ProviderInput {
  const result = providerInputSchema.safeParse(input)
  if (!result.success)
    throw new TypeError(
      "Invalid custom provider configuration; use stored credentials instead of apiKeyEnv",
    )
  const value = result.data
  if (
    (value.clearApiKey && value.apiKey?.trim())
    || (value.clearHeaders
      && Object.values(value.headers ?? {}).some((header) => header.trim()))
  )
    throw new TypeError("A secret cannot be replaced and cleared together")
  try {
    new Headers(value.headers)
  } catch {
    throw new TypeError("Invalid custom provider headers")
  }
  value.baseUrl = value.baseUrl.replace(/\/+$/, "")
  value.models = value.models.map((model) => ({
    ...model,
    ...(model.aliases ?
      {
        aliases: [
          ...new Set(model.aliases.filter((alias) => alias !== model.id)),
        ],
      }
    : {}),
  }))
  return value
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function decodeProvider(row: Record<string, unknown>): CustomProviderConfig {
  try {
    if (
      typeof row.payload_json !== "string"
      || typeof row.headers_json !== "string"
      || (row.api_key !== null && typeof row.api_key !== "string")
    )
      throw new Error()
    const metadata = metadataSchema.strict().parse(JSON.parse(row.payload_json))
    if (metadata.id !== row.id || metadata.name !== row.name) throw new Error()
    const headers = headersSchema.parse(JSON.parse(row.headers_json))
    new Headers(headers)
    return {
      ...metadata,
      ...(row.api_key ? { apiKey: row.api_key } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }
  } catch {
    throw new StorageSchemaError("Invalid provider record")
  }
}

const providerSelect =
  "SELECT p.id,p.name,p.enabled,p.revision,p.payload_json,s.api_key,COALESCE(s.headers_json, '{}') AS headers_json FROM capi_providers p LEFT JOIN capi_provider_secrets s ON s.provider_id=p.id WHERE p.deleted_at IS NULL"

export async function loadCustomProviderSnapshotFromSession(
  session: SqlSession,
): Promise<ProviderSnapshot> {
  const rows = await session.query({
    sql: `${providerSelect} AND p.enabled=1 ORDER BY p.created_at,p.id`,
    args: [],
  })
  const groq = await session.query({
    sql: "SELECT secret_value FROM capi_service_secrets WHERE service='groq'",
    args: [],
  })
  if (
    groq.length > 0
    && (typeof groq[0]?.secret_value !== "string"
      || !groq[0].secret_value.trim())
  )
    throw new StorageSchemaError("Invalid Groq credential record")
  return freeze({
    providers: rows.map((row) => decodeProvider(row)),
    ...(groq.length > 0 ? { groqApiKey: groq[0].secret_value as string } : {}),
  })
}

export function loadCustomProviderSnapshot(
  storage: Storage,
): Promise<ProviderSnapshot> {
  return storage.read(loadCustomProviderSnapshotFromSession)
}

export function providerSummary(
  provider: CustomProviderConfig,
  enabled = true,
  revision = 0,
): ProviderSummary {
  const { apiKey, apiKeyEnv: _apiKeyEnv, headers, ...metadata } = provider
  return {
    ...metadata,
    enabled,
    revision,
    apiKeyConfigured: Boolean(apiKey),
    headerNames: Object.keys(headers ?? {}),
  }
}

// eslint-disable-next-line max-params -- Shared mutation identity includes verified actor, domain kind and exact input.
export async function createProviderMutationContext(
  storage: Storage,
  kind: string,
  input: unknown,
  actorId: string,
): Promise<MutationContext> {
  return {
    operationId: randomUUID(),
    expectedRevision: await getStoreRevision(storage),
    actorId,
    kind,
    inputDigest: createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex"),
  }
}

async function upsertProvider(
  session: SqlSession,
  input: ProviderInput,
  revision: number,
): Promise<{ id: string }> {
  const previousRows = await session.query({
    sql: "SELECT p.deleted_at,s.api_key,s.headers_json,p.enabled FROM capi_providers p LEFT JOIN capi_provider_secrets s ON s.provider_id=p.id WHERE p.id=?",
    args: [input.id],
  })
  const previous: Record<string, unknown> | undefined =
    previousRows.length > 0 ? previousRows[0] : undefined
  if (previous?.deleted_at !== undefined && previous.deleted_at !== null)
    throw new TypeError("A removed provider ID cannot be reused")
  const headers = mergedProviderHeaders(previous?.headers_json, input)
  const apiKey =
    input.clearApiKey ? null : (
      input.apiKey?.trim()
      || (typeof previous?.api_key === "string" ? previous.api_key : null)
    )
  const metadata = metadataSchema.parse(input)
  const now = Date.now()
  await session.execute({
    sql: "INSERT INTO capi_providers(id,name,enabled,payload_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,payload_json=excluded.payload_json,revision=excluded.revision,updated_at=excluded.updated_at",
    args: [
      input.id,
      input.name,
      input.enabled === undefined ?
        Number(previous?.enabled ?? 1)
      : Number(input.enabled),
      JSON.stringify(metadata),
      revision,
      now,
      now,
    ],
  })
  await session.execute({
    sql: "INSERT INTO capi_provider_secrets(provider_id,api_key,headers_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET api_key=excluded.api_key,headers_json=excluded.headers_json,updated_at=excluded.updated_at",
    args: [input.id, apiKey, JSON.stringify(headers), now],
  })
  return { id: input.id }
}

function mergedProviderHeaders(
  stored: unknown,
  input: ProviderInput,
): Record<string, string> {
  let headers: Record<string, string> = {}
  if (stored !== undefined && stored !== null) {
    try {
      if (typeof stored !== "string") throw new Error()
      headers = headersSchema.parse(JSON.parse(stored))
    } catch {
      throw new StorageSchemaError("Invalid provider headers")
    }
  }
  if (input.clearHeaders) headers = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!value.trim()) continue
    const canonicalName = name.toLowerCase()
    headers = Object.fromEntries(
      Object.entries(headers).filter(
        ([storedName]) => storedName.toLowerCase() !== canonicalName,
      ),
    )
    headers[name] = value
  }
  return headers
}

function bindProviderMutation(
  context: MutationContext,
  kind: string,
  input: unknown,
): MutationContext {
  return {
    ...context,
    kind,
    inputDigest: createHash("sha256")
      .update(JSON.stringify([context.inputDigest, input]))
      .digest("hex"),
  }
}

async function listProviderSummaries(
  session: SqlSession,
): Promise<Array<ProviderSummary>> {
  return (
    await session.query({
      sql: `${providerSelect} ORDER BY p.created_at,p.id`,
      args: [],
    })
  ).map((row) => {
    if (
      (row.enabled !== 0 && row.enabled !== 1)
      || !Number.isSafeInteger(row.revision)
    )
      throw new StorageSchemaError("Invalid provider metadata")
    return providerSummary(
      decodeProvider(row),
      row.enabled === 1,
      Number(row.revision),
    )
  })
}
export function createProvidersRepository(storage: Storage) {
  return {
    storage,
    async groqStatus(): Promise<{
      apiKeyConfigured: boolean
      revision: number
    }> {
      return storage.read(async (session) => {
        const snapshot = await loadCustomProviderSnapshotFromSession(session)
        return {
          apiKeyConfigured: Boolean(snapshot.groqApiKey),
          revision: await readStoreRevision(session),
        }
      })
    },
    async list(): Promise<Array<ProviderSummary>> {
      return storage.read(listProviderSummaries)
    },
    async listPage() {
      return storage.read(async (session) => ({
        providers: await listProviderSummaries(session),
        revision: await readStoreRevision(session),
      }))
    },
    async upsert(input: ProviderInput, context: MutationContext) {
      const detached = parseInput(input)
      const bound = bindProviderMutation(context, "provider.upsert", detached)
      return runMutation(storage, bound, (session, revision) =>
        upsertProvider(session, detached, revision),
      )
    },
    async remove(id: string, context: MutationContext) {
      const bound = bindProviderMutation(context, "provider.remove", { id })
      return runMutation(storage, bound, async (session, revision) => {
        const now = Date.now()
        const removed = await session.execute({
          sql: "UPDATE capi_providers SET enabled=0,deleted_at=?,updated_at=?,revision=? WHERE id=? AND deleted_at IS NULL",
          args: [now, now, revision, id],
        })
        await session.execute({
          sql: "DELETE FROM capi_provider_secrets WHERE provider_id=?",
          args: [id],
        })
        return { id, removed: removed.rowsAffected > 0 }
      })
    },
    async setGroqSecret(
      input: { apiKey?: string; clearApiKey?: boolean },
      context: MutationContext,
    ) {
      if (
        (input.apiKey !== undefined && typeof input.apiKey !== "string")
        || (input.clearApiKey !== undefined
          && typeof input.clearApiKey !== "boolean")
        || (input.clearApiKey && input.apiKey?.trim())
      )
        throw new TypeError("Invalid Groq credential input")
      const apiKey = input.apiKey?.trim()
      const clear = input.clearApiKey === true
      const bound = bindProviderMutation(context, "groq.update", {
        apiKey,
        clear,
      })
      return runMutation(storage, bound, async (session) => {
        if (clear)
          await session.execute({
            sql: "DELETE FROM capi_service_secrets WHERE service='groq'",
            args: [],
          })
        else if (apiKey)
          await session.execute({
            sql: "INSERT INTO capi_service_secrets(service,secret_value,updated_at) VALUES('groq',?,?) ON CONFLICT(service) DO UPDATE SET secret_value=excluded.secret_value,updated_at=excluded.updated_at",
            args: [apiKey, Date.now()],
          })
        return { service: "groq" }
      })
    },
  }
}
