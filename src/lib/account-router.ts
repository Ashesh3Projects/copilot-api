/* eslint-disable max-lines -- account selection and inference response recording share one transport boundary */
import consola from "consola"
import { AsyncLocalStorage } from "node:async_hooks"

import type { RoutedAccountPin } from "~/lib/account-routing-selection"
import type { RoutingAffinitySource } from "~/lib/routing-affinity"
import type { Account } from "~/lib/token-pool"
import type {
  CopilotHeaderOptions,
  CopilotTelemetryOptions,
} from "~/services/copilot/copilot-client"
import type { Model } from "~/services/copilot/get-models"
import type { RetryBudget } from "~/services/copilot/transport-retry"

import {
  getActiveAccount,
  getTurnAccount,
  leaseAccount,
  retainTurnAccount,
  unavailableAccount,
  withAccountLeases,
  withActiveAccount,
} from "~/lib/account-lease-context"
import {
  selectCandidateAccount,
  selectModelAccount,
} from "~/lib/account-routing-selection"
import { getAccountsService } from "~/lib/accounts-service"
import { sessionTokenMatchesAccount } from "~/lib/copilot-session-token"
import { LocalHTTPError } from "~/lib/error"
import { recordModelFallbackResponse } from "~/lib/model-fallback"
import {
  getClientSessionId,
  getLastUsedRoutedAccountId,
  setLastUsedRoutedAccountId,
  shouldSuppressRequestModelDiagnostics,
} from "~/lib/request-session"
import { getRoutingAffinity } from "~/lib/routing-affinity"
import {
  recordRoutingSelection,
  type RoutingSelectionMode,
  type UpstreamSendReason,
} from "~/lib/routing-telemetry"
import { state } from "~/lib/state"
import { getRequestSnapshot } from "~/lib/storage/request-snapshot"
import { peekStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { copilotFetch, copilotHeaders } from "~/services/copilot/copilot-client"
import {
  consumeExtraSend,
  createRetryBudget,
} from "~/services/copilot/transport-retry"

// --- Constants ---

const FAILOVER_STATUSES = new Set([429])
const pinnedRoutedAccountStorage = new AsyncLocalStorage<number | undefined>()
const selectedRoutedAccountStorage = new AsyncLocalStorage<
  RoutedAccountPin | undefined
>()

function shouldPreserveAuthRejectedAccount(response: Response): boolean {
  return response.status === 401 || response.status === 403
}

function canFailOverBetweenAccounts(
  currentAccount: Account,
  nextAccount: Account,
): boolean {
  return (
    nextAccount.githubInstanceDomain === currentAccount.githubInstanceDomain
  )
}

function routedModelDiagnostic(modelId: string): string {
  return shouldSuppressRequestModelDiagnostics() ? "omitted" : modelId
}

function routedModelDiagnosticSuffix(modelId: string): string {
  return shouldSuppressRequestModelDiagnostics() ? "" : (
      ` for model "${modelId}"`
    )
}

export type { RoutedAccountPin } from "~/lib/account-routing-selection"

export function runWithPinnedRoutedAccount<T>(
  accountId: number | undefined,
  callback: () => T,
): T {
  return pinnedRoutedAccountStorage.run(accountId, callback)
}

function createEndpointUnavailableError(): LocalHTTPError {
  const clientBody = {
    error: {
      code: "endpoint_translation_unsupported",
      message:
        "The selected Copilot account no longer advertises the chosen endpoint.",
      type: "invalid_request_error",
    },
  }
  const response = Response.json(clientBody, { status: 400 })
  return new LocalHTTPError(clientBody.error.message, response, clientBody)
}

export interface RoutedModelSelection {
  accountPin?: RoutedAccountPin
  model?: Model
}

export interface RoutedModelSelectionOptions {
  copilotSessionToken?: string
}

/**
 * Select the account before endpoint routing, then expose that account's raw
 * model row as the endpoint authority. The returned mutable pin keeps the
 * later transport dispatch coherent and follows an eligible unidentified
 * failover without retaining any session-to-account mapping.
 */
export function selectRoutedModel(
  modelId: string,
  options?: RoutedModelSelectionOptions,
): RoutedModelSelection {
  const fallbackModel = state.models?.data.find((model) => model.id === modelId)
  if (!usesPooledAccounts()) return { model: fallbackModel }

  const selection = selectRoutedAccount({
    affinityKey: getEffectiveAffinityKey(),
    copilotSessionToken: options?.copilotSessionToken,
    modelId,
    routedAccountPin: undefined,
  })
  const account = selection.account
  if (!account) return { model: fallbackModel }

  return {
    accountPin: {
      accountId: account.id,
      eligibleAccountIds: selection.eligibleAccountIds,
      selectionMode: selection.selectionMode,
    },
    model: tokenPool.getModelForAccount(modelId, account.id) ?? fallbackModel,
  }
}

export function runWithRoutedModelSelection<T>(
  selection: RoutedModelSelection,
  callback: () => T,
): T {
  return selectedRoutedAccountStorage.run(selection.accountPin, callback)
}

interface AccountFetchOptions {
  account: Account
  enforceEndpointAuthority?: boolean
  headerOptions: CopilotHeaderOptions | undefined
  init: RequestInit | undefined
  path: string
  maxHttpRetryDelaySeconds: number | undefined
  modelId: string
  requireSessionTokenContinuity?: boolean
  retryBudget: RetryBudget
  reason: UpstreamSendReason
}

interface RoutedFetchContext {
  affinityKey?: string
  enforceEndpointAuthority: boolean
  headerOptions: CopilotHeaderOptions | undefined
  init: RequestInit | undefined
  modelId: string
  maxHttpRetryDelaySeconds: number | undefined
  path: string
  reason: UpstreamSendReason
  recordSelection: boolean
  sessionTokenPinsAccount: boolean
  retryBudget: RetryBudget
}

function getEffectiveAffinityKey(): string | undefined {
  return getRoutingAffinity()?.key ?? getClientSessionId()
}

function selectRoutedAccount(options: {
  affinityKey: string | undefined
  copilotSessionToken?: string
  modelId: string
  routedAccountPin: RoutedAccountPin | undefined
}) {
  return selectModelAccount({
    ...options,
    pinnedAccountId: pinnedRoutedAccountStorage.getStore(),
    selectedAccountPin: selectedRoutedAccountStorage.getStore(),
  })
}

type RoutedFetchResult = {
  account: Account | undefined
  response: Response
}

function destinationForPath(path: string): string {
  switch (path) {
    case "/responses": {
      return "Responses"
    }
    case "/chat/completions": {
      return "Chat Completions"
    }
    case "/embeddings": {
      return "Embeddings"
    }
    case "/v1/messages": {
      return "Anthropic Messages"
    }
    default: {
      return path
    }
  }
}

function copilotTelemetry(options: {
  accountId?: number
  model: string
  path: string
  reason: UpstreamSendReason
}): CopilotTelemetryOptions {
  return {
    ...(options.accountId === undefined ?
      {}
    : { accountId: options.accountId }),
    destination: destinationForPath(options.path),
    model: options.model,
    provider: "GitHub Copilot",
    reason: options.reason,
  }
}

function recordSelection(options: {
  accountId: number
  affinitySource?: RoutingAffinitySource
  eligibleAccountIds: ReadonlyArray<number>
  mode: RoutingSelectionMode
  model: string
}): void {
  recordRoutingSelection(options)
}

function mergeHeaders(
  baseHeaders: Record<string, string>,
  overrideHeaders: RequestInit["headers"],
): Record<string, string> {
  const merged = { ...baseHeaders }
  if (!overrideHeaders) {
    return merged
  }

  const overrides = new Headers(overrideHeaders)
  for (const [key, value] of overrides.entries()) {
    merged[key] = value
  }

  return merged
}

function withoutCopilotSessionToken(
  headerOptions: CopilotHeaderOptions | undefined,
): CopilotHeaderOptions | undefined {
  if (!headerOptions?.copilotSessionToken) return headerOptions
  const { copilotSessionToken: _ignored, ...rest } = headerOptions
  return rest
}

function createSessionAccountContinuityError(): LocalHTTPError {
  const clientBody = {
    error: {
      code: "session_account_continuity_error",
      message: "The Copilot session token does not match the selected account.",
      type: "session_affinity_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 409 }),
    clientBody,
  )
}

function bindSessionTokenToAccount(options: {
  accountSubject?: string
  accountToken: string | undefined
  headerOptions: CopilotHeaderOptions | undefined
  requireContinuity?: boolean
}): {
  headerOptions: CopilotHeaderOptions | undefined
  sessionTokenPinsAccount: boolean
} {
  const sessionToken = options.headerOptions?.copilotSessionToken
  if (!sessionToken) {
    return {
      headerOptions: options.headerOptions,
      sessionTokenPinsAccount: false,
    }
  }
  const matches = sessionTokenMatchesAccount({
    accountSubject: options.accountSubject,
    accountToken: options.accountToken,
    sessionToken,
  })
  if (!matches && options.requireContinuity) {
    throw createSessionAccountContinuityError()
  }
  return {
    headerOptions:
      matches ?
        options.headerOptions
      : withoutCopilotSessionToken(options.headerOptions),
    sessionTokenPinsAccount: matches,
  }
}

function createNoEnabledAccountResponse(modelId: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `No enabled account is available for model "${modelId}"`,
        type: "model_routing_error",
      },
    }),
    {
      status: 403,
      headers: { "content-type": "application/json" },
    },
  )
}

async function fetchWithAccount(
  requested: AccountFetchOptions,
): Promise<Response> {
  const options = { ...requested, account: leaseAccount(requested.account) }
  const {
    account,
    headerOptions,
    init,
    maxHttpRetryDelaySeconds,
    path,
    reason,
    retryBudget,
  } = options
  if (
    options.enforceEndpointAuthority
    && !tokenPool.accountAdvertisesModelEndpoint(account, options.modelId, path)
  ) {
    throw createEndpointUnavailableError()
  }
  const boundHeaderOptions = bindSessionTokenToAccount({
    accountSubject: account.copilotAccountSubject,
    accountToken: account.copilotToken,
    headerOptions,
    requireContinuity: options.requireSessionTokenContinuity,
  }).headerOptions
  const headers = copilotHeaders({
    ...boundHeaderOptions,
    copilotToken: account.copilotToken,
  })
  const baseUrl = tokenPool.getBaseUrl(account)

  return await copilotFetch(
    path,
    { ...init, headers },
    {
      baseUrl,
      maxHttpRetryDelaySeconds,
      retryBudget,
      telemetry: copilotTelemetry({
        accountId: account.id,
        model: options.modelId,
        path,
        reason,
      }),
    },
  )
}

async function recoverMisdirectedAccount(
  requested: AccountFetchOptions,
  originalResponse: Response,
): Promise<Response> {
  const options = { ...requested, account: leaseAccount(requested.account) }
  const { account, path, retryBudget } = options
  if (retryBudget.remaining <= 0) {
    consola.warn(
      `[Account #${account.id}] Send budget exhausted after HTTP 421 on ${path}; returning the original response`,
    )
    return originalResponse
  }

  consola.warn(
    `[Account #${account.id}] HTTP 421 on ${path}, rediscovering the Copilot endpoint`,
  )

  try {
    await tokenPool.reinitializeAccount(account, state.showToken)
  } catch {
    consola.warn(
      `[Account #${account.id}] Copilot endpoint rediscovery failed after HTTP 421; returning the original response`,
    )
    return originalResponse
  }

  if (
    options.enforceEndpointAuthority
    && !tokenPool.accountAdvertisesModelEndpoint(
      account,
      options.modelId,
      options.path,
    )
  ) {
    throw createEndpointUnavailableError()
  }

  if (!consumeExtraSend(retryBudget)) {
    consola.warn(
      `[Account #${account.id}] Send budget exhausted after HTTP 421 on ${path}; returning the original response`,
    )
    return originalResponse
  }

  return await fetchWithAccount({ ...options, reason: "http_retry" })
}

function createSessionAccountRejectedError(account: Account): LocalHTTPError {
  const message =
    "The bound account rejected this conversation; affinity was preserved and no cross-account retry was attempted."
  const clientBody = {
    error: {
      account_id: account.id,
      code: "session_account_rejected",
      message,
      type: "session_affinity_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 409 }),
    clientBody,
  )
}

async function fetchWithFallbackAccount(
  context: RoutedFetchContext,
): Promise<RoutedFetchResult> {
  const { headerOptions, init, maxHttpRetryDelaySeconds, path, retryBudget } =
    context
  const account = tokenPool.getFirstHealthyAccount()
  if (account) {
    const binding = bindSessionTokenToAccount({
      accountSubject: account.copilotAccountSubject,
      accountToken: account.copilotToken,
      headerOptions,
    })
    consola.warn(
      `Using Account #${account.id} as fallback${routedModelDiagnosticSuffix(context.modelId)}`,
    )
    setLastUsedRoutedAccountId(account.id)
    if (context.recordSelection) {
      recordSelection({
        accountId: account.id,
        eligibleAccountIds: tokenPool.getHealthyAccountIds(),
        mode: getEffectiveAffinityKey() ? "sticky" : "default",
        affinitySource: getRoutingAffinity()?.source,
        model: context.modelId,
      })
    }
    return await fetchWithRoutedAccount(
      { ...context, ...binding, enforceEndpointAuthority: false },
      account,
      context.reason,
    )
  }

  if (peekStorageRuntime()) throw unavailableAccount()
  const fallbackHeaderOptions = bindSessionTokenToAccount({
    accountToken: state.copilotToken,
    headerOptions,
  }).headerOptions
  const fallbackHeaders =
    state.copilotToken ?
      mergeHeaders(copilotHeaders(fallbackHeaderOptions), init?.headers)
    : init?.headers

  const response = await copilotFetch(
    path,
    {
      ...init,
      ...(fallbackHeaders ? { headers: fallbackHeaders } : {}),
    },
    {
      maxHttpRetryDelaySeconds,
      retryBudget,
      telemetry: copilotTelemetry({
        model: context.modelId,
        path,
        reason: context.reason,
      }),
    },
  )
  return { response, account: undefined }
}

async function failoverToAccount(
  context: RoutedFetchContext,
  currentAccount: Account,
  failedResponse: Response,
): Promise<RoutedFetchResult | undefined> {
  const {
    headerOptions,
    init,
    modelId,
    maxHttpRetryDelaySeconds,
    path,
    retryBudget,
  } = context
  const next = tokenPool
    .getEligibleAccountsForModel(modelId)
    .find(
      (account) =>
        account.id !== currentAccount.id
        && canFailOverBetweenAccounts(currentAccount, account)
        && tokenPool.accountAdvertisesModelEndpoint(account, modelId, path),
    )
  if (!next) {
    return undefined
  }

  consola.warn(
    `[Account #${currentAccount.id}] HTTP ${failedResponse.status} on ${path}, failing over to Account #${next.id}`,
  )
  // Failing over issues another upstream send, so it draws on the same budget.
  if (!consumeExtraSend(retryBudget)) {
    consola.warn(
      `[Account #${currentAccount.id}] Send budget exhausted on ${path}, not failing over`,
    )
    return undefined
  }

  setLastUsedRoutedAccountId(next.id)

  const response = await fetchWithAccount({
    account: next,
    enforceEndpointAuthority: context.enforceEndpointAuthority,
    headerOptions,
    init,
    maxHttpRetryDelaySeconds,
    modelId,
    path,
    reason: "failover",
    retryBudget,
  })
  return { response, account: next }
}

async function fetchWithRoutedAccount(
  context: RoutedFetchContext,
  account: Account,
  reason: UpstreamSendReason = "initial",
): Promise<RoutedFetchResult> {
  const { headerOptions, init, maxHttpRetryDelaySeconds, path, retryBudget } =
    context

  const accountOptions: AccountFetchOptions = {
    account,
    enforceEndpointAuthority: context.enforceEndpointAuthority,
    headerOptions,
    init,
    maxHttpRetryDelaySeconds,
    modelId: context.modelId,
    path,
    reason,
    retryBudget,
  }
  let response = await fetchWithAccount(accountOptions)
  if (response.status === 421) {
    response = await recoverMisdirectedAccount(accountOptions, response)
    if (
      context.affinityKey
      && (response.status === 401 || response.status === 403)
    ) {
      throw createSessionAccountRejectedError(account)
    }
    return { response, account }
  }
  if (
    context.affinityKey
    && (response.status === 401 || response.status === 403)
  ) {
    throw createSessionAccountRejectedError(account)
  }
  if (context.affinityKey) {
    return { response, account }
  }
  if (context.sessionTokenPinsAccount) {
    return { response, account }
  }

  if (shouldPreserveAuthRejectedAccount(response)) {
    return { response, account }
  }

  if (!FAILOVER_STATUSES.has(response.status)) {
    return { response, account }
  }

  return (
    (await failoverToAccount(context, account, response)) ?? {
      response,
      account,
    }
  )
}

// --- Last used account tracking ---

/**
 * Get the account ID used by the most recent routedFetch call.
 * Useful for logging without changing service return types.
 */
export function getLastUsedAccountId(): number | undefined {
  return getLastUsedRoutedAccountId()
}

// --- Fetch routing with failover ---

export interface RoutedFetchOptions {
  modelId: string
  headerOptions?: CopilotHeaderOptions
  maxHttpRetryDelaySeconds?: number
  reason?: UpstreamSendReason
  recordSelection?: boolean
  routedAccountPin?: RoutedAccountPin
  retryBudget?: RetryBudget
}

export interface RoutedControlPlaneFetchOptions {
  body?: Record<string, unknown>
  copilotSessionToken?: string
  modelId?: string
  path: string
  signal?: AbortSignal
}

export interface RoutedControlPlaneFetchResult {
  account: Account | undefined
  localError?: LocalHTTPError
  response: Response
}

async function singleTokenRoutedFetch(options: {
  context: RoutedFetchContext
  modelId: string
  shouldRecordSelection: boolean
}): Promise<RoutedFetchResult> {
  const { context, modelId, shouldRecordSelection } = options
  const account = getActiveAccount()
  if (account) setLastUsedRoutedAccountId(account.id)
  if (shouldRecordSelection) {
    recordRoutingSelection({
      ...(account ? { accountId: account.id } : {}),
      eligibleAccountIds: account ? [account.id] : [],
      mode: "single",
      model: modelId,
    })
  }
  const response = await copilotFetch(
    context.path,
    { ...context.init, headers: copilotHeaders(context.headerOptions) },
    {
      maxHttpRetryDelaySeconds: context.maxHttpRetryDelaySeconds,
      retryBudget: context.retryBudget,
      telemetry: copilotTelemetry({
        accountId: account?.id,
        model: modelId,
        path: context.path,
        reason: context.reason,
      }),
    },
  )
  return { response, account }
}

function createNoControlPlaneAccountResult(): RoutedControlPlaneFetchResult {
  const clientBody = {
    error: {
      code: "account_unavailable",
      message: "No healthy Copilot account is available for this request.",
      type: "account_unavailable",
    },
  }
  const response = Response.json(clientBody, { status: 503 })
  return {
    account: undefined,
    localError: new LocalHTTPError(
      clientBody.error.message,
      response,
      clientBody,
    ),
    response,
  }
}

function controlPlaneRequestInit(
  options: RoutedControlPlaneFetchOptions,
  headers: Record<string, string>,
): RequestInit {
  return {
    method: "POST",
    headers,
    ...(options.body === undefined ?
      {}
    : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  }
}

/**
 * Perform one account-aware Copilot control-plane call.
 *
 * Selection is deterministic for identified sessions and remains read-only:
 * no session token or affinity mapping is retained. Policy calls select from
 * raw model catalog membership, while session/Auto/intent calls select from
 * all healthy accounts. A selected account is never replaced by failover.
 */
export async function routedControlPlaneFetch(
  options: RoutedControlPlaneFetchOptions,
): Promise<RoutedControlPlaneFetchResult> {
  if (peekStorageRuntime()) {
    if (!getRequestSnapshot()) await getAccountsService().refreshRuntime()
    return await withAccountLeases(options.signal, () =>
      routedControlPlaneFetchInner(options),
    )
  }
  return await routedControlPlaneFetchInner(options)
}

// eslint-disable-next-line max-lines-per-function -- Preserve the single-account and pooled control-plane continuity branches together.
async function routedControlPlaneFetchInner(
  options: RoutedControlPlaneFetchOptions,
): Promise<RoutedControlPlaneFetchResult> {
  const affinityKey = getEffectiveAffinityKey()
  const retryBudget = createRetryBudget()
  const telemetryModel = options.modelId ?? "control-plane"
  setLastUsedRoutedAccountId(undefined)

  if (!usesPooledAccounts()) {
    if (peekStorageRuntime()) {
      const selected = tokenPool.getFirstHealthyAccount()
      if (!selected) return createNoControlPlaneAccountResult()
      const account = leaseAccount(selected)
      setLastUsedRoutedAccountId(account.id)
      return await withActiveAccount(account, async () => {
        const response = await copilotFetch(
          options.path,
          controlPlaneRequestInit(
            options,
            copilotHeaders({
              copilotSessionToken: options.copilotSessionToken,
            }),
          ),
          {
            retryBudget,
            telemetry: copilotTelemetry({
              accountId: account.id,
              model: telemetryModel,
              path: options.path,
              reason: "initial",
            }),
          },
        )
        return { response, account }
      })
    }
    const response = await copilotFetch(
      options.path,
      controlPlaneRequestInit(
        options,
        copilotHeaders({
          copilotSessionToken: options.copilotSessionToken,
        }),
      ),
      {
        retryBudget,
        telemetry: copilotTelemetry({
          model: telemetryModel,
          path: options.path,
          reason: "initial",
        }),
      },
    )
    return { response, account: undefined }
  }

  const candidates = tokenPool
    .getAllAccounts()
    .filter(
      (account) =>
        account.healthy
        && account.enabled !== false
        && !account.deleting
        && (options.modelId === undefined
          || account.models.has(options.modelId)),
    )
  const account = selectCandidateAccount({
    affinityKey,
    candidates,
    copilotSessionToken: options.copilotSessionToken,
  }).account
  if (!account) {
    return createNoControlPlaneAccountResult()
  }

  setLastUsedRoutedAccountId(account.id)
  const accountOptions: AccountFetchOptions = {
    account,
    enforceEndpointAuthority: false,
    headerOptions: {
      copilotSessionToken: options.copilotSessionToken,
    },
    init: controlPlaneRequestInit(options, {}),
    maxHttpRetryDelaySeconds: undefined,
    modelId: telemetryModel,
    path: options.path,
    reason: "initial",
    requireSessionTokenContinuity: Boolean(options.copilotSessionToken),
    retryBudget,
  }
  let response: Response
  try {
    response = await fetchWithAccount(accountOptions)
    if (response.status === 421) {
      response = await recoverMisdirectedAccount(accountOptions, response)
    }
  } catch (error) {
    if (error instanceof LocalHTTPError) {
      return { account, localError: error, response: error.response }
    }
    throw error
  }

  return { response, account }
}

/**
 * Perform a fetch with account-aware routing and single-attempt failover.
 *
 * In single-token mode, builds headers from headerOptions and delegates
 * to `copilotFetch`.
 * In multi-token mode, selects an account for the requested model and builds
 * headers with that account's token. A 421 rediscovery retry stays on that
 * account. Authentication rejections never cross identities; unidentified 429
 * responses may fail over once within the same GitHub instance. Identified
 * conversations never move away from their hash-selected account.
 *
 * Transport failures are NOT failed over. `copilotFetch` retries them in
 * place; every account resolves to the same Copilot host, so switching
 * accounts reuses the same connection pool and only duplicates the send.
 *
 * Callers should NOT pre-build headers — this function handles header
 * construction in all modes to avoid double-advancing the round-robin.
 */
// Keep selection, failover, and the shared logical-call budget together.

export async function routedFetch(
  path: string,
  init: RequestInit | undefined,
  options: RoutedFetchOptions,
): Promise<{ response: Response; account: Account | undefined }> {
  if (peekStorageRuntime() && !getRequestSnapshot())
    await getAccountsService().refreshRuntime()
  const result = await withAccountLeases(init?.signal, async () => {
    const single =
      getTurnAccount(options.modelId)?.single ?? !usesPooledAccounts()
    const result = await routedFetchInner(path, init, options)
    if (result.account)
      retainTurnAccount(options.modelId, result.account, single)
    return result
  })
  if (
    path === "/chat/completions"
    || path === "/responses"
    || path === "/v1/messages"
  ) {
    recordModelFallbackResponse(result.response)
  }
  return result
}

// eslint-disable-next-line complexity, max-lines-per-function -- Keep single-account compatibility, pooled selection, and retry attribution in one transport decision.
async function routedFetchInner(
  path: string,
  init: RequestInit | undefined,
  options: RoutedFetchOptions,
): Promise<{ response: Response; account: Account | undefined }> {
  const {
    modelId,
    headerOptions,
    maxHttpRetryDelaySeconds,
    reason = "initial",
    recordSelection: shouldRecordSelection = true,
    routedAccountPin,
    retryBudget = createRetryBudget(),
  } = options
  const asyncPinnedAccountId = pinnedRoutedAccountStorage.getStore()
  const selectedAccountPin = selectedRoutedAccountStorage.getStore()
  const context: RoutedFetchContext = {
    affinityKey:
      (
        routedAccountPin?.accountId !== undefined
        || asyncPinnedAccountId !== undefined
      ) ?
        `pinned-account:${routedAccountPin?.accountId ?? asyncPinnedAccountId}`
      : getEffectiveAffinityKey(),
    enforceEndpointAuthority: true,
    headerOptions,
    init,
    modelId,
    maxHttpRetryDelaySeconds,
    path,
    reason,
    recordSelection: shouldRecordSelection,
    sessionTokenPinsAccount: false,
    retryBudget,
  }
  const continuation = getTurnAccount(modelId)
  if (continuation) {
    const pin =
      routedAccountPin?.accountId
      ?? asyncPinnedAccountId
      ?? selectedAccountPin?.accountId
    if (pin !== undefined && pin !== continuation.account.id)
      throw unavailableAccount()
    setLastUsedRoutedAccountId(continuation.account.id)
    if (continuation.single)
      return withActiveAccount(continuation.account, () =>
        singleTokenRoutedFetch({ context, modelId, shouldRecordSelection }),
      )
    const binding = bindSessionTokenToAccount({
      accountSubject: continuation.account.copilotAccountSubject,
      accountToken: continuation.account.copilotToken,
      headerOptions: context.headerOptions,
    })
    return fetchWithRoutedAccount(
      { ...context, ...binding, sessionTokenPinsAccount: true },
      continuation.account,
      reason,
    )
  }
  setLastUsedRoutedAccountId(undefined)

  if (!usesPooledAccounts()) {
    if (peekStorageRuntime()) {
      const account = tokenPool.getFirstHealthyAccount()
      if (!account) throw unavailableAccount()
      const pinnedId =
        routedAccountPin?.accountId
        ?? asyncPinnedAccountId
        ?? selectedAccountPin?.accountId
      if (pinnedId !== undefined && account.id !== pinnedId)
        throw unavailableAccount()
      const snapshot = leaseAccount(account)
      return await withActiveAccount(snapshot, async () => {
        const result = await singleTokenRoutedFetch({
          context,
          modelId,
          shouldRecordSelection,
        })
        return { ...result, account: snapshot }
      })
    }
    return await singleTokenRoutedFetch({
      context,
      modelId,
      shouldRecordSelection,
    })
  }

  const affinityKey = getEffectiveAffinityKey()
  const selection = selectRoutedAccount({
    affinityKey,
    copilotSessionToken: headerOptions?.copilotSessionToken,
    modelId,
    routedAccountPin,
  })
  const account = selection.account
  const mutableAccountPin = routedAccountPin ?? selectedAccountPin
  if (mutableAccountPin && account) {
    mutableAccountPin.accountId = account.id
    mutableAccountPin.eligibleAccountIds = [...selection.eligibleAccountIds]
    mutableAccountPin.selectionMode = selection.selectionMode
  }
  if (!account) {
    if (tokenPool.hasKnownModel(modelId)) {
      const response = createNoEnabledAccountResponse(modelId)
      return { response, account: undefined }
    }

    consola.warn(
      `No account found${routedModelDiagnosticSuffix(modelId)}, falling back to default`,
    )

    return await fetchWithFallbackAccount(context)
  }

  const binding = bindSessionTokenToAccount({
    accountSubject: account.copilotAccountSubject,
    accountToken: account.copilotToken,
    headerOptions: context.headerOptions,
  })
  const boundContext = { ...context, ...binding }

  consola.debug(
    `[Account #${account.id}] ${path} (model: ${routedModelDiagnostic(modelId)}, session: ${affinityKey ? "sticky" : "default"})`,
  )
  setLastUsedRoutedAccountId(account.id)
  if (shouldRecordSelection) {
    recordSelection({
      accountId: account.id,
      affinitySource: getRoutingAffinity()?.source,
      eligibleAccountIds: selection.eligibleAccountIds,
      mode: selection.selectionMode,
      model: modelId,
    })
  }

  const result = await fetchWithRoutedAccount(boundContext, account, reason)
  if (mutableAccountPin && result.account) {
    mutableAccountPin.accountId = result.account.id
  }
  // A hosted follow-up may create a fresh local pin; preserve initial failover
  // in the enclosing model selection as well, rather than its stale first pick.
  if (selectedAccountPin && result.account)
    selectedAccountPin.accountId = result.account.id
  return result
}

function usesPooledAccounts(): boolean {
  return (
    state.isMultiToken
    || (peekStorageRuntime() !== undefined
      && tokenPool.getAllAccounts().length > 1)
  )
}
