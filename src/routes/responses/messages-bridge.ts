/* eslint-disable complexity, max-lines, max-lines-per-function, max-params -- tolerant Responses-to-Messages adapter handles open protocol families */
import type {
  EvaluatedEndpointCandidate,
  TranslationFinding,
} from "~/lib/endpoint-routing"
import type {
  AnthropicNamedTool,
  AnthropicAssistantContentBlock,
  AnthropicInlineContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type { NativeMessagesRequestOptions } from "~/routes/messages/native-handler"
import type { ContentPart } from "~/services/copilot/create-chat-completions"
import type {
  FunctionTool,
  ResponseInputItem,
  ResponseOutputItem,
  ResponsesPayload,
  ResponsesResult,
  ResponseUsage,
} from "~/services/copilot/create-responses"
import type { ResponsesWireBody } from "~/services/copilot/responses-contract"

import {
  fetchUrlAsDataUri,
  isLikelyBase64,
  parseDataUri,
} from "~/lib/attachments"
import { createEvaluatedTranslationCheck } from "~/lib/endpoint-routing"
import {
  assertEndpointTranslationSupported,
  createEndpointTranslationError,
} from "~/lib/error"
import { isModelFallbackActive } from "~/lib/model-fallback"
import { createNativeMessages } from "~/routes/messages/native-handler"
import { createWebSearchAnthropicTool } from "~/services/copilot/mcp-web-search"

import type { ResponsesAttachmentCache } from "./attachment-cache"

import {
  convertOpenAIContentPartToAnthropic,
  convertOpenAIToolsToAnthropic,
} from "../chat-completions/anthropic-conversion"
import {
  isAnthropicAssistantMessage,
  isAnthropicTextBlock,
  isAnthropicToolResultBlock,
  isAnthropicUserMessage,
} from "../messages/anthropic-types"
import { associateResponsesFunctionCalls } from "./tool-call-association"
import { checkResponsesToMessagesTranslation } from "./translation-fidelity"

export interface ResponsesMessagesBridgeOptions {
  attachmentsNormalized?: boolean
}

export type ResponsesMessagesCandidate = EvaluatedEndpointCandidate<
  "/v1/messages",
  AnthropicMessagesPayload
>

interface TolerantMessagesState {
  readonly emittedCallIds: Set<string>
  readonly findings: Array<TranslationFinding>
}

const FUTURE_RESPONSES_ITEM_CONTEXT = "[Future Responses item]"
const FUTURE_RESPONSES_ROLE_CONTEXT = "[Future role content]"
const RESPONSES_REASONING_CONTEXT = "[Assistant reasoning context]"
const RESPONSES_TOOL_CONTEXT = "[Non-function tool context]"
const RESPONSES_UNPAIRED_RESULT_CONTEXT = "[Unpaired tool result]"
const MAX_ASSISTANT_FALLBACK_TEXT_LENGTH = 16_384

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function addTranslationFinding(
  findings: Array<TranslationFinding>,
  finding: TranslationFinding,
): void {
  if (
    findings.some(
      (current) =>
        current.class === finding.class
        && current.severity === finding.severity,
    )
  ) {
    return
  }
  findings.push(finding)
}

function createTolerantMessagesState(
  _source: ResponsesWireBody,
): TolerantMessagesState {
  return {
    emittedCallIds: new Set(),
    findings: [],
  }
}

function stringifyTolerantValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

function appendTolerantTextMessage(
  messages: Array<AnthropicMessage>,
  role: "assistant" | "user",
  label: string,
  value?: unknown,
): void {
  const detail = stringifyTolerantValue(value)
  messages.push({ role, content: detail ? `${label}\n${detail}` : label })
}

async function convertTolerantResponsesContent(
  content: unknown,
  findings: Array<TranslationFinding>,
  signal: AbortSignal | undefined,
  resolveAttachment: ResponsesAttachmentCache["resolve"],
): Promise<Array<AnthropicUserContentBlock>> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: Array<AnthropicUserContentBlock> = []
  for (const raw of content) {
    if (!isRecord(raw)) {
      addTranslationFinding(findings, {
        class: "content_part",
        severity: "adapted",
      })
      blocks.push({ type: "text", text: "[Unrepresentable content item]" })
      continue
    }
    if (
      (raw.type === "input_text" || raw.type === "output_text")
      && typeof raw.text === "string"
    ) {
      blocks.push({ type: "text", text: raw.text })
      continue
    }
    if (raw.type === "input_image") {
      const value =
        typeof raw.image_url === "string" ? raw.image_url : undefined
      let parsed = value ? parseDataUri(value) : null
      if (!parsed && value) {
        parsed = await resolveAttachment({
          expectPdf: false,
          signal,
          value,
        })
      }
      if (
        parsed
        && ["image/gif", "image/jpeg", "image/png", "image/webp"].includes(
          parsed.mediaType,
        )
      ) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType as
              | "image/gif"
              | "image/jpeg"
              | "image/png"
              | "image/webp",
            data: parsed.data,
          },
        })
      } else {
        addTranslationFinding(findings, {
          class: "attachment",
          severity: "omitted",
        })
        blocks.push({ type: "text", text: "[Image attachment unavailable]" })
      }
      continue
    }
    if (raw.type === "input_file") {
      let parsed =
        typeof raw.file_data === "string" ? parseDataUri(raw.file_data) : null
      if (
        !parsed
        && typeof raw.file_data === "string"
        && isLikelyBase64(raw.file_data)
      ) {
        parsed = { data: raw.file_data, mediaType: "application/pdf" }
      }
      if (!parsed && typeof raw.file_url === "string") {
        parsed = await resolveAttachment({
          expectPdf: true,
          signal,
          value: raw.file_url,
        })
      }
      if (parsed) {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data,
          },
          ...(typeof raw.filename === "string" ? { title: raw.filename } : {}),
        })
      } else {
        addTranslationFinding(findings, {
          class: "attachment",
          severity: "omitted",
        })
        blocks.push({ type: "text", text: "[File attachment unavailable]" })
      }
      continue
    }
    addTranslationFinding(findings, {
      class: "content_part",
      severity: "adapted",
    })
    blocks.push({ type: "text", text: "[Unrepresentable content item]" })
  }
  return blocks
}

async function convertTolerantResponsesInput(
  source: ResponsesWireBody,
  state: TolerantMessagesState,
  signal: AbortSignal | undefined,
  sharedAttachmentCache: ResponsesAttachmentCache | undefined,
): Promise<{ messages: Array<AnthropicMessage>; system: Array<string> }> {
  const messages: Array<AnthropicMessage> = []
  const system: Array<string> = []
  const resolveAttachment: ResponsesAttachmentCache["resolve"] =
    sharedAttachmentCache?.resolve
    ?? (async ({ expectPdf, signal, value }) =>
      await fetchUrlAsDataUri(value, { expectPdf, signal }))
  if (typeof source.instructions === "string" && source.instructions) {
    system.push(source.instructions)
  }
  if (typeof source.input === "string") {
    messages.push({ role: "user", content: source.input })
    return { messages, system }
  }
  if (!Array.isArray(source.input)) return { messages, system }

  const associations = associateResponsesFunctionCalls(
    source.input,
    (itemIndex) => `responses_messages_call_${itemIndex}`,
  )

  for (const [itemIndex, raw] of source.input.entries()) {
    if (!isRecord(raw)) {
      if (stringifyTolerantValue(raw)) {
        addTranslationFinding(state.findings, {
          class: "unknown_item",
          severity: "adapted",
        })
        appendTolerantTextMessage(
          messages,
          "user",
          FUTURE_RESPONSES_ITEM_CONTEXT,
        )
      }
      continue
    }
    const type = typeof raw.type === "string" ? raw.type : undefined
    if (type === "function_call") {
      const id = associations.callIdByIndex.get(itemIndex)
      if (!id) continue
      if (associations.adaptedCallIndices.has(itemIndex)) {
        addTranslationFinding(state.findings, {
          class: "tool_history",
          severity: "adapted",
        })
      }
      const name =
        typeof raw.name === "string" && raw.name.trim() ?
          raw.name
        : "unknown_function"
      if (name === "unknown_function") {
        addTranslationFinding(state.findings, {
          class: "tool_history",
          severity: "adapted",
        })
      }
      if (
        associations.pairedCallIndices.has(itemIndex)
        && name !== "unknown_function"
      ) {
        state.emittedCallIds.add(id)
        appendAssistantBlock(messages, {
          type: "tool_use",
          id,
          name,
          input: safeParseArguments(
            typeof raw.arguments === "string" ?
              raw.arguments
            : stringifyTolerantValue(raw.arguments),
          ),
        })
      } else {
        addTranslationFinding(state.findings, {
          class: "tool_history",
          severity: "adapted",
        })
        appendTolerantTextMessage(
          messages,
          "assistant",
          RESPONSES_TOOL_CONTEXT,
          raw.arguments,
        )
      }
      continue
    }
    if (type === "function_call_output") {
      const callId = associations.outputCallIdByIndex.get(itemIndex)
      if (callId && state.emittedCallIds.has(callId)) {
        appendUserBlock(messages, {
          type: "tool_result",
          tool_use_id: callId,
          content: stringifyTolerantValue(raw.output),
        })
      } else {
        addTranslationFinding(state.findings, {
          class: "tool_history",
          severity: "adapted",
        })
        appendTolerantTextMessage(
          messages,
          "user",
          RESPONSES_UNPAIRED_RESULT_CONTEXT,
          raw.output,
        )
      }
      continue
    }
    if (type === "reasoning") {
      const summary = Array.isArray(raw.summary) ? raw.summary : []
      if (
        isModelFallbackActive()
        && typeof raw.encrypted_content === "string"
      ) {
        appendAssistantBlock(messages, {
          type: "thinking",
          thinking: summary
            .flatMap((entry) =>
              isRecord(entry) && typeof entry.text === "string" ?
                [entry.text]
              : [],
            )
            .join(""),
          signature: raw.encrypted_content,
        })
        continue
      }
      for (const entry of summary) {
        if (isRecord(entry) && typeof entry.text === "string" && entry.text) {
          appendTolerantTextMessage(messages, "assistant", entry.text)
        }
      }
      if (
        typeof raw.encrypted_content === "string"
        || typeof raw.id === "string"
        || summary.length === 0
      ) {
        addTranslationFinding(state.findings, {
          class: "reasoning_state",
          severity: "adapted",
        })
        appendTolerantTextMessage(
          messages,
          "assistant",
          RESPONSES_REASONING_CONTEXT,
        )
      }
      continue
    }
    if (
      type === "custom_tool_call"
      || type === "custom_tool_call_output"
      || type === "computer_call"
      || type === "computer_call_output"
      || type === "hosted_tool_call"
      || type === "programmatic_tool_call"
    ) {
      addTranslationFinding(state.findings, {
        class: "tool_history",
        severity: "adapted",
      })
      appendTolerantTextMessage(
        messages,
        type.endsWith("output") ? "user" : "assistant",
        RESPONSES_TOOL_CONTEXT,
        [raw.call_id, raw.name, stringifyTolerantValue(raw.output ?? raw.input)]
          .filter(Boolean)
          .join("\n"),
      )
      continue
    }
    if (type === undefined || type === "message") {
      if (raw.role === "system" || raw.role === "developer") {
        const text = responsesContentToPlainText(raw.content)
        if (text) system.push(text)
        continue
      }
      const assistant = raw.role === "assistant"
      const known = assistant || raw.role === "user"
      if (!known) {
        addTranslationFinding(state.findings, {
          class: "message_role",
          severity: "adapted",
        })
        appendTolerantTextMessage(
          messages,
          "user",
          FUTURE_RESPONSES_ROLE_CONTEXT,
        )
      }
      const blocks = await convertTolerantResponsesContent(
        raw.content,
        state.findings,
        signal,
        resolveAttachment,
      )
      if (blocks.length === 0) continue
      if (assistant) {
        messages.push({
          role: "assistant",
          content: blocks.filter((block) => isAnthropicTextBlock(block)),
        })
      } else {
        messages.push({ role: "user", content: blocks })
      }
      continue
    }
    addTranslationFinding(state.findings, {
      class: "unknown_item",
      severity: "adapted",
    })
    appendTolerantTextMessage(messages, "user", FUTURE_RESPONSES_ITEM_CONTEXT)
  }
  return { messages, system }
}

function repairAnthropicSchema(value: unknown): Record<string, unknown> {
  const schema = isRecord(value) ? structuredClone(value) : {}
  if (typeof schema.type === "string") schema.type = schema.type.toLowerCase()
  if (schema.type !== "object") schema.type = "object"
  if (!isRecord(schema.properties)) schema.properties = {}
  return schema
}

function repairOutputSchema(value: unknown): Record<string, unknown> {
  const schema = isRecord(value) ? structuredClone(value) : {}
  if (schema.type === undefined && isRecord(schema.properties)) {
    schema.type = "object"
  }
  if (isRecord(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) {
      schema.properties[key] = repairOutputSchema(property)
    }
  }
  return schema
}

function convertTolerantResponsesTools(
  source: ResponsesWireBody,
  findings: Array<TranslationFinding>,
): Array<AnthropicNamedTool> | undefined {
  if (!Array.isArray(source.tools)) return undefined
  const tools: Array<AnthropicNamedTool> = []
  for (const raw of source.tools) {
    if (!isRecord(raw)) {
      addTranslationFinding(findings, {
        class: "tool_shape",
        severity: "omitted",
      })
      continue
    }
    const type = typeof raw.type === "string" ? raw.type : undefined
    if (type === "web_search" || type?.startsWith("web_search_")) {
      tools.push(createWebSearchAnthropicTool(raw))
      continue
    }
    if (
      type !== "function"
      || typeof raw.name !== "string"
      || !raw.name.trim()
    ) {
      addTranslationFinding(findings, {
        class: "tool_shape",
        severity: "omitted",
      })
      continue
    }
    tools.push({
      name: raw.name,
      ...(typeof raw.description === "string" ?
        { description: raw.description }
      : {}),
      input_schema: repairAnthropicSchema(raw.parameters),
    })
  }
  return tools.length > 0 ? tools : undefined
}

function convertTolerantResponsesChoice(
  source: ResponsesWireBody,
  tools: Array<AnthropicNamedTool> | undefined,
  findings: Array<TranslationFinding>,
): AnthropicMessagesPayload["tool_choice"] | undefined {
  if (!tools?.length) return undefined
  const choice = source.tool_choice
  let converted: AnthropicMessagesPayload["tool_choice"]
  switch (choice) {
    case "none": {
      converted = { type: "none" }
      break
    }
    case "required": {
      converted = { type: "any" }
      break
    }
    case "auto": {
      converted = { type: "auto" }
      break
    }
    default: {
      if (
        isRecord(choice)
        && choice.type === "function"
        && typeof choice.name === "string"
        && tools.some((tool) => tool.name === choice.name)
      ) {
        converted = { type: "tool", name: choice.name }
      } else {
        converted = { type: "auto" }
        if (choice !== undefined) {
          addTranslationFinding(findings, {
            class: "tool_choice",
            severity: "adapted",
          })
        }
      }
    }
  }
  if (source.parallel_tool_calls === false) {
    converted.disable_parallel_tool_use = true
  }
  return converted
}

export async function adaptResponsesToMessagesCandidate(options: {
  readonly finalModel?: string
  readonly finalReasoningEffort?: string | number
  readonly attachmentCache?: ResponsesAttachmentCache
  readonly signal?: AbortSignal
  readonly source: ResponsesWireBody
}): Promise<ResponsesMessagesCandidate> {
  const source = structuredClone(options.source)
  source.model = options.finalModel ?? source.model
  if (options.finalReasoningEffort !== undefined) {
    source.reasoning = {
      ...(isRecord(source.reasoning) ? source.reasoning : {}),
      effort: options.finalReasoningEffort,
    }
  }
  const state = createTolerantMessagesState(source)
  const converted = await convertTolerantResponsesInput(
    source,
    state,
    options.signal,
    options.attachmentCache,
  )
  const tools = convertTolerantResponsesTools(source, state.findings)
  const toolChoice = convertTolerantResponsesChoice(
    source,
    tools,
    state.findings,
  )
  const payload: AnthropicMessagesPayload = {
    model: source.model,
    messages: converted.messages,
    ...(converted.system.length > 0 ?
      { system: converted.system.join("\n\n") }
    : {}),
    ...((
      typeof source.max_output_tokens === "number"
      && source.max_output_tokens > 0
    ) ?
      { max_tokens: source.max_output_tokens }
    : {}),
    ...(typeof source.temperature === "number" ?
      { temperature: source.temperature }
    : {}),
    ...(typeof source.top_p === "number" && source.temperature === undefined ?
      { top_p: source.top_p }
    : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(typeof source.user === "string" ?
      { metadata: { user_id: source.user } }
    : {}),
  }
  if (
    isRecord(source.text)
    && isRecord(source.text.format)
    && source.text.format.type === "json_schema"
  ) {
    payload.output_config = {
      ...payload.output_config,
      format: {
        ...structuredClone(source.text.format),
        schema: repairOutputSchema(source.text.format.schema),
      },
    }
  }
  if (source.temperature !== undefined && source.top_p !== undefined) {
    addTranslationFinding(state.findings, {
      class: "sampling",
      severity: "omitted",
    })
  }
  const effort = source.reasoning?.effort
  if (typeof effort === "string") {
    payload.output_config = {
      ...payload.output_config,
      effort: effort as NonNullable<
        AnthropicMessagesPayload["output_config"]
      >["effort"],
    }
  } else if (
    typeof effort === "number"
    && Number.isInteger(effort)
    && effort > 0
  ) {
    payload.thinking = { type: "enabled", budget_tokens: effort }
  } else if (effort !== undefined && effort !== null) {
    addTranslationFinding(state.findings, {
      class: "reasoning_state",
      severity: "omitted",
    })
  }
  if (
    source.background !== undefined
    || source.conversation_id !== undefined
    || source.metadata !== undefined
    || source.previous_response_id !== undefined
    || source.prompt !== undefined
    || source.service_tier !== undefined
  ) {
    addTranslationFinding(state.findings, {
      class: "stateful_controls",
      severity: "omitted",
    })
  }
  if (
    source.context_management !== undefined
    || source.multi_agent !== undefined
    || source.truncation !== undefined
  ) {
    addTranslationFinding(state.findings, {
      class: "context_management",
      severity: "omitted",
    })
  }
  const meaningful =
    converted.messages.length > 0 || converted.system.length > 0
  const findings: Array<TranslationFinding> =
    meaningful ?
      state.findings
    : [{ class: "message_shape", severity: "fatal" }, ...state.findings]
  return {
    endpoint: "/v1/messages",
    reason: "endpoint_unavailable",
    payload,
    check: createEvaluatedTranslationCheck(findings),
  }
}

export async function executePreparedResponsesMessagesBridge(options: {
  compaction?: boolean
  nativeOptions: NativeMessagesRequestOptions
  payload: AnthropicMessagesPayload
  responseContext: ResponsesPayload
  signal?: AbortSignal
}): Promise<ResponsesResult> {
  const anthropicPayload = structuredClone(options.payload)
  anthropicPayload.stream = false
  const response = (await createNativeMessages(
    anthropicPayload,
    options.nativeOptions,
    {
      alreadyAdapted: true,
      compaction: options.compaction,
      signal: options.signal,
    },
  )) as AnthropicResponse
  return anthropicResponseToResponsesResult(
    response,
    options.nativeOptions.requestedModel ?? options.responseContext.model,
    structuredClone(options.responseContext),
  )
}

export async function executeResponsesMessagesBridge(options: {
  attachmentsNormalized?: boolean
  compaction?: boolean
  nativeOptions: NativeMessagesRequestOptions
  payload: ResponsesPayload
  preserveValidatedControls?: boolean
  signal?: AbortSignal
}): Promise<ResponsesResult> {
  const anthropicPayload = await responsesPayloadToAnthropic(
    options.payload,
    options.signal,
    { attachmentsNormalized: options.attachmentsNormalized },
  )
  anthropicPayload.stream = false
  const response = (await createNativeMessages(
    anthropicPayload,
    options.nativeOptions,
    {
      compaction: options.compaction,
      preserveValidatedControls: options.preserveValidatedControls,
      signal: options.signal,
    },
  )) as AnthropicResponse
  return anthropicResponseToResponsesResult(
    response,
    options.nativeOptions.requestedModel ?? options.payload.model,
    options.payload,
  )
}

export async function responsesPayloadToAnthropic(
  payload: ResponsesPayload,
  signal?: AbortSignal,
  options?: ResponsesMessagesBridgeOptions,
): Promise<AnthropicMessagesPayload> {
  assertEndpointTranslationSupported(
    {
      blockers: [],
      code: "endpoint_translation_unsupported",
      source: "responses",
    },
    checkResponsesToMessagesTranslation(payload),
  )

  const { messages, systemTexts } = await convertResponsesInput(
    payload.input,
    signal,
    options,
  )
  if (payload.instructions) systemTexts.unshift(payload.instructions)

  const toolChoice = convertResponsesToolChoice(payload.tool_choice)
  const parallelChoice = applyParallelToolChoice(
    toolChoice,
    payload.parallel_tool_calls,
    payload.tools,
  )
  const hasMaxOutputTokens = Object.hasOwn(payload, "max_output_tokens")

  return {
    model: payload.model,
    messages,
    ...(hasMaxOutputTokens ? { max_tokens: payload.max_output_tokens } : {}),
    ...(systemTexts.length > 0 ? { system: systemTexts.join("\n\n") } : {}),
    ...(payload.temperature === undefined || payload.temperature === null ?
      {}
    : { temperature: payload.temperature }),
    ...(payload.top_p === undefined || payload.top_p === null ?
      {}
    : { top_p: payload.top_p }),
    ...(payload.user ? { metadata: { user_id: payload.user } } : {}),
    ...convertResponsesTools(payload.tools),
    ...parallelChoice,
    ...convertResponsesOutputConfig(payload),
  }
}

async function convertResponsesInput(
  input: ResponsesPayload["input"],
  signal?: AbortSignal,
  options?: { attachmentsNormalized?: boolean },
): Promise<{
  messages: Array<AnthropicMessage>
  systemTexts: Array<string>
}> {
  const messages: Array<AnthropicMessage> = []
  const emittedToolCallIds = new Set<string>()
  const systemTexts: Array<string> = []
  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
    return { messages, systemTexts }
  }
  if (!Array.isArray(input)) return { messages, systemTexts }

  for (const item of input) {
    await appendResponsesItem({
      emittedToolCallIds,
      item,
      messages,
      options,
      signal,
      systemTexts,
    })
  }
  return { messages, systemTexts }
}

async function appendResponsesItem(options: {
  emittedToolCallIds: Set<string>
  item: ResponseInputItem
  messages: Array<AnthropicMessage>
  options?: { attachmentsNormalized?: boolean }
  signal?: AbortSignal
  systemTexts: Array<string>
}): Promise<void> {
  const item = options.item as Record<string, unknown>
  const type = typeof item.type === "string" ? item.type : undefined
  if (type === "function_call") {
    const callId = typeof item.call_id === "string" ? item.call_id : ""
    const name = typeof item.name === "string" ? item.name : ""
    const argumentsText =
      typeof item.arguments === "string" ? item.arguments : ""
    appendAssistantBlock(options.messages, {
      type: "tool_use",
      id: callId,
      name,
      input: safeParseArguments(argumentsText),
    })
    if (callId) options.emittedToolCallIds.add(callId)
    return
  }
  if (type === "function_call_output") {
    const callId = typeof item.call_id === "string" ? item.call_id : ""
    if (!callId || !options.emittedToolCallIds.has(callId)) {
      options.messages.push({
        role: "user",
        content: `[Orphaned tool result]\n${serializeOrphanToolResult(item.output)}`,
      })
      return
    }
    appendUserBlock(options.messages, {
      type: "tool_result",
      tool_use_id: callId,
      content: await convertResponsesToolResult(
        item.output,
        options.signal,
        options.options,
      ),
    })
    return
  }
  if (type !== undefined && type !== "message") return

  const role = item.role
  const content = item.content
  if (role === "system" || role === "developer") {
    const text = responsesContentToPlainText(content)
    if (text) options.systemTexts.push(text)
    return
  }
  if (role === "assistant") {
    const blocks = await convertResponsesAssistantContent(
      content,
      options.signal,
      options.options,
    )
    options.messages.push({ role: "assistant", content: blocks })
    return
  }
  const blocks = await convertResponsesUserContent(
    content,
    options.signal,
    options.options,
  )
  let messageContent: string | Array<AnthropicUserContentBlock> = ""
  if (typeof content === "string") messageContent = content
  else if (blocks.length > 0) messageContent = blocks
  options.messages.push({
    role: "user",
    content: messageContent,
  })
}

function serializeOrphanToolResult(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 16_384)
  try {
    return JSON.stringify(value).slice(0, 16_384)
  } catch {
    return ""
  }
}

function appendAssistantBlock(
  messages: Array<AnthropicMessage>,
  block: AnthropicAssistantContentBlock,
): void {
  const previous = messages.at(-1)
  if (
    previous
    && isAnthropicAssistantMessage(previous)
    && Array.isArray(previous.content)
  ) {
    previous.content.push(block)
    return
  }
  messages.push({ role: "assistant", content: [block] })
}

function appendUserBlock(
  messages: Array<AnthropicMessage>,
  block: AnthropicUserContentBlock,
): void {
  const previous = messages.at(-1)
  if (
    previous
    && isAnthropicUserMessage(previous)
    && Array.isArray(previous.content)
  ) {
    previous.content.push(block)
    return
  }
  messages.push({ role: "user", content: [block] })
}

async function convertResponsesUserContent(
  content: unknown,
  signal?: AbortSignal,
  options?: { attachmentsNormalized?: boolean },
): Promise<Array<AnthropicInlineContentBlock>> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: Array<AnthropicInlineContentBlock> = []
  for (const part of content) {
    assertPreparedAttachment(part, options)
    const converted = await convertOpenAIContentPartToAnthropic(
      responsesContentPartToOpenAI(part as Record<string, unknown>),
      signal,
    )
    blocks.push(
      ...converted.filter(
        (
          block,
        ): block is Exclude<
          AnthropicUserContentBlock,
          AnthropicToolResultBlock
        > => !isAnthropicToolResultBlock(block),
      ),
    )
  }
  return blocks
}

async function convertResponsesAssistantContent(
  content: unknown,
  signal?: AbortSignal,
  options?: { attachmentsNormalized?: boolean },
): Promise<Array<AnthropicAssistantContentBlock>> {
  const blocks = await convertResponsesUserContent(content, signal, options)
  return blocks.flatMap(
    (block): Array<AnthropicAssistantContentBlock> =>
      isAnthropicTextBlock(block) ? [block] : [],
  )
}

async function convertResponsesToolResult(
  output: unknown,
  signal?: AbortSignal,
  options?: { attachmentsNormalized?: boolean },
): Promise<AnthropicToolResultBlock["content"]> {
  if (typeof output === "string") return output
  if (!Array.isArray(output)) return ""
  return await convertResponsesUserContent(output, signal, options)
}

function assertPreparedAttachment(
  part: unknown,
  options: { attachmentsNormalized?: boolean } | undefined,
): void {
  if (!options?.attachmentsNormalized || !part || typeof part !== "object") {
    return
  }
  const record = part as Record<string, unknown>
  const hasRemoteImage =
    record.type === "input_image"
    && typeof record.image_url === "string"
    && /^https?:\/\//i.test(record.image_url)
  const hasRemoteFile =
    record.type === "input_file"
    && typeof record.file_url === "string"
    && /^https?:\/\//i.test(record.file_url)
  if (!hasRemoteImage && !hasRemoteFile) return

  throw createEndpointTranslationError({
    blockers: ["message_content_part"],
    code: "endpoint_translation_unsupported",
    source: "responses",
  })
}

function responsesContentPartToOpenAI(
  part: Record<string, unknown>,
): ContentPart {
  if (part.type === "input_image") {
    const imageUrl = typeof part.image_url === "string" ? part.image_url : ""
    return {
      type: "image_url",
      image_url: {
        url: imageUrl,
        detail: "auto",
      },
    }
  }
  if (part.type === "input_file") {
    return {
      type: "file",
      file: {
        ...(typeof part.filename === "string" ?
          { filename: part.filename }
        : {}),
        ...(typeof part.file_data === "string" ?
          { file_data: part.file_data }
        : {}),
        ...(typeof part.file_id === "string" ? { file_id: part.file_id } : {}),
      },
    }
  }
  return {
    type: "text",
    text: typeof part.text === "string" ? part.text : "",
  }
}

function responsesContentToPlainText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return []
      const text = (part as { text?: unknown }).text
      return typeof text === "string" ? [text] : []
    })
    .join("\n\n")
}

function safeParseArguments(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Preserve malformed arguments explicitly instead of dropping them.
  }
  return rawArguments.trim().length > 0 ? { raw_arguments: rawArguments } : {}
}

function convertResponsesTools(
  tools: ResponsesPayload["tools"],
): Pick<AnthropicMessagesPayload, "tools"> {
  if (!Array.isArray(tools)) return {}
  const chatTools = tools.map((tool) => {
    const functionTool = tool as FunctionTool
    return {
      type: "function" as const,
      function: {
        name: functionTool.name,
        ...(functionTool.description ?
          { description: functionTool.description }
        : {}),
        parameters: functionTool.parameters ?? {},
      },
    }
  })
  return convertOpenAIToolsToAnthropic(chatTools)
}

function convertResponsesToolChoice(
  toolChoice: ResponsesPayload["tool_choice"],
): Pick<AnthropicMessagesPayload, "tool_choice"> {
  if (!toolChoice) return {}
  if (toolChoice === "auto") return { tool_choice: { type: "auto" } }
  if (toolChoice === "required") return { tool_choice: { type: "any" } }
  if (toolChoice === "none") return { tool_choice: { type: "none" } }
  if (
    typeof toolChoice === "object"
    && "name" in toolChoice
    && typeof toolChoice.name === "string"
  ) {
    return { tool_choice: { type: "tool", name: toolChoice.name } }
  }
  return {}
}

function applyParallelToolChoice(
  choice: Pick<AnthropicMessagesPayload, "tool_choice">,
  parallel: ResponsesPayload["parallel_tool_calls"],
  tools: ResponsesPayload["tools"],
): Pick<AnthropicMessagesPayload, "tool_choice"> {
  if (parallel !== false || !Array.isArray(tools) || tools.length === 0) {
    return choice
  }
  return {
    tool_choice: {
      ...(choice.tool_choice ?? { type: "auto" as const }),
      disable_parallel_tool_use: true,
    },
  }
}

function convertResponsesOutputConfig(
  payload: ResponsesPayload,
): Pick<AnthropicMessagesPayload, "output_config" | "thinking"> {
  const outputConfig: NonNullable<AnthropicMessagesPayload["output_config"]> =
    {}
  if (typeof payload.reasoning?.effort === "string") {
    outputConfig.effort = payload.reasoning.effort as NonNullable<
      AnthropicMessagesPayload["output_config"]
    >["effort"]
  }
  if (payload.text?.format) outputConfig.format = payload.text.format
  if (payload.task_budget) outputConfig.task_budget = payload.task_budget
  return {
    ...(Object.keys(outputConfig).length > 0 ?
      { output_config: outputConfig }
    : {}),
    ...(typeof payload.reasoning?.effort === "number" ?
      {
        thinking: {
          type: "enabled" as const,
          budget_tokens: payload.reasoning.effort,
        },
      }
    : {}),
  }
}

export function anthropicResponseToResponsesResult(
  response: AnthropicResponse,
  requestedModel: string,
  request?: ResponsesPayload,
): ResponsesResult {
  const { output, text } = convertAnthropicOutput(response)
  const incompleteDetails = mapStopReason(response.stop_reason)
  return {
    id: response.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: requestedModel,
    output,
    output_text: text,
    status: incompleteDetails ? "incomplete" : "completed",
    usage: mapAnthropicUsage(response),
    error: null,
    incomplete_details: incompleteDetails,
    ...getResponsesRequestContext(request),
  }
}

function getResponsesRequestContext(
  request: ResponsesPayload | undefined,
): Pick<
  ResponsesResult,
  | "instructions"
  | "metadata"
  | "parallel_tool_calls"
  | "temperature"
  | "tool_choice"
  | "tools"
  | "top_p"
>
  & Partial<Pick<ResponsesResult, "max_output_tokens" | "reasoning" | "text">> {
  if (!request) {
    return {
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    }
  }
  return {
    instructions: request.instructions ?? null,
    metadata: request.metadata ?? null,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    temperature: request.temperature ?? null,
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    reasoning: request.reasoning ?? null,
    text: request.text ?? null,
  }
}

function convertAnthropicOutput(response: AnthropicResponse): {
  output: Array<ResponseOutputItem>
  text: string
} {
  const output: Array<ResponseOutputItem> = []
  let text = ""
  let messageIndex = 0
  let reasoningIndex = 0
  for (const rawBlock of response.content) {
    const block = rawBlock as unknown as Record<string, unknown>
    const type = typeof block.type === "string" ? block.type : undefined
    if (type === "thinking") {
      if (typeof block.thinking !== "string") {
        const converted = appendAssistantBlockFallback({
          block,
          messageIndex,
          output,
          responseId: response.id,
          text,
        })
        messageIndex = converted.messageIndex
        text = converted.text
        continue
      }
      output.push(
        createReasoningOutput(
          response.id,
          block as unknown as Extract<
            AnthropicResponse["content"][number],
            { type: "thinking" }
          >,
          reasoningIndex,
        ),
      )
      reasoningIndex += 1
      continue
    }
    if (type === "text") {
      if (typeof block.text !== "string") {
        const converted = appendAssistantBlockFallback({
          block,
          messageIndex,
          output,
          responseId: response.id,
          text,
        })
        messageIndex = converted.messageIndex
        text = converted.text
        continue
      }
      text += block.text
      output.push(createTextOutput(response.id, block.text, messageIndex))
      messageIndex += 1
      continue
    }
    if (type === "tool_use") {
      if (
        typeof block.id !== "string"
        || typeof block.name !== "string"
        || !isRecordValue(block.input)
      ) {
        const converted = appendAssistantBlockFallback({
          block,
          messageIndex,
          output,
          responseId: response.id,
          text,
        })
        messageIndex = converted.messageIndex
        text = converted.text
        continue
      }
      output.push(
        createFunctionCallOutput(
          block as unknown as Extract<
            AnthropicResponse["content"][number],
            { type: "tool_use" }
          >,
        ),
      )
      continue
    }
    if (!type) {
      throwResponseContentError()
    }
    const converted = appendAssistantBlockFallback({
      block,
      messageIndex,
      output,
      responseId: response.id,
      text,
    })
    messageIndex = converted.messageIndex
    text = converted.text
  }
  return { output, text }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function throwResponseContentError(): never {
  throw createEndpointTranslationError({
    blockers: ["response_content"],
    code: "endpoint_translation_unsupported",
    source: "messages",
  })
}

function stringifyUnknownAssistantBlock(
  block: Record<string, unknown>,
): string | null {
  try {
    const serialized = JSON.stringify(block)
    return serialized.length <= MAX_ASSISTANT_FALLBACK_TEXT_LENGTH ?
        serialized
      : serialized.slice(0, MAX_ASSISTANT_FALLBACK_TEXT_LENGTH)
  } catch {
    return null
  }
}

function appendAssistantBlockFallback(options: {
  block: Record<string, unknown>
  messageIndex: number
  output: Array<ResponseOutputItem>
  responseId: string
  text: string
}): { messageIndex: number; text: string } {
  const fallbackText = stringifyUnknownAssistantBlock(options.block)
  if (!fallbackText) {
    return { messageIndex: options.messageIndex, text: options.text }
  }
  options.output.push(
    createTextOutput(options.responseId, fallbackText, options.messageIndex),
  )
  return {
    messageIndex: options.messageIndex + 1,
    text: options.text + fallbackText,
  }
}

function createReasoningOutput(
  responseId: string,
  block: Extract<AnthropicResponse["content"][number], { type: "thinking" }>,
  index: number,
): ResponseOutputItem {
  return {
    id: index === 0 ? `rs_${responseId}` : `rs_${responseId}_${index}`,
    type: "reasoning",
    summary:
      block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
    ...(block.signature ? { encrypted_content: block.signature } : {}),
    status: "completed",
  }
}

function createTextOutput(
  responseId: string,
  text: string,
  index: number,
): ResponseOutputItem {
  return {
    id: index === 0 ? `msg_${responseId}` : `msg_${responseId}_${index}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  }
}

function createFunctionCallOutput(
  block: Extract<AnthropicResponse["content"][number], { type: "tool_use" }>,
): ResponseOutputItem {
  return {
    id: `fc_${block.id}`,
    type: "function_call",
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input),
    status: "completed",
  }
}

function mapStopReason(
  reason: AnthropicResponse["stop_reason"],
): ResponsesResult["incomplete_details"] {
  if (reason === "max_tokens") return { reason: "max_output_tokens" }
  if (reason === "refusal") return { reason: "content_filter" }
  return null
}

function mapAnthropicUsage(response: AnthropicResponse): ResponseUsage {
  const cachedTokens = response.usage.cache_read_input_tokens ?? 0
  const inputTokens =
    response.usage.input_tokens
    + cachedTokens
    + (response.usage.cache_creation_input_tokens ?? 0)
  return {
    input_tokens: inputTokens,
    output_tokens: response.usage.output_tokens,
    total_tokens: inputTokens + response.usage.output_tokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}
