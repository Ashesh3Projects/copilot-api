import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

import { extractRequestCredential } from "~/lib/credential-resolver"
import { isHTTPError } from "~/lib/error"
import {
  getModelFallbackConfig,
  getModelFallbackConfigRevision,
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
  requestSequence: number
  expiresAt: number
  foreignThinking: ForeignThinkingState
}

interface FallbackAttempt {
  config: ModelFallbackConfig
  configRevision: number
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
  if (revision !== cacheRevision) {
    conversationFallbacks.clear()
    cacheRevision = revision
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
    || attempt.configRevision !== getModelFallbackConfigRevision()
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
  if (!attempt.retry) {
    captureForeignThinking(payload, attempt.foreignThinking)
    attempt.sourceModel = payload.model
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
    attempt.cached = true
    attempt.targetModel = cached.targetModel
    attempt.visitedModels.add(getModelFallbackIdentity(attempt.sourceModel))
    attempt.foreignThinking = cached.foreignThinking
    payload.model = cached.targetModel
    filterForeignThinking(payload, attempt.foreignThinking)
    return payload
  }
  return payload
}

export async function runWithModelFallback<T>(
  options: ModelFallbackRequestOptions,
  execute: () => Promise<T>,
): Promise<T> {
  if (attemptStorage.getStore()) return await execute()
  await getModelFallbackConfig()
  const config = getLoadedModelFallbackConfig()
  const configRevision = getModelFallbackConfigRevision()
  if (!config.enabled) return await execute()
  refreshCache()
  const identity = getConversationIdentity(options)
  const credential =
    options.credentialScope
    ?? createModelFallbackCredentialScope(options.headers ?? new Headers())
  const incomingThinking = captureForeignThinking(options.payload)
  let attempt: FallbackAttempt = {
    config,
    configRevision,
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
      const targetModel = nextFallbackModel(attempt)
      if (
        !targetModel
        || !canRetryFallback(attempt, error)
        || options.canRetry?.() === false
      )
        throw error
      options.signal?.throwIfAborted()
      attempt = {
        ...attempt,
        targetModel,
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

function nextFallbackModel(attempt: FallbackAttempt): string | undefined {
  if (attempt.hops >= MAX_MODEL_FALLBACK_HOPS) return undefined
  const currentModel = activeModel(attempt)
  if (!currentModel) return undefined
  const rule = attempt.config.rules.find(
    (entry) => entry.enabled && entry.sourceModel === currentModel,
  )
  return (
      rule
        && !attempt.visitedModels.has(
          getModelFallbackIdentity(rule.targetModel),
        )
        && getModelFallbackIdentity(rule.targetModel)
          !== getModelFallbackIdentity(currentModel)
    ) ?
      rule.targetModel
    : undefined
}

function canRetryFallback(attempt: FallbackAttempt, error: unknown): boolean {
  return (
    !attempt.accepted
    && attempt.firstResponse?.status === 422
    && isHTTPError(error)
    && error.response === attempt.firstResponse
  )
}
