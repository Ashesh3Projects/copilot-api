import { randomUUID } from "node:crypto"

import {
  debugCredentialLiterals,
  sanitizeDebugCapture,
  sanitizeDebugHeaders,
  sanitizeDebugText,
  sanitizeDebugUrl,
  reserveDebugCaptureMemory,
  releaseDebugCaptureMemory,
  type CapturedBody,
} from "~/lib/debug-capture"

import {
  readDescriptorSnapshotValue,
  readNativeDomExceptionField,
  readNativeErrorMessage,
  snapshotDescriptorChain,
  type DescriptorChainSnapshot,
} from "./descriptor-chain"

export const LLM_DEBUG_HISTORY_WINDOW_MS = 10 * 60 * 1000
const LLM_DEBUG_FAILURE_HISTORY_WINDOW_MS = 60 * 60 * 1000

type HeaderRecord = Record<string, string>

export interface LlmDebugLogError {
  /** Transport error code (e.g. Bun's `ECONNRESET`), when the runtime sets one. */
  code?: number | string
  errno?: number
  message: string
  name: string
  /** Runtime diagnostic path, when the thrown error exposes one. */
  path?: string
  stack?: string
}

export interface LlmDebugLogRequest extends CapturedBody {
  headers: HeaderRecord
  method: string
  path: string
  url: string
}

export interface LlmDebugLogResponse extends CapturedBody {
  bodyReadError?: LlmDebugLogError
  headers: HeaderRecord
  status: number
  statusText: string
}

export interface LlmDebugLogEntry {
  upstream?:
    | { kind: "custom"; providerId: string }
    | { kind: "copilot"; accountId?: number }
  durationMs?: number
  endedAt?: string
  error?: LlmDebugLogError
  id: string
  model?: string
  request: LlmDebugLogRequest
  requestId?: string
  response?: LlmDebugLogResponse
  startedAt: string
  startedAtMs: number
  replayable: boolean
  updatedAt: number
  status: "pending" | "complete" | "error" | "aborted" | "interrupted"
  stream?: boolean
}

export interface LlmDebugLogSummary {
  durationMs?: number
  endedAt?: string
  errorMessage?: string
  id: string
  method: string
  model?: string
  path: string
  requestBodyBytes: number
  requestId?: string
  requestPreview: string
  responseBodyBytes?: number
  responseContentType?: string
  responsePreview?: string
  responseStatus?: number
  responseStatusText?: string
  startedAt: string
  replayable: boolean
  status: LlmDebugLogEntry["status"]
  stream?: boolean
}

export interface LlmDebugLogListResponse {
  count: number
  entries: Array<LlmDebugLogSummary>
  generatedAt: string
  cursor: string | null
}

interface AbortLlmDebugLogOptions {
  endedAtMs?: number
  error: unknown
  response?: Omit<LlmDebugLogResponse, "bodyBytes">
}

interface StartLlmDebugLogInput {
  upstream?: LlmDebugLogEntry["upstream"]
  method: string
  path: string
  requestBody: string | null
  requestCapture?: CapturedBody
  requestHeaders: HeaderRecord
  requestId?: string
  startedAtMs?: number
  url: string
}

interface DebugCapture {
  entry: LlmDebugLogEntry
  controller: AbortController
  credentials: Array<string>
  bytes: number
}
// This store must remain independent of database, telemetry and backup state.
const captures = new Map<string, DebugCapture>()
const MAX_CAPTURES = 2000
let pruneTimer: ReturnType<typeof setTimeout> | undefined
let pruneDeadline: number | undefined

function releaseCapture(id: string): void {
  const capture = captures.get(id)
  if (!capture) return
  captures.delete(id)
  releaseDebugCaptureMemory(capture.bytes)
  capture.controller.abort()
  capture.credentials.length = 0
}

function captureDeadline(entry: LlmDebugLogEntry): number {
  return (
    entry.startedAtMs
    + (entry.status === "complete" ?
      LLM_DEBUG_HISTORY_WINDOW_MS
    : LLM_DEBUG_FAILURE_HISTORY_WINDOW_MS)
  )
}

function schedulePrune(): void {
  let next: number | undefined
  for (const { entry } of captures.values()) {
    const deadline = captureDeadline(entry)
    if (next === undefined || deadline < next) next = deadline
  }
  if (next === pruneDeadline) return
  if (pruneTimer !== undefined) clearTimeout(pruneTimer)
  pruneTimer = undefined
  pruneDeadline = next
  if (next === undefined) return
  pruneTimer = setTimeout(
    () => {
      pruneTimer = undefined
      pruneDeadline = undefined
      pruneCaptures()
    },
    Math.max(0, next - Date.now()),
  )
  pruneTimer.unref()
}

function pruneCaptures(now = Date.now()): void {
  for (const [id, { entry }] of captures)
    if (captureDeadline(entry) <= now) releaseCapture(id)
  schedulePrune()
}

/** Capture readers stop on clear, TTL expiry, capacity eviction, or completion. */
export function getLlmDebugCaptureSignal(id: string): AbortSignal {
  pruneCaptures()
  return captures.get(id)?.controller.signal ?? AbortSignal.abort()
}

function reserveCapture(capture: DebugCapture): boolean {
  const bytes =
    Buffer.byteLength(JSON.stringify(capture.entry))
    + capture.credentials.reduce(
      (total, value) => total + Buffer.byteLength(value),
      0,
    )
  const additionalBytes = bytes - capture.bytes
  if (additionalBytes <= 0) {
    releaseDebugCaptureMemory(-additionalBytes)
    capture.bytes = bytes
    return true
  }
  let reserved = reserveDebugCaptureMemory(additionalBytes)
  for (const [id, candidate] of captures) {
    if (reserved) break
    if (candidate === capture) continue
    releaseCapture(id)
    reserved = reserveDebugCaptureMemory(additionalBytes)
  }
  if (reserved) capture.bytes = bytes
  return reserved
}

function retainTerminalCapture(capture: DebugCapture): void {
  capture.credentials.length = 0
  capture.controller.abort()
  if (!reserveCapture(capture)) releaseCapture(capture.entry.id)
  pruneCaptures()
}

function compactWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isUnknownArray(value: unknown): value is Array<unknown> {
  return Array.isArray(value)
}

function stringFromContentPart(part: unknown): string {
  if (!isRecord(part)) return ""
  if (typeof part.text === "string") return part.text
  if (part.type === "image_url" || part.type === "input_image") return "[image]"
  if (typeof part.image_url === "string") return "[image]"
  if (isRecord(part.image_url)) return "[image]"
  return ""
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value
  if (isUnknownArray(value)) {
    const text = value
      .map((part) => stringFromContentPart(part))
      .filter(Boolean)
      .join(" ")
    if (text) return text
  }
  if (value === null || value === undefined) return ""
  return JSON.stringify(value)
}

function previewFromMessages(messages: unknown): string | undefined {
  if (!isUnknownArray(messages)) return undefined

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isRecord(message) && "content" in message) {
      return stringifyContent(message.content)
    }
  }

  return undefined
}

function previewFromInput(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (!isUnknownArray(input)) return undefined

  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index]
    if (isRecord(item) && ("content" in item || "output" in item)) {
      return stringifyContent(item.content ?? item.output)
    }
  }

  return undefined
}

function previewFromJsonBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!isRecord(parsed)) return undefined

    return (
      previewFromMessages(parsed.messages)
      ?? previewFromInput(parsed.input)
      ?? (typeof parsed.prompt === "string" ? parsed.prompt : undefined)
    )
  } catch {
    return undefined
  }
}

function inferModel(body: string | null): string | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    return isRecord(parsed) && typeof parsed.model === "string" ?
        parsed.model
      : undefined
  } catch {
    return undefined
  }
}

function inferStream(body: string | null): boolean | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    return isRecord(parsed) && typeof parsed.stream === "boolean" ?
        parsed.stream
      : undefined
  } catch {
    return undefined
  }
}

function buildRequestPreview(body: string | null): string {
  if (!body) return ""
  const jsonPreview = previewFromJsonBody(body)
  return compactWhitespace(jsonPreview ?? body)
}

function buildResponsePreview(body: string | null): string | undefined {
  if (!body) return undefined
  return compactWhitespace(body)
}

const DEBUG_ERROR_DESCRIPTOR_KEYS = new Set([
  "cause",
  "code",
  "errno",
  "message",
  "name",
  "path",
  "stack",
])
const DEBUG_ERROR_DESCRIPTOR_DEPTH = 5

/**
 * Read a runtime-attached diagnostic field, falling back to the cause. Wrapped
 * errors (`new Error(msg, { cause: bunError })`) carry these on the cause only.
 */
function readErrorField(
  snapshot: DescriptorChainSnapshot,
  key: string,
): unknown {
  const own = readDescriptorSnapshotValue(snapshot, key)
  if (own !== undefined) return own

  const cause = readDescriptorSnapshotValue(snapshot, "cause")
  const causeSnapshot = snapshotDescriptorChain(cause, {
    keys: DEBUG_ERROR_DESCRIPTOR_KEYS,
    maxDepth: DEBUG_ERROR_DESCRIPTOR_DEPTH,
  })
  if (key === "code") {
    return (
      readNativeDomExceptionField(causeSnapshot, "code")
      ?? readDescriptorSnapshotValue(causeSnapshot, key)
    )
  }
  return readDescriptorSnapshotValue(causeSnapshot, key)
}

function readDebugErrorString(
  snapshot: DescriptorChainSnapshot,
  key: string,
): string | undefined {
  let nativeValue: unknown
  if (key === "message") {
    nativeValue =
      readNativeDomExceptionField(snapshot, key)
      ?? readNativeErrorMessage(snapshot)
  } else if (key === "name") {
    nativeValue = readNativeDomExceptionField(snapshot, key)
  }
  const value = nativeValue ?? readDescriptorSnapshotValue(snapshot, key)
  return typeof value === "string" ? value : undefined
}

function readDebugErrorName(snapshot: DescriptorChainSnapshot): string {
  return readDebugErrorString(snapshot, "name") ?? snapshot.errorKind ?? "Error"
}

function readDebugErrorMessage(snapshot: DescriptorChainSnapshot): string {
  return readDebugErrorString(snapshot, "message") ?? "Unknown thrown value"
}

function normalizeDescriptorError(
  snapshot: DescriptorChainSnapshot,
): LlmDebugLogError {
  const nativeCode = readNativeDomExceptionField(snapshot, "code")
  const codeValue = nativeCode ?? readErrorField(snapshot, "code")
  const code =
    typeof codeValue === "string" || typeof codeValue === "number" ?
      codeValue
    : undefined
  const errnoValue = readErrorField(snapshot, "errno")
  const path = readErrorPath(readErrorField(snapshot, "path"))
  const stack = readDebugErrorString(snapshot, "stack")

  return {
    message: readDebugErrorMessage(snapshot),
    name: readDebugErrorName(snapshot),
    ...(stack ? { stack } : {}),
    ...(code === undefined ? {} : { code }),
    ...(typeof errnoValue === "number" ? { errno: errnoValue } : {}),
    ...(path === undefined ? {} : { path }),
  }
}

function readErrorPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function normalizeError(error: unknown): LlmDebugLogError {
  const snapshot = snapshotDescriptorChain(error, {
    keys: DEBUG_ERROR_DESCRIPTOR_KEYS,
    maxDepth: DEBUG_ERROR_DESCRIPTOR_DEPTH,
  })
  if (snapshot && typeof error === "object" && error !== null) {
    return normalizeDescriptorError(snapshot)
  }

  return {
    message:
      (
        typeof error === "string"
        || typeof error === "number"
        || typeof error === "boolean"
        || typeof error === "bigint"
      ) ?
        String(error)
      : "Unknown thrown value",
    name: "Error",
  }
}

/** Normalize an arbitrary throwable into the stored debug-log error shape. */
export function toLlmDebugLogError(error: unknown): LlmDebugLogError {
  return normalizeError(error)
}

function toSummary(entry: LlmDebugLogEntry): LlmDebugLogSummary {
  const responseContentType = findHeader(
    entry.response?.headers,
    "content-type",
  )
  return {
    durationMs: entry.durationMs,
    endedAt: entry.endedAt,
    errorMessage:
      entry.error?.message ?? entry.response?.bodyReadError?.message,
    id: entry.id,
    method: entry.request.method,
    model: entry.model,
    path: entry.request.path,
    requestBodyBytes: entry.request.bodyBytes,
    requestId: entry.requestId,
    requestPreview: buildRequestPreview(entry.request.body),
    responseBodyBytes: entry.response?.bodyBytes,
    responseContentType,
    responsePreview: buildResponsePreview(entry.response?.body ?? null),
    responseStatus: entry.response?.status,
    responseStatusText: entry.response?.statusText,
    startedAt: entry.startedAt,
    replayable: entry.replayable,
    status: entry.status,
    stream: entry.stream,
  }
}

function findHeader(
  headers: HeaderRecord | undefined,
  expectedName: string,
): string | undefined {
  if (!headers) return undefined
  const expected = expectedName.toLowerCase()
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === expected,
  )
  return match?.[1]
}

export function startLlmDebugLog(input: StartLlmDebugLogInput): string {
  const id = randomUUID()
  const startedAtMs = input.startedAtMs ?? Date.now()
  pruneCaptures()
  const customProvider = input.upstream?.kind === "custom"
  const credentials = debugCredentialLiterals(
    input.requestHeaders,
    input.url,
    customProvider,
  )
  const body = sanitizeDebugCapture({
    ...input.requestCapture,
    body: input.requestBody,
    contentType: findHeader(input.requestHeaders, "content-type"),
    knownCredentials: credentials,
  })
  const entry: LlmDebugLogEntry = {
    id,
    ...(input.upstream ? { upstream: { ...input.upstream } } : {}),
    model: inferModel(body.body),
    request: {
      ...body,
      headers: sanitizeDebugHeaders(
        input.requestHeaders,
        credentials,
        customProvider,
      ),
      method: sanitizeDebugText(input.method, credentials),
      path: sanitizeDebugUrl(sanitizeDebugText(input.path, credentials)),
      url: sanitizeDebugUrl(sanitizeDebugText(input.url, credentials)),
    },
    requestId:
      input.requestId ?
        sanitizeDebugText(input.requestId, credentials)
      : undefined,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    updatedAt: startedAtMs,
    status: "pending",
    replayable: body.body !== null && !body.redacted && !body.omittedReason,
    stream: inferStream(body.body),
  }
  const capture: DebugCapture = {
    entry,
    controller: new AbortController(),
    credentials,
    bytes: 0,
  }
  while (captures.size >= MAX_CAPTURES) {
    const oldest = captures.keys().next().value
    if (!oldest) break
    releaseCapture(oldest)
  }
  if (reserveCapture(capture)) {
    captures.set(id, capture)
  } else {
    capture.credentials.length = 0
    capture.controller.abort()
  }
  pruneCaptures()
  return id
}

function sanitizedError(
  error: unknown,
  credentials: ReadonlyArray<string>,
): LlmDebugLogError {
  const normalized = normalizeError(error)
  return Object.fromEntries(
    Object.entries(normalized).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitizeDebugText(value, credentials) : value,
    ]),
  ) as unknown as LlmDebugLogError
}

function terminalCapture(
  id: string,
  endedAtMs: number,
): DebugCapture | undefined {
  pruneCaptures(endedAtMs)
  const capture = captures.get(id)
  if (!capture || capture.entry.status !== "pending") return undefined
  capture.entry.endedAt = new Date(endedAtMs).toISOString()
  capture.entry.durationMs = endedAtMs - capture.entry.startedAtMs
  capture.entry.updatedAt = endedAtMs
  return capture
}

function sanitizeResponse(
  response: Omit<LlmDebugLogResponse, "bodyBytes"> & { bodyBytes?: number },
  capture: DebugCapture,
): LlmDebugLogResponse {
  const credentials = [
    ...capture.credentials,
    ...debugCredentialLiterals(response.headers),
  ]
  const body = sanitizeDebugCapture({
    ...response,
    contentType: findHeader(response.headers, "content-type"),
    knownCredentials: credentials,
  })
  if (body.redacted || body.omittedReason || response.bodyReadError)
    capture.entry.replayable = false
  return {
    ...body,
    ...(response.bodyReadError ?
      { bodyReadError: sanitizedError(response.bodyReadError, credentials) }
    : {}),
    headers: sanitizeDebugHeaders(response.headers, credentials),
    status: response.status,
    statusText: sanitizeDebugText(response.statusText, credentials),
  }
}

export function finishLlmDebugLog(
  id: string,
  response: Omit<LlmDebugLogResponse, "bodyBytes"> & { bodyBytes?: number },
  endedAtMs = Date.now(),
): void {
  const capture = terminalCapture(id, endedAtMs)
  if (!capture) return
  capture.entry.response = sanitizeResponse(response, capture)
  capture.entry.status =
    response.bodyReadError || response.status < 200 || response.status >= 300 ?
      "error"
    : "complete"
  retainTerminalCapture(capture)
}

export function failLlmDebugLog(
  id: string,
  error: unknown,
  endedAtMs = Date.now(),
): void {
  const capture = terminalCapture(id, endedAtMs)
  if (!capture) return
  capture.entry.error = sanitizedError(error, capture.credentials)
  capture.entry.status = "error"
  retainTerminalCapture(capture)
}

export function abortLlmDebugLog(
  id: string,
  options: AbortLlmDebugLogOptions,
): void {
  const capture = terminalCapture(id, options.endedAtMs ?? Date.now())
  if (!capture) return
  capture.entry.error = sanitizedError(options.error, capture.credentials)
  if (options.response)
    capture.entry.response = sanitizeResponse(options.response, capture)
  capture.entry.status = "aborted"
  retainTerminalCapture(capture)
}

export class LlmDebugQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmDebugQueryError"
  }
}

function decodeCursor(
  cursor?: string,
): { timestamp: number; id: string } | undefined {
  if (!cursor) return undefined
  try {
    if (cursor.length > 512) throw new Error("Oversized cursor")
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    )
    if (
      isRecord(value)
      && typeof value.timestamp === "number"
      && Number.isSafeInteger(value.timestamp)
      && typeof value.id === "string"
      && value.id.length <= 200
    ) {
      return { timestamp: value.timestamp, id: value.id }
    }
  } catch {
    // The opaque cursor never exposes parser errors or payload data.
  }
  throw new LlmDebugQueryError("Invalid debug log cursor")
}

// eslint-disable-next-line @typescript-eslint/require-await -- Preserve the async public API with strictly synchronous memory access.
export async function listLlmDebugLogs(
  options: { limit?: number; cursor?: string } = {},
): Promise<LlmDebugLogListResponse> {
  pruneCaptures()
  if (options.limit !== undefined && !Number.isFinite(options.limit))
    throw new LlmDebugQueryError("Invalid debug log limit")
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)))
  const cursor = decodeCursor(options.cursor)
  const all = [...captures.values()]
    .map(({ entry }) => entry)
    .filter(
      (entry) =>
        !cursor
        || entry.startedAtMs < cursor.timestamp
        || (entry.startedAtMs === cursor.timestamp && entry.id < cursor.id),
    )
    .sort((left, right) => {
      if (left.startedAtMs !== right.startedAtMs)
        return right.startedAtMs - left.startedAtMs
      if (left.id === right.id) return 0
      return left.id < right.id ? 1 : -1
    })
  const page = all.slice(0, limit)
  const entries = page.map((entry) => toSummary(entry))
  const last = page.at(-1)
  return {
    count: entries.length,
    entries,
    generatedAt: new Date().toISOString(),
    cursor:
      all.length > limit && last ?
        Buffer.from(
          JSON.stringify({ timestamp: last.startedAtMs, id: last.id }),
        ).toString("base64url")
      : null,
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- Preserve the async public API with strictly synchronous memory access.
export async function getLlmDebugLog(
  id: string,
): Promise<LlmDebugLogEntry | undefined> {
  pruneCaptures()
  const capture = captures.get(id)
  return capture ? structuredClone(capture.entry) : undefined
}

// eslint-disable-next-line @typescript-eslint/require-await -- Clear immediately while preserving the awaitable public API.
export async function clearLlmDebugLogs(): Promise<void> {
  for (const id of captures.keys()) releaseCapture(id)
  schedulePrune()
}
