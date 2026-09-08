/* eslint-disable complexity, max-depth, max-lines-per-function, max-params -- open Responses items require a bounded compatibility matrix */
import type {
  EvaluatedEndpointCandidate,
  TranslationFinding,
} from "~/lib/endpoint-routing"
import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"
import type { ResponsesWireBody } from "~/services/copilot/responses-contract"

import { fetchUrlAsDataUri } from "~/lib/attachments"
import { getConfig } from "~/lib/config"
import { createEvaluatedTranslationCheck } from "~/lib/endpoint-routing"
import { isModelFallbackActive } from "~/lib/model-fallback"
import {
  fitChatCompletionsCompactionPayload,
  isResponsesCompactionRequest,
} from "~/services/copilot/compaction-payload"
import { createWebSearchFunctionTool } from "~/services/copilot/mcp-web-search"

import type { ResponsesAttachmentCache } from "./attachment-cache"

import { associateResponsesFunctionCalls } from "./tool-call-association"

export type ResponsesChatCandidate = EvaluatedEndpointCandidate<
  "/chat/completions",
  ChatCompletionsPayload
>

export interface AdaptResponsesToChatOptions {
  readonly finalModel?: string
  readonly finalReasoningEffort?: string | number
  readonly signal?: AbortSignal
  readonly source: ResponsesWireBody
  readonly attachmentCache?: ResponsesAttachmentCache
}

export function getResponsesChatWebSearchMaxUses(
  source: ResponsesWireBody,
): number | undefined {
  if (!Array.isArray(source.tools)) return undefined
  for (const raw of source.tools) {
    if (!isRecord(raw)) continue
    const type = typeof raw.type === "string" ? raw.type : undefined
    if (type !== "web_search" && !type?.startsWith("web_search_")) continue
    if (
      typeof raw.max_uses === "number"
      && Number.isInteger(raw.max_uses)
      && raw.max_uses > 0
    ) {
      return raw.max_uses
    }
  }
  return undefined
}

interface AdapterState {
  readonly findings: Array<TranslationFinding>
}

const FUTURE_ITEM_CONTEXT = "[Future Responses item]"
const FUTURE_ROLE_CONTEXT = "[Future role content]"
const UNKNOWN_CONTENT_CONTEXT = "[Unrepresentable content item]"
const REASONING_CONTEXT = "[Assistant reasoning context]"
const UNPAIRED_RESULT_CONTEXT = "[Unpaired tool result]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function addFinding(
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

function createState(_source: ResponsesWireBody): AdapterState {
  return { findings: [] }
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value ?? {})
}

function stringifyUseful(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

async function convertContent(
  content: unknown,
  findings: Array<TranslationFinding>,
  signal: AbortSignal | undefined,
  resolveAttachment: ResponsesAttachmentCache["resolve"],
): Promise<string | Array<ContentPart>> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: Array<ContentPart> = []
  for (const raw of content) {
    if (!isRecord(raw)) {
      addFinding(findings, { class: "content_part", severity: "adapted" })
      parts.push({ type: "text", text: UNKNOWN_CONTENT_CONTEXT })
      continue
    }
    if (
      (raw.type === "input_text" || raw.type === "output_text")
      && typeof raw.text === "string"
    ) {
      parts.push({ type: "text", text: raw.text })
      continue
    }
    if (raw.type === "input_image") {
      const url = typeof raw.image_url === "string" ? raw.image_url : undefined
      if (url) {
        let finalUrl = url
        if (!url.startsWith("data:")) {
          const fetched = await resolveAttachment({
            expectPdf: false,
            signal,
            value: url,
          })
          if (fetched) {
            finalUrl = `data:${fetched.mediaType};base64,${fetched.data}`
          } else {
            addFinding(findings, { class: "attachment", severity: "omitted" })
            parts.push({ type: "text", text: "[Image attachment unavailable]" })
            continue
          }
        }
        parts.push({
          type: "image_url",
          image_url: {
            url: finalUrl,
            detail:
              raw.detail === "low" || raw.detail === "high" ?
                raw.detail
              : "auto",
          },
        })
      } else {
        addFinding(findings, { class: "attachment", severity: "omitted" })
        parts.push({ type: "text", text: "[Image attachment unavailable]" })
      }
      continue
    }
    if (raw.type === "input_file") {
      let fileData =
        typeof raw.file_data === "string" ? raw.file_data : undefined
      if (!fileData && typeof raw.file_url === "string") {
        const fetched = await resolveAttachment({
          expectPdf: true,
          signal,
          value: raw.file_url,
        })
        if (fetched)
          fileData = `data:${fetched.mediaType};base64,${fetched.data}`
      }
      if (fileData) {
        parts.push({
          type: "file",
          file: {
            ...(typeof raw.filename === "string" ?
              { filename: raw.filename }
            : {}),
            file_data: fileData,
          },
        })
      } else {
        addFinding(findings, { class: "attachment", severity: "omitted" })
        parts.push({ type: "text", text: "[File attachment unavailable]" })
      }
      continue
    }
    addFinding(findings, { class: "content_part", severity: "adapted" })
    parts.push({ type: "text", text: UNKNOWN_CONTENT_CONTEXT })
  }
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => (part as { text: string }).text).join("")
  }
  return parts
}

function pushContextMessage(
  messages: Array<Message>,
  role: "assistant" | "user",
  label: string,
  value?: unknown,
): void {
  const detail = stringifyUseful(value)
  messages.push({
    role,
    content: detail ? `${label}\n${detail}` : label,
  })
}

async function convertInput(
  source: ResponsesWireBody,
  state: AdapterState,
  signal: AbortSignal | undefined,
  sharedAttachmentCache: ResponsesAttachmentCache | undefined,
): Promise<Array<Message>> {
  const messages: Array<Message> = []
  const resolveAttachment: ResponsesAttachmentCache["resolve"] =
    sharedAttachmentCache?.resolve
    ?? (async ({ expectPdf, signal, value }) =>
      await fetchUrlAsDataUri(value, { expectPdf, signal }))
  if (typeof source.input === "string") {
    messages.push({ role: "user", content: source.input })
    return messages
  }
  if (!Array.isArray(source.input)) return messages
  const associations = associateResponsesFunctionCalls(
    source.input,
    (itemIndex) => `responses_call_${itemIndex}_0`,
  )

  for (const [itemIndex, raw] of source.input.entries()) {
    if (!isRecord(raw)) {
      if (stringifyUseful(raw)) {
        addFinding(state.findings, {
          class: "unknown_item",
          severity: "adapted",
        })
        pushContextMessage(messages, "user", FUTURE_ITEM_CONTEXT)
      }
      continue
    }
    const type = typeof raw.type === "string" ? raw.type : undefined
    if (type === "function_call") {
      const id = associations.callIdByIndex.get(itemIndex)
      if (!id) continue
      if (associations.adaptedCallIndices.has(itemIndex)) {
        addFinding(state.findings, {
          class: "tool_history",
          severity: "adapted",
        })
      }
      const name =
        typeof raw.name === "string" && raw.name.trim() ?
          raw.name
        : "unknown_function"
      if (name === "unknown_function") {
        addFinding(state.findings, {
          class: "tool_history",
          severity: "adapted",
        })
      }
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: { name, arguments: stringifyArguments(raw.arguments) },
          },
        ],
      })
      continue
    }
    if (type === "function_call_output") {
      const targetId = associations.outputCallIdByIndex.get(itemIndex)
      if (targetId) {
        messages.push({
          role: "tool",
          tool_call_id: targetId,
          content: stringifyUseful(raw.output),
        })
      } else {
        addFinding(state.findings, {
          class: "tool_history",
          severity: "adapted",
        })
        pushContextMessage(
          messages,
          "user",
          UNPAIRED_RESULT_CONTEXT,
          raw.output,
        )
      }
      continue
    }
    if (type === "reasoning") {
      const summary = Array.isArray(raw.summary) ? raw.summary : []
      if (isModelFallbackActive()) {
        const reasoningText = summary
          .flatMap((entry) =>
            isRecord(entry) && typeof entry.text === "string" ?
              [entry.text]
            : [],
          )
          .join("")
        const reasoningOpaque =
          typeof raw.id === "string" && !raw.id.startsWith("rs_") ?
            raw.id
          : undefined
        const encryptedContent =
          typeof raw.encrypted_content === "string" ?
            raw.encrypted_content
          : undefined
        if (reasoningOpaque || encryptedContent) {
          messages.push({
            role: "assistant",
            content: null,
            ...(reasoningText ? { reasoning_text: reasoningText } : {}),
            ...(reasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
            ...(encryptedContent ?
              { encrypted_content: encryptedContent }
            : {}),
          })
          continue
        }
      }
      for (const entry of summary) {
        if (isRecord(entry) && typeof entry.text === "string" && entry.text) {
          messages.push({ role: "assistant", content: entry.text })
        }
      }
      if (
        typeof raw.encrypted_content === "string"
        || typeof raw.id === "string"
        || summary.length === 0
      ) {
        addFinding(state.findings, {
          class: "reasoning_state",
          severity: "adapted",
        })
        messages.push({ role: "assistant", content: REASONING_CONTEXT })
      }
      continue
    }
    if (
      type === "custom_tool_call"
      || type === "custom_tool_call_output"
      || type === "computer_call_output"
      || type === "computer_call"
      || type === "hosted_tool_call"
      || type === "programmatic_tool_call"
    ) {
      addFinding(state.findings, { class: "tool_history", severity: "adapted" })
      const callId = typeof raw.call_id === "string" ? raw.call_id : "unknown"
      if (type.endsWith("output")) {
        const output = stringifyUseful(raw.output)
        const prefix =
          type === "custom_tool_call_output" ? "Custom tool result" : (
            "Tool result"
          )
        messages.push({
          role: "user",
          content: `[${prefix} ${callId}: ${output}]`,
        })
      } else {
        const name = typeof raw.name === "string" ? raw.name : "unknown"
        messages.push({
          role: "assistant",
          content: `[Custom tool call ${callId}: ${name}(${stringifyUseful(raw.input)})]`,
        })
      }
      continue
    }
    if (type === undefined || type === "message") {
      const knownRole =
        raw.role === "assistant"
        || raw.role === "developer"
        || raw.role === "system"
        || raw.role === "user"
      const role: "assistant" | "developer" | "system" | "user" =
        knownRole ?
          (raw.role as "assistant" | "developer" | "system" | "user")
        : "user"
      if (!knownRole) {
        addFinding(state.findings, {
          class: "message_role",
          severity: "adapted",
        })
        messages.push({ role: "user", content: FUTURE_ROLE_CONTEXT })
      }
      const content = await convertContent(
        raw.content,
        state.findings,
        signal,
        resolveAttachment,
      )
      if ((typeof content === "string" && content) || Array.isArray(content)) {
        messages.push({ role, content })
      }
      continue
    }
    addFinding(state.findings, { class: "unknown_item", severity: "adapted" })
    pushContextMessage(messages, "user", FUTURE_ITEM_CONTEXT)
  }
  return messages
}

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
])

function normalizeSchemaType(schema: Record<string, unknown>): boolean {
  const value = schema.type
  if (typeof value === "string") {
    const normalized = value.toLowerCase()
    if (JSON_SCHEMA_TYPES.has(normalized)) {
      if (normalized === value) return false
      schema.type = normalized
      return true
    }
    delete schema.type
    return true
  }
  if (!Array.isArray(value)) return false
  const normalized = Array.from(
    new Set(
      value.flatMap((entry) => {
        if (typeof entry !== "string") return []
        const lowered = entry.toLowerCase()
        return JSON_SCHEMA_TYPES.has(lowered) ? [lowered] : []
      }),
    ),
  )
  if (
    normalized.length === value.length
    && normalized.every((entry, index) => entry === value[index])
  ) {
    return false
  }
  if (normalized.length > 0) schema.type = normalized
  else delete schema.type
  return true
}

function repairSchemaNode(
  schema: Record<string, unknown>,
  seen: Set<object>,
  forceObject: boolean,
): boolean {
  if (seen.has(schema)) return false
  seen.add(schema)
  let repaired = normalizeSchemaType(schema)
  const hasProperties = isRecord(schema.properties)
  if (forceObject || hasProperties) {
    if (schema.type !== "object") {
      schema.type = "object"
      repaired = true
    }
    if (!hasProperties) {
      schema.properties = {}
      repaired = true
    }
  } else if (schema.type === "object") {
    schema.properties = {}
    repaired = true
  }

  const properties = isRecord(schema.properties) ? schema.properties : undefined
  if (properties && schema.required !== undefined) {
    const normalized =
      Array.isArray(schema.required) ?
        Array.from(
          new Set(
            schema.required.filter(
              (entry): entry is string =>
                typeof entry === "string" && Object.hasOwn(properties, entry),
            ),
          ),
        )
      : []
    if (normalized.length > 0) {
      const current = schema.required
      if (
        !Array.isArray(current)
        || current.length !== normalized.length
        || !current.every((entry, index) => entry === normalized[index])
      ) {
        schema.required = normalized
        repaired = true
      }
    } else {
      delete schema.required
      repaired = true
    }
  }

  for (const map of [
    schema.properties,
    schema.patternProperties,
    schema.$defs,
    schema.definitions,
  ]) {
    if (!isRecord(map)) continue
    for (const value of Object.values(map)) {
      if (isRecord(value) && repairSchemaNode(value, seen, false)) {
        repaired = true
      }
    }
  }
  for (const value of [
    schema.additionalItems,
    schema.contains,
    schema.propertyNames,
    schema.not,
    schema.if,
    schema.then,
    schema.else,
  ]) {
    if (isRecord(value) && repairSchemaNode(value, seen, false)) repaired = true
  }
  const items = schema.items
  if (isRecord(items) && repairSchemaNode(items, seen, false)) repaired = true
  else if (Array.isArray(items)) {
    for (const value of items) {
      if (isRecord(value) && repairSchemaNode(value, seen, false)) {
        repaired = true
      }
    }
  }
  for (const collection of [
    schema.anyOf,
    schema.oneOf,
    schema.allOf,
    schema.prefixItems,
  ]) {
    if (!Array.isArray(collection)) continue
    for (const value of collection) {
      if (isRecord(value) && repairSchemaNode(value, seen, false)) {
        repaired = true
      }
    }
  }
  return repaired
}

function repairSchema(value: unknown): {
  repaired: boolean
  schema: Record<string, unknown>
} {
  const schema = isRecord(value) ? clone(value) : {}
  const repaired =
    !isRecord(value) || repairSchemaNode(schema, new Set<object>(), true)
  return { repaired, schema }
}

function convertTools(
  source: ResponsesWireBody,
  findings: Array<TranslationFinding>,
): Array<Tool> | undefined {
  if (!Array.isArray(source.tools)) return undefined
  const tools: Array<Tool> = []
  for (const raw of source.tools) {
    if (!isRecord(raw)) {
      addFinding(findings, { class: "tool_shape", severity: "omitted" })
      continue
    }
    const type = typeof raw.type === "string" ? raw.type : undefined
    if (type === "web_search" || type?.startsWith("web_search_")) {
      tools.push(createWebSearchFunctionTool(raw))
      continue
    }
    const isApplyPatch =
      type === "custom"
      && raw.name === "apply_patch"
      && (getConfig().useFunctionApplyPatch ?? true)
    if (type !== "function" && !isApplyPatch) {
      addFinding(findings, { class: "tool_shape", severity: "omitted" })
      continue
    }
    const name =
      typeof raw.name === "string" && raw.name.trim() ? raw.name : undefined
    if (!name) {
      addFinding(findings, { class: "tool_shape", severity: "omitted" })
      continue
    }
    const repaired = repairSchema(
      isApplyPatch ?
        {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        }
      : raw.parameters,
    )
    let strict = typeof raw.strict === "boolean" ? raw.strict : undefined
    if (repaired.repaired) strict = false
    tools.push({
      type: "function",
      function: {
        name,
        ...(typeof raw.description === "string" ?
          { description: raw.description }
        : {}),
        parameters: repaired.schema,
        ...(strict === undefined ? {} : { strict }),
      },
    })
    if (repaired.repaired || isApplyPatch) {
      addFinding(findings, { class: "tool_shape", severity: "adapted" })
    }
  }
  return tools.length > 0 ? tools : undefined
}

function convertToolChoice(
  source: ResponsesWireBody,
  tools: Array<Tool> | undefined,
  findings: Array<TranslationFinding>,
): ChatCompletionsPayload["tool_choice"] {
  if (!tools?.length) return undefined
  const choice = source.tool_choice
  if (choice === "none" || choice === "auto" || choice === "required") {
    return choice
  }
  if (
    isRecord(choice)
    && choice.type === "function"
    && typeof choice.name === "string"
    && tools.some((tool) => tool.function.name === choice.name)
  ) {
    return { type: "function", function: { name: choice.name } }
  }
  if (choice !== undefined) {
    addFinding(findings, { class: "tool_choice", severity: "adapted" })
  }
  return "auto"
}

function addUnsupportedTopLevelFindings(
  source: ResponsesWireBody,
  findings: Array<TranslationFinding>,
): void {
  const stateKeys = [
    "background",
    "conversation_id",
    "metadata",
    "previous_response_id",
    "prompt",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "safety_identifier",
    "service_tier",
  ]
  if (
    stateKeys.some((key) => source[key] !== undefined && source[key] !== null)
  ) {
    addFinding(findings, { class: "stateful_controls", severity: "omitted" })
  }
  if (
    source.context_management !== undefined
    || source.multi_agent !== undefined
    || source.truncation !== undefined
  ) {
    addFinding(findings, { class: "context_management", severity: "omitted" })
  }
  if (source.include !== undefined || source.text !== undefined) {
    addFinding(findings, { class: "sampling", severity: "omitted" })
  }
}

export async function adaptResponsesToChatCandidate(
  options: AdaptResponsesToChatOptions,
): Promise<ResponsesChatCandidate> {
  const source = clone(options.source)
  source.model = options.finalModel ?? source.model
  if (options.finalReasoningEffort !== undefined) {
    source.reasoning = {
      ...(isRecord(source.reasoning) ? source.reasoning : {}),
      effort: options.finalReasoningEffort,
    }
  }
  const state = createState(source)
  const messages = await convertInput(
    source,
    state,
    options.signal,
    options.attachmentCache,
  )
  if (typeof source.instructions === "string" && source.instructions) {
    messages.unshift({ role: "system", content: source.instructions })
  }
  const tools = convertTools(source, state.findings)
  const toolChoice = convertToolChoice(source, tools, state.findings)
  addUnsupportedTopLevelFindings(source, state.findings)

  const payload: ChatCompletionsPayload = {
    model: source.model,
    messages,
    stream: Boolean(source.stream),
    ...(source.stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(typeof source.max_output_tokens === "number" ?
      { max_tokens: source.max_output_tokens }
    : {}),
    ...(typeof source.temperature === "number" ?
      { temperature: source.temperature }
    : {}),
    ...(typeof source.top_p === "number" && source.temperature === undefined ?
      { top_p: source.top_p }
    : {}),
    ...(typeof source.reasoning?.effort === "string" ?
      { reasoning_effort: source.reasoning.effort }
    : {}),
    ...(typeof source.user === "string" ? { user: source.user } : {}),
  }
  if (source.temperature !== undefined && source.top_p !== undefined) {
    addFinding(state.findings, { class: "sampling", severity: "omitted" })
  }
  if (
    source.reasoning?.effort !== undefined
    && typeof source.reasoning.effort !== "string"
  ) {
    addFinding(state.findings, {
      class: "reasoning_state",
      severity: "omitted",
    })
  }
  if (tools?.some((tool) => tool.function.name === "web_search")) {
    payload.parallel_tool_calls = false
  } else if (typeof source.parallel_tool_calls === "boolean") {
    payload.parallel_tool_calls = source.parallel_tool_calls
  }

  const finalizedPayload =
    isResponsesCompactionRequest(source) ?
      fitChatCompletionsCompactionPayload(payload).payload
    : payload
  const meaningful = finalizedPayload.messages.length > 0
  const findings: Array<TranslationFinding> =
    meaningful ?
      state.findings
    : [{ class: "message_shape", severity: "fatal" }, ...state.findings]
  return {
    endpoint: "/chat/completions",
    reason: "endpoint_unavailable",
    payload: finalizedPayload,
    check: createEvaluatedTranslationCheck(findings),
  }
}
