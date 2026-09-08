import type { Context } from "hono"

import { Hono } from "hono"

import type {
  AccountsService,
  CreateAccountInput,
} from "~/lib/accounts-service"
import type { GitHubDeviceLoginService } from "~/lib/github-device-login"
import type { MutationContext } from "~/lib/storage/types"

import {
  createAccountMutationContext,
  getAccountsService,
} from "~/lib/accounts-service"
import { HTTPError } from "~/lib/error"
import { getGitHubDeviceLoginService } from "~/lib/github-device-login"
import { getSettingsActorId } from "~/lib/storage/domain-settings"
import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { getStoreRevision } from "~/lib/storage/operations"

function owner(): string {
  const actor = getSettingsActorId()
  if (!actor?.startsWith("admin:"))
    throw new StorageConflictError(
      "A verified administrator session is required",
    )
  return actor
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json()
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected a JSON object")
  return value as Record<string, unknown>
}

function textField(
  input: Record<string, unknown>,
  key: string,
  required = false,
): string | undefined {
  const value = input[key]
  if (value === undefined && !required) return undefined
  if (
    typeof value !== "string"
    || (required && !value.trim())
    || value.length > 16_384
  )
    throw new TypeError(`Invalid ${key}`)
  return value.trim()
}

function accountInput(input: Record<string, unknown>): CreateAccountInput {
  return {
    token: textField(input, "token", true) ?? "",
    instanceDomain: textField(input, "instanceDomain"),
    label: textField(input, "label"),
    accountType: textField(input, "accountType"),
  }
}

function accountId(c: Context): number {
  const value = c.req.param("id")
  if (!value || !/^(?:0|[1-9]\d*)$/.test(value))
    throw new TypeError("Invalid account ID")
  const id = Number(value)
  if (!Number.isSafeInteger(id)) throw new TypeError("Invalid account ID")
  return id
}

// eslint-disable-next-line max-params -- The request supplies revision and operation identity independently from domain input.
async function mutation(
  c: Context,
  accounts: AccountsService,
  kind: string,
  input: unknown,
): Promise<MutationContext> {
  const result = await createAccountMutationContext(
    accounts.repository.storage,
    kind,
    input,
    owner(),
  )
  const revision = c.req.header("If-Match")
  if (revision !== undefined) {
    const normalized = revision.replaceAll('"', "")
    if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(Number(normalized)))
      throw new TypeError("Invalid configuration revision")
    result.expectedRevision = Number(normalized)
  }
  const operationId = c.req.header("Idempotency-Key")
  if (operationId) result.operationId = operationId
  return result
}

/** Mount after the existing dashboard admin-session/CSRF middleware. */
// eslint-disable-next-line max-lines-per-function -- Registers the cohesive account lifecycle API with shared dependency injection.
export function createDashboardAccountRoutes(
  options: {
    accounts: () => AccountsService
    device: () => GitHubDeviceLoginService
  } = { accounts: getAccountsService, device: getGitHubDeviceLoginService },
): Hono {
  const routes = new Hono()
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    if (!getSettingsActorId()?.startsWith("admin:"))
      return c.json({ error: "Unauthorized" }, 401)
    await next()
  })
  routes.onError((error, c) => {
    c.header("Cache-Control", "no-store")
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
        {
          error: "Database storage is unavailable",
          code: "storage_unavailable",
        },
        503,
      )
    if (error instanceof StorageConflictError)
      return c.json({ error: error.message, code: error.code }, 409)
    if (error instanceof TypeError || error instanceof SyntaxError)
      return c.json(
        {
          error: error instanceof SyntaxError ? "Invalid JSON" : error.message,
        },
        400,
      )
    if (error instanceof HTTPError)
      return c.json(
        {
          error:
            "GitHub credential validation failed; check the credential and Copilot access",
        },
        422,
      )
    return c.json(
      {
        error:
          "GitHub account operation failed; retry or revalidate the account",
      },
      502,
    )
  })
  routes.get("/", async (c) => {
    const accounts = options.accounts()
    return c.json({
      accounts: await accounts.list(),
      revision: await getStoreRevision(accounts.repository.storage),
    })
  })
  routes.post("/", async (c) => {
    const accounts = options.accounts()
    const input = accountInput(await body(c))
    const result = await accounts.create(
      input,
      await mutation(c, accounts, "account.create", input),
    )
    return c.json({ account: result.value, revision: result.revision }, 201)
  })
  routes.post("/refresh-models", async (c) => {
    const accounts = options.accounts()
    return c.json(
      await accounts.refreshAllModels(
        await mutation(c, accounts, "account.refresh-all-models", {}),
      ),
    )
  })
  routes.post("/device-login", async (c) => {
    const input = await body(c)
    const request = {
      instanceDomain: textField(input, "instanceDomain") ?? "github.com",
      label: textField(input, "label"),
      accountType: textField(input, "accountType"),
    }
    return c.json(
      await options
        .device()
        .start(
          request,
          owner(),
          await mutation(
            c,
            options.accounts(),
            "account.device-start",
            request,
          ),
        ),
      201,
    )
  })
  routes.get("/device-login/:id", async (c) =>
    c.json(await options.device().poll(c.req.param("id"), owner())),
  )
  routes.delete("/device-login/:id", async (c) => {
    const id = c.req.param("id")
    return c.json(
      await options.device().cancel(
        id,
        owner(),
        await mutation(c, options.accounts(), "account.device-cancel", {
          id,
        }),
      ),
    )
  })
  routes.patch("/:id", async (c) => {
    const input = await body(c)
    if (input.enabled !== undefined && typeof input.enabled !== "boolean")
      throw new TypeError("Invalid enabled state")
    const update = {
      enabled: input.enabled,
      label: input.label === null ? null : textField(input, "label"),
    }
    const accounts = options.accounts()
    const id = accountId(c)
    const result = await accounts.update(
      id,
      update,
      await mutation(c, accounts, "account.update", { id, ...update }),
    )
    return c.json({ account: result.value, revision: result.revision })
  })
  routes.delete("/:id", async (c) => {
    const accounts = options.accounts()
    const id = accountId(c)
    const result = await accounts.remove(
      id,
      await mutation(c, accounts, "account.remove", { id }),
    )
    return c.json({ account: result.value, revision: result.revision })
  })
  routes.put("/:id/credential", async (c) => {
    const input = await body(c)
    const token = textField(input, "token", true) ?? ""
    const accounts = options.accounts()
    const id = accountId(c)
    const result = await accounts.replaceCredential(
      id,
      token,
      await mutation(c, accounts, "account.reconnect", { id, token }),
    )
    return c.json({ account: result.value, revision: result.revision })
  })
  routes.post("/:id/revalidate", async (c) => {
    const accounts = options.accounts()
    const id = accountId(c)
    const account = await accounts.revalidate(
      id,
      await mutation(c, accounts, "account.revalidate", { id }),
    )
    return c.json({
      account,
      revision: await getStoreRevision(accounts.repository.storage),
    })
  })
  routes.post("/:id/refresh-models", async (c) => {
    const accounts = options.accounts()
    const id = accountId(c)
    const result = await accounts.refreshModels(
      id,
      await mutation(c, accounts, "account.refresh-models", { id }),
    )
    return c.json({
      ...result,
      revision: await getStoreRevision(accounts.repository.storage),
    })
  })
  return routes
}

export const dashboardAccountRoutes = createDashboardAccountRoutes()
