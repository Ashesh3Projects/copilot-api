/* eslint-disable complexity -- prepared and compatibility request paths intentionally share transport */
import consola from "consola"
import { events } from "fetch-event-stream"

import type { RoutedAccountPin } from "~/lib/account-router"
import type { UpstreamSendReason } from "~/lib/routing-telemetry"
import type { RetryBudget } from "~/services/copilot/transport-retry"

import { routedFetch } from "~/lib/account-router"
import {
  attachmentOmittedNote,
  fetchUrlAsDataUri,
  pdfUnsupportedByModelNote,
  toDataUri,
} from "~/lib/attachments"
import { HTTPError } from "~/lib/error"
import { modelSupportsAssistantPrefill } from "~/lib/model-settings"
import { normalizeChatCompletionsRequest } from "~/routes/chat-completions/chat-contract"
import {
  hasVisionContent,
  detectInitiator,
  addPromptCaching,
} from "~/services/copilot/copilot-client"
import {
  claimCompatibilityRetry,
  consumeExtraSend,
  createRetryBudget,
  PRE_HEADER_MAX_DELAY_SECONDS,
} from "~/services/copilot/transport-retry"

import { fitChatCompletionsCompactionPayload } from "./compaction-payload"
import { classifyCompatibilityRetry } from "./compatibility-retry"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

type StreamEvent = {
  data?: string
  event?: string
  id?: string | number
  retry?: number
}

const hasOverloadText = (value: unknown): boolean =>
  typeof value === "string" && value.toLowerCase().includes("overloaded")

export const rewriteUnsupportedAssistantPrefill = (
  payload: ChatCompletionsPayload,
): void => {
  if (modelSupportsAssistantPrefill(payload.model)) return

  const lastMessage = payload.messages.at(-1)
  if (!lastMessage || lastMessage.role !== "assistant") return

  payload.messages[payload.messages.length - 1] = {
    role: "user",
    content: lastMessage.content,
    ...(lastMessage.name ? { name: lastMessage.name } : {}),
  }
}

/**
 * Normalize payload before sending to Copilot.
 * - Downgrade json_schema to json_object (Copilot returns empty content for json_schema)
 *   and stash the schema so injectJsonInstruction can reference it
 */
const normalizePayload = (payload: ChatCompletionsPayload): void => {
  if (payload.stream && !payload.stream_options) {
    payload.stream_options = { include_usage: true }
  }

  if (
    payload.response_format
    && (payload.response_format as Record<string, unknown>).type
      === "json_schema"
  ) {
    const fmt = payload.response_format as Record<string, unknown>
    const schemaWrapper = fmt.json_schema as Record<string, unknown> | undefined
    const jsonSchema = schemaWrapper?.schema
    if (jsonSchema) {
      ;(payload as unknown as Record<string, unknown>)._json_schema = jsonSchema
    }
    payload.response_format = { type: "json_object" }
  }
}

const isJsonResponseFormat = (payload: ChatCompletionsPayload): boolean => {
  const type = (payload.response_format as Record<string, unknown> | undefined)
    ?.type
  return type === "json_object" || type === "json_schema"
}

const JSON_RESPONSE_INSTRUCTION =
  "IMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanation — just raw JSON."

/**
 * Strip markdown code fences from content when json response_format is requested.
 * Claude wraps JSON output in ```json ... ``` fences, violating the OpenAI contract
 * that guarantees raw JSON in the content field.
 */
const stripJsonFences = (result: ChatCompletionResponse): void => {
  for (const choice of result.choices) {
    const content = choice.message.content
    if (typeof content !== "string") continue
    const stripped = content
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\n?```\s*$/, "")
    if (stripped !== content) {
      choice.message.content = stripped
    }
  }
}

/**
 * When response_format requests JSON output, inject a system-level instruction
 * as a fallback. Copilot may not pass response_format through for all models
 * (e.g. Claude), causing the model to return markdown instead of JSON.
 *
 * If a json_schema was downgraded to json_object, include the schema in the
 * instruction so the model returns the correct structure.
 */
const injectJsonInstruction = (payload: ChatCompletionsPayload): void => {
  if (!isJsonResponseFormat(payload)) return

  const stashedSchema = (payload as unknown as Record<string, unknown>)
    ._json_schema
  let instruction = JSON_RESPONSE_INSTRUCTION

  if (stashedSchema) {
    instruction += `\nYou MUST conform to this JSON schema:\n${JSON.stringify(stashedSchema)}`
    delete (payload as unknown as Record<string, unknown>)._json_schema
  }

  if (
    payload.messages.some(
      (message) =>
        message.role === "system"
        && typeof message.content === "string"
        && message.content.includes(instruction),
    )
  ) {
    return
  }

  const systemMsg = payload.messages.find((m) => m.role === "system")
  if (systemMsg && typeof systemMsg.content === "string") {
    systemMsg.content = `${systemMsg.content}\n\n${instruction}`
  } else {
    payload.messages.unshift({ role: "system", content: instruction })
  }
}

const imageTypes = new Set(["image_url", "image", "input_image"])
const attachmentTypes = new Set([...imageTypes, "file", "input_file"])

function removeImages(payload: ChatCompletionsPayload): void {
  for (const msg of payload.messages) {
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.filter(
        (part) => !attachmentTypes.has(part.type),
      )
      if (msg.content.length === 1) {
        const first = msg.content[0] as TextPart
        msg.content = first.text
      }
    }
  }
}

/**
 * The Copilot /chat/completions endpoint only accepts `text` and `image_url`
 * content parts, and image URLs must be data URIs ("external image URLs are
 * not supported"). Fetch external image URLs and inline them; downgrade
 * anything that cannot be carried (PDF `file` parts, failed fetches) to an
 * explanatory text note. PDF-capable models are routed to /responses or
 * /v1/messages before reaching this function; this is the safety net.
 */
export async function normalizeChatAttachments(
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
): Promise<void> {
  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue

    const normalized: Array<ContentPart> = []
    for (const part of message.content) {
      normalized.push(
        await normalizeChatContentPart(part, payload.model, signal),
      )
    }
    message.content = normalized
  }
}

async function normalizeChatContentPart(
  part: ContentPart,
  model: string,
  signal?: AbortSignal,
): Promise<ContentPart> {
  if (part.type === "image_url" && !part.image_url.url.startsWith("data:")) {
    const inlined = await fetchUrlAsDataUri(part.image_url.url, { signal })
    if (inlined) {
      return {
        ...part,
        image_url: {
          ...part.image_url,
          url: toDataUri(inlined.mediaType, inlined.data),
        },
      }
    }
    consola.warn(`Failed to inline external image URL for ${model}`)
    return {
      type: "text",
      text: attachmentOmittedNote({
        kind: "image",
        reason: "the URL could not be fetched by the proxy",
      }),
    }
  }

  if (part.type === "file") {
    consola.warn(
      `Downgrading PDF file part for ${model}: /chat/completions cannot carry file attachments`,
    )
    return {
      type: "text",
      text: pdfUnsupportedByModelNote(model, part.file.filename),
    }
  }

  return part
}

async function handleResponse(
  response: Response,
  payload: ChatCompletionsPayload,
) {
  if (!response.ok) {
    throwFailedResponse(response, payload)
  }

  if (payload.stream) {
    return events(response)
  }

  const text = await response.text()
  if (!text) {
    consola.error("Empty response body from Copilot (status 200)")
    throw new HTTPError(
      "Empty response body from upstream",
      new Response("", { status: 502 }),
      payload,
    )
  }

  try {
    const result = JSON.parse(text) as ChatCompletionResponse
    if (isJsonResponseFormat(payload)) {
      stripJsonFences(result)
    }
    return result
  } catch {
    consola.error("Invalid JSON from Copilot")
    throw new HTTPError(
      "Invalid JSON response from upstream",
      new Response(null, { status: 502 }),
      payload,
    )
  }
}

const throwFailedResponse = (
  response: Response,
  payload: ChatCompletionsPayload,
): never => {
  consola.error(
    "Failed to create chat completions",
    `Status: ${response.status}`,
  )
  throw new HTTPError("Failed to create chat completions", response, payload)
}

const isOverloadStreamEvent = (event: StreamEvent | undefined): boolean => {
  const data = event?.data
  if (!data || data === "[DONE]") {
    return false
  }

  try {
    const parsed = JSON.parse(data) as unknown
    if (!isRecord(parsed)) {
      return false
    }

    if (event.event === "error" && hasOverloadText(parsed.message)) {
      return true
    }

    const error = parsed.error
    if (isRecord(error) && hasOverloadText(error.message)) {
      return true
    }
  } catch {
    return false
  }

  return false
}

const createBufferedEventStream = (
  firstEvent: StreamEvent | undefined,
  iterator: AsyncIterator<StreamEvent>,
): AsyncIterable<StreamEvent> => ({
  async *[Symbol.asyncIterator]() {
    if (firstEvent) {
      yield firstEvent
    }
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        return
      }
      yield next.value
    }
  },
})

interface StreamingRetryOptions {
  payload: ChatCompletionsPayload
  retry: () => Promise<Response | undefined>
  retriesRemaining?: number
}

export interface ChatCompletionsRequestOptions {
  allowCompatibilityRetry?: boolean
  candidatePrepared?: boolean
  compaction?: boolean
  copilotSessionToken?: string
  initiator?: "agent" | "user"
  routedAccountPin?: RoutedAccountPin
  retryBudget?: RetryBudget
  signal?: AbortSignal
}

interface ChatCompletionsWithProcessedPayload {
  processedPayload: ChatCompletionsPayload
  response: ChatCompletionsResult
}

interface NonStreamingChatCompletionsWithProcessedPayload {
  processedPayload: ChatCompletionsPayload
  response: ChatCompletionResponse
}

interface ChatCompletionsCoreResult {
  processedPayload: ChatCompletionsPayload
  response: ChatCompletionsResult
}

interface ChatHeaderOptions {
  copilotSessionToken?: string
  vision: boolean
  initiator: "agent" | "user"
}

interface ChatUpstreamAttempt {
  headerOptions: ChatHeaderOptions
  payload: ChatCompletionsPayload
  response: Response
}

interface ChatOperationState {
  routedAccountPin: RoutedAccountPin
  retryBudget: RetryBudget
}

async function retryChatCompatibility(options: {
  attempt: ChatUpstreamAttempt
  operation: ChatOperationState
  signal?: AbortSignal
}): Promise<ChatUpstreamAttempt> {
  const { attempt, operation } = options
  const decision = await classifyCompatibilityRetry({
    body: attempt.payload as unknown as Record<string, unknown>,
    endpoint: "/chat/completions",
    response: attempt.response,
  })
  if (decision.kind === "none") return attempt
  const retryPayload = structuredClone(attempt.payload)
  if (
    !decision.normalize(retryPayload as unknown as Record<string, unknown>)
    || !claimCompatibilityRetry(operation.retryBudget)
  ) {
    return attempt
  }
  return {
    headerOptions: attempt.headerOptions,
    payload: retryPayload,
    response: await dispatchChatCompletions(retryPayload, {
      headerOptions: attempt.headerOptions,
      operation,
      reason: "compatibility_retry",
      recordSelection: false,
      signal: options.signal,
    }),
  }
}

const prepareChatCompletionsPayload = (
  payload: ChatCompletionsPayload,
  compaction: boolean | undefined,
): ChatCompletionsPayload => {
  if (!compaction) return payload

  const fitted = fitChatCompletionsCompactionPayload(payload)
  if (fitted.reduced) {
    consola.warn("Reduced oversized ChatCompletions compaction payload", {
      originalBytes: fitted.originalBytes,
      finalBytes: fitted.finalBytes,
      omittedBinaryBlocks: fitted.omittedBinaryBlocks,
      truncatedToolOutputBytes: fitted.truncatedToolOutputBytes,
    })
  }
  return fitted.payload
}

const dispatchChatCompletions = async (
  payload: ChatCompletionsPayload,
  options: {
    headerOptions: ChatHeaderOptions
    operation: ChatOperationState
    reason?: UpstreamSendReason
    recordSelection?: boolean
    signal?: AbortSignal
  },
): Promise<Response> => {
  const { response } = await routedFetch(
    "/chat/completions",
    { method: "POST", body: JSON.stringify(payload), signal: options.signal },
    {
      modelId: payload.model,
      headerOptions: options.headerOptions,
      reason: options.reason,
      recordSelection: options.recordSelection,
      routedAccountPin: options.operation.routedAccountPin,
      retryBudget: options.operation.retryBudget,
      maxHttpRetryDelaySeconds:
        payload.stream ? PRE_HEADER_MAX_DELAY_SECONDS : undefined,
    },
  )
  return response
}

const dispatchWithImageFallback = async (options: {
  compaction: boolean | undefined
  headerOptions: ChatHeaderOptions
  outboundPayload: ChatCompletionsPayload
  operation: ChatOperationState
  signal?: AbortSignal
  sourcePayload: ChatCompletionsPayload
}): Promise<ChatUpstreamAttempt> => {
  const response = await dispatchChatCompletions(options.outboundPayload, {
    headerOptions: options.headerOptions,
    operation: options.operation,
    signal: options.signal,
  })
  if (response.status !== 413 || !options.headerOptions.vision) {
    return {
      response,
      payload: options.outboundPayload,
      headerOptions: options.headerOptions,
    }
  }

  consola.warn("413 Payload Too Large with images, retrying without images")
  if (!consumeExtraSend(options.operation.retryBudget)) {
    return {
      response,
      payload: options.outboundPayload,
      headerOptions: options.headerOptions,
    }
  }
  removeImages(options.sourcePayload)
  const retryPayload = prepareChatCompletionsPayload(
    options.sourcePayload,
    options.compaction,
  )
  const retryHeaderOptions = {
    copilotSessionToken: options.headerOptions.copilotSessionToken,
    vision: false,
    initiator: options.headerOptions.initiator,
  }
  const retryResponse = await dispatchChatCompletions(retryPayload, {
    headerOptions: retryHeaderOptions,
    operation: options.operation,
    reason: "http_retry",
    recordSelection: false,
    signal: options.signal,
  })
  return {
    response: retryResponse,
    payload: retryPayload,
    headerOptions: retryHeaderOptions,
  }
}

const handleStreamingResponse = async (
  response: Response,
  options: StreamingRetryOptions,
): Promise<AsyncIterable<StreamEvent>> => {
  const { payload, retry, retriesRemaining = 1 } = options
  if (!response.ok) {
    throwFailedResponse(response, payload)
  }

  const stream = events(response) as AsyncIterable<StreamEvent>
  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()

  if (first.done) {
    return createBufferedEventStream(undefined, iterator)
  }

  if (!isOverloadStreamEvent(first.value) || retriesRemaining === 0) {
    return createBufferedEventStream(first.value, iterator)
  }

  consola.warn("Stream overload detected on first event, retrying")
  await iterator.return?.()
  const retryResponse = await retry()
  if (!retryResponse) {
    return createBufferedEventStream(first.value, {
      next: () => Promise.resolve({ done: true, value: undefined }),
    })
  }
  return handleStreamingResponse(retryResponse, {
    ...options,
    retriesRemaining: retriesRemaining - 1,
  })
}

type ChatCompletionsResult = ChatCompletionResponse | AsyncIterable<StreamEvent>

export function createChatCompletionsWithProcessedPayload(
  payload: ChatCompletionsPayload & { stream?: false | null },
  options?: ChatCompletionsRequestOptions,
): Promise<NonStreamingChatCompletionsWithProcessedPayload>
export function createChatCompletionsWithProcessedPayload(
  payload: ChatCompletionsPayload,
  options?: ChatCompletionsRequestOptions,
): Promise<ChatCompletionsWithProcessedPayload>
export async function createChatCompletionsWithProcessedPayload(
  payload: ChatCompletionsPayload,
  options?: ChatCompletionsRequestOptions,
): Promise<ChatCompletionsWithProcessedPayload> {
  const result = await createChatCompletionsCore(payload, options)
  return {
    processedPayload: structuredClone(result.processedPayload),
    response: result.response,
  }
}

async function createChatCompletionsCore(
  payload: ChatCompletionsPayload,
  options?: ChatCompletionsRequestOptions,
): Promise<ChatCompletionsCoreResult> {
  const normalizedPayload =
    options?.candidatePrepared ?
      structuredClone(payload)
    : normalizeChatCompletionsRequest(payload)
  options?.signal?.throwIfAborted()
  if (!options?.candidatePrepared) {
    rewriteUnsupportedAssistantPrefill(normalizedPayload)
    await normalizeChatAttachments(normalizedPayload, options?.signal)
  }
  options?.signal?.throwIfAborted()
  const vision = hasVisionContent(normalizedPayload.messages)
  const initiator = detectInitiator(
    normalizedPayload.messages,
    options?.initiator,
  )
  const headerOpts = {
    copilotSessionToken: options?.copilotSessionToken,
    vision,
    initiator,
  }

  if (!options?.candidatePrepared) {
    normalizePayload(normalizedPayload)
    injectJsonInstruction(normalizedPayload)
    addPromptCaching(
      normalizedPayload.messages,
      normalizedPayload.tools ?? undefined,
    )
  }

  const outboundPayload = prepareChatCompletionsPayload(
    normalizedPayload,
    options?.compaction,
  )
  const operation: ChatOperationState = {
    routedAccountPin: options?.routedAccountPin ?? {},
    retryBudget: options?.retryBudget ?? createRetryBudget(),
  }

  const initialAttempt = await dispatchWithImageFallback({
    compaction: options?.compaction,
    headerOptions: headerOpts,
    outboundPayload,
    operation,
    signal: options?.signal,
    sourcePayload: normalizedPayload,
  })
  const active =
    options?.allowCompatibilityRetry === false ?
      initialAttempt
    : await retryChatCompatibility({
        attempt: initialAttempt,
        operation,
        signal: options?.signal,
      })
  if (normalizedPayload.stream) {
    return {
      processedPayload: active.payload,
      response: await handleStreamingResponse(active.response, {
        payload: active.payload,
        retry: async () => {
          if (!consumeExtraSend(operation.retryBudget)) return undefined
          return await dispatchChatCompletions(active.payload, {
            headerOptions: active.headerOptions,
            operation,
            reason: "http_retry",
            recordSelection: false,
            signal: options?.signal,
          })
        },
      }),
    }
  }

  return {
    processedPayload: active.payload,
    response: await handleResponse(active.response, active.payload),
  }
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options?: ChatCompletionsRequestOptions,
): Promise<ChatCompletionsResult> => {
  const result = await createChatCompletionsCore(payload, options)
  return result.response
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

export interface Delta {
  content?: string | null
  reasoning_text?: string | null // Claude thinking text from CAPI
  reasoning_opaque?: string | null // Encrypted signature from CAPI (streaming)
  encrypted_content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

export interface ResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_text?: string | null // Claude thinking text from CAPI
  reasoning_opaque?: string | null // Encrypted signature from CAPI
  encrypted_content?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null
  stream_options?: { include_usage?: boolean } | null
  parallel_tool_calls?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  top_logprobs?: number | null
  prediction?: Record<string, unknown> | null
  reasoning_effort?: string | null
  thinking_budget?: number | null
  response_format?: { type: string; [key: string]: unknown } | null
  seed?: number | null
  tools?: Array<Tool> | null
  functions?: Array<Record<string, unknown>> | null
  function_call?: string | { name: string } | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | { type: string; [key: string]: unknown }
    | null
  user?: string | null
  snippy?: { enabled: boolean } | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  encrypted_content?: string | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart | FilePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}

/**
 * OpenAI Chat Completions file content part (PDF attachments).
 * Copilot's /chat/completions endpoint rejects this type; the proxy routes
 * file-bearing payloads to /responses (input_file) or /v1/messages
 * (document blocks) instead, or forwards it verbatim to custom providers.
 */
export interface FilePart {
  type: "file"
  file: {
    filename?: string
    /** base64 data URI (e.g. "data:application/pdf;base64,...") */
    file_data?: string
    file_id?: string
  }
}
