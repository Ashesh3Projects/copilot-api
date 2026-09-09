import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

import { extractRequestCredential } from "~/lib/credential-resolver"
import { isHTTPError } from "~/lib/error"
import {
  getModelFallbackConfig,
  getModelFallbackConfigRevision,
  getCapturedModelFallbackConfigRevision,
  getLoadedModelFallbackConfig,
  type ModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { getModelFallbackIdentity } from "~/lib/model-fallback-identity"
import {
  captureForeignThinking,
  filterForeignThinking,
  hasRetainedAssistantContent,
  mergeForeignThinking,
  type ForeignThinkingState,
} from "~/lib/model-fallback-thinking"
import {
  getLoadedModelRedirects,
  getModelRedirectRevision,
  type ModelRedirectRequest,
  type ModelRedirectResult,
  type ModelRedirectRule,
} from "~/lib/model-redirect"
import { resolveModelRedirectRules } from "~/lib/model-redirect-resolver"
import { getModelRoutingSafety } from "~/lib/model-routing-safety"
import {
  normalizeReasoningEffortForModel,
  type ReasoningEffort,
} from "~/lib/model-suffix"
import { setCopilotResponseHeader } from "~/lib/request-session"
import {
  normalizeRoutingAffinityKey,
  parseRoutingMetadataRecord,
} from "~/lib/routing-affinity"

export interface ModelFallbackRequestOptions {
  headers?: Headers
  payload?: unknown
  signal?: AbortSignal
  conversationKey?: string
  credentialScope?: string
  canRetry?: () => boolean
}

interface FallbackEntry {
  targetModel: string
  route: Array<{ source: string; target: string; resolved: string }>
  requestSequence: number
  expiresAt: number
  foreignThinking: ForeignThinkingState
}

interface FallbackAttempt {
  config: ModelFallbackConfig
  configRevision: number
  redirectRevision: number
  redirects: Array<ModelRedirectRule>
  routingRequest?: ModelRedirectRequest
  targetRedirect?: ModelRedirectResult
  route: FallbackEntry["route"]
  cacheEpoch: number
  requestSequence: number
  key?: string
  sourceModel?: string
  targetModel?: string
  retry: boolean
  cached: boolean
  firstResponse?: Response
  accepted: boolean
  foreignThinking: ForeignThinkingState
  incomingThinking: ForeignThinkingState
  hops: number
  visitedModels: Set<string>
}

export const MAX_MODEL_FALLBACK_HOPS = 3

const attemptStorage = new AsyncLocalStorage<FallbackAttempt>()
const conversationFallbacks = new Map<string, FallbackEntry>()
let cacheRevision = -1
let cacheRedirectRevision = -1
let cacheEpoch = 0
let nextRequestSequence = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createModelFallbackCredentialScope(
  source: Headers | Request,
): string {
  const request =
    source instanceof Request ? source : (
      new Request("http://localhost/", { headers: source })
    )
  return createHash("sha256")
    .update(JSON.stringify(extractRequestCredential(request)))
    .digest("hex")
}

function firstIdentity(values: Array<unknown>): string | undefined {
  for (const value of values) {
    const normalized = normalizeRoutingAffinityKey(value)
    if (normalized) return normalized
  }
  return undefined
}

function getConversationIdentity(
  options: ModelFallbackRequestOptions,
): string | undefined {
  const payload = isRecord(options.payload) ? options.payload : {}
  const client = parseRoutingMetadataRecord(payload.client_metadata) ?? {}
  const metadata = parseRoutingMetadataRecord(payload.metadata) ?? {}
  const claude = parseRoutingMetadataRecord(metadata.user_id) ?? {}
  const headers = options.headers
  // A Codex child may share its parent's session and account affinity. Only
  // the actual child thread identifies this fallback conversation.
  return firstIdentity([
    client.thread_id,
    payload.thread_id,
    payload.threadId,
    headers?.get("thread-id"),
    headers?.get("x-thread-id"),
    metadata.thread_id,
    metadata.threadId,
    headers?.get("x-claude-code-session-id"),
    headers?.get("x-client-session-id"),
    headers?.get("session-id"),
    client.session_id,
    claude.session_id,
    payload.conversation_id,
    payload.conversationId,
    payload.session_id,
    payload.sessionId,
    metadata.conversation_id,
    metadata.conversationId,
    metadata.session_id,
    metadata.sessionId,
    typeof metadata.user_id === "string" ?
      metadata.user_id.match(/_session_(.+)$/u)?.[1]
    : undefined,
    options.conversationKey,
  ])
}

function refreshCache(): void {
  const revision = getModelFallbackConfigRevision()
  const redirectRevision = getModelRedirectRevision(true)
  if (
    revision !== cacheRevision
    || redirectRevision !== cacheRedirectRevision
  ) {
    conversationFallbacks.clear()
    cacheRevision = revision
    cacheRedirectRevision = redirectRevision
  }
  const now = Date.now()
  for (const [key, entry] of conversationFallbacks) {
    if (entry.expiresAt <= now) conversationFallbacks.delete(key)
  }
}

export function getModelFallbackCacheStats(): { entries: number } {
  refreshCache()
  return { entries: conversationFallbacks.size }
}

export function clearModelFallbackCache(): number {
  const entries = conversationFallbacks.size
  conversationFallbacks.clear()
  cacheEpoch++
  return entries
}

function cacheKey(attempt: FallbackAttempt): string | undefined {
  return attempt.key && attempt.sourceModel ?
      JSON.stringify([attempt.key, attempt.sourceModel])
    : undefined
}

function recordNotice(attempt: FallbackAttempt): void {
  if (
    (!attempt.retry && !attempt.cached)
    || !attempt.sourceModel
    || !attempt.targetModel
  )
    return
  if (attempt.config.nativeClientNotice) {
    setCopilotResponseHeader("openai-model", attempt.targetModel)
  }
  if (!attempt.config.notifyClient) return
  setCopilotResponseHeader("x-copilot-api-fallback-from", attempt.sourceModel)
  setCopilotResponseHeader("x-copilot-api-fallback-to", attempt.targetModel)
  setCopilotResponseHeader("x-copilot-api-fallback-reason", "http_422")
  setCopilotResponseHeader(
    "x-copilot-api-fallback-cached",
    String(attempt.cached),
  )
}

export function getModelFallbackNotice():
  | {
      sourceModel: string
      targetModel: string
      cached: boolean
      nativeClientNotice: boolean
    }
  | undefined {
  const attempt = attemptStorage.getStore()
  return noticeForAttempt(attempt)
}

export interface ModelFallbackDebugInfo {
  reason: "http_422"
  sourceModel: string
  fromModel: string
  configuredTargetModel: string
  targetModel: string
  cached: boolean
  hop: number
}

/** Captured before dispatch, including pending and failed fallback attempts. */
export function getModelFallbackDebugInfo():
  | ModelFallbackDebugInfo
  | undefined {
  const attempt = attemptStorage.getStore()
  const hop = attempt?.route.at(-1)
  if (
    !attempt
    || (!attempt.retry && !attempt.cached)
    || !attempt.sourceModel
    || !attempt.targetModel
    || !hop
  )
    return undefined
  return {
    reason: "http_422",
    sourceModel: attempt.sourceModel,
    fromModel: hop.source,
    configuredTargetModel: hop.target,
    targetModel: attempt.targetModel,
    cached: attempt.cached,
    hop: attempt.route.length,
  }
}

export function captureModelFallbackNotice(): () => ReturnType<
  typeof getModelFallbackNotice
> {
  const attempt = attemptStorage.getStore()
  return () => noticeForAttempt(attempt)
}

function noticeForAttempt(
  attempt: FallbackAttempt | undefined,
): ReturnType<typeof getModelFallbackNotice> {
  if (
    !attempt?.accepted
    || (!attempt.retry && !attempt.cached)
    || !attempt.sourceModel
    || !attempt.targetModel
  )
    return undefined
  return {
    sourceModel: attempt.sourceModel,
    targetModel: attempt.targetModel,
    cached: attempt.cached,
    nativeClientNotice: attempt.config.nativeClientNotice,
  }
}

export function applyModelFallbackTransition(payload: unknown): void {
  const attempt = attemptStorage.getStore()
  if (attempt) captureForeignThinking(payload, attempt.incomingThinking)
  if (attempt?.retry) {
    captureForeignThinking(payload, attempt.foreignThinking)
    stripModelTransitionThinking(payload)
  } else if (attempt?.cached)
    filterForeignThinking(payload, attempt.foreignThinking)
}

/** Called only with actual inference HTTP responses, never local errors. */
export function recordModelFallbackResponse(response: Response): void {
  const attempt = attemptStorage.getStore()
  if (!attempt || attempt.accepted) return
  const currentModel = activeModel(attempt)
  if (currentModel)
    attempt.visitedModels.add(getModelFallbackIdentity(currentModel))
  attempt.firstResponse = response
  attempt.accepted = response.ok
  if (!response.ok || !attempt.targetModel) return
  recordNotice(attempt)
  rememberAcceptedFallback(attempt)
}

function rememberAcceptedFallback(attempt: FallbackAttempt): void {
  if (
    !attempt.targetModel
    || !attempt.retry
    || !attempt.config.conversationAffinity
    || !attemptConfigurationIsCurrent(attempt)
    || attempt.cacheEpoch !== cacheEpoch
  )
    return
  const key = cacheKey(attempt)
  if (!key) return
  refreshCache()
  const previous = conversationFallbacks.get(key)
  // A slower earlier request must not roll a conversation back to a model
  // superseded by a later request, or replace its known foreign history.
  if (isSupersededFallback(previous, attempt)) return
  if (!attempt.foreignThinking.complete) {
    conversationFallbacks.delete(key)
    return
  }
  const foreignThinking =
    previous?.targetModel === attempt.targetModel ?
      mergeForeignThinking(previous.foreignThinking, attempt.foreignThinking)
    : attempt.foreignThinking
  conversationFallbacks.delete(key)
  if (!foreignThinking.complete) return
  conversationFallbacks.set(key, {
    targetModel: attempt.targetModel,
    route: attempt.route,
    requestSequence: Math.max(
      previous?.requestSequence ?? 0,
      attempt.requestSequence,
    ),
    expiresAt: Date.now() + attempt.config.affinityTtlSeconds * 1000,
    foreignThinking,
  })
  while (conversationFallbacks.size > attempt.config.affinityMaxEntries) {
    const oldest = conversationFallbacks.keys().next().value
    if (oldest === undefined) break
    conversationFallbacks.delete(oldest)
  }
}

function attemptConfigurationIsCurrent(attempt: FallbackAttempt): boolean {
  return (
    attempt.configRevision === getModelFallbackConfigRevision()
    && attempt.redirectRevision === getModelRedirectRevision(true)
  )
}

function isSupersededFallback(
  previous: FallbackEntry | undefined,
  attempt: FallbackAttempt,
): boolean {
  return Boolean(
    previous
      && previous.requestSequence > attempt.requestSequence
      && previous.targetModel !== attempt.targetModel,
  )
}

/** Keep a retry-eligible upstream failure above the SSE response boundary. */
export function shouldAwaitModelFallbackBeforePreflush(): boolean {
  const attempt = attemptStorage.getStore()
  return Boolean(attempt && !attempt.accepted && nextFallbackModel(attempt))
}

export function isModelFallbackActive(): boolean {
  const attempt = attemptStorage.getStore()
  return Boolean(attempt?.targetModel && (attempt.retry || attempt.cached))
}

/** The effective redirect metadata is consumed by protocol-specific preparation. */
export function getModelFallbackRedirect(): ModelRedirectResult | undefined {
  const attempt = attemptStorage.getStore()
  return attempt?.retry || attempt?.cached ? attempt.targetRedirect : undefined
}

export function getModelFallbackEffort(
  fallback?: ReasoningEffort,
): ReasoningEffort | undefined {
  return getModelFallbackRedirect()?.effort ?? fallback
}

function payloadRoutingRequest(payload: {
  model: string
}): ModelRedirectRequest {
  const record = payload as Record<string, unknown>
  const reasoning = isRecord(record.reasoning) ? record.reasoning : {}
  const output = isRecord(record.output_config) ? record.output_config : {}
  const text = isRecord(record.text) ? record.text : {}
  const rawEffort = reasoning.effort ?? record.reasoning_effort ?? output.effort
  const effort =
    (
      typeof rawEffort === "string"
      && ["high", "low", "max", "medium", "minimal", "none", "xhigh"].includes(
        rawEffort,
      )
    ) ?
      (rawEffort as ReasoningEffort)
    : undefined
  const verbosity =
    (
      text.verbosity === "low"
      || text.verbosity === "medium"
      || text.verbosity === "high"
    ) ?
      text.verbosity
    : undefined
  return {
    model: payload.model,
    effort,
    verbosity,
    modelOnly: typeof rawEffort === "number",
  }
}

function stripMessageThinking(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant") return false
  let removed = false
  for (const key of [
    "reasoning_text",
    "reasoning_opaque",
    "encrypted_content",
    "reasoning_content",
  ]) {
    if (Object.hasOwn(message, key)) {
      Reflect.deleteProperty(message, key)
      removed = true
    }
  }
  if (Array.isArray(message.content)) {
    const previousLength = message.content.length
    const retained = message.content.filter(
      (block) =>
        !isRecord(block)
        || !["reasoning", "redacted_thinking", "thinking"].includes(
          String(block.type),
        ),
    )
    message.content = retained
    removed ||= previousLength !== retained.length
  }
  return removed
}

export function stripModelTransitionThinking(payload: unknown): void {
  if (!isRecord(payload)) return
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.filter(
      (message) =>
        !isRecord(message)
        || !stripMessageThinking(message)
        || hasRetainedAssistantContent(message),
    )
  }
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.filter(
      (item) => !isRecord(item) || item.type !== "reasoning",
    )
    payload.input = (payload.input as Array<unknown>).filter(
      (item) =>
        !isRecord(item)
        || !stripMessageThinking(item)
        || hasRetainedAssistantContent(item),
    )
  }
  if (Array.isArray(payload.contents)) {
    for (const content of payload.contents) {
      if (
        !isRecord(content)
        || content.role !== "model"
        || !Array.isArray(content.parts)
      )
        continue
      content.parts = content.parts.filter(
        (part) => !isRecord(part) || part.thought !== true,
      )
      for (const part of content.parts as Array<unknown>) {
        if (!isRecord(part)) continue
        Reflect.deleteProperty(part, "thoughtSignature")
        Reflect.deleteProperty(part, "thought_signature")
      }
    }
  }
}

/** Invoke after normal routing, before endpoint/account-specific preparation. */
export function applyModelFallbackToPayload<T extends { model: string }>(
  payload: T,
  routing?: Omit<ModelRedirectRequest, "model">,
): T {
  const attempt = attemptStorage.getStore()
  if (!attempt?.config.enabled) return payload
  captureForeignThinking(payload, attempt.incomingThinking)
  if (attempt.retry && attempt.targetModel) {
    payload.model = attempt.targetModel
    captureForeignThinking(payload, attempt.foreignThinking)
    stripModelTransitionThinking(payload)
    return payload
  }
  if (attempt.cached && attempt.targetModel) {
    payload.model = attempt.targetModel
    filterForeignThinking(payload, attempt.foreignThinking)
    return payload
  }
  if (attempt.retry) return payload
  captureForeignThinking(payload, attempt.foreignThinking)
  attempt.sourceModel = payload.model
  attempt.routingRequest = {
    ...payloadRoutingRequest(payload),
    ...routing,
    model: payload.model,
  }
  const rule = attempt.config.rules.find(
    (entry) => entry.enabled && entry.sourceModel === payload.model,
  )
  attempt.targetModel = undefined
  if (!rule) return payload
  const key = cacheKey(attempt)
  const cached =
    attempt.config.conversationAffinity && key ?
      conversationFallbacks.get(key)
    : undefined
  if (!cached) return payload
  const currentRedirect = resolveCachedFallback(attempt, cached)
  // An effort change may select a different redirect. Re-evaluate the source
  // normally so the transition strips thinking from the previous target.
  if (!currentRedirect) return payload
  attempt.cached = true
  attempt.targetModel = cached.targetModel
  attempt.targetRedirect = currentRedirect
  attempt.route = cached.route
  attempt.routingRequest = {
    model: currentRedirect.model,
    effort: normalizeReasoningEffortForModel(
      currentRedirect.model,
      currentRedirect.effort,
    ),
    verbosity: currentRedirect.verbosity,
    modelOnly: attempt.routingRequest.modelOnly,
  }
  attempt.visitedModels.add(getModelFallbackIdentity(attempt.sourceModel))
  attempt.foreignThinking = cached.foreignThinking
  payload.model = cached.targetModel
  filterForeignThinking(payload, attempt.foreignThinking)
  return payload
}

function resolveCachedFallback(
  attempt: FallbackAttempt,
  cached: FallbackEntry,
): ModelRedirectResult | undefined {
  let request = attempt.routingRequest
  let result: ModelRedirectResult | undefined
  if (!request) return undefined
  for (const hop of cached.route) {
    if (request.model !== hop.source) return undefined
    const redirect = resolveModelRedirectRules(attempt.redirects, {
      ...request,
      model: hop.target,
    })
    if (redirect.loop || redirect.model !== hop.resolved) return undefined
    result = redirect
    request = {
      model: redirect.model,
      effort: normalizeReasoningEffortForModel(redirect.model, redirect.effort),
      verbosity: redirect.verbosity,
      modelOnly: request.modelOnly,
    }
  }
  return result
}

export async function runWithModelFallback<T>(
  options: ModelFallbackRequestOptions,
  execute: () => Promise<T>,
): Promise<T> {
  if (attemptStorage.getStore()) return await execute()
  await getModelFallbackConfig()
  const config = getLoadedModelFallbackConfig()
  const configRevision = getCapturedModelFallbackConfigRevision()
  if (!config.enabled || !getModelRoutingSafety().safe) return await execute()
  refreshCache()
  const identity = getConversationIdentity(options)
  const credential =
    options.credentialScope
    ?? createModelFallbackCredentialScope(options.headers ?? new Headers())
  const incomingThinking = captureForeignThinking(options.payload)
  let attempt: FallbackAttempt = {
    config,
    configRevision,
    redirectRevision: getModelRedirectRevision(),
    redirects: getLoadedModelRedirects(),
    route: [],
    cacheEpoch,
    requestSequence: ++nextRequestSequence,
    key:
      identity ?
        createHash("sha256")
          .update(JSON.stringify([credential, identity]))
          .digest("hex")
      : undefined,
    retry: false,
    cached: false,
    accepted: false,
    foreignThinking: mergeForeignThinking(incomingThinking, incomingThinking),
    incomingThinking,
    hops: 0,
    visitedModels: new Set<string>(),
  }
  while (true) {
    try {
      return await attemptStorage.run(attempt, execute)
    } catch (error) {
      const targetRedirect = nextFallbackRedirect(attempt)
      if (
        !targetRedirect
        || !canRetryFallback(attempt, error)
        || options.canRetry?.() === false
      )
        throw error
      options.signal?.throwIfAborted()
      attempt = {
        ...attempt,
        targetModel: targetRedirect.model,
        targetRedirect,
        route: [...attempt.route, fallbackRouteHop(attempt, targetRedirect)],
        routingRequest: {
          model: targetRedirect.model,
          effort: normalizeReasoningEffortForModel(
            targetRedirect.model,
            targetRedirect.effort,
          ),
          verbosity: targetRedirect.verbosity,
          modelOnly: attempt.routingRequest?.modelOnly,
        },
        retry: true,
        cached: false,
        hops: attempt.hops + 1,
        firstResponse: undefined,
        accepted: false,
        foreignThinking: mergeForeignThinking(
          attempt.foreignThinking,
          attempt.incomingThinking,
        ),
      }
    }
  }
}

function activeModel(attempt: FallbackAttempt): string | undefined {
  return attempt.retry || attempt.cached ?
      attempt.targetModel
    : attempt.sourceModel
}

function fallbackRouteHop(
  attempt: FallbackAttempt,
  redirect: ModelRedirectResult,
): FallbackEntry["route"][number] {
  return {
    source: activeModel(attempt) ?? "",
    target: redirect.originalModel ?? redirect.model,
    resolved: redirect.model,
  }
}

function nextFallbackModel(attempt: FallbackAttempt): string | undefined {
  return nextFallbackRedirect(attempt)?.model
}

function nextFallbackRedirect(
  attempt: FallbackAttempt,
): ModelRedirectResult | undefined {
  if (attempt.hops >= MAX_MODEL_FALLBACK_HOPS) return undefined
  const currentModel = activeModel(attempt)
  if (!currentModel) return undefined
  const rule = attempt.config.rules.find(
    (entry) => entry.enabled && entry.sourceModel === currentModel,
  )
  if (!rule) return undefined
  const redirect = resolveModelRedirectRules(attempt.redirects, {
    ...attempt.routingRequest,
    model: rule.targetModel,
  })
  if (
    redirect.loop
    || attempt.visitedModels.has(getModelFallbackIdentity(redirect.model))
    || getModelFallbackIdentity(redirect.model)
      === getModelFallbackIdentity(currentModel)
  )
    return undefined
  return redirect
}

function canRetryFallback(attempt: FallbackAttempt, error: unknown): boolean {
  return (
    !attempt.accepted
    && attempt.firstResponse?.status === 422
    && isHTTPError(error)
    && error.response === attempt.firstResponse
  )
}
