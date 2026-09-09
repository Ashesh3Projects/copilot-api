/* eslint-disable max-lines, complexity -- protocol routing, streaming, and fallback paths share request context */
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type {
  EndpointRouteDecision,
  TranslationFinding,
} from "~/lib/endpoint-routing"
import type { Model } from "~/services/copilot/get-models"

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
  createInvalidJsonBodyError,
  inspectHttpError,
  isAbortError,
  isHTTPError,
} from "~/lib/error"
import {
  applyModelFallbackToPayload,
  getModelFallbackRedirect,
  runWithModelFallback,
} from "~/lib/model-fallback"
import {
  applyModelRedirect,
  formatModelRedirectResult,
  type ModelRedirectVerbosity,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  type ReasoningEffort,
  normalizeReasoningEffortForModel,
  parseReasoningEffort,
  parseModelSuffix,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import { hasNonNullStreamError } from "~/lib/recoverable-stream-json"
import {
  recordNonDefaultBehavior,
  setRequestContext,
} from "~/lib/request-logger"
import {
  createSentryChatSpanOptions,
  createSentryInvokeAgentSpanOptions,
  setSentryOutputMessages,
  setSentryConversationIdFromRequest,
} from "~/lib/sentry"
import { withSseHeartbeat } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { getTokenCount } from "~/lib/tokenizer"
import { emitChatCompletionsToolSpans } from "~/lib/tool-spans"
import {
  createChatCompletions,
  createChatCompletionsWithProcessedPayload,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { isChatWebSearchFunctionTool } from "~/services/copilot/mcp-web-search"
import { canonicalizeAnthropicBeta } from "~/services/copilot/messages-contract"

import type { NativeMessagesRequestOptions } from "../messages/native-handler"

import {
  emitChatCompletionResponseAsStream,
  resolveWebSearchCalls,
} from "../messages/web-search-helpers"
import { executeAnthropicBridge } from "./anthropic-bridge"
import {
  type ChatEndpointCandidate,
  orderPreparedChatCandidates,
  prepareChatCandidates,
  prepareCustomProviderChatCandidate,
} from "./chat-candidates"
import {
  type PreparedChatCompletionsSource,
  prepareChatCompletionsRequest,
} from "./chat-contract"
import {
  executeResponsesFallback,
  recordChatEndpointFallback,
} from "./responses-fallback-executor"
import { createChatStreamTerminalAdapter } from "./stream-lifecycle"

export { selectChatUpstreamEndpoint } from "./responses-fallback-executor"

export async function handleCompletion(c: Context) {
  const rawPayload = await parseChatRequestBody(c)
  const prepared = prepareChatCompletionsRequest(rawPayload)
  const preparedSource = prepared.source
  const nativeOptions: NativeMessagesRequestOptions = {
    anthropicBeta: c.req.header("anthropic-beta"),
    anthropicVersion: c.req.header("anthropic-version"),
    modelProviderPreference: c.req.header("x-model-provider-preference"),
  }
  const conversationId = setSentryConversationIdFromRequest(c, preparedSource)

  const model = normalizeModelName(
    parseModelSuffix(preparedSource.model).baseModel,
  )

  return await Sentry.startSpan(
    createSentryInvokeAgentSpanOptions(model, conversationId),
    async () => {
      recordCopilotRequestNormalization("chat", prepared.normalizationClasses)
      return await runWithModelFallback(
        {
          headers: c.req.raw.headers,
          payload: preparedSource,
          signal: c.req.raw.signal,
        },
        async () =>
          await handleCompletionInner(c, {
            preparedSource: structuredClone(preparedSource),
            sourceFindings: prepared.findings,
            nativeOptions,
          }),
      )
    },
  )
}

async function parseChatRequestBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json<unknown>()
  } catch {
    throw createInvalidJsonBodyError()
  }
}

// Route preparation intentionally stays together so model-scoped headers are
// matched only after every payload/model transformation is complete.
// eslint-disable-next-line max-lines-per-function
async function handleCompletionInner(
  c: Context,
  options: {
    nativeOptions: NativeMessagesRequestOptions
    preparedSource: PreparedChatCompletionsSource
    sourceFindings: ReadonlyArray<TranslationFinding>
  },
) {
  const { nativeOptions, preparedSource, sourceFindings } = options
  emitChatCompletionsToolSpans(preparedSource.messages)

  const requestedModel = preparedSource.model

  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    preparedSource.model,
  )
  const replacementSource = structuredClone(preparedSource)
  replacementSource.model = baseModel

  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(
      replacementSource as unknown as ChatCompletionsPayload,
    )

  const unnormalizedModel = replacedPayload.model
  let customReferenceBeforeCopilot = resolveCustomProviderModel({
    model: unnormalizedModel,
    kind: "chat",
    copilotModelIds: getCopilotModelIds(),
  })
  let normalizedModel = normalizeModelName(unnormalizedModel)
  const payloadEffort = getPayloadReasoningEffort(replacedPayload)
  const requestedEffort = getNormalizedRequestedEffort(c, {
    model: normalizedModel,
    suffixEffort,
    payloadEffort,
  })

  if (customReferenceBeforeCopilot) {
    applyModelFallbackToPayload(replacedPayload, { effort: requestedEffort })
    normalizedModel = normalizeModelName(replacedPayload.model)
    customReferenceBeforeCopilot = resolveCustomProviderModel({
      model: replacedPayload.model,
      kind: "chat",
      copilotModelIds: getCopilotModelIds(),
    })
  }
  if (customReferenceBeforeCopilot) {
    const customSource = structuredClone(
      replacedPayload,
    ) as unknown as PreparedChatCompletionsSource
    customSource.model = replacedPayload.model
    const fallbackEffort = getModelFallbackRedirect()?.effort
    if (fallbackEffort !== undefined)
      customSource.reasoning_effort = fallbackEffort
    const customCandidate = await prepareCustomProviderChatCandidate({
      source: customSource,
      signal: c.req.raw.signal,
    })
    const customPayload = {
      ...customCandidate.payload,
      model: replacedPayload.model,
    }
    return await executeCustomProviderRequest(c, {
      reference: customReferenceBeforeCopilot,
      payload: customPayload,
      requestedModel,
      appliedRules,
      reasoningEffort: getModelFallbackRedirect()?.effort ?? requestedEffort,
      webSearchMaxUses: customCandidate.webSearchMaxUses,
    })
  }

  const {
    targetModel,
    reasoningEffort: redirectedReasoningEffort,
    redirected,
    verbosity,
  } = await resolveRedirectedModel(c, {
    model: normalizedModel,
    effort: requestedEffort,
  })
  let reasoningEffort = redirectedReasoningEffort
  const redirectedSource = structuredClone(
    replacedPayload,
  ) as unknown as PreparedChatCompletionsSource
  applyRedirectedReasoningEffort({
    c,
    payload: redirectedSource as unknown as ChatCompletionsPayload,
    model: targetModel,
    effort: reasoningEffort,
  })

  redirectedSource.model = targetModel

  const modelBeforeFallback = redirectedSource.model
  const fallbackPayload = applyRoutableModelFallback(
    c,
    redirectedSource as unknown as ChatCompletionsPayload & { model: string },
  )
  redirectedSource.model = fallbackPayload.model
  applyModelFallbackToPayload(redirectedSource, {
    effort: reasoningEffort,
    verbosity,
  })
  if (redirectedSource.model !== targetModel || getModelFallbackRedirect()) {
    reasoningEffort = normalizeReasoningEffortForModel(
      redirectedSource.model,
      getModelFallbackRedirect()?.effort ?? reasoningEffort,
    )
    applyRedirectedReasoningEffort({
      c,
      payload: redirectedSource as unknown as ChatCompletionsPayload,
      model: redirectedSource.model,
      effort: reasoningEffort,
    })
  }

  const customReference = resolveCustomProviderModel({
    model: redirectedSource.model,
    kind: "chat",
    copilotModelIds: getCopilotModelIds(),
  })
  if (customReference) {
    const customCandidate = await prepareCustomProviderChatCandidate({
      source: redirectedSource,
      signal: c.req.raw.signal,
    })
    return await executeCustomProviderRequest(c, {
      reference: customReference,
      payload: customCandidate.payload,
      requestedModel,
      appliedRules,
      reasoningEffort,
      webSearchMaxUses: customCandidate.webSearchMaxUses,
    })
  }

  const routableSource = structuredClone(
    redirectedSource,
  ) as unknown as PreparedChatCompletionsSource
  const inboundSessionToken = c.req.header("copilot-session-token")
  const copilotSessionToken =
    (
      sessionTokenMatchesModel({
        token: inboundSessionToken,
        requestedModel: baseModel,
        finalModel: routableSource.model,
        modelWasRedirected:
          replacedPayload.model !== baseModel
          || redirected
          || routableSource.model !== modelBeforeFallback,
      })
    ) ?
      inboundSessionToken
    : undefined

  consola.debug("Prepared Chat request", {
    messageCount: routableSource.messages.length,
    model: routableSource.model,
    stream: Boolean(routableSource.stream),
    toolCount: routableSource.tools?.length ?? 0,
  })

  setRequestContext(c, {
    requestedModel,
    provider: "ChatCompletions",
    model: routableSource.model,
    replacements: appliedRules,
    reasoningEffort,
  })

  const routedModel = selectRoutedModel(routableSource.model, {
    copilotSessionToken,
  })
  const selectedModel = routedModel.model

  const candidates = await prepareChatCandidates({
    nativeMessagesOptions: { ...nativeOptions },
    reasoningEffort,
    responsesVerbosity: getModelFallbackRedirect()?.verbosity ?? verbosity,
    selectedModel,
    signal: c.req.raw.signal,
    source: routableSource,
    sourceFindings,
    support: getModelEndpointSupport(selectedModel),
  })
  const orderedCandidates = orderPreparedChatCandidates({
    candidates,
    selectedModel,
    source: routableSource,
  })
  const selection = selectEvaluatedCopilotCandidate({
    candidates: orderedCandidates,
    source: "chat",
    support: getModelEndpointSupport(selectedModel),
  })
  if ("code" in selection) throw createEndpointTranslationError(selection)
  const { candidate, decision } = selection
  recordCopilotTranslationFindings("chat", candidate.endpoint, candidate.check)
  recordCopilotEndpointRoute(decision)

  const nativeChatPayload =
    candidates.chat?.payload
    ?? (structuredClone(routableSource) as unknown as ChatCompletionsPayload & {
      model: string
    })
  await setInputTokenContext(c, nativeChatPayload, selectedModel)

  if (state.manualApprove) await awaitApproval()

  return await runWithRoutedModelSelection(
    routedModel,
    async () =>
      await dispatchCopilotCompletion(c, {
        sourcePayload: nativeChatPayload,
        candidate,
        requestedModel,
        reasoningEffort,
        selectedModel,
        decision,
        nativeOptions: {
          ...nativeOptions,
          requestedModel,
          copilotSessionToken,
        },
        copilotSessionToken,
      }),
  )
}

async function dispatchCopilotCompletion(
  c: Context,
  options: {
    decision: EndpointRouteDecision
    candidate: ChatEndpointCandidate
    sourcePayload: ChatCompletionsPayload & { model: string }
    requestedModel: string
    reasoningEffort?: ReasoningEffort
    selectedModel: Model | undefined
    nativeOptions: NativeMessagesRequestOptions
    copilotSessionToken?: string
  },
) {
  const {
    decision,
    candidate,
    sourcePayload,
    requestedModel,
    reasoningEffort,
    selectedModel,
    nativeOptions,
    copilotSessionToken,
  } = options
  if (decision.target === "/v1/messages") {
    recordCopilotMessagesBeta(
      canonicalizeAnthropicBeta(nativeOptions.anthropicBeta),
    )
  }
  if (decision.translated) {
    recordChatEndpointFallback(c, sourcePayload, decision)
  }

  switch (candidate.endpoint) {
    case "/responses": {
      return await executeResponsesFallback(c, {
        payload: sourcePayload,
        preparedPayload: candidate.payload,
        requestedModel,
        reasoningEffort,
        copilotSessionToken,
        webSearchMaxUses: candidate.webSearchMaxUses,
      })
    }
    case "/v1/messages": {
      return await executeAnthropicBridge(c, {
        nativeOptions: {
          ...nativeOptions,
          webSearchMaxUses: candidate.webSearchMaxUses,
        },
        payload: sourcePayload,
        preparedPayload: candidate.payload,
        selectedModel,
      })
    }
    case "/chat/completions": {
      return await executeRequest(c, candidate.payload, {
        candidatePrepared: true,
        requestedModel,
        copilotSessionToken,
        webSearchMaxUses: candidate.webSearchMaxUses,
      })
    }
    default: {
      throw new Error("Unsupported Chat endpoint route")
    }
  }
}

function getCopilotModelIds(): Set<string> {
  return new Set(state.models?.data.map((model) => model.id) ?? [])
}

async function setInputTokenContext(
  c: Context,
  payload: ChatCompletionsPayload,
  selectedModel: Parameters<typeof getTokenCount>[1] | undefined,
): Promise<void> {
  if (!selectedModel) return

  try {
    const tokenCount = await getTokenCount(payload, selectedModel)
    setRequestContext(c, { inputTokens: tokenCount.input })
  } catch {
    consola.warn("Failed to calculate token count")
  }
}

async function executeCustomProviderRequest(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload & { model: string }
    requestedModel: string
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

  consola.debug(
    `Routing custom chat model ${requestedModel} to ${reference.provider.id}/${reference.upstreamModel}`,
  )

  setRequestContext(c, {
    requestedModel,
    provider: reference.provider.name,
    model: reference.upstreamModel,
    replacements: appliedRules,
    reasoningEffort,
  })

  if (state.manualApprove) await awaitApproval()

  if (payload.tools?.some((tool) => isChatWebSearchFunctionTool(tool))) {
    return await executeCustomProviderWebSearchRequest(c, {
      reference,
      payload,
      requestedModel,
      reasoningEffort,
      webSearchMaxUses,
    })
  }

  if (payload.stream) {
    return await handleCustomProviderStreamingResponse(c, {
      reference,
      payload,
      requestedModel,
      reasoningEffort,
    })
  }

  const response = (await createCustomProviderChatCompletions(
    reference,
    payload,
    { signal: c.req.raw.signal, reasoningEffort },
  )) as ChatCompletionResponse

  return handleCustomProviderNonStreamingResponse(c, response, requestedModel)
}

function handleCustomProviderNonStreamingResponse(
  c: Context,
  response: ChatCompletionResponse,
  requestedModel: string,
) {
  if (response.usage) {
    setRequestContext(c, {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    })
  }
  return c.json({ ...response, model: requestedModel })
}

async function handleCustomProviderStreamingResponse(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload & { model: string }
    requestedModel: string
    reasoningEffort?: ReasoningEffort
  },
) {
  const response = await createCustomProviderChatCompletions(
    options.reference,
    options.payload,
    { signal: c.req.raw.signal, reasoningEffort: options.reasoningEffort },
  )

  if (isNonStreaming(response)) {
    return handleCustomProviderNonStreamingResponse(
      c,
      response,
      options.requestedModel,
    )
  }

  return streamSSE(c, async (stream) => {
    const adapter = createChatStreamTerminalAdapter({ c, stream })
    let finalSeen = false
    stream.onAbort(() => {
      adapter.abort()
    })
    try {
      for await (const chunk of withSseHeartbeat(response, stream)) {
        if (adapter.lifecycle.state !== "open") break
        if (!chunk.data) continue
        if (chunk.data === "[DONE]") break
        if (finalSeen) {
          const usageChunk = parseTrailingChatUsageChunk(chunk.data)
          if (!usageChunk) continue
          if (usageChunk.usage) {
            setRequestContext(c, {
              inputTokens: usageChunk.usage.prompt_tokens,
              outputTokens: usageChunk.usage.completion_tokens,
            })
          }
          if (usageChunk.model !== options.requestedModel) {
            usageChunk.model = options.requestedModel
          }
          await stream.writeSSE({
            ...chunk,
            data: JSON.stringify(usageChunk),
          } as SSEMessage)
          continue
        }
        let outChunk = chunk
        const parsedValue = JSON.parse(chunk.data) as unknown
        if (hasNonNullStreamError(parsedValue)) {
          await adapter.failReceived(parsedValue.error)
          break
        }
        const parsed = parsedValue as ChatCompletionChunk
        if (parsed.usage) {
          setRequestContext(c, {
            inputTokens: parsed.usage.prompt_tokens,
            outputTokens: parsed.usage.completion_tokens,
          })
        }
        if (parsed.model !== options.requestedModel) {
          parsed.model = options.requestedModel
          outChunk = { ...chunk, data: JSON.stringify(parsed) }
        }
        await stream.writeSSE(outChunk as SSEMessage)
        if (hasChatFinalChunk(parsed)) {
          finalSeen = true
        }
      }
      await (finalSeen ?
        adapter.succeedAfterFinalChunk()
      : adapter.finishSource())
    } catch (error) {
      if (isAbortError(error)) {
        adapter.abort()
        return
      }
      await (finalSeen ?
        adapter.succeedAfterFinalChunk()
      : adapter.failAfterCommit({
          kind: "thrown",
          error,
          ...(isHTTPError(error) ?
            { inspection: await inspectHttpError(error) }
          : {}),
        }))
    }
  })
}

const executeRequest = async (
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: {
    candidatePrepared?: boolean
    requestedModel?: string
    copilotSessionToken?: string
    webSearchMaxUses?: number
  } = {},
) => {
  const needsWebSearch =
    payload.tools?.some((tool) => isChatWebSearchFunctionTool(tool)) ?? false
  if (!payload.stream) {
    return await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: payload.messages,
        model: payload.model,
      }),
      async (span) => {
        const { processedPayload, response } =
          await createChatCompletionsWithProcessedPayload(
            payload as ChatCompletionsPayload & { stream?: false | null },
            {
              candidatePrepared: options.candidatePrepared,
              copilotSessionToken: options.copilotSessionToken,
              signal: c.req.raw.signal,
            },
          )

        // Track which account handled this request (multi-token mode)
        const accountId = getLastUsedAccountId()
        if (accountId !== undefined) {
          setRequestContext(c, { accountId })
        }

        const finalResponse =
          needsWebSearch ?
            await resolveWebSearchCalls(response, processedPayload, {
              abortSignal: c.req.raw.signal,
              copilotSessionToken: options.copilotSessionToken,
              maxUses: options.webSearchMaxUses,
              createCompletion: async (followUpPayload) =>
                (
                  await createChatCompletionsWithProcessedPayload(
                    followUpPayload,
                    {
                      allowCompatibilityRetry: false,
                      candidatePrepared: true,
                      copilotSessionToken: options.copilotSessionToken,
                      signal: c.req.raw.signal,
                    },
                  )
                ).response as ChatCompletionResponse,
            })
          : response

        return handleNonStreamingResponse(c, finalResponse, {
          span,
          requestedModel: options.requestedModel,
        })
      },
    )
  }

  if (needsWebSearch) {
    return await executeStreamingWebSearchRequest(c, payload, options)
  }

  return await handleStreamingResponse(c, payload, options)
}

async function executeCustomProviderWebSearchRequest(
  c: Context,
  options: {
    reference: CustomProviderModelReference
    payload: ChatCompletionsPayload & { model: string }
    requestedModel: string
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
  const result = { ...resolved, model: options.requestedModel }

  if (result.usage) {
    setRequestContext(c, {
      inputTokens: result.usage.prompt_tokens,
      outputTokens: result.usage.completion_tokens,
    })
  }

  if (!requestedStream) return c.json(result)
  return streamSSE(c, async (stream) => {
    const adapter = createChatStreamTerminalAdapter({ c, stream })
    stream.onAbort(() => {
      adapter.abort()
    })
    try {
      await emitChatCompletionResponseAsStream(stream, result, {
        writeDone: false,
      })
      await adapter.succeedAfterFinalChunk()
    } catch (error) {
      if (isAbortError(error)) {
        adapter.abort()
        return
      }
      await adapter.failAfterCommit({
        kind: "thrown",
        error,
        ...(isHTTPError(error) ?
          { inspection: await inspectHttpError(error) }
        : {}),
      })
    }
  })
}

async function executeStreamingWebSearchRequest(
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: {
    candidatePrepared?: boolean
    requestedModel?: string
    copilotSessionToken?: string
    webSearchMaxUses?: number
  },
) {
  const bufferedPayload = { ...payload, stream: false as const }
  return await Sentry.startSpan(
    createSentryChatSpanOptions({
      inputMessages: payload.messages,
      model: payload.model,
      streaming: true,
    }),
    async (span) => {
      const { processedPayload, response: initial } =
        await createChatCompletionsWithProcessedPayload(bufferedPayload, {
          candidatePrepared: options.candidatePrepared,
          copilotSessionToken: options.copilotSessionToken,
          signal: c.req.raw.signal,
        })
      const finalResponse = await resolveWebSearchCalls(
        initial,
        processedPayload,
        {
          abortSignal: c.req.raw.signal,
          copilotSessionToken: options.copilotSessionToken,
          maxUses: options.webSearchMaxUses,
          createCompletion: async (followUpPayload) =>
            (
              await createChatCompletionsWithProcessedPayload(followUpPayload, {
                allowCompatibilityRetry: false,
                candidatePrepared: true,
                copilotSessionToken: options.copilotSessionToken,
                signal: c.req.raw.signal,
              })
            ).response as ChatCompletionResponse,
        },
      )
      const response =
        options.requestedModel ?
          { ...finalResponse, model: options.requestedModel }
        : finalResponse
      setChatCompletionSpanResult(span, response)
      return streamSSE(c, async (stream) => {
        const adapter = createChatStreamTerminalAdapter({ c, stream })
        stream.onAbort(() => {
          adapter.abort()
        })
        try {
          await emitChatCompletionResponseAsStream(stream, response, {
            writeDone: false,
          })
          await adapter.succeedAfterFinalChunk()
        } catch (error) {
          if (isAbortError(error)) {
            adapter.abort()
            return
          }
          await adapter.failAfterCommit({
            kind: "thrown",
            error,
            ...(isHTTPError(error) ?
              { inspection: await inspectHttpError(error) }
            : {}),
          })
        }
      })
    },
  )
}

function setChatCompletionSpanResult(
  span: Sentry.Span,
  response: ChatCompletionResponse,
): void {
  span.setAttribute(
    "gen_ai.usage.input_tokens",
    response.usage?.prompt_tokens ?? 0,
  )
  span.setAttribute(
    "gen_ai.usage.output_tokens",
    response.usage?.completion_tokens ?? 0,
  )
  setSentryOutputMessages(span, response.choices[0]?.message?.content ?? "")
}

function getPayloadReasoningEffort(
  payload: ChatCompletionsPayload,
): ReasoningEffort | undefined {
  const effort = (payload as unknown as Record<string, unknown>)
    .reasoning_effort
  return parseReasoningEffort(effort)
}

function getNormalizedRequestedEffort(
  c: Context,
  options: {
    model: string
    suffixEffort?: ReasoningEffort
    payloadEffort?: ReasoningEffort
  },
): ReasoningEffort | undefined {
  const requestedRawEffort = options.suffixEffort ?? options.payloadEffort
  const requestedEffort = normalizeReasoningEffortForModel(
    options.model,
    requestedRawEffort,
  )
  if (requestedRawEffort && requestedEffort !== requestedRawEffort) {
    recordNonDefaultBehavior(c, {
      kind: "reasoning_effort_clamped",
      message: `Requested effort ${requestedRawEffort} for ${options.model} was clamped to ${requestedEffort}`,
      data: {
        model: options.model,
        requestedEffort: requestedRawEffort,
        effectiveEffort: requestedEffort,
      },
    })
  }
  return requestedEffort
}

async function resolveRedirectedModel(
  c: Context,
  request: { model: string; effort?: ReasoningEffort },
): Promise<{
  reasoningEffort?: ReasoningEffort
  redirected: boolean
  targetModel: string
  verbosity?: ModelRedirectVerbosity
}> {
  const redirect = await applyModelRedirect(request)
  if (redirect.redirected) {
    recordNonDefaultBehavior(c, {
      kind: "model_redirect",
      message: `Model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: request.model,
        sourceEffort: request.effort,
        targetModel: redirect.model,
        targetEffort: redirect.effort,
        ruleId: redirect.ruleId,
        ruleIds: redirect.ruleIds?.join(","),
      },
    })
  }

  const targetModel = normalizeModelName(redirect.model)
  const reasoningEffort = normalizeReasoningEffortForModel(
    targetModel,
    redirect.effort,
  )
  reportClampedRedirectEffort(c, {
    model: targetModel,
    requestedEffort: redirect.effort,
    effectiveEffort: reasoningEffort,
  })
  return {
    targetModel,
    reasoningEffort,
    redirected: redirect.redirected,
    verbosity: redirect.verbosity,
  }
}

function reportClampedRedirectEffort(
  c: Context,
  options: {
    model: string
    requestedEffort?: ReasoningEffort
    effectiveEffort?: ReasoningEffort
  },
): void {
  if (
    !options.requestedEffort
    || options.effectiveEffort === options.requestedEffort
  ) {
    return
  }
  recordNonDefaultBehavior(c, {
    kind: "reasoning_effort_clamped",
    message: `Requested redirected effort ${options.requestedEffort} for ${options.model} was clamped to ${options.effectiveEffort}`,
    data: {
      model: options.model,
      requestedEffort: options.requestedEffort,
      effectiveEffort: options.effectiveEffort,
    },
  })
}

function applyRoutableModelFallback(
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
): ChatCompletionsPayload & { model: string } {
  if (
    payload.model.endsWith("-1m")
    || tokenPool.hasEnabledAccountForKnownModel(payload.model) !== undefined
  ) {
    return payload
  }

  const candidate = `${payload.model}-1m`
  if (!state.models?.data.some((m) => m.id === candidate)) return payload

  recordNonDefaultBehavior(c, {
    kind: "model_fallback",
    message: `No enabled account can serve ${payload.model}; falling back to ${candidate}`,
    data: {
      sourceModel: payload.model,
      targetModel: candidate,
      reason: "no routable account for known model",
    },
  })
  return { ...payload, model: candidate }
}

function applyRedirectedReasoningEffort(options: {
  c: Context
  payload: ChatCompletionsPayload
  model: string
  effort: ReasoningEffort | undefined
}): void {
  const extra = options.payload as unknown as Record<string, unknown>
  if (!options.effort) {
    delete extra.reasoning_effort
    return
  }
  if (usesImplicitReasoningDefault(options.model)) {
    recordNonDefaultBehavior(options.c, {
      kind: "reasoning_effort_implicit_default",
      message: `${options.model} is configured for implicit reasoning defaults; removing explicit reasoning_effort=${options.effort}`,
      data: {
        model: options.model,
        requestedEffort: options.effort,
      },
    })
    delete extra.reasoning_effort
    return
  }
  extra.reasoning_effort = options.effort
}

const handleNonStreamingResponse = (
  c: Context,
  response: ChatCompletionResponse,
  context: { span: Sentry.Span; requestedModel?: string },
) => {
  const { span, requestedModel } = context
  consola.debug("Received non-streaming Chat response", {
    choiceCount: response.choices.length,
    model: response.model,
  })
  if (response.usage) {
    setRequestContext(c, {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    })
  }

  span.setAttribute(
    "gen_ai.usage.input_tokens",
    response.usage?.prompt_tokens ?? 0,
  )
  span.setAttribute(
    "gen_ai.usage.output_tokens",
    response.usage?.completion_tokens ?? 0,
  )
  const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
  if (cachedTokens > 0) {
    span.setAttribute("gen_ai.usage.input_tokens.cached", cachedTokens)
  }
  setSentryOutputMessages(span, response.choices[0]?.message?.content ?? "")

  if (requestedModel) {
    return c.json({ ...response, model: requestedModel })
  }
  return c.json(response)
}

// eslint-disable-next-line max-lines-per-function
const handleStreamingResponse = (
  c: Context,
  payload: ChatCompletionsPayload & { model: string },
  options: {
    candidatePrepared?: boolean
    requestedModel?: string
    copilotSessionToken?: string
  },
) => {
  consola.debug("Streaming response")
  return Sentry.startSpanManual(
    createSentryChatSpanOptions({
      inputMessages: payload.messages,
      model: payload.model,
      streaming: true,
    }),
    // eslint-disable-next-line max-lines-per-function
    async (span, finish) => {
      let spanFinished = false
      const finishSpan = () => {
        if (spanFinished) return
        spanFinished = true
        finish()
      }

      try {
        const response = await createChatCompletions(payload, {
          candidatePrepared: options.candidatePrepared,
          copilotSessionToken: options.copilotSessionToken,
          signal: c.req.raw.signal,
        })

        // Track which account handled this request (multi-token mode)
        const accountId = getLastUsedAccountId()
        if (accountId !== undefined) {
          setRequestContext(c, { accountId })
        }

        if (isNonStreaming(response)) {
          const result = handleNonStreamingResponse(c, response, {
            span,
            requestedModel: options.requestedModel,
          })
          finishSpan()
          return result
        }

        return streamSSE(c, async (stream) => {
          const adapter = createChatStreamTerminalAdapter({ c, stream })
          let finalSeen = false
          stream.onAbort(() => {
            adapter.abort()
          })
          try {
            let streamInputTokens = 0
            let streamOutputTokens = 0
            let streamCachedTokens = 0

            for await (const chunk of withSseHeartbeat(response, stream)) {
              if (adapter.lifecycle.state !== "open") break
              if (!chunk.data) continue
              if (chunk.data === "[DONE]") break
              if (finalSeen) {
                const usageChunk = parseTrailingChatUsageChunk(chunk.data)
                if (!usageChunk) continue
                if (usageChunk.usage) {
                  streamInputTokens = usageChunk.usage.prompt_tokens
                  streamOutputTokens = usageChunk.usage.completion_tokens
                  streamCachedTokens =
                    usageChunk.usage.prompt_tokens_details?.cached_tokens ?? 0
                  setRequestContext(c, {
                    inputTokens: usageChunk.usage.prompt_tokens,
                    outputTokens: usageChunk.usage.completion_tokens,
                  })
                }
                if (
                  options.requestedModel
                  && usageChunk.model !== options.requestedModel
                ) {
                  usageChunk.model = options.requestedModel
                }
                await stream.writeSSE({
                  ...chunk,
                  data: JSON.stringify(usageChunk),
                } as SSEMessage)
                continue
              }
              let outChunk = chunk
              // Capture usage from final chunk if available
              const parsedValue = JSON.parse(chunk.data) as unknown
              if (hasNonNullStreamError(parsedValue)) {
                await adapter.failReceived(parsedValue.error)
                break
              }
              const parsed = parsedValue as ChatCompletionChunk
              if (parsed.usage) {
                streamInputTokens = parsed.usage.prompt_tokens
                streamOutputTokens = parsed.usage.completion_tokens
                streamCachedTokens =
                  parsed.usage.prompt_tokens_details?.cached_tokens ?? 0
                setRequestContext(c, {
                  inputTokens: parsed.usage.prompt_tokens,
                  outputTokens: parsed.usage.completion_tokens,
                })
              }
              if (
                options.requestedModel
                && parsed.model !== options.requestedModel
              ) {
                parsed.model = options.requestedModel
                outChunk = { ...chunk, data: JSON.stringify(parsed) }
              }
              await stream.writeSSE(outChunk as SSEMessage)
              if (hasChatFinalChunk(parsed)) {
                finalSeen = true
              }
            }
            await (finalSeen ?
              adapter.succeedAfterFinalChunk()
            : adapter.finishSource())

            // Set token attributes after streaming completes - span is still open.
            span.setAttribute("gen_ai.usage.input_tokens", streamInputTokens)
            span.setAttribute("gen_ai.usage.output_tokens", streamOutputTokens)
            if (streamCachedTokens > 0) {
              span.setAttribute(
                "gen_ai.usage.input_tokens.cached",
                streamCachedTokens,
              )
            }
          } catch (error) {
            if (isAbortError(error)) {
              adapter.abort()
              return
            }
            await (finalSeen ?
              adapter.succeedAfterFinalChunk()
            : adapter.failAfterCommit({
                kind: "thrown",
                error,
                ...(isHTTPError(error) ?
                  { inspection: await inspectHttpError(error) }
                : {}),
              }))
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

const isNonStreaming = (
  response: unknown,
): response is ChatCompletionResponse =>
  typeof response === "object"
  && response !== null
  && Object.hasOwn(response, "choices")

function hasChatFinalChunk(chunk: unknown): boolean {
  if (typeof chunk !== "object" || chunk === null) return false
  const choices = (chunk as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return false
  return choices.some((choice) => {
    if (typeof choice !== "object" || choice === null) return false
    const finishReason = (choice as { finish_reason?: unknown }).finish_reason
    return finishReason !== null && finishReason !== undefined
  })
}

function parseTrailingChatUsageChunk(
  data: string,
): ChatCompletionChunk | undefined {
  try {
    const chunk = JSON.parse(data) as ChatCompletionChunk
    return chunk.choices.length === 0 && chunk.usage ? chunk : undefined
  } catch {
    return undefined
  }
}
