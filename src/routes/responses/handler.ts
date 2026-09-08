/* eslint-disable max-lines, max-lines-per-function */
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import {
  getLastUsedAccountId,
  runWithRoutedModelSelection,
  selectRoutedModel,
} from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { getConfig } from "~/lib/config"
import {
  recordCopilotEndpointRoute,
  recordCopilotMessagesBeta,
  recordCopilotRequestNormalization,
  recordCopilotTranslationFindings,
} from "~/lib/copilot-contract-observability"
import { sessionTokenMatchesModel } from "~/lib/copilot-session-token"
import {
  createCustomProviderChatCompletions,
  resolveCustomProviderModel,
  type CustomProviderModelReference,
} from "~/lib/custom-providers"
import {
  type EndpointRouteDecision,
  type EndpointRouteFailure,
  getModelEndpointSupport,
  selectCopilotEndpoint,
} from "~/lib/endpoint-routing"
import {
  assertEndpointTranslationSupported,
  createEndpointTranslationError,
  createInvalidJsonBodyError,
  isAbortError,
  isHTTPError,
  inspectHttpError,
} from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import {
  applyModelFallbackToPayload,
  captureModelFallbackNotice,
  isModelFallbackActive,
  runWithModelFallback,
} from "~/lib/model-fallback"
import { applyResponsesModelFallbackNotice } from "~/lib/model-fallback-notice"
import {
  applyModelRedirect,
  formatModelRedirectResult,
  type ModelRedirectVerbosity,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  getModelReasoningConfig,
  type ReasoningEffort,
  normalizeReasoningEffortForModel,
  parseReasoningEffort,
  parseModelSuffix,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import {
  hasNonNullStreamError,
  parseRecoverableStreamJson,
} from "~/lib/recoverable-stream-json"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import { installResponsesRoutingAffinity } from "~/lib/routing-affinity"
import {
  createSentryChatSpanOptions,
  createSentryInvokeAgentSpanOptions,
  setSentryOutputMessages,
  setSentryConversationIdFromRequest,
} from "~/lib/sentry"
import {
  raceSsePreflush,
  type SseHeartbeatSink,
  unwrapSsePreflushSettlement,
  withHeartbeatWhilePending,
  withSseHeartbeat,
  writeSseHeartbeat,
} from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { emitResponsesToolSpans } from "~/lib/tool-spans"
import { isResponsesCompactionRequest } from "~/services/copilot/compaction-payload"
import {
  createChatCompletionsWithProcessedPayload,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  normalizeResponsesAttachments,
  type FunctionTool,
  type ResponseInputItem,
  type ResponseOutputFunctionCall,
  type ResponseOutputItem,
  type ResponseOutputMessage,
  type ResponseOutputReasoning,
  type ResponseOutputText,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseUsage,
} from "~/services/copilot/create-responses"
import {
  createWebSearchResponsesTool,
  isResponsesWebSearchFunctionTool,
} from "~/services/copilot/mcp-web-search"
import { canonicalizeAnthropicBeta } from "~/services/copilot/messages-contract"
import { normalizeResponsesAttachmentsFailClosed } from "~/services/copilot/responses-attachments"
import {
  finalizeNativeResponsesRequest,
  type PreparedResponsesSource,
  prepareResponsesRequest,
} from "~/services/copilot/responses-contract"

import { type NativeMessagesRequestOptions } from "../messages/native-handler"
import {
  emitResponsesResultAsStream,
  resolveResponsesWebSearchCalls,
} from "../messages/web-search-helpers"
import {
  type PreparedResponsesChatCompletion,
  resolvePreparedResponsesWebSearchCalls,
  type ResponsesChatCompletionFactory,
} from "./chat-fallback-completion"
import {
  prepareResponsesCandidates,
  selectResponsesCandidate,
} from "./fallback-candidates"
import { executePreparedResponsesMessagesBridge } from "./messages-bridge"
import { readResponsesRequestJson } from "./request-json"
import { adaptResponsesToChatCandidate } from "./responses-chat-adapter"
import { getResponsesChatWebSearchMaxUses } from "./responses-chat-adapter"
import { applyResponsesServiceTierRouting } from "./service-tier"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  classifyResponsesTerminal,
  createPartialTextOutput,
  createResponsesStreamFailureState,
  createResponsesTerminalLifecycle,
  RECEIVED_RESPONSES_FAILURE,
  type ResponsesStreamChunk,
  updateResponsesFailureState,
} from "./stream-lifecycle"
import {
  checkResponsesToChatTranslation,
  checkResponsesToMessagesTranslation,
} from "./translation-fidelity"
import {
  expandCompactionItems,
  getResponsesRequestOptions,
  getResponsesVerbosity,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

/**
 * Extracts detailed token counts from a Responses API usage object,
 * avoiding optional-chain branches in the caller.
 */
const extractDetailedUsage = (
  usage: ResponseUsage | null | undefined,
): {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
} => ({
  inputTokens: usage?.input_tokens ?? 0,
  outputTokens: usage?.output_tokens ?? 0,
  cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
  reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
})

/**
 * Extracts usage from a ChatCompletionChunk usage object into the CCStreamState
 * format, keeping optional-chain branches out of the caller.
 */
const extractCCUsage = (usage: {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens: number }
}): { inputTokens: number; outputTokens: number; cachedTokens: number } => ({
  inputTokens: usage.prompt_tokens,
  outputTokens: usage.completion_tokens,
  cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
})

/**
 * Sets optional cached input tokens and reasoning output tokens attributes on a
 * Sentry span.  Extracting this avoids adding `if`-branches to already-complex
 * handler functions.
 */
const setDetailedTokenAttributes = (
  span: Sentry.Span,
  opts: { cachedTokens?: number; reasoningTokens?: number },
): void => {
  if (opts.cachedTokens && opts.cachedTokens > 0) {
    span.setAttribute("gen_ai.usage.input_tokens.cached", opts.cachedTokens)
  }
  if (opts.reasoningTokens && opts.reasoningTokens > 0) {
    span.setAttribute(
      "gen_ai.usage.output_tokens.reasoning",
      opts.reasoningTokens,
    )
  }
}

const getCompletedBufferedResponse = (chunkData: {
  event?: string
  data?: string
}): ResponsesResult | null => {
  if (
    !chunkData.data
    || (chunkData.event !== "response.completed"
      && chunkData.event !== "response.incomplete")
  ) {
    return null
  }

  try {
    const parsed = JSON.parse(chunkData.data) as {
      response?: ResponsesResult
    }
    return parsed.response ?? null
  } catch {
    return null
  }
}

interface NativeResponsesStreamWriter extends SseHeartbeatSink {
  writeSSE: (data: {
    id?: string
    event?: string
    data: string
  }) => Promise<void>
}

interface NativeResponsesStreamOptions {
  c: Context
  copilotSessionToken?: string
  finishSpan: () => void
  initiator: "agent" | "user"
  preparedPayload: ResponsesPayload
  requestedModel: string
  response: AsyncIterable<ResponsesStreamChunk>
  streamSpan: Sentry.Span
  vision: boolean
}

async function streamImmediateNativeResponses(
  stream: NativeResponsesStreamWriter,
  options: NativeResponsesStreamOptions,
): Promise<void> {
  const failureState = createResponsesStreamFailureState(options.requestedModel)
  const lifecycle = createResponsesTerminalLifecycle({
    c: options.c,
    stream,
    state: failureState,
  })
  const idTracker = createStreamIdTracker()
  const writeContext = {
    stream,
    requestedModel: options.requestedModel,
    idTracker,
  }
  stream.onAbort?.(() => {
    lifecycle.abort()
  })
  try {
    for await (const chunk of withSseHeartbeat(options.response, stream)) {
      if (lifecycle.state !== "open") break
      const normalized = normalizeResponsesStreamChunk(chunk)
      const outbound = processNativeResponsesChunk(normalized, writeContext)
      if (outbound === undefined) continue
      updateResponsesFailureState(failureState, outbound)
      await writeNativeResponsesChunk(outbound, stream)
      await commitReceivedResponsesTerminal(lifecycle, normalized.event)
    }
    await lifecycle.finishSource()
  } catch (error) {
    await failResponsesLifecycle(lifecycle, stream, error)
  } finally {
    options.finishSpan()
  }
}

async function streamBufferedNativeResponses(
  stream: NativeResponsesStreamWriter,
  options: NativeResponsesStreamOptions,
): Promise<void> {
  const failureState = createResponsesStreamFailureState(options.requestedModel)
  const lifecycle = createResponsesTerminalLifecycle({
    c: options.c,
    stream,
    state: failureState,
  })
  const bufferedChunks: Array<ResponsesStreamChunk> = []
  const idTracker = createStreamIdTracker()
  const writeContext = {
    stream,
    requestedModel: options.requestedModel,
    idTracker,
  }
  let completedResult: ResponsesResult | null = null
  stream.onAbort?.(() => {
    lifecycle.abort()
  })
  try {
    for await (const chunk of withSseHeartbeat(options.response, stream)) {
      if (lifecycle.state !== "open") break
      const normalized = normalizeResponsesStreamChunk(chunk)
      const outbound = processNativeResponsesChunk(normalized, writeContext)
      if (outbound === undefined) continue
      bufferedChunks.push(outbound)
      updateResponsesFailureState(failureState, outbound)
      completedResult =
        getCompletedBufferedResponse(outbound) ?? completedResult
      const terminal = classifyResponsesTerminal(normalized.event)
      if (!terminal) continue
      if (terminal === "response.failed" || terminal === "error") {
        await writeBufferedNativeResponsesChunks(bufferedChunks, stream)
        await lifecycle.fail({
          kind: "thrown",
          error: RECEIVED_RESPONSES_FAILURE,
        })
      }
      break
    }
    updateNativeResponsesSpan(options.streamSpan, completedResult)
    if (lifecycle.state !== "open") return
    if (!completedResult) {
      await lifecycle.finishSource()
      return
    }
    const terminalResult = completedResult
    options.finishSpan()
    const resolved = await withHeartbeatWhilePending(
      Sentry.withActiveSpan(null, () =>
        resolveResponsesWebSearchCalls(
          terminalResult,
          options.preparedPayload,
          {
            copilotSessionToken: options.copilotSessionToken,
            vision: options.vision,
            initiator: options.initiator,
            signal: options.c.req.raw.signal,
          },
        ),
      ),
      stream,
    )
    await emitResponsesResultAsStream(
      stream,
      withRequestedResponseModel(resolved, options.requestedModel),
    )
    await lifecycle.succeed("synthetic")
  } catch (error) {
    await failResponsesLifecycle(lifecycle, stream, error)
  } finally {
    options.finishSpan()
  }
}

function normalizeResponsesStreamChunk(
  chunk: ResponsesStreamChunk,
): ResponsesStreamChunk {
  return {
    id: chunk.id,
    event: chunk.event,
    data: chunk.data ?? "",
  }
}

interface NativeResponsesWriteContext {
  stream: NativeResponsesStreamWriter
  requestedModel: string
  idTracker: ReturnType<typeof createStreamIdTracker>
}

function processNativeResponsesChunk(
  chunk: ResponsesStreamChunk,
  context: NativeResponsesWriteContext,
): ResponsesStreamChunk | undefined {
  const restoredData = rewriteResponseModelInEvent(
    chunk.data ?? "",
    context.requestedModel,
  )
  const data = fixStreamIds(restoredData, chunk.event, context.idTracker)
  if (data === undefined) return undefined
  return {
    ...(typeof chunk.id === "string" ? { id: chunk.id } : {}),
    event: chunk.event,
    data,
  }
}

async function writeNativeResponsesChunk(
  chunk: ResponsesStreamChunk,
  stream: NativeResponsesStreamWriter,
): Promise<void> {
  await stream.writeSSE({
    ...(typeof chunk.id === "string" ? { id: chunk.id } : {}),
    event: chunk.event,
    data: chunk.data ?? "",
  })
}

async function writeBufferedNativeResponsesChunks(
  chunks: ReadonlyArray<ResponsesStreamChunk>,
  stream: NativeResponsesStreamWriter,
): Promise<void> {
  for (const chunk of chunks) {
    await writeNativeResponsesChunk(chunk, stream)
  }
}

async function commitReceivedResponsesTerminal(
  lifecycle: ReturnType<typeof createResponsesTerminalLifecycle>,
  event: string | undefined,
): Promise<void> {
  const terminal = classifyResponsesTerminal(event)
  if (terminal === "response.completed" || terminal === "response.incomplete") {
    await lifecycle.succeed(terminal)
    return
  }
  if (terminal === "response.failed" || terminal === "error") {
    await lifecycle.fail({
      kind: "thrown",
      error: RECEIVED_RESPONSES_FAILURE,
    })
  }
}

async function failResponsesLifecycle(
  lifecycle: ReturnType<typeof createResponsesTerminalLifecycle>,
  stream: NativeResponsesStreamWriter,
  error: unknown,
): Promise<void> {
  if (isAbortError(error) || stream.aborted || stream.closed) {
    lifecycle.abort()
    return
  }
  const inspection =
    isHTTPError(error) ? await inspectHttpError(error) : undefined
  if (inspection?.status === 499) {
    lifecycle.abort()
    return
  }
  await lifecycle.fail({ kind: "thrown", error, inspection })
}

function updateNativeResponsesSpan(
  streamSpan: Sentry.Span,
  result: ResponsesResult | null,
): void {
  const usage = extractDetailedUsage(result?.usage)
  streamSpan.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens)
  streamSpan.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens)
  setDetailedTokenAttributes(streamSpan, {
    cachedTokens: usage.cachedTokens,
    reasoningTokens: usage.reasoningTokens,
  })
  setSentryOutputMessages(streamSpan, result?.output_text ?? "")
}

type ResponsesReasoningEffort = ReasoningEffort | number

function isResponsesReasoningEffort(
  value: unknown,
): value is ResponsesReasoningEffort {
  return (
    Number.isInteger(value)
    || value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
  )
}

export function normalizeResponsesReasoning(
  payload: ResponsesPayload,
  suffixEffort?: ReasoningEffort,
): ResponsesReasoningEffort | undefined {
  // Accept OpenAI-compatible top-level aliases and normalize to reasoning.effort
  const topLevelEffortRaw = payload.reasoningEffort ?? payload.reasoning_effort
  const topLevelEffort =
    isResponsesReasoningEffort(topLevelEffortRaw) ? topLevelEffortRaw : (
      undefined
    )

  if (topLevelEffort !== undefined) {
    payload.reasoning =
      payload.reasoning ?
        {
          ...payload.reasoning,
          effort: payload.reasoning.effort ?? topLevelEffort,
        }
      : { effort: topLevelEffort }
  }
  delete payload.reasoningEffort
  delete payload.reasoning_effort

  if (suffixEffort && typeof payload.reasoning?.effort !== "number") {
    payload.reasoning =
      payload.reasoning ?
        {
          ...payload.reasoning,
          effort: suffixEffort,
        }
      : { effort: suffixEffort }
  }

  const effort = payload.reasoning?.effort
  return isResponsesReasoningEffort(effort) ? effort : undefined
}

function getRedirectReasoningEffort(
  effort: ResponsesReasoningEffort | undefined,
): ReasoningEffort | undefined {
  return typeof effort === "string" ? parseReasoningEffort(effort) : undefined
}

function applyRedirectedResponsesEffort(options: {
  c: Context
  payload: ResponsesPayload
  model: string
  effort: ReasoningEffort | undefined
  preserveNumericEffort: boolean
}): void {
  if (!options.effort) {
    if (options.preserveNumericEffort) return
    if (
      usesImplicitReasoningDefault(options.model)
      && options.payload.reasoning
    ) {
      recordNonDefaultBehavior(options.c, {
        kind: "reasoning_effort_implicit_default",
        message: `${options.model} is configured for implicit reasoning defaults; removing explicit reasoning config`,
        data: {
          model: options.model,
        },
      })
      delete options.payload.reasoning
    }
    return
  }
  options.payload.reasoning =
    options.payload.reasoning ?
      { ...options.payload.reasoning, effort: options.effort }
    : { effort: options.effort }
}

async function resolveResponsesRedirect(
  c: Context,
  request: {
    model: string
    effectiveEffort?: ResponsesReasoningEffort
    verbosity?: ModelRedirectVerbosity
  },
): Promise<Awaited<ReturnType<typeof applyModelRedirect>>> {
  const redirectRawEffort = getRedirectReasoningEffort(request.effectiveEffort)
  const requestedEffort = normalizeReasoningEffortForModel(
    request.model,
    redirectRawEffort,
  )
  reportClampedResponsesEffort(c, {
    model: request.model,
    requestedEffort: redirectRawEffort,
    effectiveEffort: requestedEffort,
  })

  const redirect = await applyModelRedirect({
    model: request.model,
    effort: requestedEffort,
    verbosity: request.verbosity,
    modelOnly: typeof request.effectiveEffort === "number",
  })
  if (redirect.redirected) {
    const numericEffort = typeof request.effectiveEffort === "number"
    recordNonDefaultBehavior(c, {
      kind: "model_redirect",
      message: `Model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: request.model,
        sourceEffort: numericEffort ? undefined : requestedEffort,
        targetModel: redirect.model,
        targetEffort: numericEffort ? undefined : redirect.effort,
        targetVerbosity: redirect.verbosity,
        ruleId: redirect.ruleId,
        ruleIds: redirect.ruleIds?.join(","),
      },
    })
  }
  return redirect
}

function reportClampedResponsesEffort(
  c: Context,
  options: {
    model: string
    requestedEffort?: ReasoningEffort
    effectiveEffort?: ReasoningEffort
    redirected?: boolean
  },
): void {
  if (
    !options.requestedEffort
    || options.effectiveEffort === options.requestedEffort
  ) {
    return
  }
  const prefix = options.redirected ? "Requested redirected" : "Requested"
  recordNonDefaultBehavior(c, {
    kind: "reasoning_effort_clamped",
    message: `${prefix} effort ${options.requestedEffort} for ${options.model} was clamped to ${options.effectiveEffort}`,
    data: {
      model: options.model,
      requestedEffort: options.requestedEffort,
      effectiveEffort: options.effectiveEffort,
    },
  })
}

function applyResponsesModelFallback(
  c: Context,
  payload: ResponsesPayload,
): boolean {
  if (
    payload.model.endsWith("-1m")
    || tokenPool.hasEnabledAccountForKnownModel(payload.model) !== undefined
  ) {
    return false
  }

  const candidate = `${payload.model}-1m`
  if (!state.models?.data.some((m) => m.id === candidate)) return false

  recordNonDefaultBehavior(c, {
    kind: "model_fallback",
    message: `No enabled account can serve ${payload.model}; falling back to ${candidate}`,
    data: {
      sourceModel: payload.model,
      targetModel: candidate,
      reason: "no routable account for known model",
    },
  })
  payload.model = candidate
  return true
}

function reportResponsesEndpointFallback(
  c: Context,
  model: string,
  decision: EndpointRouteDecision,
): void {
  const targetName =
    decision.target === "/v1/messages" ?
      "native /v1/messages"
    : "ChatCompletions"
  const targetEndpoint =
    decision.target === "/v1/messages" ? "AnthropicMessages" : "ChatCompletions"
  recordNonDefaultBehavior(c, {
    kind: "endpoint_fallback",
    message: `Model ${model} does not support /responses; falling back to ${targetName}`,
    data: {
      model,
      sourceEndpoint: "Responses",
      targetEndpoint,
    },
  })
}

export function selectResponsesUpstreamEndpoint(options: {
  payload: ResponsesPayload
  selectedModel: Model | undefined
}): EndpointRouteDecision | EndpointRouteFailure {
  const support = getModelEndpointSupport(options.selectedModel)
  const chatCheck = getResponsesChatRouteCheck(options.payload)
  return selectCopilotEndpoint({
    source: "responses",
    support,
    candidates: [
      {
        endpoint: "/responses",
        reason: "endpoint_unavailable",
        check: { supported: true, blockers: [] },
      },
      {
        endpoint: "/v1/messages",
        reason: "endpoint_unavailable",
        check: getResponsesMessagesRouteCheck(
          options.payload,
          options.selectedModel,
        ),
      },
      {
        endpoint: "/chat/completions",
        reason: "endpoint_unavailable",
        check: chatCheck,
      },
    ],
  })
}

function getResponsesChatRouteCheck(payload: ResponsesPayload): {
  blockers: Array<string>
  supported: boolean
} {
  const check = checkResponsesToChatTranslation(payload)
  if (!isResponsesCompactionRequest(payload)) return check
  const blockers = check.blockers.filter(
    (blocker) =>
      blocker !== "tool_semantics:custom_tool_call"
      && blocker !== "tool_semantics:custom_tool_call_output"
      && blocker !== "tool_semantics:computer_call_output"
      && blocker !== "client_metadata",
  )
  return { supported: blockers.length === 0, blockers }
}

function withRequestedResponseModel(
  result: ResponsesResult,
  requestedModel: string,
): ResponsesResult {
  return { ...result, model: requestedModel }
}

export function rewriteResponseModelInEvent(
  data: string,
  requestedModel: string,
): string {
  try {
    const parsed = JSON.parse(data) as unknown
    if (!isPlainResponseEventRecord(parsed)) return data
    const response = readResponseEventDataProperty(parsed, "response")
    if (!isPlainResponseEventRecord(response)) return data
    const model = readResponseEventDataProperty(response, "model")
    if (typeof model !== "string" || model.length === 0) return data
    return JSON.stringify({
      ...parsed,
      response: { ...response, model: requestedModel },
    })
  } catch {
    return data
  }
  return data
}

function isPlainResponseEventRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value) as unknown
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function readResponseEventDataProperty(
  value: Record<string, unknown>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && "value" in descriptor ? descriptor.value : undefined
}

export const handleResponses = async (c: Context) => {
  const payload = await parseResponsesRequestBody(c)
  const preparedSource = prepareResponsesRequest(payload)
  const sourcePayload = preparedSource.source
  const nativeOptions: NativeMessagesRequestOptions = {
    anthropicBeta: c.req.header("anthropic-beta"),
    anthropicVersion: c.req.header("anthropic-version"),
    modelProviderPreference: c.req.header("x-model-provider-preference"),
  }
  installResponsesRoutingAffinity(
    (sourcePayload as Record<string, unknown>).client_metadata,
  )
  const conversationId = setSentryConversationIdFromRequest(c, sourcePayload)

  const model = parseModelSuffix(sourcePayload.model).baseModel

  return await Sentry.startSpan(
    createSentryInvokeAgentSpanOptions(model, conversationId),
    async () => {
      return await runWithModelFallback(
        {
          headers: c.req.raw.headers,
          payload: sourcePayload,
          signal: c.req.raw.signal,
        },
        async () => {
          const response = await handleResponsesInner(c, {
            legacyPayload: structuredClone(payload),
            nativeOptions,
            preparedSource: structuredClone(preparedSource),
          })
          return applyResponsesModelFallbackNotice(
            response,
            captureModelFallbackNotice(),
          )
        },
      )
    },
  )
}

async function parseResponsesRequestBody(c: Context): Promise<unknown> {
  try {
    return await readResponsesRequestJson(c.req.raw)
  } catch (error) {
    if (isHTTPError(error) || isAbortError(error)) throw error
    throw createInvalidJsonBodyError()
  }
}

// eslint-disable-next-line complexity -- native, custom, and fallback routes share preparation state
const handleResponsesInner = async (
  c: Context,
  options: {
    legacyPayload: unknown
    nativeOptions: NativeMessagesRequestOptions
    preparedSource: PreparedResponsesSource
  },
) => {
  const payload = structuredClone(
    options.preparedSource.source,
  ) as ResponsesPayload
  const legacyPayload = options.legacyPayload as ResponsesPayload
  const nativeOptions = options.nativeOptions
  // Emit synthetic tool execution spans from tool results in input history
  emitResponsesToolSpans(payload.input)

  // Capture the originally requested model before any manipulation
  const requestedModel = payload.model

  // Parse model suffix and apply reasoning effort override (e.g. "gpt-5.3-codex:high")
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    payload.model,
  )

  const customReferenceBeforeRedirect = resolveCustomResponsesModel(
    baseModel,
    payload,
  )
  payload.model =
    customReferenceBeforeRedirect ? baseModel : normalizeModelName(baseModel)
  const effectiveEffort = normalizeResponsesReasoning(payload, suffixEffort)
  syncLegacyResponsesRouteState(legacyPayload, payload)
  let directCustomReference = getDirectCustomResponsesReference(
    customReferenceBeforeRedirect,
    payload,
  )
  if (directCustomReference) {
    applyResponsesServiceTierRouting(c, payload)
    applyModelFallbackToPayload(payload)
    directCustomReference = resolveCustomResponsesModel(payload.model, payload)
  }
  if (directCustomReference) {
    syncLegacyResponsesRouteState(legacyPayload, payload)
    return await dispatchCustomResponsesRequest(c, {
      finalEffort: effectiveEffort,
      payload,
      reference: directCustomReference,
      requestedModel,
    })
  }
  const redirect = await resolveResponsesRedirect(c, {
    model: payload.model,
    effectiveEffort,
    verbosity: getResponsesVerbosity(payload),
  })
  // eslint-disable-next-line require-atomic-updates
  payload.model = normalizeModelName(redirect.model)
  const redirectedEffort =
    typeof effectiveEffort === "number" ? undefined : (
      normalizeReasoningEffortForModel(payload.model, redirect.effort)
    )
  if (typeof effectiveEffort !== "number") {
    reportClampedResponsesEffort(c, {
      model: payload.model,
      requestedEffort: redirect.effort,
      effectiveEffort: redirectedEffort,
      redirected: true,
    })
  }
  applyRedirectedResponsesEffort({
    c,
    payload,
    model: payload.model,
    effort: redirectedEffort,
    preserveNumericEffort: typeof effectiveEffort === "number",
  })
  syncLegacyResponsesRouteState(legacyPayload, payload)
  const serviceTierRouting = applyResponsesServiceTierRouting(c, payload, {
    allowCustomProvider: !isResponsesCompactionRequest(payload),
    customReference: resolveCustomResponsesModel(payload.model, payload),
  })
  applyResponsesServiceTierRouting(undefined, legacyPayload)
  const normalVariantRedirected =
    !resolveRoutedCustomResponsesModel(
      serviceTierRouting.customReference,
      payload,
    ) && applyResponsesModelFallback(c, payload)
  const beforeModelFallback = payload.model
  applyModelFallbackToPayload(payload)
  const finalEffort =
    typeof effectiveEffort === "number" ? effectiveEffort : (
      normalizeReasoningEffortForModel(
        payload.model,
        redirectedEffort ?? effectiveEffort,
      )
    )
  if (
    beforeModelFallback !== payload.model
    && typeof finalEffort !== "number"
  ) {
    applyRedirectedResponsesEffort({
      c,
      payload,
      model: payload.model,
      effort: finalEffort,
      preserveNumericEffort: false,
    })
  }
  syncLegacyResponsesRouteState(legacyPayload, payload)

  const customReference = resolveRoutedCustomResponsesModel(
    beforeModelFallback === payload.model ?
      serviceTierRouting.customReference
    : undefined,
    payload,
  )
  if (customReference) {
    return await dispatchCustomResponsesRequest(c, {
      finalEffort,
      payload,
      reference: customReference,
      requestedModel,
    })
  }

  const copilotSessionToken = resolveResponsesSessionToken(c, {
    payload,
    redirectOccurred: [
      beforeModelFallback !== payload.model,
      normalVariantRedirected,
      redirect.redirected,
      serviceTierRouting.redirected,
    ].includes(true),
    requestedModel: baseModel,
  })
  legacyPayload.model = payload.model

  setRequestContext(c, {
    requestedModel,
    provider: "Responses",
    model: payload.model,
    reasoningEffort: typeof finalEffort === "string" ? finalEffort : undefined,
  })
  logger.debug("Received Responses request", {
    inputKind: Array.isArray(payload.input) ? "items" : typeof payload.input,
    stream: Boolean(payload.stream),
    toolCount: payload.tools?.length ?? 0,
  })

  // Expand compaction items back into regular messages
  expandCompactionItems(payload)
  expandCompactionItems(legacyPayload)

  const routedModel = selectRoutedModel(payload.model, {
    copilotSessionToken,
  })
  const selectedModel = routedModel.model
  const nativeFinalized = finalizeNativeResponsesRequest(
    {
      source: payload,
      normalizationClasses: options.preparedSource.normalizationClasses,
    },
    {
      model: payload.model,
      defaultEffort: getModelReasoningConfig(payload.model)?.defaultEffort,
      implicitDefault: usesImplicitReasoningDefault(payload.model),
    },
  )
  const nativeBody = {
    ...nativeFinalized,
    body: stripResponsesWarmupControl(nativeFinalized.body),
  }
  disableParallelWebSearch(nativeBody.body)
  const candidates = await prepareResponsesCandidates({
    adaptationSource: payload,
    finalReasoningEffort: finalEffort,
    nativeBody,
    preservedSource: options.preparedSource,
    responsesVerbosity: redirect.verbosity,
    selectedModel,
    signal: c.req.raw.signal,
  })
  const selection = selectResponsesCandidate({ candidates, selectedModel })
  if ("code" in selection) throw createEndpointTranslationError(selection)
  const { candidate, decision } = selection
  recordCopilotRequestNormalization("responses", [
    ...nativeFinalized.normalizationClasses,
  ])
  if (candidate.check.findings.length > 0) {
    recordCopilotTranslationFindings(
      "responses",
      candidate.endpoint,
      candidate.check,
    )
  }
  recordCopilotEndpointRoute(decision)
  if (decision.target === "/v1/messages") {
    recordCopilotMessagesBeta(
      canonicalizeAnthropicBeta(nativeOptions.anthropicBeta),
    )
  }

  if (state.manualApprove) await awaitApproval()

  return await runWithRoutedModelSelection(routedModel, async () => {
    if (candidate.endpoint === "/v1/messages") {
      reportResponsesEndpointFallback(c, payload.model, decision)
      return await handleWithAnthropicMessages({
        c,
        preparedPayload: candidate.payload,
        responseContext: payload,
        nativeOptions: {
          ...nativeOptions,
          requestedModel,
          copilotSessionToken,
        },
      })
    }

    if (candidate.endpoint === "/chat/completions") {
      reportResponsesEndpointFallback(c, candidate.payload.model, decision)
      setRequestContext(c, { provider: "Responses→ChatCompletions" })
      return await handleWithChatCompletions(c, candidate.payload, {
        requestedModel,
        copilotSessionToken,
        webSearchMaxUses: getResponsesChatWebSearchMaxUses(payload),
      })
    }

    await candidate.prepareForDispatch()
    const preparedPayload = candidate.payload

    const { vision, initiator } = getResponsesRequestOptions(preparedPayload)

    // Extract messages for Sentry span attribute
    const inputMessages =
      typeof preparedPayload.input === "string" ?
        preparedPayload.input
      : JSON.stringify(preparedPayload.input)

    if (isStreamingRequested(preparedPayload)) {
      logger.debug("Forwarding native Responses stream")
      return await Sentry.startSpanManual(
        createSentryChatSpanOptions({
          inputMessages,
          model: preparedPayload.model,
          streaming: true,
        }),
        async (streamSpan, finish) => {
          let spanFinished = false
          const finishSpan = () => {
            if (spanFinished) return
            spanFinished = true
            finish()
          }

          try {
            const response = await createResponses(preparedPayload, {
              copilotSessionToken,
              vision,
              initiator,
              prepared: true,
              signal: c.req.raw.signal,
            })

            const accountId = getLastUsedAccountId()
            if (accountId !== undefined) {
              setRequestContext(c, { accountId })
            }

            if (!isAsyncIterable(response)) {
              const hadWebSearch = response.output.some(
                (item: ResponseOutputItem) =>
                  item.type === "function_call" && item.name === "web_search",
              )
              const du = extractDetailedUsage(response.usage)
              streamSpan.setAttribute(
                "gen_ai.usage.input_tokens",
                du.inputTokens,
              )
              streamSpan.setAttribute(
                "gen_ai.usage.output_tokens",
                du.outputTokens,
              )
              setDetailedTokenAttributes(streamSpan, {
                cachedTokens: du.cachedTokens,
                reasoningTokens: du.reasoningTokens,
              })
              setSentryOutputMessages(streamSpan, response.output_text)
              finishSpan()

              const resolved =
                hadWebSearch ?
                  await resolveResponsesWebSearchCalls(
                    response,
                    preparedPayload,
                    {
                      copilotSessionToken,
                      vision,
                      initiator,
                      signal: c.req.raw.signal,
                    },
                  )
                : response

              logger.debug("Forwarding native Responses result", {
                model: resolved.model,
                outputCount: resolved.output.length,
                status: resolved.status,
              })
              return c.json(
                withRequestedResponseModel(resolved, requestedModel),
              )
            }

            const nativeStreamOptions = {
              c,
              copilotSessionToken,
              finishSpan,
              initiator,
              preparedPayload,
              requestedModel,
              response,
              streamSpan,
              vision,
            }
            const emulatesWebSearch =
              preparedPayload.tools?.some((tool) =>
                isResponsesWebSearchFunctionTool(tool),
              ) ?? false
            return streamSSE(c, async (stream) => {
              if (emulatesWebSearch) {
                await streamBufferedNativeResponses(stream, nativeStreamOptions)
                return
              }
              await streamImmediateNativeResponses(stream, nativeStreamOptions)
            })
          } catch (error) {
            finishSpan()
            throw error
          }
        },
      )
    }

    const { initialResult, hadWebSearch } = await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages,
        model: preparedPayload.model,
      }),
      async (span) => {
        const result = (await createResponses(preparedPayload, {
          copilotSessionToken,
          vision,
          initiator,
          prepared: true,
          signal: c.req.raw.signal,
        })) as ResponsesResult

        const accountId = getLastUsedAccountId()
        if (accountId !== undefined) {
          setRequestContext(c, { accountId })
        }

        const hadWebSearch = result.output.some(
          (item: ResponseOutputItem) =>
            item.type === "function_call" && item.name === "web_search",
        )
        const inputTokens = result.usage?.input_tokens ?? 0
        const outputTokens = result.usage?.output_tokens ?? 0
        span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
        span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
        const cachedTokens =
          result.usage?.input_tokens_details?.cached_tokens ?? 0
        const reasoningTokens =
          result.usage?.output_tokens_details?.reasoning_tokens ?? 0
        setDetailedTokenAttributes(span, { cachedTokens, reasoningTokens })
        setSentryOutputMessages(span, result.output_text)

        return { initialResult: result, hadWebSearch }
      },
    )

    const resolved =
      hadWebSearch ?
        await resolveResponsesWebSearchCalls(initialResult, preparedPayload, {
          copilotSessionToken,
          vision,
          initiator,
          signal: c.req.raw.signal,
        })
      : initialResult

    logger.debug("Forwarding native Responses result", {
      model: resolved.model,
      outputCount: resolved.output.length,
      status: resolved.status,
    })

    return c.json(withRequestedResponseModel(resolved, requestedModel))
  })
}

function getResponsesCopilotModelIds(): Set<string> {
  return new Set(state.models?.data.map((model) => model.id) ?? [])
}

function resolveCustomResponsesModel(
  model: string,
  payload?: ResponsesPayload,
): CustomProviderModelReference | undefined {
  if (payload && isResponsesCompactionRequest(payload)) return undefined
  return resolveCustomProviderModel({
    model,
    kind: "chat",
    copilotModelIds: getResponsesCopilotModelIds(),
  })
}

function getDirectCustomResponsesReference(
  reference: CustomProviderModelReference | undefined,
  payload: ResponsesPayload,
): CustomProviderModelReference | undefined {
  return payload.service_tier === "priority" ? undefined : reference
}

function resolveRoutedCustomResponsesModel(
  serviceTierReference: CustomProviderModelReference | undefined,
  payload: ResponsesPayload,
): CustomProviderModelReference | undefined {
  return (
    serviceTierReference ?? resolveCustomResponsesModel(payload.model, payload)
  )
}

async function dispatchCustomResponsesRequest(
  c: Context,
  options: {
    finalEffort?: ResponsesReasoningEffort
    payload: ResponsesPayload
    reference: CustomProviderModelReference
    requestedModel: string
  },
): Promise<Response> {
  expandCompactionItems(options.payload)
  const candidate = await adaptResponsesToChatCandidate({
    source: options.payload,
    finalModel: options.payload.model,
    finalReasoningEffort: options.finalEffort,
    signal: c.req.raw.signal,
  })
  if (!candidate.check.supported) {
    throw createEndpointTranslationError({
      blockers: candidate.check.findings
        .filter((finding) => finding.severity === "fatal")
        .map((finding) => finding.class),
      code: "endpoint_translation_unsupported",
      source: "responses",
    })
  }
  recordCopilotTranslationFindings(
    "responses",
    candidate.endpoint,
    candidate.check,
  )
  setRequestContext(c, {
    requestedModel: options.requestedModel,
    provider: options.reference.provider.name,
    model: options.reference.upstreamModel,
    reasoningEffort:
      typeof options.finalEffort === "string" ? options.finalEffort : undefined,
  })
  if (state.manualApprove) await awaitApproval()
  const completionFactory: ResponsesChatCompletionFactory = async (
    payload,
    factoryOptions,
  ) => ({
    processedPayload: structuredClone(payload),
    response: await createCustomProviderChatCompletions(
      options.reference,
      payload,
      {
        signal: factoryOptions.signal,
        reasoningEffort:
          typeof options.finalEffort === "string" ?
            options.finalEffort
          : undefined,
      },
    ),
  })
  return await handleWithChatCompletions(c, candidate.payload, {
    completionFactory,
    requestedModel: options.requestedModel,
    webSearchMaxUses: getResponsesChatWebSearchMaxUses(options.payload),
  })
}

function syncLegacyResponsesRouteState(
  legacyPayload: ResponsesPayload,
  routedPayload: ResponsesPayload,
): void {
  legacyPayload.model = routedPayload.model
  delete legacyPayload.reasoningEffort
  delete legacyPayload.reasoning_effort
  if (routedPayload.reasoning === undefined) {
    delete legacyPayload.reasoning
  } else {
    legacyPayload.reasoning = structuredClone(routedPayload.reasoning)
  }
}

function resolveResponsesSessionToken(
  c: Context,
  options: {
    payload: ResponsesPayload
    redirectOccurred: boolean
    requestedModel: string
  },
): string | undefined {
  const modelWasRedirected = options.redirectOccurred
  const token = c.req.header("copilot-session-token")
  return (
      sessionTokenMatchesModel({
        token,
        requestedModel: options.requestedModel,
        finalModel: options.payload.model,
        modelWasRedirected,
      })
    ) ?
      token
    : undefined
}

export async function prepareResponsesRouteForTransport(options: {
  payload: ResponsesPayload
  selectedModel: Model | undefined
  signal?: AbortSignal
}): Promise<{
  decision: EndpointRouteDecision
  preparedPayload: ResponsesPayload
}> {
  const preparedSource = prepareResponsesRequest(options.payload)
  const prepared = finalizeNativeResponsesRequest(preparedSource, {
    model: options.payload.model,
    defaultEffort: getModelReasoningConfig(options.payload.model)
      ?.defaultEffort,
    implicitDefault: usesImplicitReasoningDefault(options.payload.model),
  })
  const preparedPayload = prepared.body
  const support = getModelEndpointSupport(options.selectedModel)
  if (!support.responses && !isResponsesWarmupPayload(preparedPayload)) {
    await (support.messages ?
      normalizeResponsesAttachmentsFailClosed(preparedPayload, options.signal)
    : normalizeResponsesAttachments(preparedPayload, options.signal))
  }
  const routePayload = stripResponsesWarmupControl(preparedPayload)
  let decision = selectResponsesUpstreamEndpoint({
    payload: routePayload,
    selectedModel: options.selectedModel,
  })
  if (
    "code" in decision
    && support.chat
    && payloadHasChatFallbackToolRewrite(routePayload)
  ) {
    const chatPayload = structuredClone(routePayload)
    convertWebSearchTool(chatPayload)
    useFunctionApplyPatch(chatPayload)
    if (getResponsesChatRouteCheck(chatPayload).supported) {
      preparedPayload.tools = chatPayload.tools
      decision = {
        reason: "endpoint_unavailable",
        source: "responses",
        target: "/chat/completions",
        translated: true,
      }
    }
  }
  if ("code" in decision) throw createEndpointTranslationError(decision)
  recordCopilotRequestNormalization("responses", [
    ...prepared.normalizationClasses,
  ])
  recordCopilotEndpointRoute(decision)
  return { decision, preparedPayload }
}

function isResponsesWarmupPayload(payload: ResponsesPayload): boolean {
  return (payload as Record<string, unknown>).generate === false
}

function stripResponsesWarmupControl(
  payload: ResponsesPayload,
): ResponsesPayload {
  if (!isResponsesWarmupPayload(payload)) return payload
  const routePayload = structuredClone(payload)
  delete (routePayload as Record<string, unknown>).generate
  return routePayload
}

function payloadHasChatFallbackToolRewrite(payload: ResponsesPayload): boolean {
  return (
    Array.isArray(payload.tools)
    && payload.tools.some((tool) => {
      const type = (tool as { type?: unknown }).type
      return (
        (type === "custom" && tool.name === "apply_patch")
        || (typeof type === "string"
          && (type === "web_search" || type.startsWith("web_search_")))
      )
    })
  )
}

function getResponsesMessagesRouteCheck(
  payload: ResponsesPayload,
  selectedModel: Model | undefined,
): { blockers: Array<string>; supported: boolean } {
  const check = checkResponsesToMessagesTranslation(payload)
  const effort = payload.reasoning?.effort
  if (typeof effort !== "string") return check
  const supportedEfforts = selectedModel?.capabilities.supports.reasoning_effort
  if (!supportedEfforts) return check
  if (supportedEfforts.includes(effort)) return check
  return {
    supported: false,
    blockers:
      check.blockers.includes("reasoning_effort") ?
        check.blockers
      : [...check.blockers, "reasoning_effort"],
  }
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

type ResponsesChatCompletionResult = PreparedResponsesChatCompletion["response"]

const isNonStreaming = (
  response: ResponsesChatCompletionResult,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

export const useFunctionApplyPatch = (payload: ResponsesPayload): void => {
  const config = getConfig()
  const useFunctionApplyPatch = config.useFunctionApplyPatch ?? true
  if (useFunctionApplyPatch) {
    logger.debug("Using function tool apply_patch for responses")
    if (Array.isArray(payload.tools)) {
      const toolsArr = payload.tools
      for (let i = 0; i < toolsArr.length; i++) {
        const t = toolsArr[i]
        if (t.type !== "custom" || typeof t.name !== "string") {
          continue
        }

        if (t.name === "apply_patch") {
          toolsArr[i] = {
            type: "function",
            name: t.name,
            description: "Use the `apply_patch` tool to edit files",
            parameters: {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "The entire contents of the apply_patch command",
                },
              },
              required: ["input"],
            },
            strict: false,
          }
        }
      }
    }
  }
}

export const assertResponsesChatFallbackTranslation = (
  payload: ResponsesPayload,
  preserveCustomToolContext: boolean | undefined,
): void => {
  const check = checkResponsesToChatTranslation(payload)
  const blockers =
    preserveCustomToolContext ?
      check.blockers.filter(
        (blocker) =>
          blocker !== "tool_semantics:custom_tool_call"
          && blocker !== "tool_semantics:custom_tool_call_output"
          && blocker !== "tool_semantics:computer_call_output"
          && blocker !== "client_metadata",
      )
    : check.blockers
  assertEndpointTranslationSupported(
    {
      blockers: [],
      code: "endpoint_translation_unsupported",
      source: "responses",
    },
    { supported: blockers.length === 0, blockers },
  )
}

export const convertWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.map((t) => {
    const type = (t as { type?: string }).type
    if (
      typeof type === "string"
      && (type === "web_search" || type.startsWith("web_search_"))
    ) {
      return createWebSearchResponsesTool(t)
    }
    return t
  })
  payload.parallel_tool_calls = false

  const choice = payload.tool_choice as { type?: string } | undefined
  if (
    choice
    && typeof choice.type === "string"
    && (choice.type === "web_search" || choice.type.startsWith("web_search_"))
  ) {
    payload.tool_choice = { type: "function", name: "web_search" }
  }
}

export const disableParallelWebSearch = (payload: ResponsesPayload): void => {
  if (payload.tools?.some((tool) => isResponsesWebSearchFunctionTool(tool))) {
    payload.parallel_tool_calls = false
  }
}

// ─── ChatCompletions fallback for models without /responses support ───

interface CCFunctionCallState {
  itemId: string
  callId: string
  name: string
  arguments: string
  outputIndex: number
}

interface CCStreamState {
  seqNum: number
  responseId: string
  createdAt: number
  resolvedModel: string
  accumulatedText: string
  textItemAdded: boolean
  messageItemId: string
  functionCalls: Map<number, CCFunctionCallState>
  nextOutputIndex: number
  usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  responseCreated: boolean
  pendingFinishReason?: string
  preserveFallbackThinking: boolean
  reasoningText: string
  reasoningOpaque?: string
  encryptedContent?: string
}

type WriteEventFn = (event: string, data: unknown) => Promise<void>

const createCCStreamState = (model: string): CCStreamState => ({
  seqNum: 0,
  responseId: "resp_cc",
  createdAt: Math.floor(Date.now() / 1000),
  resolvedModel: model,
  accumulatedText: "",
  textItemAdded: false,
  messageItemId: "msg_cc_001",
  functionCalls: new Map(),
  nextOutputIndex: 0,
  usage: {},
  responseCreated: false,
  preserveFallbackThinking: isModelFallbackActive(),
  reasoningText: "",
})

function ccFailureOutput(state: CCStreamState): Array<ResponseOutputItem> {
  const output = createPartialTextOutput(
    state.accumulatedText,
    state.messageItemId,
  )
  for (const [, call] of state.functionCalls) {
    output.push({
      id: call.itemId,
      type: "function_call",
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
      status: "in_progress",
    })
  }
  return output
}

const convertInputToMessages = (
  input: ResponsesPayload["input"],
  preserveCustomToolContext: boolean,
): ChatCompletionsPayload["messages"] => {
  const messages: ChatCompletionsPayload["messages"] = []

  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
    return messages
  }

  if (!Array.isArray(input)) return messages

  let pendingToolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []

  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [...pendingToolCalls],
      })
      pendingToolCalls = []
    }
  }

  const convertCustomItem = (
    itemType: unknown,
    item: ResponseInputItem,
  ): boolean => {
    if (!preserveCustomToolContext) return false
    if (itemType === "custom_tool_call") {
      const call = item as {
        call_id: string
        input?: string
        name: string
      }
      flushToolCalls()
      messages.push({
        role: "assistant",
        content:
          `[Custom tool call ${call.call_id}: `
          + `${call.name}(${call.input ?? ""})]`,
      })
      return true
    }
    if (itemType === "custom_tool_call_output") {
      const output = item as { call_id: string; output: unknown }
      messages.push({
        role: "user",
        content:
          `[Custom tool result ${output.call_id}: `
          + `${stringifyResponsesToolOutput(output.output)}]`,
      })
      return true
    }
    if (itemType === "computer_call_output") {
      const output = item as { call_id?: string; output: unknown }
      messages.push({
        role: "user",
        content:
          `[Computer tool result ${output.call_id ?? "unknown"}: `
          + `${stringifyResponsesToolOutput(output.output)}]`,
      })
      return true
    }
    return false
  }

  for (const item of input) {
    const itemType = (item as { type?: string }).type
    if (itemType === "reasoning") continue
    if (itemType === "function_call") {
      const fc = item as { call_id: string; name: string; arguments: string }
      pendingToolCalls.push({
        id: fc.call_id,
        type: "function",
        function: { name: fc.name, arguments: fc.arguments },
      })
      continue
    }
    if (convertCustomItem(itemType, item)) continue
    flushToolCalls()
    if (itemType === "function_call_output") {
      const fco = item as { call_id: string; output: unknown }
      messages.push({
        role: "tool",
        content: convertFunctionCallOutputToCC(fco.output),
        tool_call_id: fco.call_id,
      })
      continue
    }
    if (!itemType || itemType === "message") {
      convertMessageItem(item, messages)
    }
  }

  flushToolCalls()
  return messages
}

const convertResponsesContentToCC = (
  content: Array<Record<string, unknown>>,
): Array<ContentPart> => {
  const parts: Array<ContentPart> = []
  for (const part of content) {
    if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image_url } })
      continue
    }
    if (part.type === "input_file") {
      parts.push({
        type: "file",
        file: {
          ...(typeof part.filename === "string" ?
            { filename: part.filename }
          : {}),
          ...(typeof part.file_data === "string" ?
            { file_data: part.file_data }
          : {}),
          ...(typeof part.file_id === "string" ?
            { file_id: part.file_id }
          : {}),
        },
      })
      continue
    }
    if (typeof part.text === "string") {
      parts.push({ type: "text", text: part.text })
    }
  }
  return parts
}

const flattenTextParts = (
  parts: Array<ContentPart>,
): string | Array<ContentPart> =>
  parts.every((part) => part.type === "text") ?
    parts.map((part) => (part as { text: string }).text).join("")
  : parts

const convertFunctionCallOutputToCC = (
  output: unknown,
): string | Array<ContentPart> => {
  if (typeof output === "string") return output
  if (Array.isArray(output)) {
    const parts = convertResponsesContentToCC(
      output as Array<Record<string, unknown>>,
    )
    if (parts.length > 0) return flattenTextParts(parts)
  }
  return JSON.stringify(output)
}

const stringifyResponsesToolOutput = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output)

const convertMessageItem = (
  item: unknown,
  messages: ChatCompletionsPayload["messages"],
): void => {
  const msg = item as {
    role: "user" | "assistant" | "system" | "developer"
    content?: string | Array<Record<string, unknown>>
  }
  const role = msg.role === "developer" ? "developer" : msg.role
  let content: string | Array<ContentPart>

  if (typeof msg.content === "string") {
    content = msg.content
  } else if (Array.isArray(msg.content)) {
    content = flattenTextParts(convertResponsesContentToCC(msg.content))
  } else {
    content = ""
  }

  messages.push({ role, content })
}

const convertToolsForCC = (
  tools: ResponsesPayload["tools"],
): ChatCompletionsPayload["tools"] => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined

  const converted = tools
    .filter((t): t is FunctionTool => "name" in t && "parameters" in t)
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters ?? {},
      },
    }))

  return converted.length > 0 ? converted : undefined
}

const convertToolChoiceForCC = (
  toolChoice: ResponsesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] => {
  if (!toolChoice) return undefined

  if (typeof toolChoice === "string") {
    return toolChoice as "none" | "auto" | "required"
  }

  if (typeof toolChoice === "object" && "name" in toolChoice) {
    return {
      type: "function",
      function: { name: (toolChoice as { name: string }).name },
    }
  }

  return undefined
}

export const responsesToChatCompletions = (
  payload: ResponsesPayload,
  options: { preserveCustomToolContext?: boolean } = {},
): ChatCompletionsPayload => {
  assertResponsesChatFallbackTranslation(
    payload,
    options.preserveCustomToolContext,
  )

  const messages = convertInputToMessages(
    payload.input,
    options.preserveCustomToolContext ?? false,
  )

  if (payload.instructions) {
    messages.unshift({ role: "system", content: payload.instructions })
  }

  const tools = convertToolsForCC(payload.tools)
  const toolChoice = convertToolChoiceForCC(payload.tool_choice)
  const mappedControls = mapResponsesControlsToChat(payload)

  // Map structured output (text.format) to response_format
  // Preserve json_schema details so normalizePayload can stash the schema
  // before downgrading to json_object
  const textFormat = (payload as Record<string, unknown>).text as
    | { format?: { type: string; schema?: unknown; [key: string]: unknown } }
    | undefined
  let responseFormat:
    | {
        type: string
        json_schema?: { schema: unknown }
        [key: string]: unknown
      }
    | undefined
  if (textFormat?.format?.type === "json_schema") {
    responseFormat = {
      type: "json_schema",
      json_schema: { schema: textFormat.format.schema },
    }
  } else if (textFormat?.format?.type === "json_object") {
    responseFormat = { type: "json_object" }
  }

  return {
    model: payload.model,
    messages,
    ...mappedControls,
    stream: payload.stream ?? false,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(payload.stream ? { stream_options: { include_usage: true } } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  }
}

function mapResponsesControlsToChat(
  payload: ResponsesPayload,
): Pick<
  ChatCompletionsPayload,
  | "max_tokens"
  | "parallel_tool_calls"
  | "reasoning_effort"
  | "temperature"
  | "top_p"
  | "user"
> {
  return {
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_tokens: payload.max_output_tokens,
    parallel_tool_calls: payload.parallel_tool_calls,
    reasoning_effort:
      typeof payload.reasoning?.effort === "string" ?
        payload.reasoning.effort
      : undefined,
    user: payload.user,
  }
}

const chatCompletionToResponsesResult = (
  response: ChatCompletionResponse,
  model: string,
): ResponsesResult => {
  const choice = response.choices[0]
  const output: Array<ResponseOutputItem> = []
  let outputText = ""

  if (choice.message.reasoning_opaque || choice.message.encrypted_content) {
    output.push({
      id: choice.message.reasoning_opaque ?? `rs_${response.id}`,
      type: "reasoning",
      summary:
        choice.message.reasoning_text ?
          [{ type: "summary_text", text: choice.message.reasoning_text }]
        : [],
      ...(choice.message.encrypted_content ?
        { encrypted_content: choice.message.encrypted_content }
      : {}),
    } satisfies ResponseOutputReasoning)
  }

  // Map text content
  if (choice.message.content) {
    outputText = choice.message.content
    output.push({
      id: `msg_${response.id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: choice.message.content,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    } satisfies ResponseOutputMessage)
  }

  // Map tool calls
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        id: `fc_${tc.id}`,
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      } satisfies ResponseOutputFunctionCall)
    }
  }

  // Map finish_reason to status
  let status = "completed"
  let incompleteDetails: ResponsesResult["incomplete_details"] = null
  if (choice.finish_reason === "length") {
    status = "incomplete"
    incompleteDetails = { reason: "max_output_tokens" }
  }

  return {
    id: `resp_${response.id}`,
    object: "response",
    created_at: response.created,
    model,
    output,
    output_text: outputText,
    status,
    usage: mapCCUsage(response.usage),
    error: null,
    incomplete_details: incompleteDetails,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
}

const mapCCUsage = (
  usage: ChatCompletionResponse["usage"],
): ResponseUsage | null => {
  if (!usage) return null
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.prompt_tokens_details ?
      {
        input_tokens_details: {
          cached_tokens: usage.prompt_tokens_details.cached_tokens,
        },
      }
    : {}),
  }
}

const buildCCResponseResult = (
  state: CCStreamState,
  outputItems: Array<ResponseOutputItem>,
  resultOpts: { status: string; outputText: string },
): ResponsesResult => ({
  id: state.responseId,
  object: "response",
  created_at: state.createdAt,
  model: state.resolvedModel,
  output: outputItems,
  output_text: resultOpts.outputText,
  status: resultOpts.status,
  usage: {
    input_tokens: state.usage.inputTokens ?? 0,
    output_tokens: state.usage.outputTokens ?? 0,
    total_tokens:
      (state.usage.inputTokens ?? 0) + (state.usage.outputTokens ?? 0),
    ...(state.usage.cachedTokens === undefined ?
      {}
    : {
        input_tokens_details: {
          cached_tokens: state.usage.cachedTokens,
        },
      }),
  },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
})

const emitTextDelta = async (
  s: CCStreamState,
  content: string,
  writeEvent: WriteEventFn,
): Promise<void> => {
  if (!s.textItemAdded) {
    s.textItemAdded = true
    const textOutputIndex = s.nextOutputIndex++
    await writeEvent("response.output_item.added", {
      item: {
        id: s.messageItemId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
      output_index: textOutputIndex,
      sequence_number: s.seqNum++,
      type: "response.output_item.added",
    })
  }

  s.accumulatedText += content
  await writeEvent("response.output_text.delta", {
    content_index: 0,
    delta: content,
    item_id: s.messageItemId,
    output_index: 0,
    sequence_number: s.seqNum++,
    type: "response.output_text.delta",
  })
}

const emitToolCallDelta = async (
  s: CCStreamState,
  tc: NonNullable<ChatCompletionChunk["choices"][0]["delta"]["tool_calls"]>[0],
  writeEvent: WriteEventFn,
): Promise<void> => {
  const tcIndex = tc.index
  let fcState = s.functionCalls.get(tcIndex)

  if (!fcState) {
    const callId = tc.id ?? `call_cc_${tcIndex}`
    const name = tc.function?.name ?? ""
    fcState = {
      itemId: `fc_${callId}`,
      callId,
      name,
      arguments: "",
      outputIndex: s.nextOutputIndex++,
    }
    s.functionCalls.set(tcIndex, fcState)

    await writeEvent("response.output_item.added", {
      item: {
        id: fcState.itemId,
        type: "function_call",
        call_id: fcState.callId,
        name: fcState.name,
        arguments: "",
        status: "in_progress",
      },
      output_index: fcState.outputIndex,
      sequence_number: s.seqNum++,
      type: "response.output_item.added",
    })
  }

  if (tc.function?.name && !fcState.name) {
    fcState.name = tc.function.name
  }

  if (tc.function?.arguments) {
    fcState.arguments += tc.function.arguments
    await writeEvent("response.function_call_arguments.delta", {
      delta: tc.function.arguments,
      item_id: fcState.itemId,
      output_index: fcState.outputIndex,
      sequence_number: s.seqNum++,
      type: "response.function_call_arguments.delta",
    })
  }
}

const emitDoneEvents = async (
  s: CCStreamState,
  finishReason: string,
  writeEvent: WriteEventFn,
): Promise<"response.completed" | "response.incomplete"> => {
  if (s.accumulatedText) {
    await emitTextDoneEvents(s, writeEvent)
  }

  for (const [, fcState] of s.functionCalls) {
    await emitFunctionCallDoneEvents(s, fcState, writeEvent)
  }

  const reasoning = fallbackStreamReasoning(s)
  if (reasoning) {
    const outputIndex = s.nextOutputIndex++
    await writeEvent("response.output_item.added", {
      item: { ...reasoning, status: "in_progress" },
      output_index: outputIndex,
      sequence_number: s.seqNum++,
      type: "response.output_item.added",
    })
    await writeEvent("response.output_item.done", {
      item: reasoning,
      output_index: outputIndex,
      sequence_number: s.seqNum++,
      type: "response.output_item.done",
    })
  }

  return await emitResponseCompleted(s, finishReason, writeEvent)
}

const emitTextDoneEvents = async (
  s: CCStreamState,
  writeEvent: WriteEventFn,
): Promise<void> => {
  await writeEvent("response.output_text.done", {
    content_index: 0,
    item_id: s.messageItemId,
    output_index: 0,
    sequence_number: s.seqNum++,
    text: s.accumulatedText,
    type: "response.output_text.done",
  })

  await writeEvent("response.output_item.done", {
    item: {
      id: s.messageItemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: s.accumulatedText,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    } satisfies ResponseOutputMessage,
    output_index: 0,
    sequence_number: s.seqNum++,
    type: "response.output_item.done",
  })
}

const emitFunctionCallDoneEvents = async (
  s: CCStreamState,
  fcState: CCFunctionCallState,
  writeEvent: WriteEventFn,
): Promise<void> => {
  await writeEvent("response.function_call_arguments.done", {
    arguments: fcState.arguments,
    item_id: fcState.itemId,
    name: fcState.name,
    output_index: fcState.outputIndex,
    sequence_number: s.seqNum++,
    type: "response.function_call_arguments.done",
  })

  await writeEvent("response.output_item.done", {
    item: {
      id: fcState.itemId,
      type: "function_call",
      call_id: fcState.callId,
      name: fcState.name,
      arguments: fcState.arguments,
      status: "completed",
    } satisfies ResponseOutputFunctionCall,
    output_index: fcState.outputIndex,
    sequence_number: s.seqNum++,
    type: "response.output_item.done",
  })
}

const emitResponseCompleted = async (
  s: CCStreamState,
  finishReason: string,
  writeEvent: WriteEventFn,
): Promise<"response.completed" | "response.incomplete"> => {
  const finalOutput: Array<ResponseOutputItem> = []

  if (s.accumulatedText) {
    finalOutput.push({
      id: s.messageItemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: s.accumulatedText,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    } satisfies ResponseOutputMessage)
  }

  for (const [, fcState] of s.functionCalls) {
    finalOutput.push({
      id: fcState.itemId,
      type: "function_call",
      call_id: fcState.callId,
      name: fcState.name,
      arguments: fcState.arguments,
      status: "completed",
    } satisfies ResponseOutputFunctionCall)
  }

  const reasoning = fallbackStreamReasoning(s)
  if (reasoning) finalOutput.push(reasoning)

  let finalStatus = "completed"
  let incompleteDetails: ResponsesResult["incomplete_details"] = null
  if (finishReason === "length") {
    finalStatus = "incomplete"
    incompleteDetails = { reason: "max_output_tokens" }
  }

  const finalResult = buildCCResponseResult(s, finalOutput, {
    status: finalStatus,
    outputText: s.accumulatedText,
  })
  finalResult.incomplete_details = incompleteDetails

  const terminalEvent =
    finishReason === "length" ? "response.incomplete" : "response.completed"
  await writeEvent(terminalEvent, {
    response: finalResult,
    sequence_number: s.seqNum++,
    type: terminalEvent,
  })
  return terminalEvent
}

export const streamChatCompletionsAsResponses = async (
  stream: {
    writeSSE: (data: { event?: string; data: string }) => Promise<void>
  },
  ccStream: AsyncIterable<{ data?: string; event?: string }>,
  model: string,
): Promise<{
  state: CCStreamState
  terminal?: "response.completed" | "response.incomplete"
}> =>
  await streamChatCompletionsAsResponsesWithState({
    stream,
    ccStream,
    state: createCCStreamState(model),
  })

const streamChatCompletionsAsResponsesWithState = async (options: {
  stream: {
    writeSSE: (data: { event?: string; data: string }) => Promise<void>
  }
  ccStream: AsyncIterable<{ data?: string; event?: string }>
  state: CCStreamState
}): Promise<{
  state: CCStreamState
  terminal?: "response.completed" | "response.incomplete"
}> => {
  const s = options.state
  let terminal: "response.completed" | "response.incomplete" | undefined

  const writeEvent: WriteEventFn = async (event, data) => {
    await options.stream.writeSSE({ event, data: JSON.stringify(data) })
  }

  for await (const rawEvent of options.ccStream) {
    if (terminal) break
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue

    const chunk = parseRecoverableStreamJson({
      data: rawEvent.data,
      event: rawEvent.event,
      protocol: "Chat-to-Responses",
      terminal: false,
    }) as ChatCompletionChunk | undefined
    if (chunk === undefined) continue
    if (hasNonNullStreamError(chunk)) {
      throw chunk.error
    }
    if (s.pendingFinishReason) {
      if (chunk.usage) s.usage = extractCCUsage(chunk.usage)
      continue
    }
    await processChatCompletionsChunk(s, chunk, writeEvent)
  }

  if (!terminal && s.pendingFinishReason) {
    terminal = await emitDoneEvents(s, s.pendingFinishReason, writeEvent)
  }

  return { state: s, terminal }
}

async function processChatCompletionsChunk(
  state: CCStreamState,
  chunk: ChatCompletionChunk,
  writeEvent: WriteEventFn,
): Promise<void> {
  // The state is request-local and processed serially by the owning iterator.

  if (chunk.id) state.responseId = `resp_${chunk.id}`
  if (chunk.created) state.createdAt = chunk.created
  if (chunk.usage) state.usage = extractCCUsage(chunk.usage)
  const shouldCreateResponse = !state.responseCreated
  if (shouldCreateResponse) {
    state.responseCreated = true
    const skeleton = buildCCResponseResult(state, [], {
      status: "in_progress",
      outputText: "",
    })
    await writeEvent("response.created", {
      response: skeleton,
      sequence_number: state.seqNum++,
      type: "response.created",
    })
  }
  const choice = chunk.choices.at(0)
  if (choice?.delta) {
    if (state.preserveFallbackThinking) {
      if (choice.delta.reasoning_text)
        state.reasoningText += choice.delta.reasoning_text
      if (choice.delta.reasoning_opaque)
        state.reasoningOpaque = choice.delta.reasoning_opaque
      if (choice.delta.encrypted_content)
        state.encryptedContent = choice.delta.encrypted_content
    }
    const content = choice.delta.content as string | undefined
    if (content) await emitTextDelta(state, content, writeEvent)
    for (const toolCall of choice.delta.tool_calls ?? []) {
      await emitToolCallDelta(state, toolCall, writeEvent)
    }
  }
  const finishReason = choice?.finish_reason
  // eslint-disable-next-line require-atomic-updates
  if (finishReason) state.pendingFinishReason = finishReason
}

function fallbackStreamReasoning(
  state: CCStreamState,
): ResponseOutputReasoning | undefined {
  if (
    !state.preserveFallbackThinking
    || (!state.reasoningOpaque
      && !state.reasoningText
      && !state.encryptedContent)
  )
    return undefined
  return {
    id: state.reasoningOpaque ?? `rs_${state.responseId}`,
    type: "reasoning",
    summary:
      state.reasoningText ?
        [{ type: "summary_text", text: state.reasoningText }]
      : [],
    status: "completed",
    ...(state.encryptedContent ?
      { encrypted_content: state.encryptedContent }
    : {}),
  }
}

const handleWithAnthropicMessages = async (options: {
  c: Context
  nativeOptions: NativeMessagesRequestOptions
  preparedPayload: import("../messages/anthropic-types").AnthropicMessagesPayload
  responseContext: ResponsesPayload
}) => {
  const { c, nativeOptions, preparedPayload, responseContext } = options
  const requestedModel = nativeOptions.requestedModel ?? responseContext.model
  setRequestContext(c, { provider: "Responses→AnthropicMessages" })
  const compaction = isResponsesCompactionRequest(responseContext)
  if (!responseContext.stream) {
    const result = await executePreparedResponsesMessagesBridge({
      compaction,
      nativeOptions,
      payload: preparedPayload,
      responseContext,
      signal: c.req.raw.signal,
    })
    setResponsesResultContext(c, result)
    return c.json(result)
  }

  const upstreamController = new AbortController()
  const signal = AbortSignal.any([c.req.raw.signal, upstreamController.signal])
  const pendingResult = executePreparedResponsesMessagesBridge({
    compaction,
    nativeOptions,
    payload: preparedPayload,
    responseContext,
    signal,
  })
  const preflush = await raceSsePreflush(pendingResult)

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => upstreamController.abort())
    const failureState = createResponsesStreamFailureState(requestedModel)
    failureState.responseId = "resp_messages_failed"
    const lifecycle = createResponsesTerminalLifecycle({
      c,
      stream,
      state: failureState,
    })
    stream.onAbort(() => {
      lifecycle.abort()
    })
    try {
      if (preflush.kind === "pending") await writeSseHeartbeat(stream)
      const result =
        preflush.kind === "settled" ?
          preflush.value
        : unwrapSsePreflushSettlement(
            await withHeartbeatWhilePending(preflush.pending, stream),
          )
      if (stream.aborted || stream.closed) return
      setResponsesResultContext(c, result)
      await emitResponsesResultAsStream(stream, result)
      await lifecycle.succeed("synthetic")
    } catch (error) {
      if (isAbortError(error) || stream.aborted || stream.closed) {
        lifecycle.abort()
        return
      }
      const inspection =
        isHTTPError(error) ? await inspectHttpError(error) : undefined
      if (inspection?.status === 499) {
        lifecycle.abort()
        return
      }
      await lifecycle.fail({ kind: "thrown", error, inspection })
    }
  })
}

function setResponsesResultContext(c: Context, result: ResponsesResult): void {
  const nativeAccountId = getLastUsedAccountId()
  if (nativeAccountId !== undefined) {
    setRequestContext(c, { accountId: nativeAccountId })
  }
  if (!result.usage) return
  setRequestContext(c, {
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
  })
}

export const handleWithChatCompletions = async (
  c: Context,
  ccPayload: ChatCompletionsPayload,
  options: {
    completionFactory?: ResponsesChatCompletionFactory
    requestedModel?: string
    copilotSessionToken?: string
    webSearchMaxUses?: number
  } = {},
) => {
  const responseModel = options.requestedModel ?? ccPayload.model
  const completionFactory: ResponsesChatCompletionFactory =
    options.completionFactory
    ?? (async (payload, factoryOptions) => {
      const result = await createChatCompletionsWithProcessedPayload(payload, {
        allowCompatibilityRetry: factoryOptions.allowCompatibilityRetry,
        candidatePrepared: true,
        copilotSessionToken: options.copilotSessionToken,
        signal: factoryOptions.signal,
      })
      return {
        ...result,
        accountId: getLastUsedAccountId(),
      }
    })
  const needsWebSearch =
    ccPayload.tools?.some((tool) => tool.function.name === "web_search")
    ?? false
  logger.debug("Prepared Chat fallback request", {
    messageCount: ccPayload.messages.length,
    model: ccPayload.model,
    stream: Boolean(ccPayload.stream),
    toolCount: ccPayload.tools?.length ?? 0,
  })

  // Non-streaming: span wraps the entire call + response processing
  if (!ccPayload.stream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: ccPayload.messages,
        model: ccPayload.model,
      }),
      async (span) => {
        const initial = await completionFactory(ccPayload, {
          signal: c.req.raw.signal,
        })
        const response = initial.response

        // Track which account handled this request (multi-token mode)
        if (initial.accountId !== undefined) {
          setRequestContext(c, { accountId: initial.accountId })
        }

        const ccResponse =
          needsWebSearch ?
            await resolvePreparedResponsesWebSearchCalls({
              completionFactory,
              initial,
              maxUses: options.webSearchMaxUses,
              signal: c.req.raw.signal,
            })
          : (response as ChatCompletionResponse)
        logger.debug("Received Chat fallback response", {
          choiceCount: ccResponse.choices.length,
          model: ccResponse.model,
        })

        if (ccResponse.usage) {
          setRequestContext(c, {
            inputTokens: ccResponse.usage.prompt_tokens,
            outputTokens: ccResponse.usage.completion_tokens,
          })
        }

        const inputTokens = ccResponse.usage?.prompt_tokens ?? 0
        const outputTokens = ccResponse.usage?.completion_tokens ?? 0
        span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
        span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
        const cachedTokens =
          ccResponse.usage?.prompt_tokens_details?.cached_tokens ?? 0
        setDetailedTokenAttributes(span, { cachedTokens })
        setSentryOutputMessages(
          span,
          ccResponse.choices[0]?.message?.content ?? "",
        )

        const result = chatCompletionToResponsesResult(
          ccResponse,
          responseModel,
        )
        return c.json(result)
      },
    )
  }

  logger.debug("ChatCompletions fallback streaming")

  if (needsWebSearch) {
    return handleStreamingChatFallbackWebSearch(c, {
      ccPayload,
      completionFactory,
      responseModel,
      webSearchMaxUses: options.webSearchMaxUses,
    })
  }

  return await Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: ccPayload.messages,
      model: ccPayload.model,
      streaming: true,
    }),
    async (streamSpan, finish) => {
      let spanFinished = false
      const finishSpan = () => {
        if (spanFinished) return
        spanFinished = true
        finish()
      }

      try {
        const initial = await completionFactory(ccPayload, {
          signal: c.req.raw.signal,
        })
        const response = initial.response

        if (initial.accountId !== undefined) {
          setRequestContext(c, { accountId: initial.accountId })
        }

        if (isNonStreaming(response)) {
          if (response.usage) {
            setRequestContext(c, {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens,
            })
          }

          streamSpan.setAttribute(
            "gen_ai.usage.input_tokens",
            response.usage?.prompt_tokens ?? 0,
          )
          streamSpan.setAttribute(
            "gen_ai.usage.output_tokens",
            response.usage?.completion_tokens ?? 0,
          )
          const cachedTokens =
            response.usage?.prompt_tokens_details?.cached_tokens ?? 0
          setDetailedTokenAttributes(streamSpan, { cachedTokens })
          setSentryOutputMessages(
            streamSpan,
            response.choices[0]?.message?.content ?? "",
          )
          finishSpan()

          const result = chatCompletionToResponsesResult(
            response,
            responseModel,
          )
          return c.json(result)
        }

        return streamSSE(c, async (sseStream) => {
          const chatState = createCCStreamState(responseModel)
          const failureState = createResponsesStreamFailureState(responseModel)
          const lifecycle = createResponsesTerminalLifecycle({
            c,
            stream: sseStream,
            state: failureState,
          })
          sseStream.onAbort(() => {
            lifecycle.abort()
          })
          try {
            const ccStream = response as AsyncIterable<{
              data?: string
              event?: string
            }>
            const outcome = await streamChatCompletionsAsResponsesWithState({
              stream: sseStream,
              ccStream: withSseHeartbeat(ccStream, sseStream),
              state: chatState,
            })
            failureState.responseId = outcome.state.responseId
            failureState.model = outcome.state.resolvedModel
            failureState.createdAt = outcome.state.createdAt
            failureState.sequenceNumber = outcome.state.seqNum
            failureState.outputText = outcome.state.accumulatedText
            failureState.output = ccFailureOutput(outcome.state)
            failureState.usage =
              buildCCResponseResult(outcome.state, [], {
                status: "in_progress",
                outputText: outcome.state.accumulatedText,
              }).usage ?? null
            await (outcome.terminal ?
              lifecycle.succeed(outcome.terminal)
            : lifecycle.finishSource())

            setRequestContext(c, {
              inputTokens: outcome.state.usage.inputTokens,
              outputTokens: outcome.state.usage.outputTokens,
            })

            streamSpan.setAttribute(
              "gen_ai.usage.input_tokens",
              outcome.state.usage.inputTokens ?? 0,
            )
            streamSpan.setAttribute(
              "gen_ai.usage.output_tokens",
              outcome.state.usage.outputTokens ?? 0,
            )
            const cachedTokens = outcome.state.usage.cachedTokens ?? 0
            setDetailedTokenAttributes(streamSpan, { cachedTokens })
            setSentryOutputMessages(streamSpan, outcome.state.accumulatedText)
          } catch (error) {
            failureState.responseId = chatState.responseId
            failureState.model = chatState.resolvedModel
            failureState.createdAt = chatState.createdAt
            failureState.sequenceNumber = chatState.seqNum
            failureState.outputText = chatState.accumulatedText
            failureState.output = ccFailureOutput(chatState)
            failureState.usage =
              buildCCResponseResult(chatState, [], {
                status: "in_progress",
                outputText: chatState.accumulatedText,
              }).usage ?? null
            if (isAbortError(error) || sseStream.aborted || sseStream.closed) {
              lifecycle.abort()
              return
            }
            const inspection =
              isHTTPError(error) ? await inspectHttpError(error) : undefined
            if (inspection?.status === 499) {
              lifecycle.abort()
              return
            }
            await lifecycle.fail({ kind: "thrown", error, inspection })
          } finally {
            finishSpan()
          }
        })
      } catch (error) {
        finishSpan()
        throw error
      }
    },
  )
}

function handleStreamingChatFallbackWebSearch(
  c: Context,
  options: {
    ccPayload: ChatCompletionsPayload
    completionFactory: ResponsesChatCompletionFactory
    responseModel: string
    webSearchMaxUses?: number
  },
): Response {
  return streamSSE(c, async (stream) => {
    const failureState = createResponsesStreamFailureState(
      options.responseModel,
    )
    const lifecycle = createResponsesTerminalLifecycle({
      c,
      stream,
      state: failureState,
    })
    stream.onAbort(() => {
      lifecycle.abort()
    })
    try {
      const result = await withHeartbeatWhilePending(
        (async () => {
          const payload = {
            ...options.ccPayload,
            stream: false,
            stream_options: null,
          }
          const initialCompletion = await options.completionFactory(payload, {
            signal: c.req.raw.signal,
          })
          const response = await resolvePreparedResponsesWebSearchCalls({
            completionFactory: options.completionFactory,
            initial: initialCompletion,
            maxUses: options.webSearchMaxUses,
            signal: c.req.raw.signal,
          })
          return chatCompletionToResponsesResult(
            response,
            options.responseModel,
          )
        })(),
        stream,
      )
      if (stream.aborted || stream.closed) {
        lifecycle.abort()
        return
      }
      await emitResponsesResultAsStream(stream, result)
      await lifecycle.succeed("synthetic")
    } catch (error) {
      if (isAbortError(error) || stream.aborted || stream.closed) {
        lifecycle.abort()
        return
      }
      const inspection =
        isHTTPError(error) ? await inspectHttpError(error) : undefined
      if (inspection?.status === 499) {
        lifecycle.abort()
        return
      }
      await lifecycle.fail({ kind: "thrown", error, inspection })
    }
  })
}
