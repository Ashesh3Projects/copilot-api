/* eslint-disable max-lines -- centralized HTTP error boundary and hostile input validation */
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import * as Sentry from "@sentry/bun"
import consola from "consola"

import type {
  EndpointRouteFailure,
  TranslationCheck,
} from "~/lib/endpoint-routing"

import {
  readDescriptorSnapshotValue,
  readNativeDomExceptionField,
  snapshotDescriptorChain,
} from "~/lib/descriptor-chain"
import {
  isProxyObject,
  snapshotPlainDataRecord,
} from "~/lib/plain-data-snapshot"
import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { collectSafeCopilotResponseHeaders } from "~/services/copilot/copilot-contract"

const ABORT_ERROR_DESCRIPTOR_KEYS = new Set(["name"])
const RESPONSE_PROTOTYPE_DESCRIPTORS = Object.getOwnPropertyDescriptors(
  Response.prototype,
)
const RESPONSE_CLONE = RESPONSE_PROTOTYPE_DESCRIPTORS.clone.value as (
  this: Response,
) => Response
const RESPONSE_HEADERS = RESPONSE_PROTOTYPE_DESCRIPTORS.headers.get as (
  this: Response,
) => Headers
const RESPONSE_STATUS = RESPONSE_PROTOTYPE_DESCRIPTORS.status.get as (
  this: Response,
) => number
const RESPONSE_ARRAY_BUFFER = RESPONSE_PROTOTYPE_DESCRIPTORS.arrayBuffer
  .value as (this: Response) => Promise<ArrayBuffer>
const HEADERS_GET = Object.getOwnPropertyDescriptor(Headers.prototype, "get")
  ?.value as (this: Headers, name: string) => string | null
export const HTTP_TOO_MANY_REQUESTS_STATUS = 429

/**
 * Check if an error is an AbortError (client disconnected during streaming).
 * These are expected and should not be logged or reported to Sentry.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const snapshot = snapshotDescriptorChain(error, {
    keys: ABORT_ERROR_DESCRIPTOR_KEYS,
    maxDepth: 5,
  })
  if (!snapshot) return false
  const name =
    readNativeDomExceptionField(snapshot, "name")
    ?? readDescriptorSnapshotValue(snapshot, "name")
    ?? snapshot.errorKind
  return name === "AbortError"
}

export class HTTPError extends Error {
  response: Response
  requestPayload?: unknown

  constructor(message: string, response: Response, requestPayload?: unknown) {
    super(message)
    this.response = response
    this.requestPayload = redactSensitiveValue(requestPayload)
    HTTP_ERROR_RESPONSE_CAPTURES.set(
      this,
      captureHttpErrorResponse(message, response),
    )
  }
}

export class SensitiveHTTPError extends HTTPError {}

export interface SafeCustomProviderClientError {
  readonly code?: string
  readonly message: string
  readonly type: string
}

interface CustomProviderHttpErrorSnapshot {
  readonly providerError?: SafeCustomProviderClientError
  readonly responseHeaders: Readonly<Record<string, string>>
  readonly safeMessage: string
  readonly status: number
}

interface CustomProviderHttpErrorOptions {
  readonly requestPayload?: unknown
  readonly responseBody: string
}

const CUSTOM_PROVIDER_HTTP_ERROR_SNAPSHOTS = new WeakMap<
  HTTPError,
  CustomProviderHttpErrorSnapshot
>()

export class CustomProviderHTTPError extends SensitiveHTTPError {
  constructor(
    message: string,
    response: Response,
    options: CustomProviderHttpErrorOptions,
  ) {
    super(message, response, options.requestPayload)
    CUSTOM_PROVIDER_HTTP_ERROR_SNAPSHOTS.set(this, {
      providerError: snapshotCustomProviderClientError(options.responseBody),
      safeMessage: "Custom provider request failed",
      ...snapshotLocalResponse(response),
    })
  }
}

interface LocalHttpErrorSnapshot {
  readonly clientBody?: Readonly<Record<string, unknown>>
  readonly localError?: SafeLocalClientError
  readonly responseHeaders: Readonly<Record<string, string>>
  readonly safeMessage: string
  readonly status: number
}

const LOCAL_HTTP_ERROR_SNAPSHOTS = new WeakMap<
  HTTPError,
  LocalHttpErrorSnapshot
>()

export class LocalHTTPError extends HTTPError {
  readonly clientBody: Record<string, unknown>

  constructor(
    message: string,
    response: Response,
    clientBody: Record<string, unknown>,
  ) {
    super(message, response)
    this.clientBody = clientBody
    const clientBodySnapshot = snapshotPlainDataRecord(clientBody)
    const responseSnapshot = snapshotLocalResponse(response)
    LOCAL_HTTP_ERROR_SNAPSHOTS.set(this, {
      clientBody: clientBodySnapshot,
      localError: safeLocalClientError(clientBodySnapshot),
      safeMessage:
        safeLocalClientError(clientBodySnapshot)?.message
        ?? safeHttpErrorMessage(message),
      ...responseSnapshot,
    })
  }
}

export function createInvalidJsonBodyError(): LocalHTTPError {
  const clientBody = {
    error: {
      code: "invalid_json",
      message: "The request body must contain valid JSON.",
      param: "body",
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

export function createInvalidRequestError(
  message: string,
  param: string,
): LocalHTTPError {
  const clientBody = {
    error: {
      code: "invalid_request",
      message,
      param,
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

export function createEndpointTranslationError(
  failure: EndpointRouteFailure,
): LocalHTTPError {
  const concept = failure.blockers[0] ?? "request_shape"
  const clientBody = {
    error: {
      code: failure.code,
      message:
        "The selected Copilot model cannot accept this request without losing required protocol data.",
      param: concept,
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

export function assertEndpointTranslationSupported(
  failure: EndpointRouteFailure,
  check: TranslationCheck,
): void {
  if (check.supported) return
  throw createEndpointTranslationError({
    blockers: check.blockers,
    code: failure.code,
    source: failure.source,
  })
}

interface UpstreamErrorBody {
  error: {
    code?: unknown
    message?: unknown
  }
}

export interface SafeUpstreamClientError {
  code: string
  fingerprint: string
  message: string
}

interface HttpErrorInspectionBase {
  readonly responseHeaders: Readonly<Record<string, string>>
  readonly safeMessage: string
  readonly status: number
  readonly suppressResponseBodyDiagnostics?: true
}

export interface UpstreamFailureSnapshot {
  readonly bodyBytes: Readonly<Uint8Array<ArrayBuffer>>
  readonly bodyText?: string
  readonly contentType?: string
  readonly responseHeaders: Readonly<Record<string, string>>
  readonly status: number
}

export interface UpstreamHttpErrorInspection
  extends HttpErrorInspectionBase,
    UpstreamFailureSnapshot {
  readonly kind: "upstream"
  readonly clientError?: SafeUpstreamClientError
  readonly localClientBody?: undefined
  readonly localError?: undefined
}

export interface LocalHttpErrorInspection extends HttpErrorInspectionBase {
  readonly kind: "local"
  readonly localClientBody?: Readonly<Record<string, unknown>>
  readonly localError?: SafeLocalClientError
  readonly bodyBytes?: undefined
  readonly bodyText?: undefined
  readonly contentType?: undefined
  readonly clientError?: undefined
}

export interface FallbackHttpErrorInspection extends HttpErrorInspectionBase {
  readonly kind: "fallback"
  readonly localClientBody?: undefined
  readonly localError?: undefined
  readonly bodyBytes?: undefined
  readonly bodyText?: undefined
  readonly contentType?: undefined
  readonly clientError?: undefined
}

export interface CustomProviderHttpErrorInspection
  extends HttpErrorInspectionBase {
  readonly kind: "custom-provider"
  readonly providerError?: SafeCustomProviderClientError
  readonly localClientBody?: undefined
  readonly localError?: undefined
  readonly bodyBytes?: undefined
  readonly bodyText?: undefined
  readonly contentType?: undefined
  readonly clientError?: undefined
}

export type HttpErrorInspection =
  | UpstreamHttpErrorInspection
  | LocalHttpErrorInspection
  | FallbackHttpErrorInspection
  | CustomProviderHttpErrorInspection

/** @deprecated Use HttpErrorInspection. */
export type SafeHttpErrorInspection = HttpErrorInspection

export interface SafeLocalClientError {
  readonly code?: string
  readonly message: string
  readonly param?: string
  readonly type: string
}

export function isHTTPError(error: unknown): error is HTTPError {
  if (isProxyObject(error)) return false
  try {
    return error instanceof HTTPError
  } catch {
    return false
  }
}

interface HttpErrorResponseCapture {
  readonly contentType?: string
  readonly responseBody?: Response
  readonly responseHeaders: Readonly<Record<string, string>>
  readonly safeMessage: string
  readonly status: number
}

const HTTP_ERROR_RESPONSE_CAPTURES = new WeakMap<
  HTTPError,
  HttpErrorResponseCapture
>()
const HTTP_ERROR_INSPECTIONS = new WeakMap<
  HTTPError,
  Promise<HttpErrorInspection>
>()

const SENSITIVE_FIELD_PATTERN =
  /password|secret|api[_-]?key|authorization|cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret|code[_-]?verifier|(?:conversation|session|thread)[_-]?id|prompt[_-]?cache[_-]?key|safety[_-]?identifier|user[_-]?id/i
const SENSITIVE_ERROR_MESSAGE_PATTERN =
  /authorization|bearer\s|api[_ -]?key|credential|password|secret|token|cookie/i
const SAFE_PROVIDER_ERROR_METADATA_PATTERN = /^[\w.:-]{1,128}$/u
const SAFE_PROVIDER_ERROR_MESSAGE_MAX_LENGTH = 2048
const SAFE_HTTP_ERROR_MESSAGES = new Set([
  "Empty response body from upstream",
  "Failed to create chat completions",
  "Failed to create embeddings",
  "Failed to create responses",
  "Failed to get Copilot usage",
  "Failed to get device code",
  "Failed to get GitHub user",
  "Failed to get models",
  "Invalid JSON response from upstream",
  "Request rejected",
])

function safeHttpErrorMessage(message: unknown): string {
  return typeof message === "string" && SAFE_HTTP_ERROR_MESSAGES.has(message) ?
      message
    : "Upstream request failed"
}

function snapshotLocalHttpError(
  error: HTTPError,
): LocalHttpErrorSnapshot | undefined {
  return LOCAL_HTTP_ERROR_SNAPSHOTS.get(error)
}

function snapshotLocalResponse(
  response: Response,
): Pick<LocalHttpErrorSnapshot, "responseHeaders" | "status"> {
  let status = 500
  let responseHeaders: Readonly<Record<string, string>> = Object.freeze({})
  try {
    const nativeStatus = Reflect.apply(RESPONSE_STATUS, response, []) as unknown
    if (
      typeof nativeStatus === "number"
      && Number.isInteger(nativeStatus)
      && nativeStatus >= 200
      && nativeStatus <= 599
    ) {
      status = nativeStatus
    }
    const headers = Reflect.apply(RESPONSE_HEADERS, response, []) as unknown
    if (headers instanceof Headers && !isProxyObject(headers)) {
      responseHeaders = Object.freeze(
        collectSafeCopilotResponseHeaders(headers),
      )
    }
  } catch {
    // Local responses are native at construction; fail closed if not.
  }
  return { responseHeaders, status }
}

function safeLocalClientError(
  clientBody: Readonly<Record<string, unknown>> | undefined,
): SafeLocalClientError | undefined {
  const bodyError = clientBody?.error
  if (
    typeof bodyError !== "object"
    || bodyError === null
    || Array.isArray(bodyError)
  ) {
    return undefined
  }
  const record = bodyError as Readonly<Record<string, unknown>>
  if (
    typeof record.type !== "string"
    || typeof record.message !== "string"
    || !isSafeLocalErrorMetadata(record)
  ) {
    return undefined
  }
  return Object.freeze({
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    message: record.message,
    ...(typeof record.param === "string" ? { param: record.param } : {}),
    type: record.type,
  } satisfies SafeLocalClientError)
}

function snapshotCustomProviderClientError(
  responseBody: string,
): SafeCustomProviderClientError | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseBody) as unknown
  } catch {
    return undefined
  }
  const snapshot = snapshotPlainDataRecord(parsed)
  if (!snapshot) return undefined
  const bodyError = snapshot.error
  if (
    typeof bodyError !== "object"
    || bodyError === null
    || Array.isArray(bodyError)
  ) {
    return undefined
  }
  const record = bodyError as Readonly<Record<string, unknown>>
  const message = unwrapUpstreamErrorMessage(record.message)?.trim()
  if (
    !message
    || message.length > SAFE_PROVIDER_ERROR_MESSAGE_MAX_LENGTH
    || hasControlCharacter(message)
    || hasSensitiveProviderErrorText(message)
  ) {
    return undefined
  }
  const metadata = safeProviderErrorMetadataSnapshot(record)
  if (!metadata) return undefined
  return Object.freeze({
    ...(metadata.code ? { code: metadata.code } : {}),
    message,
    type: metadata.type,
  })
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 31 || codePoint === 127) return true
  }
  return false
}

function safeProviderErrorMetadata(value: unknown): string | undefined {
  return (
      typeof value === "string"
        && SAFE_PROVIDER_ERROR_METADATA_PATTERN.test(value)
        && !hasSensitiveProviderErrorText(value)
    ) ?
      value
    : undefined
}

function hasSensitiveProviderErrorText(value: string): boolean {
  const terms = value.replaceAll(/[_.:-]+/gu, " ")
  return SENSITIVE_ERROR_MESSAGE_PATTERN.test(terms)
}

function safeProviderErrorMetadataSnapshot(
  record: Readonly<Record<string, unknown>>,
): Pick<SafeCustomProviderClientError, "code" | "type"> | undefined {
  const safeType = safeProviderErrorMetadata(record.type)
  const code = safeProviderErrorMetadata(record.code)
  if (record.type !== undefined && safeType === undefined) return undefined
  if (record.code !== undefined && code === undefined) return undefined
  return { ...(code ? { code } : {}), type: safeType ?? "api_error" }
}

const SAFE_LOCAL_ERROR_TYPES = new Set([
  "account_unavailable",
  "error",
  "invalid_request_error",
  "not_found_error",
  "session_affinity_error",
  "server_error",
])
const SAFE_LOCAL_ERROR_CODES = new Set([
  "bad_request",
  "compaction_payload_too_large",
  "endpoint_translation_unsupported",
  "invalid_json",
  "invalid_request",
  "invalid_type",
  "invalid_value",
  "model_not_found",
  "request_too_large",
  "responses_payload_too_large",
  "server_error",
  "session_account_continuity_error",
  "session_account_rejected",
  "unsupported_value",
  "web_search_limit_exceeded",
])

function isSafeLocalErrorMetadata(
  record: Readonly<Record<string, unknown>>,
): boolean {
  if (!SAFE_LOCAL_ERROR_TYPES.has(record.type as string)) return false
  if (typeof record.code === "string") {
    return SAFE_LOCAL_ERROR_CODES.has(record.code)
  }
  return record.type === "not_found_error"
}

function redactSensitiveValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_FIELD_PATTERN.test(key)) return "[REDACTED]"
  if (
    typeof value === "string"
    && (key === "client_metadata" || key === "metadata")
  ) {
    try {
      return JSON.stringify(redactSensitiveValue(JSON.parse(value) as unknown))
    } catch {
      return "[REDACTED]"
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item))
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        redactSensitiveValue(nestedValue, nestedKey),
      ]),
    )
  }
  return value
}

function isUpstreamErrorBody(value: unknown): value is UpstreamErrorBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const body = value as Record<string, unknown>
  return typeof body.error === "object" && body.error !== null
}

function unwrapUpstreamErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== "object" || parsed === null) return value
    const record = parsed as Record<string, unknown>
    if (typeof record.error === "string") return record.error
    if (typeof record.message === "string") return record.message
  } catch {
    return value
  }
  return value
}

function classifyValidationMessage(
  message: string,
): Pick<SafeUpstreamClientError, "fingerprint" | "message"> | undefined {
  const toolChoiceMessage =
    "Invalid request content: A tool_choice was set on the request but no tools were specified."
  if (message === toolChoiceMessage) {
    return { fingerprint: "tool_choice_without_tools", message }
  }
  const sampling =
    /^Unsupported parameter: '(temperature|top_p)' is not supported with this model\.$/.exec(
      message,
    )
  if (sampling) {
    return {
      fingerprint: `unsupported_${sampling[1]}`,
      message: `Unsupported parameter: '${sampling[1]}' is not supported with this model.`,
    }
  }
  const imageMessage =
    "validating vision content in responses input: validating responses image content: image media type not supported"
  if (message === imageMessage) {
    return { fingerprint: "unsupported_image_media_type", message }
  }
  return undefined
}

function safeUpstreamClientError(
  status: number,
  body: unknown,
): SafeUpstreamClientError | undefined {
  const snapshot = snapshotPlainDataRecord(body)
  if (status !== 400 || !snapshot || !isUpstreamErrorBody(snapshot)) {
    return undefined
  }
  const code = snapshot.error.code
  const message = unwrapUpstreamErrorMessage(snapshot.error.message)
  const validation = message ? classifyValidationMessage(message) : undefined
  if (
    code !== "invalid_request_body"
    || !message
    || !validation
    || SENSITIVE_ERROR_MESSAGE_PATTERN.test(message)
  ) {
    return undefined
  }
  return {
    code,
    ...validation,
  }
}

function fallbackSafeMessage(status: number, safeMessage: string): string {
  if (status === 402) return "Copilot quota exhausted"
  if (status === 466) return "Copilot client version mismatch"
  return safeMessage
}

function captureHttpErrorResponse(
  message: string,
  response: Response,
): HttpErrorResponseCapture {
  const safeMessage = safeHttpErrorMessage(message)
  if (isProxyObject(response)) {
    return {
      responseHeaders: Object.freeze({}),
      safeMessage,
      status: 500,
    }
  }

  let status = 500
  let responseHeaders: Readonly<Record<string, string>> = Object.freeze({})
  try {
    const nativeStatus = Reflect.apply(RESPONSE_STATUS, response, []) as unknown
    if (
      typeof nativeStatus === "number"
      && Number.isInteger(nativeStatus)
      && nativeStatus >= 200
      && nativeStatus <= 599
    ) {
      status = nativeStatus
    }
    const headers = Reflect.apply(RESPONSE_HEADERS, response, []) as unknown
    if (!(headers instanceof Headers) || isProxyObject(headers)) {
      return { responseHeaders, safeMessage, status }
    }
    responseHeaders = Object.freeze(collectSafeCopilotResponseHeaders(headers))
    const contentType = Reflect.apply(HEADERS_GET, headers, [
      "content-type",
    ]) as unknown
    const responseBody = Reflect.apply(RESPONSE_CLONE, response, [])
    return {
      responseBody,
      responseHeaders,
      safeMessage,
      status,
      ...(typeof contentType === "string" ? { contentType } : {}),
    }
  } catch {
    return { responseHeaders, safeMessage, status }
  }
}

function readHttpErrorCapture(error: HTTPError): HttpErrorResponseCapture {
  const localSnapshot = snapshotLocalHttpError(error)
  if (localSnapshot) {
    return {
      responseHeaders: localSnapshot.responseHeaders,
      safeMessage: localSnapshot.safeMessage,
      status: localSnapshot.status,
    }
  }
  return (
    HTTP_ERROR_RESPONSE_CAPTURES.get(error) ?? {
      responseHeaders: Object.freeze({}),
      safeMessage: "Upstream request failed",
      status: 500,
    }
  )
}

function getHttpErrorDiagnosticPolicy(error: HTTPError) {
  return error instanceof SensitiveHTTPError ?
      { suppressResponseBodyDiagnostics: true as const }
    : {}
}

export function snapshotHttpErrorMetadata(
  error: HTTPError,
): HttpErrorInspection {
  const diagnosticPolicy = getHttpErrorDiagnosticPolicy(error)
  const localSnapshot = snapshotLocalHttpError(error)
  if (localSnapshot) {
    return Object.freeze({
      kind: "local",
      localClientBody: localSnapshot.clientBody,
      localError: localSnapshot.localError,
      responseHeaders: localSnapshot.responseHeaders,
      safeMessage: fallbackSafeMessage(
        localSnapshot.status,
        localSnapshot.localError?.message ?? localSnapshot.safeMessage,
      ),
      status: localSnapshot.status,
      ...diagnosticPolicy,
    })
  }
  const customProviderSnapshot = CUSTOM_PROVIDER_HTTP_ERROR_SNAPSHOTS.get(error)
  if (customProviderSnapshot) {
    return Object.freeze({
      kind: "custom-provider",
      providerError: customProviderSnapshot.providerError,
      responseHeaders: customProviderSnapshot.responseHeaders,
      safeMessage: customProviderSnapshot.safeMessage,
      status: customProviderSnapshot.status,
      ...diagnosticPolicy,
    })
  }
  const snapshot = readHttpErrorCapture(error)
  return Object.freeze({
    kind: "fallback",
    responseHeaders: snapshot.responseHeaders,
    safeMessage: fallbackSafeMessage(snapshot.status, snapshot.safeMessage),
    status: snapshot.status,
    ...diagnosticPolicy,
  })
}

function isTextualContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase()
  return (
    mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType.endsWith("+json")
    || mediaType === "application/xml"
    || mediaType.endsWith("+xml")
    || mediaType === "application/javascript"
    || mediaType === "application/ecmascript"
    || mediaType === "application/x-www-form-urlencoded"
  )
}

function classifyUpstreamBody(
  status: number,
  bodyText: string | undefined,
): SafeUpstreamClientError | undefined {
  if (bodyText === undefined) return undefined
  try {
    return safeUpstreamClientError(status, JSON.parse(bodyText) as unknown)
  } catch {
    return undefined
  }
}

async function inspectCapturedHttpError(
  error: HTTPError,
): Promise<HttpErrorInspection> {
  const diagnosticPolicy = getHttpErrorDiagnosticPolicy(error)
  const localSnapshot = snapshotLocalHttpError(error)
  if (localSnapshot) return snapshotHttpErrorMetadata(error)
  if (CUSTOM_PROVIDER_HTTP_ERROR_SNAPSHOTS.has(error)) {
    return snapshotHttpErrorMetadata(error)
  }

  const snapshot = readHttpErrorCapture(error)
  if (!snapshot.responseBody) return snapshotHttpErrorMetadata(error)

  let bodyBytes: Uint8Array<ArrayBuffer>
  try {
    const buffer = await Reflect.apply(
      RESPONSE_ARRAY_BUFFER,
      snapshot.responseBody,
      [],
    )
    bodyBytes = new Uint8Array(buffer.slice(0))
  } catch {
    return Object.freeze({
      kind: "fallback",
      responseHeaders: snapshot.responseHeaders,
      safeMessage: fallbackSafeMessage(snapshot.status, snapshot.safeMessage),
      status: snapshot.status,
      ...diagnosticPolicy,
    })
  }
  if (bodyBytes.byteLength === 0) {
    return Object.freeze({
      kind: "fallback",
      responseHeaders: snapshot.responseHeaders,
      safeMessage: fallbackSafeMessage(snapshot.status, snapshot.safeMessage),
      status: snapshot.status,
      ...diagnosticPolicy,
    })
  }

  const contentType = snapshot.contentType
  const bodyText =
    isTextualContentType(contentType) ?
      new TextDecoder(undefined, { ignoreBOM: true }).decode(bodyBytes)
    : undefined
  return Object.freeze({
    kind: "upstream",
    bodyBytes,
    ...(bodyText === undefined ? {} : { bodyText }),
    clientError: classifyUpstreamBody(snapshot.status, bodyText),
    ...(contentType === undefined ? {} : { contentType }),
    responseHeaders: snapshot.responseHeaders,
    safeMessage: fallbackSafeMessage(snapshot.status, snapshot.safeMessage),
    status: snapshot.status,
    ...diagnosticPolicy,
  })
}

export function inspectHttpError(
  error: HTTPError,
): Promise<HttpErrorInspection> {
  const cached = HTTP_ERROR_INSPECTIONS.get(error)
  if (cached) return cached
  const inspection = inspectCapturedHttpError(error)
  HTTP_ERROR_INSPECTIONS.set(error, inspection)
  return inspection
}

function upstreamBodyFields(inspection: UpstreamHttpErrorInspection) {
  const upstreamResponseBodyBytes = Array.from(inspection.bodyBytes)
  return {
    upstreamResponseBody: inspection.bodyText ?? upstreamResponseBodyBytes,
    upstreamResponseBodyBytes,
    ...(inspection.contentType ?
      { upstreamResponseContentType: inspection.contentType }
    : {}),
  }
}

function logHttpError(inspection: HttpErrorInspection): void {
  consola.error(`[${inspection.status}] ${inspection.safeMessage}`)
  if (
    inspection.kind === "upstream"
    && !inspection.suppressResponseBodyDiagnostics
  ) {
    consola.error(upstreamBodyFields(inspection))
  }
  if (inspection.clientError) {
    consola.error("Validation class:", inspection.clientError.fingerprint)
  }
}

function captureHttpError(options: {
  c: Context
  inspection: HttpErrorInspection
}): void {
  const { c, inspection } = options
  Sentry.captureException(new Error(inspection.safeMessage), {
    ...(inspection.clientError ?
      {
        fingerprint: [
          "http-error",
          c.req.path,
          String(inspection.status),
          inspection.clientError.code,
          inspection.clientError.fingerprint,
        ],
      }
    : {}),
    tags: {
      path: c.req.path,
      method: c.req.method,
      status: String(inspection.status),
    },
    extra: {
      status: inspection.status,
      validationClass: inspection.clientError?.fingerprint,
      ...((
        inspection.kind === "upstream"
        && !inspection.suppressResponseBodyDiagnostics
      ) ?
        upstreamBodyFields(inspection)
      : {}),
    },
  })
}

export function reportHttpErrorForTransport(
  inspection: HttpErrorInspection,
  options: { method: string; path: string },
): void {
  logHttpError(inspection)
  Sentry.captureException(new Error(inspection.safeMessage), {
    tags: {
      path: options.path,
      method: options.method,
      status: String(inspection.status),
    },
    extra: {
      status: inspection.status,
      validationClass: inspection.clientError?.fingerprint,
      ...((
        inspection.kind === "upstream"
        && !inspection.suppressResponseBodyDiagnostics
      ) ?
        upstreamBodyFields(inspection)
      : {}),
    },
  })
}

export function reportHttpError(
  c: Context,
  inspection: HttpErrorInspection,
): void {
  logHttpError(inspection)
  captureHttpError({ c, inspection })
}

/** @deprecated Use inspectHttpError. */
export const inspectSafeHttpError = inspectHttpError
/** @deprecated Use reportHttpError. */
export const reportSafeHttpError = reportHttpError
/** @deprecated Use snapshotHttpErrorMetadata. */
export const snapshotSafeHttpError = snapshotHttpErrorMetadata

function httpErrorResponse(c: Context, inspection: HttpErrorInspection) {
  if (inspection.kind === "custom-provider") {
    return c.json(
      {
        error: inspection.providerError ?? {
          message: inspection.safeMessage,
          type: "error",
        },
      },
      inspection.status as ContentfulStatusCode,
    )
  }
  if (inspection.kind === "upstream") {
    return c.body(
      inspection.bodyBytes.slice(),
      inspection.status as ContentfulStatusCode,
      {
        ...inspection.responseHeaders,
        ...(inspection.contentType ?
          { "content-type": inspection.contentType }
        : {}),
      },
    )
  }
  for (const [name, value] of Object.entries(inspection.responseHeaders)) {
    c.header(name, value)
  }
  if (inspection.localClientBody) {
    return c.json(
      inspection.localClientBody,
      inspection.status as ContentfulStatusCode,
    )
  }
  return c.json(
    { error: { message: inspection.safeMessage, type: "error" } },
    inspection.status as ContentfulStatusCode,
  )
}

async function forwardHttpError(c: Context, error: HTTPError) {
  const metadata = snapshotHttpErrorMetadata(error)
  if (metadata.status === 499) {
    consola.debug("Client disconnected (upstream 499)")
    return c.body(null, 499 as ContentfulStatusCode)
  }

  const inspection = await inspectHttpError(error)
  reportHttpError(c, inspection)
  return httpErrorResponse(c, inspection)
}

export async function forwardError(c: Context, error: unknown) {
  if (
    !isProxyObject(error)
    && (error instanceof StorageUnavailableError
      || error instanceof StorageCommitUnknownError
      || error instanceof StorageSchemaError
      || error instanceof StorageConflictError)
  ) {
    c.header("Cache-Control", "no-store")
    const conflict = error instanceof StorageConflictError
    const unknownCommit = error instanceof StorageCommitUnknownError
    let code = "storage_unavailable"
    let message = "Database storage is temporarily unavailable."
    if (conflict) {
      code = "storage_conflict"
      message = "Stored state changed. Reload and try again."
    } else if (unknownCommit) {
      code = "storage_commit_unknown"
      message =
        "The save outcome could not be confirmed. Reload before making further changes."
    }
    return c.json(
      {
        error: {
          code,
          message,
          type: "server_error",
        },
      },
      conflict ? 409 : 503,
    )
  }
  // Client disconnected — nothing to send back, don't log as error
  if (isAbortError(error)) {
    consola.debug("Client disconnected (AbortError)")
    // 499 = client closed request (nginx convention), not in Hono's StatusCode union
    return c.body(null, 499 as ContentfulStatusCode)
  }

  if (isHTTPError(error)) return await forwardHttpError(c, error)

  consola.error("Unexpected internal error")

  Sentry.captureException(new Error("Unexpected internal error"), {
    tags: {
      path: c.req.path,
      method: c.req.method,
    },
  })

  return c.json(
    {
      error: {
        code: "internal_error",
        message: "Internal server error",
        type: "server_error",
      },
    },
    500,
  )
}
