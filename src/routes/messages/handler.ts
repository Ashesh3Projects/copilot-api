/* eslint-disable max-lines, max-lines-per-function, complexity */
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import { streamSSE } from "hono/streaming"

import type { RoutedAccountPin } from "~/lib/account-router"
import type {
  EndpointRouteDecision,
  EndpointRouteFailure,
} from "~/lib/endpoint-routing"
import type { Model } from "~/services/copilot/get-models"
import type { RetryBudget } from "~/services/copilot/transport-retry"

import {
  getLastUsedAccountId,
  runWithRoutedModelSelection,
  selectRoutedModel,
} from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
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
  getModelEndpointSupport,
  selectEvaluatedCopilotCandidate,
} from "~/lib/endpoint-routing"
import {
  createEndpointTranslationError,
  inspectHttpError,
  isAbortError,
  isHTTPError,
  LocalHTTPError,
} from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import {
  applyModelFallbackToPayload,
  captureModelFallbackNotice,
  runWithModelFallback,
} from "~/lib/model-fallback"
import { applyMessagesModelFallbackNotice } from "~/lib/model-fallback-notice"
import {
  applyModelRedirect,
  formatModelRedirectResult,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
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
import {
  installRoutingAffinityFallback,
  resolveClaudeRoutingAffinity,
} from "~/lib/routing-affinity"
import {
  createSentryChatSpanOptions,
  createSentryInvokeAgentSpanOptions,
  setSentryOutputMessages,
  setSentryConversationIdFromRequest,
} from "~/lib/sentry"
import {
  raceSsePreflush,
  unwrapSsePreflushSettlement,
  withHeartbeatWhilePending,
  withSseHeartbeat,
  writeSseHeartbeat,
} from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { getTokenCount } from "~/lib/tokenizer"
import { emitAnthropicToolSpans } from "~/lib/tool-spans"
import {
  closeResponsesOpenBlocks,
  createResponsesNormalTerminalEvents,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import { isWebSearchToolType } from "~/services/copilot/mcp-web-search"
import {
  createInvalidAnthropicMessagesJsonError,
  getCanonicalAnthropicBetaIdentifiers,
  prepareAnthropicMessagesRequest,
  validateAnthropicRequestHeaderOptions,
} from "~/services/copilot/messages-contract"
import { createRetryBudget } from "~/services/copilot/transport-retry"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
  isAnthropicTextBlock,
} from "./anthropic-types"
import {
  prepareMessagesChatCandidate,
  prepareMessagesCandidates,
} from "./messages-candidates"
import {
  handleWithNativeMessages,
  type NativeMessagesRequestOptions,
} from "./native-handler"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  createMessagesTerminalAdapter,
  type MessagesTerminalAdapter,
  writeAnthropicEvents,
} from "./stream-lifecycle"
import {
  closeAnthropicOpenBlocks,
  createFallbackMessageDeltaEvents,
  translateChunkToAnthropicEvents,
} from "./stream-translation"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import {
  emitAnthropicResponseAsStream,
  extractWebSearchCalls,
  hasWebSearchInChunks,
  reconstructFromChunks,
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "./web-search-helpers"

export function selectMessagesUpstreamEndpoint(options: {
  payload: AnthropicMessagesPayload
  selectedModel: Model | undefined
}): EndpointRouteDecision | EndpointRouteFailure {
  const support =
    options.selectedModel ?
      getModelEndpointSupport(options.selectedModel)
    : {
        chat: true,
        embeddings: false,
        messages: false,
        responses: false,
        responsesWebSocket: false,
      }
  const endpoints = ["/v1/messages", "/responses", "/chat/completions"] as const
  const candidate = endpoints.find((endpoint) => {
    if (endpoint === "/v1/messages") return support.messages
    if (endpoint === "/responses") return support.responses
    return support.chat
  })
  if (!candidate) {
    return {
      blockers: [],
      code: "endpoint_translation_unsupported",
      source: "messages",
    }
  }
  return {
    reason: candidate === "/v1/messages" ? "native" : "endpoint_unavailable",
    source: "messages",
    target: candidate,
    translated: candidate !== "/v1/messages",
  }
}

/**
 * Strip thinking blocks from all assistant messages in the payload.
 * Returns true if any thinking blocks were removed.
 * Used to recover from "Invalid signature in thinking block" errors
 * when models are switched mid-conversation.
 */
export { stripThinkingBlocks } from "./thinking-recovery"

const logger = createHandlerLogger("messages-handler")

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

function applyReplacedChatTextToMessages(
  payload: AnthropicMessagesPayload,
  replacedMessages: ChatCompletionsPayload["messages"],
): void {
  const replacementTexts = replacedMessages.flatMap((message) => {
    if (typeof message.content === "string") return [message.content]
    if (!Array.isArray(message.content)) return []
    return message.content.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    )
  })
  const originalTextCount = payload.messages.reduce((count, message) => {
    if (typeof message.content === "string") return count + 1
    if (!Array.isArray(message.content)) return count
    return (
      count
      + message.content.filter((block) => isAnthropicTextBlock(block)).length
    )
  }, 0)
  if (replacementTexts.length !== originalTextCount) return
  let replacementIndex = 0
  for (const message of payload.messages) {
    if (typeof message.content === "string") {
      const replacement = replacementTexts[replacementIndex]
      replacementIndex += 1
      message.content = replacement
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!isAnthropicTextBlock(block)) continue
      const replacement = replacementTexts[replacementIndex]
      replacementIndex += 1
      block.text = replacement
    }
  }
}

const hasWebSearchToolInPayload = (
  tools: AnthropicMessagesPayload["tools"],
): boolean => {
  if (!tools) return false
  return tools.some((tool) => isWebSearchToolType(tool))
}

export async function handleCompletion(c: Context) {
  let rawPayload: AnthropicMessagesPayload
  try {
    rawPayload = await c.req.json<AnthropicMessagesPayload>()
  } catch {
    throw createInvalidAnthropicMessagesJsonError()
  }
  const preparedMessages = prepareAnthropicMessagesRequest({
    payload: rawPayload,
  })
  const anthropicPayload = preparedMessages.body
  const nativeOptions: NativeMessagesRequestOptions =
    validateAnthropicRequestHeaderOptions({
      anthropicBeta: c.req.header("anthropic-beta"),
      anthropicVersion: c.req.header("anthropic-version"),
      modelProviderPreference: c.req.header("x-model-provider-preference"),
    })
  installRoutingAffinityFallback(
    resolveClaudeRoutingAffinity(anthropicPayload.metadata),
  )
  const conversationId = setSentryConversationIdFromRequest(c, anthropicPayload)
  logger.debug("Received Anthropic request", {
    messageCount: anthropicPayload.messages.length,
    stream: Boolean(anthropicPayload.stream),
    toolCount: anthropicPayload.tools?.length ?? 0,
  })

  const model = normalizeModelName(
    parseModelSuffix(anthropicPayload.model).baseModel,
  )

  return await Sentry.startSpan(
    createSentryInvokeAgentSpanOptions(model, conversationId),
    async () => {
      recordCopilotRequestNormalization(
        "messages",
        preparedMessages.normalizationClasses,
      )
      recordCopilotMessagesBeta(nativeOptions.anthropicBeta)
      return await runWithModelFallback(
        {
          headers: c.req.raw.headers,
          payload: anthropicPayload,
          signal: c.req.raw.signal,
        },
        async () => {
          const response = await handleCompletionInner(
            c,
            structuredClone(anthropicPayload),
            nativeOptions,
          )
          return await applyMessagesModelFallbackNotice(
            response,
            { payload: anthropicPayload, headers: c.req.raw.headers },
            captureModelFallbackNotice(),
          )
        },
      )
    },
  )
}

async function handleCompletionInner(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  nativeOptions: NativeMessagesRequestOptions,
) {
  // Emit synthetic tool execution spans from tool results in message history
  emitAnthropicToolSpans(anthropicPayload.messages)

  // Capture the originally requested model before any manipulation
  const requestedModel = anthropicPayload.model

  // Parse model suffix for reasoning effort override (e.g. "claude-sonnet-4.6:high")
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    anthropicPayload.model,
  )
  // Normalize model name (e.g. "claude-opus-4-6[1m]" → "claude-opus-4.6-1m")
  const normalized = normalizeModelName(baseModel)

  const bodyEffortOverride = getOutputConfigReasoningEffort(anthropicPayload)
  const requestedRawEffort = suffixEffort ?? bodyEffortOverride
  const requestedEffort = normalizeReasoningEffortForModel(
    normalized,
    requestedRawEffort,
  )
  if (requestedRawEffort && requestedEffort !== requestedRawEffort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested effort ${requestedRawEffort} for ${normalized} was clamped to ${requestedEffort}`,
      data: {
        model: normalized,
        requestedEffort: requestedRawEffort,
        effectiveEffort: requestedEffort,
      },
    })
  }

  // Apply silent model redirect (response will still report requestedModel)
  const redirect = await applyModelRedirect({
    model: normalized,
    effort: requestedEffort,
  })
  if (redirect.redirected) {
    recordNonDefaultBehavior(c, {
      kind: "model_redirect",
      message: `Model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: normalized,
        sourceEffort: requestedEffort,
        targetModel: redirect.model,
        targetEffort: redirect.effort,
        targetVerbosity: redirect.verbosity,
        ruleId: redirect.ruleId,
        ruleIds: redirect.ruleIds?.join(","),
      },
    })
  }
  let redirectEffort = normalizeReasoningEffortForModel(
    redirect.model,
    redirect.effort,
  )
  if (redirect.effort && redirectEffort !== redirect.effort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested redirected effort ${redirect.effort} for ${redirect.model} was clamped to ${redirectEffort}`,
      data: {
        model: redirect.model,
        requestedEffort: redirect.effort,
        effectiveEffort: redirectEffort,
      },
    })
  }
  // eslint-disable-next-line require-atomic-updates
  anthropicPayload.model = redirect.model

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  const initiatorOverride = subagentMarker ? "agent" : undefined
  if (subagentMarker) logger.debug("Detected Subagent marker")

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)

  const { anthropicBeta } = nativeOptions
  logger.debug("Anthropic Beta header present:", Boolean(anthropicBeta))

  // Route to model variants based on client signals
  const modelWasRedirected =
    redirect.redirected
    || applyModelVariantRouting(c, anthropicPayload, anthropicBeta)

  const { payload: replacementPayload, appliedRules } =
    await applyReplacementsToPayload(translateToOpenAI(anthropicPayload))
  if (appliedRules.length > 0) {
    setRequestContext(c, { replacements: appliedRules })
    applyReplacedChatTextToMessages(
      anthropicPayload,
      replacementPayload.messages,
    )
  }

  const beforeModelFallback = anthropicPayload.model
  applyModelFallbackToPayload(anthropicPayload)
  redirectEffort = normalizeReasoningEffortForModel(
    anthropicPayload.model,
    redirectEffort,
  )
  const customReference = resolveCustomChatModel(anthropicPayload.model)
  if (customReference) {
    const customCandidate = await prepareMessagesChatCandidate({
      source: anthropicPayload,
      applyCopilotSemantics: false,
      effortOverride: redirectEffort,
      signal: c.req.raw.signal,
    })
    if (state.manualApprove) await awaitApproval()
    setRequestContext(c, {
      requestedModel,
      model: anthropicPayload.model,
      provider: "ChatCompletions",
      reasoningEffort:
        redirectEffort ?? getBodyReasoningEffort(anthropicPayload),
    })
    const customPayload = {
      ...customCandidate.payload,
      model: customReference.requestedModel,
    }
    return await executeCustomProviderChatCompletions(c, {
      reference: customReference,
      payload: customPayload,
      requestedModel,
      appliedRules: [],
      reasoningEffort: redirectEffort,
      webSearchMaxUses: customCandidate.webSearchMaxUses,
    })
  }

  const inboundSessionToken = c.req.header("copilot-session-token")
  const copilotSessionToken =
    (
      sessionTokenMatchesModel({
        token: inboundSessionToken,
        requestedModel: baseModel,
        finalModel: anthropicPayload.model,
        modelWasRedirected:
          modelWasRedirected || anthropicPayload.model !== beforeModelFallback,
      })
    ) ?
      inboundSessionToken
    : undefined

  const routedModel = selectRoutedModel(anthropicPayload.model, {
    copilotSessionToken,
  })
  const selectedModel = routedModel.model
  if (state.models && !selectedModel) throw createMessagesModelNotFoundError()
  const routingModel =
    selectedModel
    ?? ({
      id: anthropicPayload.model,
      name: anthropicPayload.model,
      object: "model",
      version: "unknown",
      supported_endpoints: ["/chat/completions"],
      capabilities: {
        family: "unknown",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    } satisfies Model)

  const candidates = await prepareMessagesCandidates({
    source: anthropicPayload,
    selectedModel: routingModel,
    effortOverride: redirectEffort,
    preserveNativeBodyEffort:
      suffixEffort === undefined && !redirect.redirected,
    responsesVerbosity: redirect.verbosity,
    isCompact,
    signal: c.req.raw.signal,
  })
  const selection = selectEvaluatedCopilotCandidate({
    candidates: candidates.ordered,
    source: "messages",
    support: getModelEndpointSupport(routingModel),
  })
  if ("code" in selection) throw createEndpointTranslationError(selection)
  const { candidate, decision: routeDecision } = selection
  recordCopilotTranslationFindings(
    "messages",
    candidate.endpoint,
    candidate.check,
  )
  recordCopilotEndpointRoute(routeDecision)

  if (state.manualApprove) await awaitApproval()

  let apiType = "ChatCompletions"
  if (routeDecision.target === "/v1/messages") {
    apiType = "AnthropicMessages"
  } else if (routeDecision.target === "/responses") {
    apiType = "Responses"
  }
  if (routeDecision.translated) {
    recordNonDefaultBehavior(c, {
      kind: "endpoint_fallback",
      message: `Model ${anthropicPayload.model} does not support native /v1/messages; falling back to ${apiType}`,
      data: {
        model: anthropicPayload.model,
        sourceEndpoint: "AnthropicMessages",
        targetEndpoint: apiType,
      },
    })
  }

  // Determine effective reasoning effort for logging
  const bodyEffort = getBodyReasoningEffort(anthropicPayload)
  const effectiveEffort = redirectEffort ?? bodyEffort
  const effortOverride = redirectEffort

  setRequestContext(c, {
    requestedModel,
    model: anthropicPayload.model,
    provider: apiType,
    reasoningEffort: effectiveEffort,
  })

  return await runWithRoutedModelSelection(routedModel, async () => {
    const retryBudget = createRetryBudget()
    const routedAccountPin: RoutedAccountPin = {}
    if (candidate.endpoint === "/v1/messages") {
      const requestOptions: NativeMessagesRequestOptions = {
        ...nativeOptions,
        requestedModel,
        originalStream: Boolean(anthropicPayload.stream),
        retryBudget,
        routedAccountPin,
        toolsPrepared: true,
        compaction: candidate.compaction,
        copilotSessionToken,
        ...(initiatorOverride ? { initiatorOverride } : {}),
      }
      return await handleWithNativeMessages(
        c,
        candidate.payload,
        requestOptions,
      )
    }

    if (candidate.endpoint === "/responses") {
      return await handleWithResponsesApi(c, anthropicPayload, {
        copilotSessionToken,
        initiatorOverride,
        effortOverride,
        requestedModel,
        retryBudget,
        routedAccountPin,
        preparedPayload: candidate.payload,
        webSearchMaxUses: candidate.webSearchMaxUses,
      })
    }

    return await handleWithChatCompletions(c, anthropicPayload, {
      copilotSessionToken,
      initiatorOverride,
      effortOverride,
      requestedModel,
      retryBudget,
      routedAccountPin,
      preparedPayload: candidate.payload,
      webSearchMaxUses: candidate.webSearchMaxUses,
    })
  })
}

interface BufferedChatCompletionsResult {
  hadWebSearch: boolean
  initialResponse: ChatCompletionResponse | null
}

function setOptionalTokenDetails(
  span: Sentry.Span,
  cachedTokens: number,
  reasoningTokens = 0,
): void {
  if (cachedTokens > 0) {
    span.setAttribute("gen_ai.usage.input_tokens.cached", cachedTokens)
  }
  if (reasoningTokens > 0) {
    span.setAttribute("gen_ai.usage.output_tokens.reasoning", reasoningTokens)
  }
}

function setChatCompletionSpanResult(
  span: Sentry.Span,
  response: ChatCompletionResponse | null,
): void {
  const inputTokens = response?.usage?.prompt_tokens ?? 0
  const outputTokens = response?.usage?.completion_tokens ?? 0
  const cachedTokens =
    response?.usage?.prompt_tokens_details?.cached_tokens ?? 0
  span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
  span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
  setOptionalTokenDetails(span, cachedTokens)
  setSentryOutputMessages(span, response?.choices[0]?.message?.content ?? "")
}

const streamChatCompletionsWithWebSearch = async (
  target: { stream: SSEStream; owner: MessagesStreamOwner },
  response: AsyncIterable<{ data?: string }>,
  requestedModel?: string,
): Promise<BufferedChatCompletionsResult> => {
  const { stream, owner } = target
  const bufferedChunks: Array<ChatCompletionChunk> = []
  let finalSeen = false
  const iterator = response[Symbol.asyncIterator]()

  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      const rawEvent = next.value
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue
      const parsedValue = parseRecoverableStreamJson({
        data: rawEvent.data,
        protocol: "Chat-to-Messages",
        terminal: false,
      })
      if (parsedValue === undefined) continue
      if (hasNonNullStreamError(parsedValue)) {
        await owner.adapter.failReceived(createReceivedChatMessagesError())
        break
      }
      const chunk = parsedValue as ChatCompletionChunk
      bufferedChunks.push(chunk)
      if (hasChatFinishReason(chunk)) {
        finalSeen = true
        await consumeTrailingChatUsage(iterator, (usageChunk) => {
          bufferedChunks.push(usageChunk)
        })
        break
      }
    }
  } catch (error) {
    if (!finalSeen) throw error
  }

  if (owner.adapter.lifecycle.state !== "open") {
    return { hadWebSearch: false, initialResponse: null }
  }

  const initialResponse = reconstructFromChunks(bufferedChunks)

  if (hasWebSearchInChunks(bufferedChunks)) {
    return { hadWebSearch: true, initialResponse }
  }

  // No web_search calls — replay buffered chunks
  const streamState: AnthropicStreamState = {
    terminal: "open",
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
  owner.setCloseOpenBlocks(() => closeAnthropicOpenBlocks(streamState))

  for (const chunk of bufferedChunks) {
    const events = translateChunkToAnthropicEvents(
      chunk,
      streamState,
      requestedModel,
    )
    for (const event of events) {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    }
  }

  await (streamState.pendingFinishReason ?
    owner.adapter.succeed(async () => {
      await writeAnthropicEvents(
        stream,
        createFallbackMessageDeltaEvents(streamState),
      )
    })
  : owner.adapter.finishSource())

  return { hadWebSearch: false, initialResponse }
}

const streamChatCompletionsDirect = async (
  target: { stream: SSEStream; owner: MessagesStreamOwner },
  response: AsyncIterable<{ data?: string }>,
  requestedModel?: string,
): Promise<{
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  responseText: string
}> => {
  const { stream, owner } = target
  const streamState: AnthropicStreamState = {
    terminal: "open",
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
  owner.setCloseOpenBlocks(() => closeAnthropicOpenBlocks(streamState))

  let streamInputTokens = 0
  let streamOutputTokens = 0
  let streamCachedTokens = 0
  let streamText = ""
  let finalSeen = false
  const iterator = response[Symbol.asyncIterator]()

  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      const rawEvent = next.value
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue
      const parsedValue = parseRecoverableStreamJson({
        data: rawEvent.data,
        protocol: "Chat-to-Messages",
        terminal: false,
      })
      if (parsedValue === undefined) continue
      if (hasNonNullStreamError(parsedValue)) {
        await owner.adapter.failReceived(createReceivedChatMessagesError())
        break
      }
      const chunk = parsedValue as ChatCompletionChunk

      if (chunk.usage) {
        streamInputTokens = chunk.usage.prompt_tokens
        streamOutputTokens = chunk.usage.completion_tokens
        streamCachedTokens =
          chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
      }
      for (const choice of chunk.choices) {
        streamText += choice.delta.content ?? ""
      }

      const events = translateChunkToAnthropicEvents(
        chunk,
        streamState,
        requestedModel,
      )
      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
      if (streamState.pendingFinishReason) {
        finalSeen = true
        await consumeTrailingChatUsage(iterator, (usageChunk) => {
          if (!usageChunk.usage) return
          streamInputTokens = usageChunk.usage.prompt_tokens
          streamOutputTokens = usageChunk.usage.completion_tokens
          streamCachedTokens =
            usageChunk.usage.prompt_tokens_details?.cached_tokens ?? 0
          translateChunkToAnthropicEvents(
            usageChunk,
            streamState,
            requestedModel,
          )
        })
        await owner.adapter.succeed(async () => {
          await writeAnthropicEvents(
            stream,
            createFallbackMessageDeltaEvents(streamState),
          )
        })
        break
      }
    }
  } catch (error) {
    if (!finalSeen) throw error
  }

  if (!finalSeen) await owner.adapter.finishSource()

  return {
    inputTokens: streamInputTokens,
    outputTokens: streamOutputTokens,
    cachedTokens: streamCachedTokens,
    responseText: streamText,
  }
}

const hasChatFinishReason = (chunk: ChatCompletionChunk): boolean =>
  chunk.choices.some((choice) => choice.finish_reason !== null)

const consumeTrailingChatUsage = async (
  response: AsyncIterator<{ data?: string }>,
  consume: (chunk: ChatCompletionChunk) => void,
): Promise<void> => {
  while (true) {
    let next: IteratorResult<{ data?: string }>
    try {
      next = await response.next()
    } catch {
      return
    }
    if (next.done || next.value.data === "[DONE]") return
    if (!next.value.data) continue
    try {
      const parsed = JSON.parse(next.value.data) as unknown
      if (hasNonNullStreamError(parsed)) return
      const chunk = parsed as ChatCompletionChunk
      if (chunk.choices.length === 0 && chunk.usage) consume(chunk)
    } catch {
      return
    }
  }
}

function createReceivedChatMessagesError() {
  return {
    type: "error" as const,
    error: {
      type: "api_error",
      message: "Upstream Chat stream failed.",
    },
  }
}

const tryCountTokens = async (
  c: Context,
  payload: Parameters<typeof getTokenCount>[0],
): Promise<void> => {
  try {
    const selectedModel = state.models?.data.find((m) => m.id === payload.model)
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      setRequestContext(c, { inputTokens: tokenCount.input })
    }
  } catch {
    // Token counting is best-effort, don't fail the request
  }
}

function getCopilotModelIds(): Set<string> {
  return new Set(state.models?.data.map((model) => model.id) ?? [])
}

function resolveCustomChatModel(
  model: string,
): CustomProviderModelReference | undefined {
  const copilotModelIds = getCopilotModelIds()
  const unnormalizedReference = resolveCustomProviderModel({
    model,
    kind: "chat",
    copilotModelIds,
  })
  if (unnormalizedReference) return unnormalizedReference

  const normalizedModel = normalizeModelName(model)
  if (normalizedModel === model) return undefined

  return resolveCustomProviderModel({
    model: normalizedModel,
    kind: "chat",
    copilotModelIds,
  })
}

function applyThinkingBudget(
  payload: ChatCompletionsPayload,
  budgetTokens: number | undefined,
): void {
  const extra = payload as unknown as Record<string, unknown>
  delete extra.thinking_budget
  if (!budgetTokens) return
  if (usesImplicitReasoningDefault(normalizeModelName(payload.model))) return

  extra.thinking_budget = budgetTokens
}

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    copilotSessionToken?: string
    initiatorOverride?: "agent" | "user"
    effortOverride?: ReasoningEffort
    preparedPayload?: ChatCompletionsPayload
    requestedModel?: string
    retryBudget?: RetryBudget
    routedAccountPin?: RoutedAccountPin
    webSearchMaxUses?: number
  },
) => await executeChatCompletions(c, anthropicPayload, options)

const executeChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    copilotSessionToken?: string
    initiatorOverride?: "agent" | "user"
    effortOverride?: ReasoningEffort
    preparedPayload?: ChatCompletionsPayload
    requestedModel?: string
    retryBudget?: RetryBudget
    routedAccountPin?: RoutedAccountPin
    webSearchMaxUses?: number
  },
) => {
  const {
    copilotSessionToken,
    initiatorOverride,
    effortOverride,
    preparedPayload,
    requestedModel,
    retryBudget,
    routedAccountPin,
    webSearchMaxUses,
  } = options ?? {}
  const openAIPayload =
    preparedPayload ?
      structuredClone(preparedPayload)
    : translateToOpenAI(anthropicPayload)

  // Enable thinking/reasoning on the ChatCompletions path
  // Copilot API uses reasoning_effort to enable thinking (returns reasoning_text in response)
  // thinking_budget is also sent for models that support explicit budget control
  if (!preparedPayload && anthropicPayload.thinking) {
    const extra = openAIPayload as unknown as Record<string, unknown>
    const usesImplicitDefault = usesImplicitReasoningDefault(
      normalizeModelName(openAIPayload.model),
    )
    if (!usesImplicitDefault) {
      const upstreamEffort = effortOverride ?? "medium"
      if (!effortOverride) {
        recordNonDefaultBehavior(c, {
          kind: "reasoning_effort_default",
          message: `Thinking is enabled for ${openAIPayload.model}, but no explicit effort survived parsing/redirect; sending upstream reasoning_effort=${upstreamEffort}`,
          data: {
            model: openAIPayload.model,
            defaultEffort: upstreamEffort,
            thinkingType: anthropicPayload.thinking.type,
          },
        })
      }
      extra.reasoning_effort = upstreamEffort
    } else if (effortOverride) {
      recordNonDefaultBehavior(c, {
        kind: "reasoning_effort_implicit_default",
        message: `${openAIPayload.model} is configured for implicit reasoning defaults; removing explicit reasoning_effort=${effortOverride}`,
        data: {
          model: openAIPayload.model,
          requestedEffort: effortOverride,
        },
      })
    }
    // Claude requires temperature=1 when thinking is enabled
    openAIPayload.temperature = 1
    delete openAIPayload.top_p
  } else if (
    !preparedPayload
    && effortOverride
    && !usesImplicitReasoningDefault(normalizeModelName(openAIPayload.model))
  ) {
    // Subagent/skill requests may set output_config.effort without a thinking
    // block. Forward reasoning_effort so Copilot enables extended thinking;
    // also pin temperature=1 and drop top_p as the model requires.
    const extra = openAIPayload as unknown as Record<string, unknown>
    extra.reasoning_effort = effortOverride
    openAIPayload.temperature = 1
    delete openAIPayload.top_p
  }

  const replacedPayload = openAIPayload
  const appliedRules: Array<string> = []
  if (!preparedPayload && anthropicPayload.thinking) {
    applyThinkingBudget(
      replacedPayload,
      anthropicPayload.thinking.budget_tokens,
    )
  }
  const customReference =
    preparedPayload ? undefined : resolveCustomChatModel(replacedPayload.model)
  if (customReference) {
    const customPayload = {
      ...replacedPayload,
      model: customReference.requestedModel,
    }
    return await executeCustomProviderChatCompletions(c, {
      reference: customReference,
      payload: customPayload,
      requestedModel,
      appliedRules,
      reasoningEffort: effortOverride,
    })
  }

  const finalPayload = {
    ...replacedPayload,
    model: normalizeModelName(replacedPayload.model),
  }

  if (appliedRules.length > 0) {
    setRequestContext(c, { replacements: appliedRules })
  }

  await tryCountTokens(c, finalPayload)

  logger.debug("Prepared translated Chat request", {
    messageCount: finalPayload.messages.length,
    model: finalPayload.model,
    stream: Boolean(finalPayload.stream),
    toolCount: finalPayload.tools?.length ?? 0,
  })

  if (!finalPayload.stream) {
    const { initialResponse, hadWebSearch } = await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: finalPayload.messages,
        model: finalPayload.model,
      }),
      async (span) => {
        const response = (await createChatCompletions(finalPayload, {
          candidatePrepared: preparedPayload !== undefined,
          copilotSessionToken,
          initiator: initiatorOverride,
          retryBudget,
          routedAccountPin,
          signal: c.req.raw.signal,
        })) as ChatCompletionResponse

        // Track which account handled this request (multi-token mode)
        const accountId = getLastUsedAccountId()
        if (accountId !== undefined) {
          setRequestContext(c, { accountId })
        }

        const hadWebSearch = extractWebSearchCalls(response).length > 0
        setChatCompletionSpanResult(span, response)

        return { initialResponse: response, hadWebSearch }
      },
    )

    const finalResponse =
      hadWebSearch ?
        await resolveWebSearchCalls(initialResponse, finalPayload, {
          copilotSessionToken,
          initiatorOverride,
          abortSignal: c.req.raw.signal,
          maxUses: webSearchMaxUses,
          ...(preparedPayload ?
            {
              createCompletion: async (payload) =>
                (await createChatCompletions(payload, {
                  allowCompatibilityRetry: false,
                  candidatePrepared: true,
                  copilotSessionToken,
                  initiator: initiatorOverride,
                  signal: c.req.raw.signal,
                })) as ChatCompletionResponse,
            }
          : {}),
        })
      : initialResponse

    logger.debug("Received non-streaming Chat response", {
      choiceCount: finalResponse.choices.length,
      model: finalResponse.model,
    })

    const anthropicResponse = translateToAnthropic(
      finalResponse,
      requestedModel,
    )
    logger.debug("Translated Anthropic response", {
      blockCount: anthropicResponse.content.length,
      model: anthropicResponse.model,
    })
    return c.json(anthropicResponse)
  }

  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  logger.debug("Streaming response from Copilot")
  return await Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: finalPayload.messages,
      model: finalPayload.model,
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
        const downstreamAbort = new AbortController()
        const upstreamSignal = AbortSignal.any([
          c.req.raw.signal,
          downstreamAbort.signal,
        ])
        const preflush = await raceSsePreflush(
          createChatCompletions(finalPayload, {
            candidatePrepared: preparedPayload !== undefined,
            copilotSessionToken,
            initiator: initiatorOverride,
            retryBudget,
            routedAccountPin,
            signal: upstreamSignal,
          }),
        )

        return streamSSE(c, async (stream) => {
          stream.onAbort(() => downstreamAbort.abort())
          const owner = createMessagesStreamOwner(c, stream)
          stream.onAbort(() => {
            owner.adapter.abort()
          })

          try {
            if (preflush.kind === "pending") {
              // Returning the SSE response is not enough to reset an edge read
              // timer: write one comment immediately so headers and a body byte
              // are committed while the upstream first-event probe continues.
              await writeSseHeartbeat(stream)
            }
            const response =
              preflush.kind === "settled" ?
                preflush.value
              : unwrapSsePreflushSettlement(
                  await withHeartbeatWhilePending(preflush.pending, stream),
                )

            // Track which account handled this request (multi-token mode)
            const accountId = getLastUsedAccountId()
            if (accountId !== undefined) {
              setRequestContext(c, { accountId })
            }

            if (needsWebSearchBuffering) {
              const buffered = await streamChatCompletionsWithWebSearch(
                { stream, owner },
                withSseHeartbeat(
                  response as AsyncIterable<{ data?: string }>,
                  stream,
                ),
                requestedModel,
              )

              setChatCompletionSpanResult(streamSpan, buffered.initialResponse)

              if (buffered.hadWebSearch && buffered.initialResponse) {
                finishSpan()
                const initialResp = buffered.initialResponse
                // Runs inside the already-open stream, so heartbeating it
                // forfeits no HTTP status. The resolver loops full generations
                // plus live web fetches — easily past Cloudflare's budget.
                const resolved = await withHeartbeatWhilePending(
                  Sentry.withActiveSpan(null, () =>
                    resolveWebSearchCalls(initialResp, finalPayload, {
                      copilotSessionToken,
                      initiatorOverride,
                      abortSignal: upstreamSignal,
                      maxUses: webSearchMaxUses,
                      ...(preparedPayload ?
                        {
                          createCompletion: async (payload) =>
                            (await createChatCompletions(payload, {
                              allowCompatibilityRetry: false,
                              candidatePrepared: true,
                              copilotSessionToken,
                              initiator: initiatorOverride,
                              signal: upstreamSignal,
                            })) as ChatCompletionResponse,
                        }
                      : {}),
                    }),
                  ),
                  stream,
                )
                const anthropicResponse = translateToAnthropic(
                  resolved,
                  requestedModel,
                )
                await owner.adapter.succeed(async () => {
                  await emitAnthropicResponseAsStream(stream, anthropicResponse)
                })
              }
              return
            }

            const directResult = await streamChatCompletionsDirect(
              { stream, owner },
              withSseHeartbeat(
                response as AsyncIterable<{ data?: string }>,
                stream,
              ),
              requestedModel,
            )

            streamSpan.setAttribute(
              "gen_ai.usage.input_tokens",
              directResult.inputTokens,
            )
            streamSpan.setAttribute(
              "gen_ai.usage.output_tokens",
              directResult.outputTokens,
            )
            setOptionalTokenDetails(streamSpan, directResult.cachedTokens)
            setSentryOutputMessages(streamSpan, directResult.responseText)
          } catch (error) {
            await failMessagesStream(owner.adapter, error)
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

async function executeCustomProviderChatCompletions(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload
    requestedModel?: string
    appliedRules: Array<string>
    reasoningEffort?: ReasoningEffort
    webSearchMaxUses?: number
  },
) {
  const {
    reference,
    payload,
    requestedModel,
    appliedRules,
    reasoningEffort,
    webSearchMaxUses,
  } = options
  const responseModel = requestedModel ?? payload.model

  logger.debug(
    `Routing Anthropic custom chat model ${responseModel} to ${reference.provider.id}/${reference.upstreamModel}`,
  )

  setRequestContext(c, {
    requestedModel,
    provider: reference.provider.name,
    model: reference.upstreamModel,
    replacements: appliedRules,
    reasoningEffort,
  })

  if (payload.tools?.some((tool) => tool.function.name === "web_search")) {
    return await executeCustomProviderWebSearch(c, {
      reference,
      payload,
      responseModel,
      reasoningEffort,
      webSearchMaxUses,
    })
  }

  if (!payload.stream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: payload.messages,
        model: reference.upstreamModel,
      }),
      async (span) => {
        const response = (await createCustomProviderChatCompletions(
          reference,
          payload,
          { signal: c.req.raw.signal, reasoningEffort },
        )) as ChatCompletionResponse

        if (response.usage) {
          setRequestContext(c, {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          })
        }
        setChatCompletionSpanResult(span, response)

        const anthropicResponse = translateToAnthropic(response, responseModel)
        logger.debug("Translated custom provider Anthropic response", {
          blockCount: anthropicResponse.content.length,
          model: anthropicResponse.model,
        })
        return c.json(anthropicResponse)
      },
    )
  }

  return await handleCustomProviderChatCompletionStream(c, {
    reference,
    payload,
    responseModel,
    reasoningEffort,
  })
}

async function executeCustomProviderWebSearch(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload
    responseModel: string
    reasoningEffort?: ReasoningEffort
    webSearchMaxUses?: number
  },
) {
  const requestedStream = Boolean(options.payload.stream)
  const payload = { ...options.payload, stream: false, stream_options: null }
  const createCompletion = async (
    currentPayload: ChatCompletionsPayload,
  ): Promise<ChatCompletionResponse> =>
    (await createCustomProviderChatCompletions(
      options.reference,
      currentPayload,
      {
        signal: c.req.raw.signal,
        reasoningEffort: options.reasoningEffort,
      },
    )) as ChatCompletionResponse

  const initial = await createCompletion(payload)
  const resolved = await resolveWebSearchCalls(initial, payload, {
    abortSignal: c.req.raw.signal,
    createCompletion,
    maxUses: options.webSearchMaxUses,
  })
  setRequestContext(c, {
    inputTokens: resolved.usage?.prompt_tokens,
    outputTokens: resolved.usage?.completion_tokens,
  })
  const result = translateToAnthropic(resolved, options.responseModel)

  if (!requestedStream) return c.json(result)
  return streamSSE(c, async (stream) => {
    const owner = createMessagesStreamOwner(c, stream)
    stream.onAbort(() => {
      owner.adapter.abort()
    })
    try {
      await owner.adapter.succeed(async () => {
        await emitAnthropicResponseAsStream(stream, result)
      })
    } catch (error) {
      await failMessagesStream(owner.adapter, error)
    }
  })
}

async function handleCustomProviderChatCompletionStream(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload
    responseModel: string
    reasoningEffort?: ReasoningEffort
  },
) {
  return await Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: options.payload.messages,
      model: options.reference.upstreamModel,
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
        const response = await createCustomProviderChatCompletions(
          options.reference,
          options.payload,
          {
            signal: c.req.raw.signal,
            reasoningEffort: options.reasoningEffort,
          },
        )

        return streamSSE(c, async (stream) => {
          const owner = createMessagesStreamOwner(c, stream)
          stream.onAbort(() => {
            owner.adapter.abort()
          })
          try {
            const directResult = await streamChatCompletionsDirect(
              { stream, owner },
              withSseHeartbeat(
                response as AsyncIterable<{ data?: string }>,
                stream,
              ),
              options.responseModel,
            )

            setRequestContext(c, {
              inputTokens: directResult.inputTokens,
              outputTokens: directResult.outputTokens,
            })
            streamSpan.setAttribute(
              "gen_ai.usage.input_tokens",
              directResult.inputTokens,
            )
            streamSpan.setAttribute(
              "gen_ai.usage.output_tokens",
              directResult.outputTokens,
            )
            setOptionalTokenDetails(streamSpan, directResult.cachedTokens)
            setSentryOutputMessages(streamSpan, directResult.responseText)
          } catch (error) {
            await failMessagesStream(owner.adapter, error)
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

type SSEStream = {
  readonly aborted: boolean
  readonly closed: boolean
  writeSSE: (data: { event?: string; data: string }) => Promise<void>
}

type MessagesStreamOwner = {
  adapter: MessagesTerminalAdapter
  setCloseOpenBlocks(
    closeOpenBlocks: () => Array<
      import("./anthropic-types").AnthropicStreamEventData
    >,
  ): void
}

function createMessagesStreamOwner(
  c: Context,
  stream: SSEStream,
): MessagesStreamOwner {
  let closeOpenBlocks = EMPTY_MESSAGES_CLOSE
  return {
    adapter: createMessagesTerminalAdapter({
      c,
      stream,
      closeOpenBlocks: () => closeOpenBlocks(),
    }),
    setCloseOpenBlocks(next) {
      closeOpenBlocks = next
    },
  }
}

const EMPTY_MESSAGES_CLOSE = () =>
  new Array<import("./anthropic-types").AnthropicStreamEventData>()

async function failMessagesStream(
  adapter: MessagesTerminalAdapter,
  error: unknown,
): Promise<void> {
  if (isAbortError(error)) {
    adapter.abort()
    return
  }
  await adapter.fail({
    kind: "thrown",
    error,
    ...(isHTTPError(error) ?
      { inspection: await inspectHttpError(error) }
    : {}),
  })
}

type ResponsesStream = AsyncIterable<{ event?: string; data?: string }>

const writeResponsesEvents = async (
  stream: SSEStream,
  parsed: ResponseStreamEvent,
  streamState: ReturnType<typeof createResponsesStreamState>,
): Promise<ReturnType<typeof translateResponsesStreamEvent>> => {
  const result = translateResponsesStreamEvent(parsed, streamState)
  if (result.kind === "events") {
    await writeAnthropicEvents(stream, result.events)
  }
  return result
}

const isWebSearchFunctionCall = (parsed: ResponseStreamEvent): boolean =>
  parsed.type === "response.output_item.done"
  && "item" in parsed
  && (parsed.item as { type?: string }).type === "function_call"
  && (parsed.item as { name?: string }).name === "web_search"

const isResponseCompleted = (
  parsed: ResponseStreamEvent,
): parsed is ResponseStreamEvent & { response: ResponsesResult } =>
  (parsed.type === "response.completed"
    || parsed.type === "response.incomplete")
  && "response" in parsed

const bufferResponsesStream = async (
  stream: SSEStream,
  response: ResponsesStream,
): Promise<{
  events: Array<ResponseStreamEvent>
  hasWebSearch: boolean
  completedResult: ResponsesResult | null
}> => {
  const events: Array<ResponseStreamEvent> = []
  let hasWebSearch = false
  let completedResult: ResponsesResult | null = null

  for await (const chunk of response) {
    if (chunk.event === "ping") {
      await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
      continue
    }
    if (!chunk.data) continue

    const parsed = parseRecoverableStreamJson({
      data: chunk.data,
      event: chunk.event,
      protocol: "Responses-to-Messages",
      terminal: isResponsesTerminalEventName(chunk.event),
    }) as ResponseStreamEvent | undefined
    if (parsed === undefined) continue
    events.push(parsed)

    if (isWebSearchFunctionCall(parsed)) hasWebSearch = true
    if (parsed.type === "response.failed" || parsed.type === "error") break
    if (isResponseCompleted(parsed)) {
      completedResult = parsed.response
      break
    }
  }

  return { events, hasWebSearch, completedResult }
}

const replayBufferedEvents = async (
  stream: SSEStream,
  owner: MessagesStreamOwner,
  bufferedEvents: Array<ResponseStreamEvent>,
): Promise<void> => {
  const streamState = createResponsesStreamState()
  owner.setCloseOpenBlocks(() => closeResponsesOpenBlocks(streamState))

  for (const parsed of bufferedEvents) {
    const result = await writeResponsesEvents(stream, parsed, streamState)
    if (result.kind === "success") {
      await owner.adapter.succeed(async () => {
        await writeAnthropicEvents(
          stream,
          createResponsesNormalTerminalEvents(streamState, result.response),
        )
      })
      return
    }
    if (result.kind === "failure") {
      await owner.adapter.failReceived(result.error)
      // The adapter has committed the only failure terminal before this mark.
      // eslint-disable-next-line require-atomic-updates
      streamState.terminal = "failed"
      return
    }
  }
  await owner.adapter.finishSource()
}

const streamResponsesWithWebSearch = async (
  stream: SSEStream,
  owner: MessagesStreamOwner,
  response: ResponsesStream,
): Promise<{
  hadWebSearch: boolean
  initialResult: ResponsesResult | null
}> => {
  const { events, hasWebSearch, completedResult } = await bufferResponsesStream(
    stream,
    response,
  )

  if (hasWebSearch && completedResult) {
    return { hadWebSearch: true, initialResult: completedResult }
  }

  await replayBufferedEvents(stream, owner, events)
  return { hadWebSearch: false, initialResult: completedResult }
}

const streamResponsesDirect = async (
  stream: SSEStream,
  owner: MessagesStreamOwner,
  response: ResponsesStream,
): Promise<{
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  responseText: string
}> => {
  const streamState = createResponsesStreamState()
  owner.setCloseOpenBlocks(() => closeResponsesOpenBlocks(streamState))
  let streamInputTokens = 0
  let streamOutputTokens = 0
  let streamCachedTokens = 0
  let streamReasoningTokens = 0
  let responseText = ""

  for await (const chunk of response) {
    if (chunk.event === "ping") {
      await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
      continue
    }
    if (!chunk.data) continue

    const parsed = parseRecoverableStreamJson({
      data: chunk.data,
      event: chunk.event,
      protocol: "Responses-to-Messages",
      terminal: isResponsesTerminalEventName(chunk.event),
    }) as ResponseStreamEvent | undefined
    if (parsed === undefined) continue
    // Capture usage from response.completed events
    if (isResponseCompleted(parsed) && parsed.response.usage) {
      streamInputTokens = parsed.response.usage.input_tokens
      streamOutputTokens = parsed.response.usage.output_tokens ?? 0
      streamCachedTokens =
        parsed.response.usage.input_tokens_details?.cached_tokens ?? 0
      streamReasoningTokens =
        parsed.response.usage.output_tokens_details?.reasoning_tokens ?? 0
      responseText = parsed.response.output_text
    }

    const result = await writeResponsesEvents(stream, parsed, streamState)
    if (result.kind === "success") {
      await owner.adapter.succeed(async () => {
        await writeAnthropicEvents(
          stream,
          createResponsesNormalTerminalEvents(streamState, result.response),
        )
      })
      break
    }
    if (result.kind === "failure") {
      await owner.adapter.failReceived(result.error)
      // The adapter has committed the only failure terminal before this mark.
      // eslint-disable-next-line require-atomic-updates
      streamState.terminal = "failed"
      break
    }
  }

  if (streamState.terminal === "open") await owner.adapter.finishSource()

  return {
    inputTokens: streamInputTokens,
    outputTokens: streamOutputTokens,
    cachedTokens: streamCachedTokens,
    reasoningTokens: streamReasoningTokens,
    responseText,
  }
}

function isResponsesTerminalEventName(event: string | undefined): boolean {
  return (
    event === "error"
    || event === "response.completed"
    || event === "response.failed"
    || event === "response.incomplete"
  )
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    copilotSessionToken?: string
    initiatorOverride?: "agent" | "user"
    effortOverride?: ReasoningEffort
    preparedPayload?: ResponsesPayload
    requestedModel?: string
    retryBudget?: RetryBudget
    routedAccountPin?: RoutedAccountPin
    webSearchMaxUses?: number
  },
) => await executeResponsesApi(c, anthropicPayload, options)

const executeResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    copilotSessionToken?: string
    initiatorOverride?: "agent" | "user"
    effortOverride?: ReasoningEffort
    preparedPayload?: ResponsesPayload
    requestedModel?: string
    retryBudget?: RetryBudget
    routedAccountPin?: RoutedAccountPin
    webSearchMaxUses?: number
  },
) => {
  const {
    copilotSessionToken,
    initiatorOverride,
    effortOverride,
    preparedPayload,
    requestedModel,
    retryBudget,
    routedAccountPin,
    webSearchMaxUses,
  } = options ?? {}
  const responsesPayload =
    preparedPayload ?
      structuredClone(preparedPayload)
    : translateAnthropicMessagesToResponsesPayload(
        anthropicPayload,
        effortOverride,
      )
  logger.debug("Prepared translated Responses request", {
    inputKind: Array.isArray(responsesPayload.input) ? "items" : "text",
    model: responsesPayload.model,
    stream: Boolean(responsesPayload.stream),
    toolCount: responsesPayload.tools?.length ?? 0,
  })

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)

  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  if (responsesPayload.stream) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return await Sentry.startSpanManual(
      createSentryChatSpanOptions({
        inputMessages: anthropicPayload.messages,
        model: anthropicPayload.model,
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
          const response = await createResponses(responsesPayload, {
            copilotSessionToken,
            vision,
            initiator: initiatorOverride ?? initiator,
            signal: c.req.raw.signal,
            prepared: preparedPayload !== undefined,
            retryBudget,
            routedAccountPin,
          })

          const responsesAccountId = getLastUsedAccountId()
          if (responsesAccountId !== undefined) {
            setRequestContext(c, { accountId: responsesAccountId })
          }

          return streamSSE(c, async (stream) => {
            const owner = createMessagesStreamOwner(c, stream)
            stream.onAbort(() => {
              owner.adapter.abort()
            })
            try {
              if (needsWebSearchBuffering) {
                const buffered = await streamResponsesWithWebSearch(
                  stream,
                  owner,
                  withSseHeartbeat(response as ResponsesStream, stream),
                )

                const inputTokens =
                  buffered.initialResult?.usage?.input_tokens ?? 0
                const outputTokens =
                  buffered.initialResult?.usage?.output_tokens ?? 0
                const cachedTokens =
                  buffered.initialResult?.usage?.input_tokens_details
                    ?.cached_tokens ?? 0
                const reasoningTokens =
                  buffered.initialResult?.usage?.output_tokens_details
                    ?.reasoning_tokens ?? 0
                streamSpan.setAttribute(
                  "gen_ai.usage.input_tokens",
                  inputTokens,
                )
                streamSpan.setAttribute(
                  "gen_ai.usage.output_tokens",
                  outputTokens,
                )
                setOptionalTokenDetails(
                  streamSpan,
                  cachedTokens,
                  reasoningTokens,
                )
                setSentryOutputMessages(
                  streamSpan,
                  buffered.initialResult?.output_text ?? "",
                )

                if (buffered.hadWebSearch && buffered.initialResult) {
                  finishSpan()
                  const initialRes = buffered.initialResult
                  // Inside the open stream — see the note on the Chat
                  // Completions web-search path above.
                  const resolved = await withHeartbeatWhilePending(
                    Sentry.withActiveSpan(null, () =>
                      resolveResponsesWebSearchCalls(
                        initialRes,
                        responsesPayload,
                        {
                          copilotSessionToken,
                          vision,
                          initiator: initiatorOverride ?? initiator,
                          signal: c.req.raw.signal,
                          maxUses: webSearchMaxUses,
                          ...(preparedPayload ?
                            {
                              createResponse: async (payload) =>
                                (await createResponses(payload, {
                                  allowCompatibilityRetry: false,
                                  copilotSessionToken,
                                  vision,
                                  initiator: initiatorOverride ?? initiator,
                                  signal: c.req.raw.signal,
                                  prepared: true,
                                })) as ResponsesResult,
                            }
                          : {}),
                        },
                      ),
                    ),
                    stream,
                  )
                  const anthropicResponse =
                    translateResponsesResultToAnthropic(resolved)
                  if (requestedModel) anthropicResponse.model = requestedModel
                  await owner.adapter.succeed(async () => {
                    await emitAnthropicResponseAsStream(
                      stream,
                      anthropicResponse,
                    )
                  })
                }
                return
              }

              const directUsage = await streamResponsesDirect(
                stream,
                owner,
                withSseHeartbeat(response as ResponsesStream, stream),
              )

              streamSpan.setAttribute(
                "gen_ai.usage.input_tokens",
                directUsage.inputTokens,
              )
              streamSpan.setAttribute(
                "gen_ai.usage.output_tokens",
                directUsage.outputTokens,
              )
              setOptionalTokenDetails(
                streamSpan,
                directUsage.cachedTokens,
                directUsage.reasoningTokens,
              )
              setSentryOutputMessages(streamSpan, directUsage.responseText)
            } catch (error) {
              await failMessagesStream(owner.adapter, error)
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

  const { initialResult, hadWebSearch } = await Sentry.startSpan(
    createSentryChatSpanOptions({
      inputMessages: anthropicPayload.messages,
      model: anthropicPayload.model,
    }),
    async (span) => {
      const result = (await createResponses(responsesPayload, {
        copilotSessionToken,
        vision,
        initiator: initiatorOverride ?? initiator,
        signal: c.req.raw.signal,
        prepared: preparedPayload !== undefined,
        retryBudget,
        routedAccountPin,
      })) as ResponsesResult

      const responsesAccountId = getLastUsedAccountId()
      if (responsesAccountId !== undefined) {
        setRequestContext(c, { accountId: responsesAccountId })
      }

      const hadWebSearch = result.output.some(
        (item) => item.type === "function_call" && item.name === "web_search",
      )
      const inputTokens = result.usage?.input_tokens ?? 0
      const outputTokens = result.usage?.output_tokens ?? 0
      const cachedTokens =
        result.usage?.input_tokens_details?.cached_tokens ?? 0
      const reasoningTokens =
        result.usage?.output_tokens_details?.reasoning_tokens ?? 0
      span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
      span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
      setOptionalTokenDetails(span, cachedTokens, reasoningTokens)
      setSentryOutputMessages(span, result.output_text)

      return { initialResult: result, hadWebSearch }
    },
  )

  const resolved =
    hadWebSearch ?
      await resolveResponsesWebSearchCalls(initialResult, responsesPayload, {
        copilotSessionToken,
        vision,
        initiator: initiatorOverride ?? initiator,
        signal: c.req.raw.signal,
        maxUses: webSearchMaxUses,
        ...(preparedPayload ?
          {
            createResponse: async (payload) =>
              (await createResponses(payload, {
                allowCompatibilityRetry: false,
                copilotSessionToken,
                vision,
                initiator: initiatorOverride ?? initiator,
                signal: c.req.raw.signal,
                prepared: true,
              })) as ResponsesResult,
          }
        : {}),
      })
    : initialResult

  logger.debug("Received non-streaming Responses result", {
    model: resolved.model,
    outputCount: resolved.output.length,
    status: resolved.status,
  })

  const anthropicResponse = translateResponsesResultToAnthropic(resolved)
  if (requestedModel) anthropicResponse.model = requestedModel
  logger.debug("Translated Anthropic response", {
    blockCount: anthropicResponse.content.length,
    model: anthropicResponse.model,
  })
  return c.json(anthropicResponse)
}

const modelExists = (id: string) =>
  state.models?.data.some((m) => m.id === id) ?? false

function createMessagesModelNotFoundError(): LocalHTTPError {
  const clientBody = {
    type: "error",
    error: {
      type: "not_found_error",
      code: "model_not_found",
      message: "The requested Copilot Messages model was not found.",
      param: "model",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 404 }),
    clientBody,
  )
}

/**
 * Route to model variants based on client signals (1m context, fast mode).
 * Mutates the payload in place.
 */
function applyModelVariantRouting(
  c: Context,
  payload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
): boolean {
  const initialModel = payload.model
  // 1M context via beta header → route to -1m model variant
  if (
    getCanonicalAnthropicBetaIdentifiers(anthropicBeta).has(
      "context-1m-2025-08-07",
    )
  ) {
    const candidate = `${payload.model}-1m`
    if (modelExists(candidate)) {
      recordNonDefaultBehavior(c, {
        kind: "model_variant_routing",
        message: `anthropic-beta context-1m routed ${payload.model} to ${candidate}`,
        data: {
          sourceModel: payload.model,
          targetModel: candidate,
          reason: "context-1m beta header",
        },
      })
      payload.model = candidate
    }
  }

  // Fallback: if the base model has no routable account but the -1m variant
  // does, auto-route to it. The merged model list (state.models) may include
  // models that no individual account can serve via the token pool, causing
  // routedFetch to fall back to the legacy single-token path which often 400s.
  if (!payload.model.endsWith("-1m")) {
    const hasEnabledAccount = tokenPool.hasEnabledAccountForKnownModel(
      payload.model,
    )
    if (hasEnabledAccount === undefined) {
      const candidate = `${payload.model}-1m`
      if (modelExists(candidate)) {
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
      }
    }
  }

  // Fast mode → route to -fast model variant, strip unsupported field
  if (payload.speed === "fast") {
    const candidate = `${payload.model}-fast`
    if (modelExists(candidate)) {
      recordNonDefaultBehavior(c, {
        kind: "model_variant_routing",
        message: `speed=fast routed ${payload.model} to ${candidate}`,
        data: {
          sourceModel: payload.model,
          targetModel: candidate,
          reason: "speed=fast",
        },
      })
      payload.model = candidate
    }
    recordNonDefaultBehavior(c, {
      kind: "request_field_stripped",
      message: `Removed unsupported speed=${payload.speed} before forwarding ${payload.model}`,
      data: {
        model: payload.model,
        field: "speed",
        value: payload.speed,
      },
    })
    delete payload.speed
  }
  return payload.model !== initialModel
}

/**
 * Extract reasoning effort info from the Anthropic request body for logging.
 * Claude Code sends effort as `output_config.effort` (low/medium/high/max)
 * and thinking mode as `thinking.type` (enabled/adaptive).
 * When effort is omitted, this proxy defaults the effective value to "medium".
 */
function getBodyReasoningEffort(
  payload: AnthropicMessagesPayload,
): string | undefined {
  // No thinking config at all — no effort to report
  if (!payload.thinking && !payload.output_config?.effort) return undefined

  const parts: Array<string> = []

  // output_config.effort is the actual effort level (low/medium/high/max)
  // When omitted, align the log context with the proxy's runtime default.
  const effort =
    payload.output_config?.effort ?? (payload.thinking ? "medium" : undefined)
  if (effort) {
    parts.push(effort)
  }

  // thinking.type indicates the thinking mode (enabled/adaptive)
  if (payload.thinking) {
    parts.push(payload.thinking.type)
    if (payload.thinking.budget_tokens) {
      parts.push(`${payload.thinking.budget_tokens.toLocaleString()} budget`)
    }
  }

  return parts.length > 0 ? parts.join(", ") : undefined
}

function getOutputConfigReasoningEffort(
  payload: AnthropicMessagesPayload,
): ReasoningEffort | undefined {
  return parseReasoningEffort(payload.output_config?.effort)
}

const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}
