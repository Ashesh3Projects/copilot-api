import * as Sentry from "@sentry/bun"
import consola from "consola"
import { randomUUID } from "node:crypto"

import { getActiveAccount } from "~/lib/account-lease-context"
import { markCopilotContractResponseMetadataAvailable } from "~/lib/copilot-contract-observability"
import {
  type CopilotRequestAttribution,
  getCopilotRequestAttribution,
  mergeCopilotRequestAttribution,
} from "~/lib/copilot-request-context"
import {
  bodyToDebugCapture,
  tapDebugResponse,
  type CapturedBody,
  DebugCaptureError,
} from "~/lib/debug-capture"
import { resolveCopilotApiBaseUrl } from "~/lib/github-instance"
import {
  abortLlmDebugLog,
  failLlmDebugLog,
  finishLlmDebugLog,
  getLlmDebugCaptureSignal,
  startLlmDebugLog,
  toLlmDebugLogError,
} from "~/lib/llm-debug-log"
import { getModelFallbackDebugInfo } from "~/lib/model-fallback"
import {
  clearCopilotResponseHeaders,
  getClientSessionId,
  getRoutingTelemetryRequestState,
  getRequestId,
  setCopilotResponseHeader,
  updateRoutingTelemetryRequestState,
} from "~/lib/request-session"
import {
  recordUpstreamCall,
  type UpstreamOutcome,
  type UpstreamSendReason,
} from "~/lib/routing-telemetry"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { deriveUpstreamSessionId } from "~/lib/upstream-session-affinity"
import {
  collectSafeCopilotResponseHeaders,
  COPILOT_API_VERSION,
  DEFAULT_COPILOT_INTEGRATION_ID,
  normalizeAccountIntegrationId,
  sanitizeCopilotHeaderValue,
} from "~/services/copilot/copilot-contract"
import { rediscoverCopilotOAuthBaseUrl } from "~/services/github/resolve-copilot-oauth"

import type { RetryBudget, RetryClaim } from "./transport-retry"

import {
  isEncryptedCompactionVerificationError,
  refreshRequestIdForRetry,
} from "./encrypted-compaction-retry"
export {
  addPromptCaching,
  detectInitiator,
  hasVisionContent,
} from "./copilot-payload-helpers"
import { createCopilotTransportInit } from "./transport-options"
import {
  abortableSleep,
  BACKOFF_FACTOR,
  BASE_DELAY_SECONDS,
  claimCompatibilityRetry,
  createRetryBudget,
  createRetryClaim,
  createTransportChain,
  handleTransportFailure,
  isAbortLikeError,
  logChainResponse,
  MAX_DELAY_SECONDS,
  MAX_ROUTED_SENDS,
} from "./transport-retry"

// --- Constants ---

export const INITIAL_RETRY_BACKOFF_EXTRA_SECONDS = 1
export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

export interface CopilotTelemetryOptions {
  accountId?: number
  destination: string
  model: string
  provider: "GitHub Copilot"
  reason: UpstreamSendReason
}

type HttpRetrySleep = (
  ms: number,
  signal: AbortSignal | null | undefined,
) => Promise<void>

let httpRetrySleep: HttpRetrySleep = abortableSleep

export function setHttpRetrySleepForTest(sleep?: HttpRetrySleep): void {
  httpRetrySleep = sleep ?? abortableSleep
}

// --- Base URL ---

export function copilotBaseUrl(): string {
  const account = getActiveAccount()
  return resolveCopilotApiBaseUrl(
    account?.githubInstanceDomain ?? state.githubInstanceDomain,
    account?.copilotApiBaseUrl ?? state.copilotApiBaseUrl,
    account?.accountType ?? state.accountType,
  )
}

// --- Headers ---

export interface CopilotHeaderOptions {
  anthropicBeta?: string
  /** Set the anthropic-version header (native /v1/messages requests). */
  anthropicVersion?: string
  attribution?: CopilotRequestAttribution
  copilotSessionToken?: string
  copilotToken?: string
  integrationId?: string | null
  initiator?: "agent" | "user"
  modelProviderPreference?: string
  vision?: boolean
}

const attributionHeaderNames: Partial<
  Record<keyof CopilotRequestAttribution, string>
> = {
  clientExperimentAssignment: "X-Copilot-Client-Exp-Assignment-Context",
  clientMachineId: "X-Client-Machine-Id",
  harnessId: "Copilot-Harness-Id",
  parentAgentId: "X-Parent-Agent-Id",
  repositoryHost: "X-GitHub-Repository-Host",
  repositoryNwo: "X-GitHub-Repository-Nwo",
  subsystemId: "Copilot-Subsystem-Id",
}

function assignSanitizedHeader(
  headers: Record<string, string>,
  options: { maxLength?: number; name: string; value: string | undefined },
): void {
  const sanitized = sanitizeCopilotHeaderValue(options.value, options.maxLength)
  if (sanitized) headers[options.name] = sanitized
}

function assignAttributionHeaders(
  headers: Record<string, string>,
  attribution: CopilotRequestAttribution,
): void {
  for (const [key, name] of Object.entries(attributionHeaderNames) as Array<
    [keyof CopilotRequestAttribution, string]
  >) {
    const value = attribution[key]
    if (value) headers[name] = value
  }
}

function assignTypedOptionHeaders(
  headers: Record<string, string>,
  options: CopilotHeaderOptions | undefined,
): void {
  assignSanitizedHeader(headers, {
    name: "Anthropic-Beta",
    value: options?.anthropicBeta,
  })
  assignSanitizedHeader(headers, {
    name: "anthropic-version",
    value: options?.anthropicVersion,
  })
  assignSanitizedHeader(headers, {
    maxLength: 16 * 1024,
    name: "Copilot-Session-Token",
    value: options?.copilotSessionToken,
  })
  assignSanitizedHeader(headers, {
    name: "X-Model-Provider-Preference",
    value: options?.modelProviderPreference,
  })
}

function resolveCopilotHeaderToken(options?: CopilotHeaderOptions): string {
  const token =
    options?.copilotToken
    ?? getActiveAccount()?.copilotToken
    ?? state.copilotToken
  if (!token) {
    throw new Error("Copilot token is not set. Cannot build request headers.")
  }
  return token
}

function resolveAccountIntegrationHeader(
  options?: CopilotHeaderOptions,
): string {
  if (options?.integrationId !== undefined)
    return (
      normalizeAccountIntegrationId(options.integrationId)
      ?? DEFAULT_COPILOT_INTEGRATION_ID
    )
  const account = getActiveAccount()
  if (account)
    return (
      normalizeAccountIntegrationId(account.integrationId)
      ?? DEFAULT_COPILOT_INTEGRATION_ID
    )
  return state.copilotIntegrationId
}

export function copilotHeaders(
  options?: CopilotHeaderOptions,
): Record<string, string> {
  const token = resolveCopilotHeaderToken(options)

  const initiator = options?.initiator ?? "user"
  const affinityKey = getClientSessionId()
  const upstreamSessionId =
    affinityKey ? deriveUpstreamSessionId(affinityKey) : state.sessionId
  const attribution = mergeCopilotRequestAttribution(
    getCopilotRequestAttribution(),
    options?.attribution,
  )
  const agentTaskId = attribution.agentTaskId ?? upstreamSessionId

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "copilot-api",
    "Copilot-Integration-Id": resolveAccountIntegrationHeader(options),
    "Copilot-Harness-Id": "copilot-sdk",
    "editor-version": `vscode/${state.vsCodeVersion ?? "1.104.3"}`,
    "Openai-Intent": attribution.openaiIntent ?? "conversation-agent",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
    "X-Initiator": initiator,
    "X-Request-Id": getRequestId() ?? randomUUID(),
    "X-Interaction-Id": upstreamSessionId,
    "X-Client-Session-Id": upstreamSessionId,
    "X-Agent-Task-Id": agentTaskId,
    "X-Interaction-Type":
      attribution.interactionType
      ?? (initiator === "user" ? "conversation-user" : "conversation-agent"),
  }

  assignAttributionHeaders(headers, attribution)

  if (options?.vision) {
    headers["Copilot-Vision-Request"] = "true"
  }

  assignTypedOptionHeaders(headers, options)

  return headers
}

// --- Quota Headers ---

export interface QuotaParams {
  [key: string]: string
}

export function parseQuotaHeaders(
  response: Response,
): Record<string, QuotaParams> | undefined {
  const quotaPrefix = "x-quota-snapshot-"
  const result: Record<string, QuotaParams> = {}
  let found = false

  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.startsWith(quotaPrefix)) {
      found = true
      const quotaType = lowerKey.slice(quotaPrefix.length)
      const params: QuotaParams = {}
      for (const part of value.split(/[;&]/)) {
        const trimmed = part.trim()
        const eqIndex = trimmed.indexOf("=")
        if (eqIndex !== -1) {
          params[trimmed.slice(0, eqIndex).trim()] = trimmed
            .slice(eqIndex + 1)
            .trim()
        }
      }
      result[quotaType] = params
    }
  }

  return found ? result : undefined
}

// --- Deterministic 400 Detection ---

/**
 * Check if a 400 response body indicates a deterministic (non-transient) error.
 * These should not be retried as they will fail the same way every time.
 */
export function isDeterministic400(body: string): boolean {
  const patterns = [
    "Invalid signature",
    "Invalid `signature`",
    "model_not_supported",
    "model is not supported",
    "messages must be non-empty",
    "invalid_request_body",
    "invalid_type",
    "invalid_value",
    "unexpected_field",
    "unknown_field",
    "not_supported",
    "unrecognized_field",
  ]
  if (patterns.some((pattern) => body.includes(pattern))) return true

  // Copilot's generic "Bad Request\n" response indicates a payload structure issue
  // (e.g. null max_tokens) that won't resolve on retry
  if (body.trim() === "Bad Request") return true

  return false
}

// --- Header Normalization ---

function toHeaderRecord(
  headersInit: RequestInit["headers"],
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!headersInit) return headers

  if (headersInit instanceof Headers) {
    for (const [key, value] of headersInit.entries()) {
      headers[key] = value
    }
    return headers
  }

  if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      headers[key] = value
    }
    return headers
  }

  for (const [key, value] of Object.entries(headersInit)) {
    if (typeof value === "string") {
      headers[key] = value
    }
  }
  return headers
}

function isLlmDebugPath(path: string): boolean {
  return (
    path === "/chat/completions"
    || path === "/responses"
    || path === "/embeddings"
    || path === "/v1/messages"
  )
}

async function captureLlmDebugResponse(
  logId: string,
  response: Response,
  captured: Promise<CapturedBody>,
): Promise<void> {
  const responseHeaders = Object.fromEntries(response.headers.entries())
  try {
    const body = await captured
    finishLlmDebugLog(logId, {
      ...body,
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    })
  } catch (error) {
    const cause = error instanceof DebugCaptureError ? error.cause : error
    const debugResponse = {
      body: null,
      bodyBytes: 0,
      bodyBytesComplete: false,
      omittedReason: "read-error" as const,
      ...(error instanceof DebugCaptureError ? error.capture : {}),
      bodyReadError: toLlmDebugLogError(cause),
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    }
    if (isAbortLikeError(cause) || isAbortLikeError(error)) {
      abortLlmDebugLog(logId, { error: cause, response: debugResponse })
      return
    }
    finishLlmDebugLog(logId, debugResponse)
  }
}

function startLlmDebugAttempt(opts: {
  accountId?: number
  headers: Record<string, string>
  path: string
  requestInit: RequestInit | undefined
  url: string
}): string | undefined {
  const { headers, path, requestInit, url } = opts
  if (!isLlmDebugPath(path)) return undefined

  const requestCapture = bodyToDebugCapture(requestInit?.body)
  return startLlmDebugLog({
    fallback: getModelFallbackDebugInfo(),
    requestCapture,
    upstream: { kind: "copilot", accountId: opts.accountId },
    method: requestInit?.method ?? "GET",
    path,
    requestBody: requestCapture.body,
    requestHeaders: headers,
    requestId: headers["X-Request-Id"] ?? headers["x-request-id"],
    url,
  })
}

function captureLlmDebugAttemptResponse(
  logId: string | undefined,
  response: Response,
  signal?: AbortSignal,
): Response {
  if (!logId) return response
  const captureSignal = getLlmDebugCaptureSignal(logId)
  const tapped = tapDebugResponse(
    response,
    signal ? AbortSignal.any([signal, captureSignal]) : captureSignal,
  )
  void captureLlmDebugResponse(logId, tapped.response, tapped.capture)
  return tapped.response
}

function failLlmDebugAttempt(logId: string | undefined, error: unknown): void {
  if (!logId) return
  if (isAbortLikeError(error)) {
    abortLlmDebugLog(logId, { error })
    return
  }
  failLlmDebugLog(logId, error)
}

function isRetryableStatus(response: Response): boolean {
  return RETRYABLE_STATUSES.has(response.status)
}

async function rediscoverSingleTokenEndpoint(): Promise<string | undefined> {
  const account = getActiveAccount()
  const githubToken = account?.githubToken ?? state.githubToken
  if (!githubToken || (!account && state.isMultiToken)) return undefined

  try {
    return await rediscoverCopilotOAuthBaseUrl({
      accountType: account?.accountType ?? state.accountType,
      currentBaseUrl: copilotBaseUrl(),
      githubToken,
      instanceDomain:
        account?.githubInstanceDomain ?? state.githubInstanceDomain,
    })
  } catch (error) {
    consola.warn("Failed to rediscover Copilot endpoint after HTTP 421", {
      errorClass: error instanceof Error ? error.name : "Unknown",
    })
    return undefined
  }
}

function outcomeForResponse(response: Response): UpstreamOutcome {
  if (response.status >= 500) return "server_error"
  if (response.status >= 400) return "client_error"
  return "success"
}

function outcomeForError(error: unknown): UpstreamOutcome {
  return isAbortLikeError(error) ? "aborted" : "transport_error"
}

function recordCopilotAttempt(options: {
  outcome: UpstreamOutcome
  reason: UpstreamSendReason
  telemetry: CopilotTelemetryOptions | undefined
}): void {
  const { outcome, reason, telemetry } = options
  if (!telemetry) return
  updateRoutingTelemetryRequestState({
    destination: telemetry.destination,
    model: telemetry.model,
    provider: telemetry.provider,
  })
  const requestState = getRoutingTelemetryRequestState()
  recordUpstreamCall({
    ...(telemetry.accountId === undefined ?
      {}
    : { accountId: telemetry.accountId }),
    model: telemetry.model,
    outcome,
    provider: telemetry.provider,
    reason,
    route:
      requestState ?
        `${requestState.sourceProtocol} -> ${telemetry.destination}`
      : telemetry.destination,
  })
}

interface CopilotAttemptTelemetryState {
  reason: UpstreamSendReason
  telemetry?: CopilotTelemetryOptions
}

function createCopilotAttemptTelemetryState(
  options:
    | {
        telemetry?: CopilotTelemetryOptions
      }
    | undefined,
): CopilotAttemptTelemetryState {
  return {
    reason: options?.telemetry?.reason ?? "initial",
    ...(options?.telemetry ? { telemetry: options.telemetry } : {}),
  }
}

async function fetchCopilotAttempt(options: {
  init: RequestInit
  telemetryState: CopilotAttemptTelemetryState
  url: string
}): Promise<Response> {
  const { init, telemetryState, url } = options
  try {
    const response = await fetch(url, init)
    recordCopilotAttempt({
      outcome: outcomeForResponse(response),
      reason: telemetryState.reason,
      telemetry: telemetryState.telemetry,
    })
    return response
  } catch (error) {
    recordCopilotAttempt({
      outcome: outcomeForError(error),
      reason: telemetryState.reason,
      telemetry: telemetryState.telemetry,
    })
    throw error
  }
}

// --- Retry Delay Calculation ---

function parseRetryAfterSeconds(
  retryAfterHeader: string | null,
): number | null {
  if (!retryAfterHeader) return null

  const parsedNumber = Number(retryAfterHeader)
  if (!Number.isNaN(parsedNumber)) {
    return Math.max(0, parsedNumber)
  }

  const parsedDate = Date.parse(retryAfterHeader)
  if (Number.isNaN(parsedDate)) {
    return null
  }

  const seconds = Math.ceil((parsedDate - Date.now()) / 1000)
  return Math.max(0, seconds)
}

function calculateHttpRetryDelay(
  retryAfterHeader: string | null,
  retryBackoffExtraSeconds: number,
): number {
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader)
  const baseDelay = retryAfterSeconds ?? BASE_DELAY_SECONDS
  return Math.min(baseDelay + retryBackoffExtraSeconds, MAX_DELAY_SECONDS)
}

function applyRetryJitter(delaySeconds: number): number {
  const jitterMultiplier = 0.8 + Math.random() * 0.4
  return Math.min(delaySeconds * jitterMultiplier, MAX_DELAY_SECONDS)
}

// --- Fetch with Retry ---

function planHttpRetryDelaySeconds(options: {
  attempt: number
  maxDelaySeconds: number
  path: string
  response: Response
  retryBackoffExtraSeconds: number
}): number {
  const { attempt, maxDelaySeconds, path, response, retryBackoffExtraSeconds } =
    options
  const rawDelaySeconds = calculateHttpRetryDelay(
    response.headers.get("retry-after"),
    retryBackoffExtraSeconds,
  )
  const jitteredDelaySeconds = applyRetryJitter(rawDelaySeconds)
  // This sleep runs before any response header is sent, so it counts directly
  // against Cloudflare's ~120-125s origin inactivity budget.
  const delaySeconds = Math.min(jitteredDelaySeconds, maxDelaySeconds)
  const clampedSeconds =
    delaySeconds < jitteredDelaySeconds ? jitteredDelaySeconds : undefined

  consola.warn(
    `HTTP ${response.status} on ${path} (attempt ${attempt + 1}), retrying in ${delaySeconds.toFixed(1)}s`,
  )
  Sentry.addBreadcrumb({
    category: "copilot",
    message: `HTTP ${response.status} on ${path} (attempt ${attempt + 1})`,
    level: "warning",
    data: {
      status: response.status,
      delay: delaySeconds,
      rawDelay: rawDelaySeconds,
      // Present only when the pre-header ceiling actually shortened the wait,
      // so an under-honoured `retry-after` is visible in production.
      ...(clampedSeconds === undefined ?
        {}
      : { clampedFromDelay: clampedSeconds }),
    },
  })

  return delaySeconds
}

function logQuotaSnapshot(response: Response): void {
  const quota = parseQuotaHeaders(response)
  if (quota) {
    consola.debug("Copilot quota snapshot:", quota)
  }
}

function recordFinalResponseHeaders(response: Response): void {
  clearCopilotResponseHeaders()
  const metadata = collectSafeCopilotResponseHeaders(response.headers)
  for (const [name, value] of Object.entries(metadata)) {
    setCopilotResponseHeader(name, value)
  }
}

type ResponseAction =
  | { kind: "rediscover-endpoint" }
  | { kind: "retry-encrypted-compaction" }
  | { delaySeconds: number; kind: "retry-status" }
  | { kind: "return" }

interface RetryResponseState {
  requestInit: RequestInit | undefined
  retryBackoffExtraSeconds: number
  telemetryReason: UpstreamSendReason
}

/** Decide what an upstream response means and whether it merits recovery. */
async function classifyResponse(options: {
  attempt: number
  claimEncryptedCompactionRetry: RetryClaim
  endpointRediscoveryAttempted: boolean
  claimRetry: RetryClaim
  maxHttpRetryDelaySeconds: number
  path: string
  requestInit: RequestInit | undefined
  response: Response
  retryBackoffExtraSeconds: number
  baseUrl?: string
}): Promise<ResponseAction> {
  const {
    attempt,
    claimEncryptedCompactionRetry,
    endpointRediscoveryAttempted,
    claimRetry,
    maxHttpRetryDelaySeconds,
    path,
    requestInit,
    response,
    retryBackoffExtraSeconds,
  } = options

  if (
    response.status === 421
    && options.baseUrl === undefined
    && !endpointRediscoveryAttempted
  ) {
    return { kind: "rediscover-endpoint" }
  }

  if (response.status === 400) {
    if (
      (await isEncryptedCompactionVerificationError(
        path,
        response,
        requestInit,
      ))
      && claimEncryptedCompactionRetry()
    ) {
      consola.warn(
        `HTTP 400 encrypted compaction verification failed on ${path}, retrying with preserved payload`,
      )
      return { kind: "retry-encrypted-compaction" }
    }
    return { kind: "return" }
  }

  if (isRetryableStatus(response) && claimRetry()) {
    return {
      delaySeconds: planHttpRetryDelaySeconds({
        attempt,
        maxDelaySeconds: maxHttpRetryDelaySeconds,
        path,
        response,
        retryBackoffExtraSeconds,
      }),
      kind: "retry-status",
    }
  }

  return { kind: "return" }
}

async function applyRetryResponseAction(options: {
  action: Exclude<ResponseAction, { kind: "return" }>
  requestInit: RequestInit | undefined
  retryBackoffExtraSeconds: number
}): Promise<RetryResponseState | undefined> {
  const { action, requestInit, retryBackoffExtraSeconds } = options

  if (action.kind === "rediscover-endpoint") {
    const baseUrl = await rediscoverSingleTokenEndpoint()
    if (!baseUrl) return undefined
    const account = getActiveAccount()
    if (account) tokenPool.publishRecoveredBaseUrl(account, baseUrl)
    else state.copilotApiBaseUrl = baseUrl
    return {
      requestInit: refreshRequestIdForRetry(requestInit),
      retryBackoffExtraSeconds,
      telemetryReason: "compatibility_retry",
    }
  }

  if (action.kind === "retry-status") {
    await httpRetrySleep(action.delaySeconds * 1000, requestInit?.signal)
    return {
      requestInit,
      retryBackoffExtraSeconds: retryBackoffExtraSeconds * BACKOFF_FACTOR,
      telemetryReason: "http_retry",
    }
  }

  return {
    requestInit: refreshRequestIdForRetry(requestInit),
    retryBackoffExtraSeconds,
    telemetryReason: "compatibility_retry",
  }
}

// Keep the retry state machine in one scope so all resends share one budget.
// eslint-disable-next-line complexity, max-lines-per-function
export async function copilotFetch(
  path: string,
  init?: RequestInit,
  fetchOptions?: {
    baseUrl?: string
    maxHttpRetryDelaySeconds?: number
    retryBudget?: RetryBudget
    telemetry?: CopilotTelemetryOptions
  },
): Promise<Response> {
  const budget = fetchOptions?.retryBudget ?? createRetryBudget()
  const maxHttpRetryDelaySeconds =
    fetchOptions?.maxHttpRetryDelaySeconds ?? MAX_DELAY_SECONDS
  // Both caps apply: the shared routed-call allowance and this invocation's
  // own limit, so one copilotFetch can never drain the whole budget.
  const claimRetry: RetryClaim = createRetryClaim(budget)
  const claimEncryptedCompactionRetry: RetryClaim = () =>
    claimCompatibilityRetry(budget)
  let endpointRediscoveryAttempted = false
  const chain = createTransportChain(path, randomUUID())
  const maxAttempts = MAX_ROUTED_SENDS
  let retryBackoffExtraSeconds = INITIAL_RETRY_BACKOFF_EXTRA_SECONDS
  let requestInit = init
  const telemetryState = createCopilotAttemptTelemetryState(fetchOptions)

  let lastError: Error | undefined
  let lastResponse: Response | undefined
  clearCopilotResponseHeaders()

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let debugLogId: string | undefined
    const attemptStartedAtMs = Date.now()
    chain.attempt = attempt
    const url = `${fetchOptions?.baseUrl ?? copilotBaseUrl()}${path}`

    try {
      const headers = toHeaderRecord(requestInit?.headers)

      debugLogId = startLlmDebugAttempt({
        headers,
        path,
        requestInit,
        url,
        accountId:
          telemetryState.telemetry?.accountId ?? getActiveAccount()?.id,
      })

      const transportInit = createCopilotTransportInit({
        ...requestInit,
        headers,
      })
      const upstreamResponse = await fetchCopilotAttempt({
        init: transportInit,
        telemetryState,
        url,
      })

      const response = captureLlmDebugAttemptResponse(
        debugLogId,
        upstreamResponse,
        requestInit?.signal ?? undefined,
      )
      // Once a new response arrived, an earlier retry response can no longer
      // be returned. Drain through its tap with bounded stream backpressure.
      if (lastResponse) {
        void lastResponse.body
          ?.pipeTo(new WritableStream<Uint8Array>({ write() {} }))
          .catch(() => undefined)
        lastResponse = undefined
      }
      logQuotaSnapshot(response)

      const action = await classifyResponse({
        attempt,
        claimEncryptedCompactionRetry,
        endpointRediscoveryAttempted,
        claimRetry,
        maxHttpRetryDelaySeconds,
        path,
        requestInit,
        response,
        retryBackoffExtraSeconds,
        baseUrl: fetchOptions?.baseUrl,
      })

      if (action.kind !== "return") {
        clearCopilotResponseHeaders()
        if (action.kind === "rediscover-endpoint") {
          endpointRediscoveryAttempted = true
        }
        const next = await applyRetryResponseAction({
          action,
          requestInit,
          retryBackoffExtraSeconds,
        })
        if (!next) {
          logChainResponse(
            chain,
            Date.now() - attemptStartedAtMs,
            response.status,
          )
          recordFinalResponseHeaders(response)
          markCopilotContractResponseMetadataAvailable()
          return response
        }
        lastResponse = response
        requestInit = next.requestInit
        retryBackoffExtraSeconds = next.retryBackoffExtraSeconds
        telemetryState.reason = next.telemetryReason
        continue
      }

      logChainResponse(chain, Date.now() - attemptStartedAtMs, response.status)
      recordFinalResponseHeaders(response)
      markCopilotContractResponseMetadataAvailable()
      return response
    } catch (error) {
      lastError = error as Error
      failLlmDebugAttempt(debugLogId, error)
      clearCopilotResponseHeaders()

      // Resolves once the backoff has elapsed; throws to end the chain.
      await handleTransportFailure({
        attemptMs: Date.now() - attemptStartedAtMs,
        chain,
        claimRetry,
        error,
        signal: requestInit?.signal,
      })
      telemetryState.reason = "transport_retry"
    }
  }

  if (lastResponse) {
    recordFinalResponseHeaders(lastResponse)
    markCopilotContractResponseMetadataAvailable()
    return lastResponse
  }

  throw lastError ?? new Error("Request failed without a captured error")
}
