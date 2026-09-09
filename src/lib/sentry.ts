import type { BunOptions } from "@sentry/bun"
import type { Client, SpanAttributes, SpanJSON } from "@sentry/core"
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { createHash } from "node:crypto"

import { getModelSettings } from "~/lib/model-settings"
import {
  isCodexPluginCategoryRequest,
  isCodexPluginSearchRequest,
  isGoogleModelActionRequest,
  sanitizeRequestDiagnosticReference,
  sanitizeSensitiveDiagnosticQuery,
} from "~/lib/request-diagnostics"
import { getRequestId } from "~/lib/request-session"
import { getRoutingAffinity } from "~/lib/routing-affinity"
import { isCredentialControlTelemetry } from "~/lib/sentry-credential-controls"
import { scrubCodexPluginSearchData } from "~/lib/sentry-plugin-search"

import packageJson from "../../package.json" with { type: "json" }

/**
 * Ordinary Sentry telemetry never records AI request/response bodies. The one
 * explicit ordinary-telemetry exception is an owned final upstream HTTP
 * failure body. Other raw capture remains restricted to administrator-only
 * LLM Debug.
 */
export function shouldRecordAiContent(): boolean {
  return false
}

const SENSITIVE_HEADER_PATTERNS = [
  "authorization",
  "api-key",
  "cookie",
  "x-api-key",
]
const SENSITIVE_HEADER_NAMES = new Set([
  "anthropic-beta",
  "anthropic-version",
  "copilot-session-token",
  "proxy-authorization",
  "x-agent-task-id",
  "x-goog-api-key",
  "x-interaction-id",
  "x-model-provider-preference",
  "x-parent-agent-id",
])
export const SENTRY_CONVERSATION_ID_HEADERS = [
  "x-sentry-conversation-id",
  "x-conversation-id",
  "x-thread-id",
  "x-session-id",
  "x-claude-code-session-id",
] as const
const ROUTING_AFFINITY_HEADER_NAMES = new Set([
  ...SENTRY_CONVERSATION_ID_HEADERS,
  "session-id",
  "thread-id",
  "x-client-session-id",
])
const FILTERED_VALUE = "[Filtered]"
const STATSIG_PROXY_HOST = "ab.chatgpt.com"
const STATSIG_CLIENT_KEY_RE = /(^|[?&])k=[^&#\s"'<>]*/g
const GOOGLE_PRIVATE_MODEL_ACTION_REFERENCE =
  /\/(?:v1beta\/models|v1\/models|models)\/([^/?#\s"'<>]+)/gi
const SENTRY_SCRUB_MAX_DEPTH = 64
const OPAQUE_UPSTREAM_RESPONSE_FIELDS = new Set([
  "upstreamResponseBody",
  "upstreamResponseBodyBytes",
  "upstreamResponseContentType",
])

type HeaderTuple = [string, unknown]

interface OwnDataEntry {
  key: string
  value: unknown
}

interface InspectionResult<T> {
  complete: boolean
  value: T
}

interface SentrySpanShape {
  data: Record<string, never>
  op?: string
  parent_span_id?: string
  span_id: string
  start_timestamp: number
  status?: string
  timestamp?: number
  trace_id: string
}

type ScrubResult = "safe" | "uncertain"

const SAFE_SCRUB_RESULT: ScrubResult = "safe"
const UNCERTAIN_SCRUB_RESULT: ScrubResult = "uncertain"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isSensitiveHeader(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    ROUTING_AFFINITY_HEADER_NAMES.has(lower)
    || SENSITIVE_HEADER_NAMES.has(lower)
    || SENSITIVE_HEADER_PATTERNS.some((pattern) => lower.includes(pattern))
  )
}

function isRoutingAffinityHeader(key: string): boolean {
  return ROUTING_AFFINITY_HEADER_NAMES.has(key.toLowerCase())
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

const STATSIG_HOST_REFERENCE_RE = new RegExp(
  String.raw`(^|[^a-z0-9.-])${escapeRegExp(STATSIG_PROXY_HOST)}(?::\d+)?(?=$|[/?#\s"'<>])`,
  "i",
)

function containsStatsigHost(value: string): boolean {
  return STATSIG_HOST_REFERENCE_RE.test(value)
}

function inspectLocalStatsigContext(
  entries: ReadonlyArray<OwnDataEntry>,
): InspectionResult<boolean> {
  if (
    entries.some(
      ({ key, value }) =>
        !OPAQUE_UPSTREAM_RESPONSE_FIELDS.has(key)
        && typeof value === "string"
        && containsStatsigHost(value),
    )
  )
    return { complete: true, value: true }

  const server = entries.find(({ key }) => key === "server")?.value
  if (!isRecord(server)) return { complete: true, value: false }
  const serverInspection = inspectOwnDataEntries(server)
  return {
    complete: serverInspection.complete,
    value: serverInspection.value.some(
      ({ value }) => typeof value === "string" && containsStatsigHost(value),
    ),
  }
}

function scrubStatsigClientKeyString(
  value: string,
  inheritedStatsigContext: boolean,
): string {
  const isStatsigContext = inheritedStatsigContext || containsStatsigHost(value)
  if (!isStatsigContext) return value

  return value.replaceAll(
    STATSIG_CLIENT_KEY_RE,
    (_match, prefix: string) => `${prefix}k=${FILTERED_VALUE}`,
  )
}

interface StatsigScrubContext {
  inheritedStatsigContext: boolean
  seen: WeakMap<object, boolean>
}

// eslint-disable-next-line complexity -- fail-closed descriptor traversal tracks partial progress
function scrubStatsigClientKeyDataSafely(
  value: unknown,
  context: StatsigScrubContext,
  depth = 0,
): ScrubResult {
  if (!isRecord(value)) return SAFE_SCRUB_RESULT
  if (depth > SENTRY_SCRUB_MAX_DEPTH) return UNCERTAIN_SCRUB_RESULT

  const seenInStatsigContext = context.seen.get(value)
  if (
    seenInStatsigContext === true
    || (seenInStatsigContext === false && !context.inheritedStatsigContext)
  )
    return SAFE_SCRUB_RESULT
  context.seen.set(value, context.inheritedStatsigContext)

  const inspected = inspectOwnDataEntries(value)
  let result = inspected.complete ? SAFE_SCRUB_RESULT : UNCERTAIN_SCRUB_RESULT

  const statsigInspection = inspectLocalStatsigContext(inspected.value)
  if (!statsigInspection.complete) result = UNCERTAIN_SCRUB_RESULT
  const localStatsigContext =
    context.inheritedStatsigContext || statsigInspection.value
  if (localStatsigContext) context.seen.set(value, true)
  for (const { key, value: nestedValue } of inspected.value) {
    if (OPAQUE_UPSTREAM_RESPONSE_FIELDS.has(key)) continue
    if (isRoutingAffinityHeader(key)) {
      if (!setOwnDataValue(value, key, FILTERED_VALUE))
        result = UNCERTAIN_SCRUB_RESULT
      continue
    }
    if (typeof nestedValue === "string") {
      const scrubbed = scrubStatsigClientKeyString(
        nestedValue,
        localStatsigContext,
      )
      if (scrubbed !== nestedValue && !setOwnDataValue(value, key, scrubbed))
        result = UNCERTAIN_SCRUB_RESULT
      continue
    }
    if (
      scrubStatsigClientKeyDataSafely(
        nestedValue,
        { inheritedStatsigContext: localStatsigContext, seen: context.seen },
        depth + 1,
      ) === UNCERTAIN_SCRUB_RESULT
    )
      result = UNCERTAIN_SCRUB_RESULT
  }
  return result
}

export function scrubStatsigClientKeyData(value: unknown): void {
  scrubStatsigClientKeyDataSafely(value, {
    inheritedStatsigContext: false,
    seen: new WeakMap<object, boolean>(),
  })
}

interface GoogleRouteScrubContext {
  method: string
  privateRouteValues: ReadonlySet<string>
  seen: WeakSet<object>
}

function sanitizeGoogleRouteString(
  key: string,
  value: string,
  context: GoogleRouteScrubContext,
): string {
  if (context.privateRouteValues.has(value)) return FILTERED_VALUE
  const sanitized = sanitizeRequestDiagnosticReference(context.method, value)
  return key === "url.query" || key === "query" ?
      sanitizeSensitiveDiagnosticQuery(sanitized)
    : sanitized
}

function scrubGoogleRouteData(
  value: unknown,
  context: GoogleRouteScrubContext,
  depth = 0,
): ScrubResult {
  if (!isRecord(value) || context.seen.has(value)) return SAFE_SCRUB_RESULT
  if (depth > SENTRY_SCRUB_MAX_DEPTH) return UNCERTAIN_SCRUB_RESULT
  context.seen.add(value)

  const inspected = inspectOwnDataEntries(value)
  let result = inspected.complete ? SAFE_SCRUB_RESULT : UNCERTAIN_SCRUB_RESULT
  for (const { key, value: nestedValue } of inspected.value) {
    if (OPAQUE_UPSTREAM_RESPONSE_FIELDS.has(key)) continue
    if (typeof nestedValue === "string") {
      const scrubbed = sanitizeGoogleRouteString(key, nestedValue, context)
      if (scrubbed !== nestedValue && !setOwnDataValue(value, key, scrubbed))
        result = UNCERTAIN_SCRUB_RESULT
    } else if (
      scrubGoogleRouteData(nestedValue, context, depth + 1)
      === UNCERTAIN_SCRUB_RESULT
    ) {
      result = UNCERTAIN_SCRUB_RESULT
    }
  }
  return result
}

function addGoogleRouteValueParts(
  values: Set<string>,
  match: RegExpMatchArray,
): void {
  values.add(match[1])
  const separator = match[1].lastIndexOf(":")
  if (separator === -1) return
  values.add(match[1].slice(0, separator))
  values.add(match[1].slice(separator + 1))
}

// eslint-disable-next-line max-params -- recursive depth bounds hostile telemetry
function findGoogleRouteValues(
  value: unknown,
  method: string,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): Set<string> {
  const values = new Set<string>()
  if (!isRecord(value) || seen.has(value) || depth > SENTRY_SCRUB_MAX_DEPTH) {
    return values
  }
  seen.add(value)

  for (const [key, entry] of ownDataEntries(value)) {
    if (OPAQUE_UPSTREAM_RESPONSE_FIELDS.has(key)) continue
    if (typeof entry === "string") {
      const matches = entry.matchAll(GOOGLE_PRIVATE_MODEL_ACTION_REFERENCE)
      for (const match of matches) {
        if (sanitizeRequestDiagnosticReference(method, match[0]) === match[0])
          continue
        addGoogleRouteValueParts(values, match)
      }
      continue
    }
    for (const nested of findGoogleRouteValues(
      entry,
      method,
      seen,
      depth + 1,
    )) {
      values.add(nested)
    }
  }
  return values
}

// eslint-disable-next-line complexity -- descriptor-only traversal keeps hostile data inert
function findGoogleRequestMethod(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): string | undefined {
  if (!isRecord(value) || seen.has(value) || depth > SENTRY_SCRUB_MAX_DEPTH) {
    return undefined
  }
  seen.add(value)

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, "value")) continue
      const entry: unknown = descriptor.value
      const method = findGoogleRequestMethod(entry, seen, depth + 1)
      if (method) return method
    }
    return undefined
  }

  const entries = ownDataEntries(value)
  const directMethod = findDirectGoogleRequestMethod(value, entries)
  if (directMethod) return directMethod

  for (const [key, entry] of entries) {
    if (OPAQUE_UPSTREAM_RESPONSE_FIELDS.has(key)) continue
    if (typeof entry === "string") {
      const separator = entry.indexOf(" ")
      if (separator > 0) {
        const method = entry.slice(0, separator)
        const reference = entry.slice(separator + 1)
        if (
          /^[A-Z]+$/i.test(method)
          && sanitizeRequestDiagnosticReference(method, reference) !== reference
        ) {
          return method
        }
      }
      continue
    }
    const method = findGoogleRequestMethod(entry, seen, depth + 1)
    if (method) return method
  }
  return undefined
}

function findDirectGoogleRequestMethod(
  value: Record<string, unknown>,
  entries: ReadonlyArray<[string, unknown]>,
): string | undefined {
  const directMethod = [
    ownDataValue(value, "method"),
    ownDataValue(value, "http.method"),
    ownDataValue(value, "http.request.method"),
  ].find((entry): entry is string => typeof entry === "string")
  if (!directMethod) return undefined
  return (
      entries.some(
        ([, entry]) =>
          typeof entry === "string"
          && sanitizeRequestDiagnosticReference(directMethod, entry) !== entry,
      )
    ) ?
      directMethod
    : undefined
}

function isHeaderTuple(entry: unknown): entry is HeaderTuple {
  const record = entry as Record<string, unknown>
  return (
    Array.isArray(entry)
    && typeof ownDataValue(record, "0") === "string"
    && ownDataValue(record, "1") !== undefined
  )
}

function isHeaderContainerKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return (
    normalized === "headers"
    || normalized === "request_headers"
    || normalized === "request.headers"
    || normalized === "http.request.header"
    || normalized === "http.request.headers"
    || normalized === "http.request.header.entries"
    || normalized.endsWith("headertuples")
    || normalized.endsWith("header_tuples")
  )
}

function sensitiveSemanticHeaderName(key: string): string | undefined {
  const normalized = key.toLowerCase()
  for (const prefix of [
    "http.request.header.",
    "http.request.headers.",
    "request.header.",
    "request.headers.",
  ]) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length)
  }
  return undefined
}

function inspectOwnDataEntries(
  value: Record<string, unknown>,
): InspectionResult<Array<OwnDataEntry>> {
  const entries: Array<OwnDataEntry> = []
  let keys: Array<string>
  try {
    keys = Object.keys(value)
  } catch {
    return { complete: false, value: entries }
  }
  for (const key of keys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) return { complete: false, value: entries }
      if (!Object.hasOwn(descriptor, "value")) continue
      entries.push({ key, value: descriptor.value })
    } catch {
      return { complete: false, value: entries }
    }
  }
  return { complete: true, value: entries }
}

function ownDataEntries(
  value: Record<string, unknown>,
): Array<[string, unknown]> {
  return inspectOwnDataEntries(value).value.map(
    ({ key, value: entryValue }) => [key, entryValue],
  )
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.hasOwn(descriptor, "value") ?
        descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

function setOwnDataValue(
  owner: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return false
    if (descriptor.writable) {
      Object.defineProperty(owner, key, { ...descriptor, value })
      return true
    }
    if (!descriptor.configurable) return Object.is(descriptor.value, value)
    Object.defineProperty(owner, key, { ...descriptor, value })
    return true
  } catch {
    // Hostile telemetry values are ignored rather than invoked.
    return false
  }
}

// eslint-disable-next-line complexity -- handles record and tuple header encodings together
function scrubHeaderContainer(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): ScrubResult {
  if (!isRecord(value) || seen.has(value)) return SAFE_SCRUB_RESULT
  if (depth > SENTRY_SCRUB_MAX_DEPTH) return UNCERTAIN_SCRUB_RESULT
  seen.add(value)

  if (Array.isArray(value)) {
    const inspected = inspectOwnDataEntries(
      value as unknown as Record<string, unknown>,
    )
    let result = inspected.complete ? SAFE_SCRUB_RESULT : UNCERTAIN_SCRUB_RESULT
    for (const { value: entry } of inspected.value) {
      if (isHeaderTuple(entry)) {
        const headerName = ownDataValue(
          entry as unknown as Record<string, unknown>,
          "0",
        )
        const tupleDescriptor = Object.getOwnPropertyDescriptor(entry, "1")
        if (
          typeof headerName === "string"
          && isSensitiveHeader(headerName)
          && tupleDescriptor
          && Object.hasOwn(tupleDescriptor, "value")
          && !setOwnDataValue(
            entry as unknown as Record<string, unknown>,
            "1",
            FILTERED_VALUE,
          )
        )
          result = UNCERTAIN_SCRUB_RESULT
        continue
      }
      if (
        scrubHeaderContainer(entry, seen, depth + 1) === UNCERTAIN_SCRUB_RESULT
      )
        result = UNCERTAIN_SCRUB_RESULT
    }
    return result
  }

  const iteratorEntries = ownDataValue(value, "entries")
  if (typeof iteratorEntries === "function") return SAFE_SCRUB_RESULT

  const inspected = inspectOwnDataEntries(value)
  let result = inspected.complete ? SAFE_SCRUB_RESULT : UNCERTAIN_SCRUB_RESULT
  for (const { key, value: nestedValue } of inspected.value) {
    if (OPAQUE_UPSTREAM_RESPONSE_FIELDS.has(key)) continue
    if (isSensitiveHeader(key)) {
      if (!setOwnDataValue(value, key, FILTERED_VALUE))
        result = UNCERTAIN_SCRUB_RESULT
      continue
    }
    if (
      isRecord(nestedValue)
      && scrubHeaderContainer(nestedValue, seen, depth + 1)
        === UNCERTAIN_SCRUB_RESULT
    )
      result = UNCERTAIN_SCRUB_RESULT
  }
  return result
}

// eslint-disable-next-line max-params, complexity -- recursive descriptor traversal is the privacy boundary
function scrubNestedHeaders(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  headerSeen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): ScrubResult {
  if (!isRecord(value) || seen.has(value)) return SAFE_SCRUB_RESULT
  if (depth > SENTRY_SCRUB_MAX_DEPTH) return UNCERTAIN_SCRUB_RESULT
  seen.add(value)

  if (Array.isArray(value)) {
    const inspected = inspectOwnDataEntries(
      value as unknown as Record<string, unknown>,
    )
    let result = inspected.complete ? SAFE_SCRUB_RESULT : UNCERTAIN_SCRUB_RESULT
    for (const { value: nestedValue } of inspected.value) {
      if (
        scrubNestedHeaders(nestedValue, seen, headerSeen, depth + 1)
        === UNCERTAIN_SCRUB_RESULT
      )
        result = UNCERTAIN_SCRUB_RESULT
    }
    return result
  }

  const inspected = inspectOwnDataEntries(value)
  let result = inspected.complete ? SAFE_SCRUB_RESULT : UNCERTAIN_SCRUB_RESULT
  for (const { key, value: nestedValue } of inspected.value) {
    if (OPAQUE_UPSTREAM_RESPONSE_FIELDS.has(key)) continue
    const semanticHeaderName = sensitiveSemanticHeaderName(key)
    if (semanticHeaderName && isSensitiveHeader(semanticHeaderName)) {
      if (!setOwnDataValue(value, key, FILTERED_VALUE))
        result = UNCERTAIN_SCRUB_RESULT
      continue
    }
    if (isHeaderContainerKey(key)) {
      if (
        scrubHeaderContainer(nestedValue, headerSeen, depth + 1)
        === UNCERTAIN_SCRUB_RESULT
      )
        result = UNCERTAIN_SCRUB_RESULT
      continue
    }
    if (
      scrubNestedHeaders(nestedValue, seen, headerSeen, depth + 1)
      === UNCERTAIN_SCRUB_RESULT
    )
      result = UNCERTAIN_SCRUB_RESULT
  }
  return result
}

function scrubSensitiveData<T>(event: T): T | null {
  if (isRecord(event)) {
    if (isCredentialControlTelemetry(event, ownDataValue)) return null
    if (scrubNestedHeaders(event) === UNCERTAIN_SCRUB_RESULT) return null
    if (
      scrubStatsigClientKeyDataSafely(event, {
        inheritedStatsigContext: false,
        seen: new WeakMap<object, boolean>(),
      }) === UNCERTAIN_SCRUB_RESULT
    )
      return null
    if (!scrubCodexPluginSearchData(event)) return null
    const googleRequestMethod = findGoogleRequestMethod(event)
    if (
      googleRequestMethod
      && scrubGoogleRouteData(event, {
        method: googleRequestMethod,
        privateRouteValues: findGoogleRouteValues(event, googleRequestMethod),
        seen: new WeakSet<object>(),
      }) === UNCERTAIN_SCRUB_RESULT
    )
      return null
  }

  return event
}

function readOwnStructuralString(
  span: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = ownDataValue(span, key)
  return typeof value === "string" ? value : undefined
}

function readOwnStructuralNumber(
  span: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = ownDataValue(span, key)
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * The installed Sentry SDK does not support dropping spans from beforeSendSpan:
 * a null result is ignored and the original span is emitted. On privacy
 * uncertainty, return a minimal fresh span containing only primitive tracing
 * structure. All descriptive data, attributes, measurements and links are
 * omitted so no uninspected user value can survive.
 */
function createFailClosedSentrySpan(
  span: Record<string, unknown>,
): SentrySpanShape {
  return {
    data: {},
    span_id: readOwnStructuralString(span, "span_id") ?? "0000000000000000",
    start_timestamp: readOwnStructuralNumber(span, "start_timestamp") ?? 0,
    trace_id:
      readOwnStructuralString(span, "trace_id")
      ?? "00000000000000000000000000000000",
    ...(readOwnStructuralString(span, "op") && {
      op: readOwnStructuralString(span, "op"),
    }),
    ...(readOwnStructuralString(span, "parent_span_id") && {
      parent_span_id: readOwnStructuralString(span, "parent_span_id"),
    }),
    ...(readOwnStructuralString(span, "status") && {
      status: readOwnStructuralString(span, "status"),
    }),
    ...(readOwnStructuralNumber(span, "timestamp") !== undefined && {
      timestamp: readOwnStructuralNumber(span, "timestamp"),
    }),
  }
}

function scrubSensitiveSpanData(span: SpanJSON): SpanJSON {
  const record = span as unknown as Record<string, unknown>
  return (scrubSensitiveData(record)
    ?? createFailClosedSentrySpan(record)) as unknown as SpanJSON
}

interface SentryRequestDiagnostics {
  method: string
  path: string
  url: string
}

export function applySentryRequestDiagnosticsToScope(
  scope: Sentry.Scope,
  request: SentryRequestDiagnostics,
): void {
  const isPrivatePluginQuery =
    isCodexPluginSearchRequest(request.method, request.path)
    || isCodexPluginCategoryRequest(request.method, request.path)
  if (
    !isGoogleModelActionRequest(request.method, request.path)
    && !isPrivatePluginQuery
  ) {
    return
  }

  const path = sanitizeRequestDiagnosticReference(
    request.method,
    request.path,
  ).split(/[?#]/, 1)[0]
  const url = sanitizeRequestDiagnosticReference(request.method, request.url)
  const currentRequest =
    scope.getScopeData().sdkProcessingMetadata.normalizedRequest

  scope.setTransactionName(`${request.method} ${path}`)
  scope.setSDKProcessingMetadata({
    normalizedRequest: {
      ...currentRequest,
      method: request.method,
      ...(isPrivatePluginQuery && {
        query_string: undefined,
      }),
      url,
    },
  })
}

export function applySentryRequestDiagnostics(
  request: SentryRequestDiagnostics,
): void {
  const isolationScope = Sentry.getIsolationScope()
  applySentryRequestDiagnosticsToScope(isolationScope, request)

  const currentScope = Sentry.getCurrentScope()
  if (currentScope !== isolationScope) {
    applySentryRequestDiagnosticsToScope(currentScope, request)
  }
}

function sentryAiSpanDefaultsIntegration() {
  return {
    name: "CopilotApiAiSpanDefaults",
    setup(client: Client) {
      client.on("spanStart", (span) => {
        const { data = {}, description, op } = Sentry.spanToJSON(span)
        const operationName = getGenAiOperationName(op, description, data)

        if (operationName && data["gen_ai.operation.name"] === undefined) {
          span.setAttribute("gen_ai.operation.name", operationName)
        }
        if (operationName && data["gen_ai.agent.name"] === undefined) {
          span.setAttribute("gen_ai.agent.name", SENTRY_AGENT_NAME)
        }

        const conversationId =
          Sentry.getCurrentScope().getScopeData().conversationId
          ?? Sentry.getIsolationScope().getScopeData().conversationId
        if (!conversationId) return

        const hasAiOperationId = data["ai.operationId"] !== undefined
        if (
          !op?.startsWith("gen_ai.")
          && !hasAiOperationId
          && !description?.startsWith("ai.")
        ) {
          return
        }

        span.setAttribute("gen_ai.conversation.id", conversationId)
      })
    },
  }
}

const SENTRY_AGENT_NAME = "copilot-proxy"

function getGenAiOperationName(
  op: string | undefined,
  description: string | undefined,
  attributes: SpanAttributes,
): string | undefined {
  if (op?.startsWith("gen_ai.")) return op.slice("gen_ai.".length)
  if (attributes["ai.operationId"] !== undefined) {
    return description?.startsWith("ai.") ? description.slice(3) : undefined
  }
  return undefined
}

export function createSentryInvokeAgentSpanOptions(
  model: string,
  conversationId?: string,
): { attributes: SpanAttributes; name: string; op: string } {
  return {
    op: "gen_ai.invoke_agent",
    name: `invoke_agent ${SENTRY_AGENT_NAME}`,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": SENTRY_AGENT_NAME,
      "gen_ai.request.model": getSentryModelName(model),
      ...(conversationId && {
        "gen_ai.conversation.id": conversationId,
      }),
    },
  }
}

export function createSentryChatSpanOptions(options: {
  inputMessages?: unknown
  model: string
  streaming?: boolean
}): { attributes: SpanAttributes; name: string; op: string } {
  const model = getSentryModelName(options.model)
  return {
    op: "gen_ai.chat",
    name: `chat ${model}`,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": SENTRY_AGENT_NAME,
      "gen_ai.request.model": model,
      "gen_ai.response.model": model,
      ...(options.streaming && {
        "gen_ai.response.streaming": true,
      }),
    },
  }
}

export function createSentryToolSpanOptions(options: {
  isError?: boolean
  toolArguments?: unknown
  toolName: string
  toolResult?: unknown
  toolType?: string
}): { attributes: SpanAttributes; name: string; op: string } {
  return {
    op: "gen_ai.execute_tool",
    name: `execute_tool ${options.toolName}`,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": options.toolName,
      "gen_ai.tool.type": options.toolType ?? "function",
      ...(options.isError && { "gen_ai.tool.error": "true" }),
    },
  }
}

export function setSentryOutputMessages(
  _span: Sentry.Span,
  _content: unknown,
): void {
  // Intentionally empty: ordinary Sentry spans retain only structural data.
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return

  Sentry.init(createSentryInitOptions(dsn))

  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason)
  })

  // Pipe consola logs to Sentry
  consola.addReporter(Sentry.createConsolaReporter())

  consola.info("Sentry initialized")
}

export type CopilotApiSentryInitOptions = BunOptions

export function createSentryInitOptions(
  dsn: string,
): CopilotApiSentryInitOptions {
  const tracesSampleRate = Number.parseFloat(
    process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1.0",
  )

  return {
    dsn,
    release: `copilot-api@${packageJson.version}`,
    environment: process.env.NODE_ENV ?? "development",
    sendDefaultPii: false,
    streamGenAiSpans: true,
    tracesSampleRate:
      Number.isFinite(tracesSampleRate) ? tracesSampleRate : 1.0,
    enableLogs: true,
    integrations: [
      sentryAiSpanDefaultsIntegration(),
      Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
    ],
    beforeSend(event) {
      return scrubSensitiveData(event)
    },
    beforeSendTransaction(event) {
      return scrubSensitiveData(event)
    },
    beforeSendSpan(span) {
      return scrubSensitiveSpanData(span)
    },
    beforeSendLog(log) {
      return scrubSensitiveData(log)
    },
  }
}

const CONVERSATION_ID_PAYLOAD_KEYS = [
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
  "session_id",
  "sessionId",
  "prompt_cache_key",
]

const CONVERSATION_ID_METADATA_KEYS = [
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
  "session_id",
  "sessionId",
]

function normalizeConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getFirstStringValue(
  source: Record<string, unknown>,
  keys: Array<string>,
): string | undefined {
  for (const key of keys) {
    const value = normalizeConversationId(source[key])
    if (value) return value
  }

  return undefined
}

function getConversationIdFromUserId(userId: unknown): string | undefined {
  if (typeof userId !== "string" || userId.length === 0) return undefined

  try {
    const parsed = JSON.parse(userId) as unknown
    if (isRecord(parsed)) {
      const sessionId = normalizeConversationId(parsed.session_id)
      if (sessionId) return sessionId
    }
  } catch {
    // Fall through to the legacy Claude Code string format.
  }

  const sessionMatch = userId.match(/_session_(.+)$/)
  return normalizeConversationId(sessionMatch?.[1])
}

function getConversationIdFromMetadata(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined

  return (
    getFirstStringValue(metadata, CONVERSATION_ID_METADATA_KEYS)
    ?? getConversationIdFromUserId(metadata.user_id)
  )
}

export function getSentryConversationIdFromPayload(
  payload: unknown,
): string | undefined {
  if (!isRecord(payload)) return undefined

  return (
    getFirstStringValue(payload, CONVERSATION_ID_PAYLOAD_KEYS)
    ?? getConversationIdFromMetadata(payload.metadata)
  )
}

export function getSentryConversationIdFromHeaders(
  headers: Headers,
): string | undefined {
  for (const header of SENTRY_CONVERSATION_ID_HEADERS) {
    const value = normalizeConversationId(headers.get(header))
    if (value) return value
  }

  return undefined
}

export function pseudonymizeSentryConversationId(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

export function setSentryConversationIdFromRequest(
  c: Context,
  payload?: unknown,
): string | undefined {
  const routingAffinityKey = getRoutingAffinity()?.key
  const payloadConversationId = getSentryConversationIdFromPayload(payload)
  const headerConversationId = getSentryConversationIdFromHeaders(
    c.req.raw.headers,
  )
  const conversationId =
    routingAffinityKey && (payloadConversationId || headerConversationId) ?
      undefined
    : (payloadConversationId ?? headerConversationId ?? getRequestId())

  if (!conversationId) return undefined

  const pseudonymousConversationId =
    pseudonymizeSentryConversationId(conversationId)
  Sentry.setConversationId(pseudonymousConversationId)
  return pseudonymousConversationId
}

/**
 * Map copilot-api model names to canonical model IDs recognized by
 * Sentry's cost calculation (via models.dev / OpenRouter).
 */
const SENTRY_MODEL_MAP: Record<string, string> = {
  // Claude models (copilot uses dots, models.dev uses hyphens)
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4.6-1m": "claude-opus-4-6",
  "claude-opus-4.6-fast": "claude-opus-4-6",
  "claude-opus-4.5": "claude-opus-4-5",
  "claude-opus-4": "claude-opus-4-0",
  "claude-opus-4.1": "claude-opus-4-1",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-sonnet-4": "claude-sonnet-4-0",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-3.5": "claude-3-5-haiku-20241022",
  // GPT models
  "gpt-4.1": "gpt-4.1-2025-04-14",
  "gpt-4.1-mini": "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano": "gpt-4.1-nano-2025-04-14",
  "gpt-4o": "gpt-4o-2024-08-06",
  "gpt-4o-mini": "gpt-4o-mini-2024-07-18",
  // o-series
  o3: "o3-2025-04-16",
  "o3-mini": "o3-mini-2025-01-31",
  "o4-mini": "o4-mini-2025-04-16",
}

const REASONING_SUFFIXES = new Set(["low", "medium", "high", "xhigh", "max"])

export function getSentryModelName(model: string): string {
  const configuredName = getModelSettings(model)?.sentryModelName
  if (configuredName) return configuredName

  const baseModel = getModelWithoutReasoningSuffix(model)
  const configuredBaseName = getModelSettings(baseModel)?.sentryModelName
  if (configuredBaseName) return configuredBaseName

  if (Object.hasOwn(SENTRY_MODEL_MAP, baseModel)) {
    return SENTRY_MODEL_MAP[baseModel]
  }

  return SENTRY_MODEL_MAP[model] ?? model
}

function getModelWithoutReasoningSuffix(model: string): string {
  const colonIndex = model.lastIndexOf(":")
  if (colonIndex === -1) return model

  const suffix = model.slice(colonIndex + 1)
  return REASONING_SUFFIXES.has(suffix) ? model.slice(0, colonIndex) : model
}

export function setupSentryShutdown(): void {
  process.on("SIGTERM", async () => {
    await Sentry.close(2000)
    process.exit(0)
  })
}
