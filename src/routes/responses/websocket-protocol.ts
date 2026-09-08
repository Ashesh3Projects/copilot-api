import type { CopilotRequestAttribution } from "~/lib/copilot-request-context"
import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"
import type { AnthropicRequestHeaderOptions } from "~/services/copilot/messages-contract"

import { resolveCopilotRequestAttribution } from "~/lib/copilot-request-context"
import { parseRoutingMetadataRecord } from "~/lib/routing-affinity"
import { sanitizeCopilotHeaderValue } from "~/services/copilot/copilot-contract"
import { sanitizeAnthropicRequestHeaderOptions } from "~/services/copilot/messages-contract"

const FRAME_ENVELOPE_KEYS = new Set([
  "agent_task_id",
  "headers",
  "initiator",
  "parent_agent_id",
  "response",
  "type",
])
const METADATA_ELIGIBLE_EVENT_TYPES = new Set([
  "response.completed",
  "response.created",
  "response.failed",
  "response.incomplete",
])
const SAFE_EVENT_HEADER_NAMES = new Set([
  "openai-model",
  "x-copilot-api-fallback-from",
  "x-copilot-api-fallback-to",
  "x-copilot-api-fallback-reason",
  "x-copilot-api-fallback-cached",
  "x-copilot-api-exp-assignment-context",
  "x-copilot-service-request-id",
  "x-github-copilot-request-te",
  "x-github-request-id",
])
const QUOTA_SNAPSHOT_PREFIX = "x-quota-snapshot-"
const AFFINITY_CLIENT_METADATA_KEYS = new Set(["session_id", "thread_id"])
const FALLBACK_IDENTITY_HEADERS = [
  "thread-id",
  "x-thread-id",
  "x-claude-code-session-id",
  "x-client-session-id",
  "session-id",
]
const RESPONSES_TERMINAL_TYPES = new Set([
  "error",
  "response.completed",
  "response.failed",
  "response.incomplete",
])

export type EmittedWebSocketTerminal =
  | "error"
  | "response.completed"
  | "response.failed"
  | "response.incomplete"

export interface ParsedResponseCreateFrame {
  attribution: CopilotRequestAttribution
  requestHeaders?: Headers
  initiator?: "agent" | "user"
  nativeMessagesOptions: AnthropicRequestHeaderOptions
  payload: ResponsesPayload
  requestedModel?: string
}

export type WebSocketFrameParseResult =
  | { ok: true; value: ParsedResponseCreateFrame }
  | {
      ok: false
      error: {
        code: string
        message: string
        status: number
        type: "invalid_request_error"
      }
    }

export type ContinuationResolution =
  | { ok: true; payload: ResponsesPayload }
  | {
      ok: false
      code: "invalid_request_error" | "previous_response_not_found"
      message: string
      status: 400
    }

export function parseResponsesWebSocketFrame(
  message: string | Buffer | Uint8Array,
): WebSocketFrameParseResult {
  if (typeof message !== "string") {
    return parseError("bad_request", "Binary frames not supported")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(message) as unknown
  } catch {
    return parseError("bad_request", "Invalid JSON")
  }

  if (!isRecord(parsed)) {
    return parseError("bad_request", "JSON message must be an object")
  }

  if (parsed.type !== "response.create") {
    return parseError("bad_request", "Unsupported message type")
  }

  const payload = extractResponsesPayload(parsed)
  payload.stream = true

  const initiator = parseInitiator(parsed, resolveFrameHeaders(parsed.headers))
  const requestHeaders = mergeFallbackIdentityHeaders(
    resolveFrameHeaders(parsed.headers),
  )

  return {
    ok: true,
    value: {
      attribution: resolveFrameAttribution(parsed),
      ...(Array.from(requestHeaders.keys()).length > 0 ?
        { requestHeaders }
      : {}),
      ...(initiator ? { initiator } : {}),
      nativeMessagesOptions: extractNativeMessagesOptions(parsed.headers),
      payload,
      requestedModel: getRequestedModel(parsed),
    },
  }
}

export function mergeFallbackIdentityHeaders(
  current?: Headers,
  update?: Headers,
): Headers {
  const headers = new Headers()
  for (const name of FALLBACK_IDENTITY_HEADERS) {
    const value = update?.get(name) ?? current?.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

export function addResponsesWebSocketMetadata(
  frame: string,
  headers: Record<string, string>,
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(frame) as unknown
  } catch {
    return frame
  }
  if (
    !isRecord(parsed)
    || typeof parsed.type !== "string"
    || !METADATA_ELIGIBLE_EVENT_TYPES.has(parsed.type)
  ) {
    return frame
  }

  const eventHeaders: Record<string, string> = {}
  const quotaSnapshots: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (name.startsWith(QUOTA_SNAPSHOT_PREFIX)) {
      const quotaName = name.slice(QUOTA_SNAPSHOT_PREFIX.length)
      if (quotaName) quotaSnapshots[quotaName] = value
      continue
    }
    if (SAFE_EVENT_HEADER_NAMES.has(name)) eventHeaders[name] = value
  }

  const hadReservedFields =
    "headers" in parsed || "copilot_quota_snapshots" in parsed
  if (
    !hadReservedFields
    && Object.keys(eventHeaders).length === 0
    && Object.keys(quotaSnapshots).length === 0
  ) {
    return frame
  }
  const safeFrame = { ...parsed }
  delete safeFrame.headers
  delete safeFrame.copilot_quota_snapshots
  return JSON.stringify({
    ...safeFrame,
    ...(Object.keys(eventHeaders).length > 0 ? { headers: eventHeaders } : {}),
    ...(Object.keys(quotaSnapshots).length > 0 ?
      { copilot_quota_snapshots: quotaSnapshots }
    : {}),
  })
}

export function extractResponsesPayload(
  frame: Record<string, unknown>,
): ResponsesPayload {
  const topLevel = omitFrameEnvelope(frame)
  const nested =
    isRecord(frame.response) ? omitFrameEnvelope(frame.response) : {}
  return structuredClone({ ...topLevel, ...nested }) as ResponsesPayload
}

export function mergeEffectiveNativeMessagesOptions(
  current: AnthropicRequestHeaderOptions,
  update: AnthropicRequestHeaderOptions,
): AnthropicRequestHeaderOptions {
  return { ...current, ...update }
}

export function classifyEmittedWebSocketTerminal(
  parsed: { type?: unknown },
  _eventName?: string,
): EmittedWebSocketTerminal | undefined {
  return (
      typeof parsed.type === "string"
        && RESPONSES_TERMINAL_TYPES.has(parsed.type)
    ) ?
      (parsed.type as EmittedWebSocketTerminal)
    : undefined
}

export function resolveResponsesContinuation(
  snapshots: ReadonlyMap<string, ResponsesPayload>,
  payload: ResponsesPayload,
): ContinuationResolution {
  const previousResponseId = (payload as Record<string, unknown>)
    .previous_response_id

  if (previousResponseId === undefined) {
    return { ok: true, payload: structuredClone(payload) }
  }
  if (typeof previousResponseId !== "string") {
    return continuationError(
      "invalid_request_error",
      "previous_response_id must be a string",
    )
  }
  if (previousResponseId === "") {
    return continuationError(
      "invalid_request_error",
      "previous_response_id must not be empty",
    )
  }

  const snapshotPayload = snapshots.get(previousResponseId)
  if (!snapshotPayload) {
    // External IDs require direct upstream response state or gateway storage;
    // this no-storage transport can resolve only this connection's snapshots.
    return continuationError(
      "previous_response_not_found",
      "The previous response is not available on this WebSocket connection.",
    )
  }
  if (
    typeof payload.model === "string"
    && payload.model !== snapshotPayload.model
  ) {
    return continuationError(
      "invalid_request_error",
      "Continuation model must match the previous response model.",
    )
  }
  if (
    !isContinuationInput(snapshotPayload.input)
    || !isContinuationInput(payload.input)
  ) {
    return continuationError(
      "invalid_request_error",
      "input must be a string or array",
    )
  }
  return {
    ok: true,
    payload: rehydrateContinuationPayloadFromSnapshot(snapshotPayload, payload),
  }
}

export function rehydrateContinuationPayloadFromSnapshot(
  snapshotPayload: ResponsesPayload,
  payload: ResponsesPayload,
): ResponsesPayload {
  const snapshotClone = structuredClone(snapshotPayload)
  const payloadClone = structuredClone(payload)
  const mergedInput = mergeContinuationInput(
    snapshotClone.input,
    payloadClone.input,
  )
  const {
    client_metadata: _ignoredClientMetadata,
    model: _ignoredModel,
    ...safePayloadClone
  } = payloadClone
  const {
    client_metadata: _ignoredSnapshotClientMetadata,
    ...safeSnapshotClone
  } = snapshotClone
  const clientMetadata = mergeContinuationClientMetadata(
    snapshotClone.client_metadata,
    payloadClone.client_metadata,
  )

  const merged: ResponsesPayload = {
    ...safeSnapshotClone,
    ...safePayloadClone,
    ...(clientMetadata === undefined ?
      {}
    : { client_metadata: clientMetadata }),
    ...(mergedInput !== undefined ? { input: mergedInput } : {}),
  }
  delete merged.previous_response_id
  delete merged.generate
  return merged
}

function mergeContinuationClientMetadata(
  snapshotMetadata: ResponsesPayload["client_metadata"],
  currentMetadata: ResponsesPayload["client_metadata"],
): ResponsesPayload["client_metadata"] {
  const snapshotRecord = parseRoutingMetadataRecord(snapshotMetadata)
  const currentRecord = parseRoutingMetadataRecord(currentMetadata)
  if (!snapshotRecord && !currentRecord) return undefined

  const merged = structuredClone(currentRecord ?? snapshotRecord ?? {})
  for (const key of AFFINITY_CLIENT_METADATA_KEYS) {
    if (snapshotRecord && Object.hasOwn(snapshotRecord, key)) {
      merged[key] = structuredClone(snapshotRecord[key])
    } else Reflect.deleteProperty(merged, key)
  }
  return merged
}

export function rehydrateContinuationPayload(
  responseSnapshots: ReadonlyMap<string, ResponsesPayload>,
  payload: ResponsesPayload,
): ResponsesPayload | undefined {
  const previousResponseId = payload.previous_response_id
  if (!previousResponseId) return undefined

  const snapshotPayload = responseSnapshots.get(previousResponseId)
  if (!snapshotPayload) return undefined

  return rehydrateContinuationPayloadFromSnapshot(snapshotPayload, payload)
}

export function mergeContinuationInput(
  snapshotInput: ResponsesPayload["input"],
  input: ResponsesPayload["input"],
): ResponsesPayload["input"] {
  if (snapshotInput === undefined) return input
  if (input === undefined) return snapshotInput
  return [
    ...continuationInputItems(snapshotInput),
    ...continuationInputItems(input),
  ]
}

function continuationInputItems(
  input: Exclude<ResponsesPayload["input"], undefined>,
): Array<ResponseInputItem> {
  if (Array.isArray(input)) return input
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: input }],
    },
  ]
}

function isContinuationInput(
  input: unknown,
): input is ResponsesPayload["input"] {
  return (
    input === undefined || typeof input === "string" || Array.isArray(input)
  )
}

function omitFrameEnvelope(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !FRAME_ENVELOPE_KEYS.has(key)),
  )
}

function resolveFrameAttribution(
  frame: Record<string, unknown>,
): CopilotRequestAttribution {
  const headers = resolveFrameHeaders(frame.headers)
  const attribution = resolveCopilotRequestAttribution(headers)
  if ("agent_task_id" in frame) delete attribution.agentTaskId
  if ("parent_agent_id" in frame) delete attribution.parentAgentId
  const agentTaskId = sanitizeCopilotHeaderValue(
    typeof frame.agent_task_id === "string" ? frame.agent_task_id : undefined,
  )
  const parentAgentId = sanitizeCopilotHeaderValue(
    typeof frame.parent_agent_id === "string" ?
      frame.parent_agent_id
    : undefined,
  )
  return {
    ...attribution,
    ...(agentTaskId ? { agentTaskId } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
  }
}

function parseInitiator(
  frame: Record<string, unknown>,
  headers: Headers,
): "agent" | "user" | undefined {
  if (
    "initiator" in frame
    && (frame.initiator === "agent" || frame.initiator === "user")
  ) {
    return frame.initiator
  }

  const headerValue = headers.get("x-initiator")
  return headerValue === "agent" || headerValue === "user" ?
      headerValue
    : undefined
}

function extractNativeMessagesOptions(
  value: unknown,
): AnthropicRequestHeaderOptions {
  if (!isRecord(value)) return {}
  const normalized = new Map<string, string>()
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") {
      normalized.set(name.toLowerCase(), headerValue)
    }
  }
  return sanitizeAnthropicRequestHeaderOptions({
    anthropicBeta: normalized.get("anthropic-beta"),
    anthropicVersion: normalized.get("anthropic-version"),
    modelProviderPreference: normalized.get("x-model-provider-preference"),
  })
}

function resolveFrameHeaders(value: unknown): Headers {
  const headers = new Headers()
  if (!isRecord(value)) return headers

  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") continue
    try {
      headers.set(name, headerValue)
    } catch {
      // Malformed or forbidden envelope headers are ignored recoverably.
    }
  }
  return headers
}

function getRequestedModel(frame: Record<string, unknown>): string | undefined {
  if (isRecord(frame.response) && typeof frame.response.model === "string") {
    return frame.response.model
  }
  return typeof frame.model === "string" ? frame.model : undefined
}

function parseError(
  code: string,
  message: string,
): Extract<WebSocketFrameParseResult, { ok: false }> {
  return {
    ok: false,
    error: { code, message, status: 400, type: "invalid_request_error" },
  }
}

function continuationError(
  code: "invalid_request_error" | "previous_response_not_found",
  message: string,
): Extract<ContinuationResolution, { ok: false }> {
  return { ok: false, code, message, status: 400 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
