import { Hono, type Context } from "hono"

import { normalizeGatewayCredential } from "~/lib/credential-value"
import { createCredentialsRepository } from "~/lib/storage/credentials-repository"
import { getSettingsActorId } from "~/lib/storage/domain-settings"
import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageNotFoundError,
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import {
  createProviderMutationContext,
  createProvidersRepository,
} from "~/lib/storage/providers-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"

async function body(c: Context): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json()
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Expected a JSON object")
  return value as Record<string, unknown>
}

async function mutation(c: Context, kind: string, input: unknown) {
  const actor = getSettingsActorId()
  if (!actor?.startsWith("admin:"))
    throw new StorageConflictError(
      "A verified administrator session is required",
    )
  const result = await createProviderMutationContext(
    getStorageRuntime().storage,
    kind,
    input,
    actor,
  )
  const revision = c.req.header("If-Match")
  if (revision !== undefined) {
    const normalized = revision.replaceAll('"', "")
    if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(Number(normalized)))
      throw new TypeError("Invalid configuration revision")
    result.expectedRevision = Number(normalized)
  }
  result.operationId = c.req.header("Idempotency-Key") ?? result.operationId
  return result
}

async function groqStatus() {
  return createProvidersRepository(getStorageRuntime().storage).groqStatus()
}

function handleError(error: Error, c: Context) {
  if (error instanceof StorageCommitUnknownError)
    return c.json(
      {
        error: error.message,
        code: error.code,
        operationId: error.operationId,
      },
      503,
    )
  if (
    error instanceof StorageUnavailableError
    || error instanceof StorageSchemaError
  )
    return c.json(
      { error: "Database storage is unavailable", code: "storage_unavailable" },
      503,
    )
  if (error instanceof StorageConflictError)
    return c.json({ error: error.message, code: error.code }, 409)
  if (error instanceof StorageNotFoundError)
    return c.json({ error: error.message, code: error.code }, 404)
  if (error instanceof TypeError || error instanceof SyntaxError)
    return c.json(
      { error: error instanceof SyntaxError ? "Invalid JSON" : error.message },
      400,
    )
  return c.json({ error: "Credential operation failed" }, 500)
}

function administratorSecretRoutes(): Hono {
  const routes = new Hono()
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    if (!getSettingsActorId()?.startsWith("admin:"))
      return c.json({ error: "Unauthorized" }, 401)
    await next()
  })
  routes.onError(handleError)
  return routes
}

/** Mounted after administrator session and CSRF validation. */
export function createDashboardCredentialRoutes(): Hono {
  const routes = administratorSecretRoutes()
  routes.get("/gateway", async (c) => {
    const storage = getStorageRuntime().storage
    return c.json(await createCredentialsRepository(storage).listWithRevision())
  })
  routes.post("/gateway", async (c) => {
    const input = await body(c)
    if (
      typeof input.label !== "string"
      || !input.label.trim()
      || input.label.length > 200
    )
      throw new TypeError("A gateway credential label is required")
    const value = {
      label: input.label,
      credential: normalizeGatewayCredential(input.credential),
    }
    const context = await mutation(c, "gateway.create", value)
    const result = await createCredentialsRepository(
      getStorageRuntime().storage,
    ).create(value, context)
    return c.json({ ...result.value, revision: result.revision }, 201)
  })
  routes.post("/gateway/:id/reveal", async (c) => {
    const result = await createCredentialsRepository(
      getStorageRuntime().storage,
    ).reveal(c.req.param("id"))
    if (!result)
      throw new StorageNotFoundError("Gateway credential does not exist")
    return c.json(result)
  })
  routes.delete("/gateway/:id", async (c) => {
    const id = c.req.param("id")
    const context = await mutation(c, "gateway.delete", { id })
    const result = await createCredentialsRepository(
      getStorageRuntime().storage,
    ).remove(id, context)
    return c.json({ ...result.value, revision: result.revision })
  })
  routes.get("/groq", async (c) => c.json(await groqStatus()))
  routes.put("/groq", async (c) => {
    const input = await body(c)
    if (
      (input.apiKey !== undefined && typeof input.apiKey !== "string")
      || (input.clearApiKey !== undefined
        && typeof input.clearApiKey !== "boolean")
    )
      throw new TypeError("Invalid Groq credential input")
    const value = {
      apiKey: input.apiKey,
      clearApiKey: input.clearApiKey,
    }
    const runtime = getStorageRuntime()
    await createProvidersRepository(runtime.storage).setGroqSecret(
      value,
      await mutation(c, "groq.update", value),
    )
    await runtime.snapshot.refreshIfChanged()
    return c.json(await groqStatus())
  })
  return routes
}

export function createDashboardProviderSecretRoutes(): Hono {
  const routes = administratorSecretRoutes()
  routes.post("/:id/reveal", async (c) => {
    const result = await createProvidersRepository(
      getStorageRuntime().storage,
    ).reveal(c.req.param("id"))
    if (!result)
      throw new StorageNotFoundError("Custom provider does not exist")
    return c.json(result)
  })
  return routes
}
