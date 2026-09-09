/* eslint-disable require-atomic-updates -- Bun serializes this fixture's per-file lifecycle and shared initialization promise. */
import "./data-dir"

import { afterAll } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import {
  AccountsService,
  createAccountMutationContext,
  validateAccount,
  type AccountValidation,
} from "~/lib/accounts-service"
import { mergeConfigWithDefaults } from "~/lib/config"
import { hasSuppliedRequestCredential } from "~/lib/credential-resolver"
import { state } from "~/lib/state"
import { credentialDigest } from "~/lib/storage/credentials-repository"
import {
  closeStorageRuntime,
  getStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"
import {
  createHistoryRuntime,
  peekHistoryRuntime,
} from "~/lib/telemetry-writer"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"

import { integrationDataDirectory, integrationDataRoot } from "./data-dir"

export const TEST_TIMEOUT = 60_000

let initPromise: Promise<void> | null = null
let validatedAccount: AccountValidation | undefined
let databaseNumber = 0
export const INTEGRATION_GATEWAY_KEY = randomBytes(32).toString("base64url")

/** Register once in each integration test file, after its other cleanup hooks. */
// eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix -- Registers a per-file Bun lifecycle hook.
export function useIntegrationFixture(): void {
  afterAll(async () => {
    const checked = resolve(integrationDataDirectory)
    if (!checked.startsWith(`${integrationDataRoot}${sep}`))
      throw new Error("Unsafe integration fixture cleanup path")
    try {
      await initPromise?.catch(() => {})
      await peekHistoryRuntime()?.close(1000)
      await closeStorageRuntime()
      for (const account of tokenPool.getAllAccounts())
        tokenPool.deleteAccount(account.id)
      state.models = undefined
      state.githubToken = undefined
      state.copilotToken = undefined
      state.apiKeyAuth = undefined
    } finally {
      initPromise = null
      await rm(checked, { recursive: true, force: true })
    }
  })
}

export function initializeTestState(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit()
  }
  return initPromise
}

async function doInit(): Promise<void> {
  // GH_TOKEN is explicit integration-test input, never a runtime auth source.
  const githubToken = process.env.GH_TOKEN?.trim() ?? ""
  if (!githubToken) {
    throw new Error(
      "Live integration tests require an explicit GH_TOKEN. No stored credentials are read.",
    )
  }
  await mkdir(integrationDataDirectory, { recursive: true })
  const runtime = await initializeStorageRuntime({
    config: {
      kind: "sqlite",
      path: join(
        integrationDataDirectory,
        `integration-${databaseNumber++}.sqlite`,
      ),
    },
  })
  await mergeConfigWithDefaults()
  await createHistoryRuntime(runtime.storage)
  const input = {
    token: githubToken,
    instanceDomain: state.githubInstanceDomain,
    accountType: state.accountType,
    label: "Explicit live integration account",
  }
  const accounts = new AccountsService(runtime.storage, {
    pool: tokenPool,
    validate: async (candidate) => {
      if (
        !validatedAccount
        || validatedAccount.persisted.token !== candidate.token
        || validatedAccount.persisted.instanceDomain
          !== candidate.instanceDomain
        || validatedAccount.persisted.accountType !== candidate.accountType
      )
        validatedAccount = await validateAccount(candidate)
      return validatedAccount
    },
  })
  await accounts.create(
    input,
    await createAccountMutationContext(
      runtime.storage,
      "account.create",
      input,
      "test:integration",
    ),
  )
  state.isMultiToken = false
  state.models = tokenPool.getAllModels()
  await registerGatewayCredential(INTEGRATION_GATEWAY_KEY)
}

/** Persist only explicitly requested test keys; never infer keys from a request. */
export async function registerGatewayCredential(key: string): Promise<void> {
  const digest = credentialDigest(key)
  await getStorageRuntime().storage.transaction(async (session) => {
    await session.execute({
      sql: "INSERT OR IGNORE INTO capi_gateway_credentials (id,digest,label,created_at) VALUES (?,?,?,?)",
      args: [`integration:${digest}`, digest, "Integration test", Date.now()],
    })
    await session.execute({
      sql: "INSERT OR IGNORE INTO capi_gateway_secrets(credential_id,secret_value,updated_at) VALUES(?,?,?)",
      args: [`integration:${digest}`, key, Date.now()],
    })
  })
}

export async function removeGatewayCredential(key: string): Promise<void> {
  await getStorageRuntime().storage.transaction(async (session) => {
    await session.execute({
      sql: "DELETE FROM capi_gateway_credentials WHERE id = ?",
      args: [`integration:${credentialDigest(key)}`],
    })
  })
}

export async function request(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  await initializeTestState()
  const headers = new Headers(init?.headers)
  const probe = new Request(new URL(path, "http://localhost").toString(), {
    headers,
  })
  if (!hasSuppliedRequestCredential(probe))
    headers.set("authorization", `Bearer ${INTEGRATION_GATEWAY_KEY}`)
  return rawRequest(path, { ...init, headers })
}

/** Auth-boundary tests must use this helper so missing/invalid credentials stay intact. */
export async function rawRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  await initializeTestState()
  const url = new URL(path, "http://localhost")
  return server.request(url.pathname + url.search, init)
}

export async function postJSON(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

export async function collectSSEEvents(
  response: Response,
): Promise<Array<{ event?: string; data: string }>> {
  const text = await response.text()
  const events: Array<{ event?: string; data: string }> = []

  let currentEvent: string | undefined
  let currentData: Array<string> = []

  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim()
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice(6))
    } else if (line === "" && currentData.length > 0) {
      events.push({
        event: currentEvent,
        data: currentData.join("\n"),
      })
      currentEvent = undefined
      currentData = []
    }
  }

  // Handle trailing event without final newline
  if (currentData.length > 0) {
    events.push({
      event: currentEvent,
      data: currentData.join("\n"),
    })
  }

  return events
}
