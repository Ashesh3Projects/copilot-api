import type { Context } from "hono"

import consola from "consola"
import { randomUUID } from "node:crypto"

import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import {
  runWithRoutedModelSelection,
  selectRoutedModel,
} from "~/lib/account-router"
import {
  createCustomProviderChatCompletions,
  resolveCustomProviderModel,
} from "~/lib/custom-providers"
import { getModelEndpointSupport } from "~/lib/endpoint-routing"
import { createHandlerLogger } from "~/lib/logger"
import {
  applyModelFallbackToPayload,
  getModelFallbackRedirect,
  isModelFallbackActive,
  runWithModelFallback,
} from "~/lib/model-fallback"
import { getLoadedModelFallbackConfig } from "~/lib/model-fallback-config"
import {
  applyModelRedirect,
  type ModelRedirectRequest,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  normalizeReasoningEffortForModel,
  parseModelSuffix,
} from "~/lib/model-suffix"
import { setRequestContext } from "~/lib/request-logger"
import { installResponsesRoutingAffinity } from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { createNativeMessages } from "~/routes/messages/native-handler"
import {
  type CompactionPayloadFitResult,
  fitResponsesCompactionPayload,
  fitChatCompletionsCompactionPayload,
} from "~/services/copilot/compaction-payload"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  createChatCompletions,
} from "~/services/copilot/create-chat-completions"
import {
  type ResponseInputItem,
  type ResponseUsage,
  type ResponsesPayload,
  type ResponsesResult,
  createResponses,
} from "~/services/copilot/create-responses"

import { getCompactionPrompt } from "./compact-prompt"
import {
  chatCompactionSummary,
  type CompactionSummary,
  messagesCompactionSummary,
  responsesCompactionSummary,
} from "./compact-summary"
import { adaptResponsesToMessagesCandidate } from "./messages-bridge"
import { readResponsesRequestJson } from "./request-json"
import { expandCompactionItems, getResponsesRequestOptions } from "./utils"

const logger = createHandlerLogger("compact-handler")

interface CompactRequestBody {
  model: string
  input: Array<ResponseInputItem>
  instructions?: string
  client_metadata?: Record<string, unknown> | string
  previous_response_id?: string
  prompt_cache_key?: string
}

interface CompactionItem {
  id: string
  type: "compaction"
  encrypted_content: string
}

interface CompactedResponse {
  id: string
  object: "response.compaction"
  created_at: number
  output: Array<CompactionItem>
  usage: ResponseUsage | null
}

/**
 * Build the final CompactedResponse from summary text and usage data.
 */
const buildCompactedResponse = (
  summaryText: string,
  usage: ResponseUsage | null,
): CompactedResponse => {
  const encoded = Buffer.from(summaryText, "utf8").toString("base64")

  return {
    id: `resp_compact_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output: [
      {
        id: `cmp_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        type: "compaction",
        encrypted_content: encoded,
      },
    ],
    usage,
  }
}

/**
 * Convert ResponseInputItems to ChatCompletions messages for the fallback path.
 */
const convertInputToMessages = (
  input: Array<ResponseInputItem>,
): ChatCompletionsPayload["messages"] => {
  const messages: ChatCompletionsPayload["messages"] = []

  for (const item of input) {
    const itemType = (item as { type?: string }).type
    if (!itemType || itemType === "message") {
      const msg = item as {
        role: "user" | "assistant" | "system" | "developer"
        content?: string | Array<{ type?: string; text?: string }>
      }
      const role = msg.role === "developer" ? "system" : msg.role
      let content = ""
      if (typeof msg.content === "string") {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join("")
      }
      messages.push({ role, content })
    } else {
      convertSpecialItem(messages, itemType, item)
    }
  }

  return messages
}

const convertSpecialItem = (
  messages: ChatCompletionsPayload["messages"],
  itemType: string,
  item: ResponseInputItem,
): void => {
  switch (itemType) {
    case "custom_tool_call": {
      const call = item as {
        call_id?: string
        input?: string
        name?: string
      }
      messages.push({
        role: "assistant",
        content:
          `[Custom tool call ${call.call_id ?? "unknown"}: `
          + `${call.name ?? "unknown"}(${call.input ?? ""})]`,
      })
      break
    }
    case "custom_tool_call_output": {
      const output = item as { call_id?: string; output?: unknown }
      messages.push({
        role: "user",
        content:
          `[Custom tool result ${output.call_id ?? "unknown"}: `
          + `${stringifyToolOutput(output.output)}]`,
      })
      break
    }
    case "function_call": {
      const fc = item as {
        call_id?: string
        name?: string
        arguments?: string
      }
      messages.push({
        role: "assistant",
        content:
          `[Tool call ${fc.call_id ?? "unknown"}: `
          + `${fc.name ?? "unknown"}(${fc.arguments ?? ""})]`,
      })
      break
    }
    case "function_call_output": {
      const fco = item as { call_id?: string; output?: string }
      const output = stringifyToolOutput(fco.output)
      messages.push({
        role: "user",
        content: `[Tool result ${fco.call_id ?? "unknown"}: ${output}]`,
      })
      break
    }
    case "reasoning": {
      const reasoning = item as {
        summary?: Array<{ text?: string }>
      }
      const text = reasoning.summary
        ?.map((s) => s.text ?? "")
        .filter(Boolean)
        .join("\n")
      if (text) {
        messages.push({
          role: "assistant",
          content: `[Thinking: ${text}]`,
        })
      }
      break
    }
    // No default
  }
}

const stringifyToolOutput = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output)

const reportCompactionReduction = (
  message: string,
  fitted: CompactionPayloadFitResult<ResponsesPayload>,
): void => {
  if (!fitted.reduced) return
  consola.warn(message, {
    originalBytes: fitted.originalBytes,
    finalBytes: fitted.finalBytes,
    omittedBinaryBlocks: fitted.omittedBinaryBlocks,
    truncatedToolOutputBytes: fitted.truncatedToolOutputBytes,
  })
}

async function compactWithMessages(
  c: Context,
  responsesPayload: ResponsesPayload,
  selectedModel: Model | undefined,
): Promise<CompactionSummary> {
  setRequestContext(c, { provider: "Compact→AnthropicMessages" })
  const fitted = fitResponsesCompactionPayload(responsesPayload)
  reportCompactionReduction("Reduced oversized compact summary payload", fitted)
  const { payload } = await adaptResponsesToMessagesCandidate({
    source: fitted.payload,
    signal: c.req.raw.signal,
  })
  payload.stream = false
  const outputLimit = selectedModel?.capabilities.limits?.max_output_tokens
  if (Number.isInteger(outputLimit) && Number(outputLimit) > 0) {
    payload.max_tokens = outputLimit
  }
  const response = await createNativeMessages(
    payload,
    {
      anthropicBeta: c.req.header("anthropic-beta"),
      anthropicVersion: c.req.header("anthropic-version"),
      modelProviderPreference: c.req.header("x-model-provider-preference"),
    },
    { compaction: true, signal: c.req.raw.signal },
  )
  return messagesCompactionSummary(response as AnthropicResponse)
}

export const handleCompact = async (c: Context) => {
  const body = await readResponsesRequestJson<CompactRequestBody>(c.req.raw)
  installResponsesRoutingAffinity(body.client_metadata)
  return await runWithModelFallback(
    { headers: c.req.raw.headers, payload: body, signal: c.req.raw.signal },
    async () => await handleCompactAttempt(c, structuredClone(body)),
  )
}

const handleCompactAttempt = async (c: Context, body: CompactRequestBody) => {
  const requestedModel = body.model
  const sourceModel = await resolveCompactFallbackSource(requestedModel)
  // The fallback executor owns this fresh payload clone for the whole attempt.
  // eslint-disable-next-line require-atomic-updates
  body.model = sourceModel.model
  applyModelFallbackToPayload(body, sourceModel)
  const model = body.model

  setRequestContext(c, {
    requestedModel,
    provider: "Compact",
    model,
  })

  const compactionPrompt = getCompactionPrompt()
  const compactionUserMessage: ResponseInputItem = {
    type: "message",
    role: "user",
    content: "Please summarize the conversation above concisely.",
  }

  const input: Array<ResponseInputItem> = [
    ...(Array.isArray(body.input) ? body.input : []),
    compactionUserMessage,
  ]

  const tempPayload = { input, model } as ResponsesPayload
  expandCompactionItems(tempPayload)
  const expandedInput = tempPayload.input as Array<ResponseInputItem>
  const responsesPayload: ResponsesPayload = {
    model,
    instructions: compactionPrompt,
    input: expandedInput,
    stream: false,
    tool_choice: "none",
    store: false,
    ...compactFallbackOptions(),
  }
  const customReference = resolveCompactCustomFallback(model)
  const routedModel = customReference ? {} : selectRoutedModel(model)
  const support = getModelEndpointSupport(routedModel.model)
  const { summaryText, usage } = await runWithRoutedModelSelection(
    routedModel,
    async () => {
      if (!customReference && support.responses) {
        // Use native Responses API
        const fitted = fitResponsesCompactionPayload(responsesPayload)
        const fittedPayload = fitted.payload
        reportCompactionReduction(
          "Reduced oversized compact summary payload",
          fitted,
        )
        const { vision, initiator } = getResponsesRequestOptions(fittedPayload)
        const response = await createResponses(fittedPayload, {
          vision,
          initiator,
          signal: c.req.raw.signal,
          compaction: true,
        })

        const result = response as ResponsesResult
        logger.debug("Compact Responses result received")
        return responsesCompactionSummary(result)
      }
      if (!customReference && support.messages && !support.chat) {
        return await compactWithMessages(c, responsesPayload, routedModel.model)
      }
      // Fall back to ChatCompletions
      consola.debug(
        `[compact] Model ${model} does not support /responses, falling back to ChatCompletions`,
      )
      setRequestContext(c, { provider: "Compact→ChatCompletions" })
      const ccPayload: ChatCompletionsPayload = {
        model,
        messages: [
          { role: "system", content: compactionPrompt },
          ...convertInputToMessages(expandedInput),
        ],
        stream: false,
        temperature: 0,
        ...compactChatFallbackOptions(),
      }

      const response =
        customReference ?
          await createCustomProviderChatCompletions(
            customReference,
            fitChatCompletionsCompactionPayload(ccPayload).payload,
            { signal: c.req.raw.signal },
          )
        : await createChatCompletions(ccPayload, {
            compaction: true,
            signal: c.req.raw.signal,
          })
      const result = response as ChatCompletionResponse
      logger.debug("Compact ChatCompletions result received")
      return chatCompactionSummary(result)
    },
  )

  if (usage) {
    setRequestContext(c, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    })
  }

  const compactedResponse = buildCompactedResponse(summaryText, usage)
  return c.json(compactedResponse)
}

function resolveCompactCustomFallback(model: string) {
  return isModelFallbackActive() ?
      resolveCustomProviderModel({
        model,
        kind: "chat",
        copilotModelIds: new Set(
          state.models?.data.map((entry) => entry.id) ?? [],
        ),
      })
    : undefined
}

async function resolveCompactFallbackSource(
  requestedModel: string,
): Promise<ModelRedirectRequest> {
  const { baseModel, reasoningEffort } = parseModelSuffix(requestedModel)
  if (!getLoadedModelFallbackConfig().enabled)
    return { model: baseModel, effort: reasoningEffort }
  const normalized = normalizeModelName(baseModel)
  const redirect = await applyModelRedirect({
    model: normalized,
    effort: normalizeReasoningEffortForModel(normalized, reasoningEffort),
  })
  const model = normalizeModelName(redirect.model)
  if (
    !model.endsWith("-1m")
    && tokenPool.hasEnabledAccountForKnownModel(model) === undefined
    && state.models?.data.some((entry) => entry.id === `${model}-1m`)
  )
    return {
      model: `${model}-1m`,
      effort: redirect.effort,
      verbosity: redirect.verbosity,
    }
  return { model, effort: redirect.effort, verbosity: redirect.verbosity }
}

function compactFallbackOptions(): Pick<
  ResponsesPayload,
  "reasoning" | "text"
> {
  const redirect = getModelFallbackRedirect()
  return {
    ...(redirect?.effort ? { reasoning: { effort: redirect.effort } } : {}),
    ...(redirect?.verbosity ? { text: { verbosity: redirect.verbosity } } : {}),
  }
}

function compactChatFallbackOptions(): Pick<
  ChatCompletionsPayload,
  "reasoning_effort"
> {
  const effort = getModelFallbackRedirect()?.effort
  return effort ? { reasoning_effort: effort } : {}
}
