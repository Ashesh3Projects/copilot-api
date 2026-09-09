import consola from "consola"
import { events } from "fetch-event-stream"

import type {
  CustomProviderConfig,
  CustomProviderModelConfig,
} from "~/lib/config"
import type { ReasoningEffort } from "~/lib/model-suffix"
import type { MutationContext } from "~/lib/storage/types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type {
  EmbeddingRequest,
  EmbeddingResponse,
} from "~/services/copilot/create-embeddings"

import { getConfigForTest } from "~/lib/config"
import {
  tapDebugResponse,
  type CapturedBody,
  DebugCaptureError,
} from "~/lib/debug-capture"
import { CustomProviderHTTPError, LocalHTTPError } from "~/lib/error"
import {
  abortLlmDebugLog,
  failLlmDebugLog,
  finishLlmDebugLog,
  getLlmDebugCaptureSignal,
  startLlmDebugLog,
  toLlmDebugLogError,
} from "~/lib/llm-debug-log"
import { recordModelFallbackResponse } from "~/lib/model-fallback"
import {
  getRoutingTelemetryRequestState,
  updateRoutingTelemetryRequestState,
} from "~/lib/request-session"
import {
  recordUpstreamCall,
  type UpstreamOutcome,
} from "~/lib/routing-telemetry"
import { getSettingsActorId } from "~/lib/storage/domain-settings"
import { StorageConflictError } from "~/lib/storage/errors"
import {
  createProviderMutationContext,
  createProvidersRepository,
  type ProviderInput,
  type ProviderSummary,
} from "~/lib/storage/providers-repository"
import {
  getCurrentSnapshot,
  getRequestSnapshot,
} from "~/lib/storage/request-snapshot"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { isAbortLikeError } from "~/services/copilot/transport-retry"

export type CustomProviderModelKind = "chat" | "embedding"

export interface CustomProviderModelReference {
  provider: CustomProviderConfig
  model: CustomProviderModelConfig
  requestedModel: string
  upstreamModel: string
  matchedAlias: boolean
}

export interface CustomProviderModelListing {
  id: string
  object: "model"
  type: CustomProviderModelKind
  kind: CustomProviderModelKind
  created: number
  created_at: string
  owned_by: string
  provider: string
  provider_id: string
  display_name: string
  canonical_id?: string
  alias?: boolean
  aliases?: Array<string>
  dimensions?: number
  supports_streaming?: boolean
}

export interface CustomProviderRequestOptions {
  signal?: AbortSignal
  reasoningEffort?: ReasoningEffort
}

interface ModelListingOptions {
  provider: CustomProviderConfig
  model: CustomProviderModelConfig
  id: string
  alias?: boolean
}

interface CustomProviderFetchRequest {
  reference: CustomProviderModelReference
  path: "/chat/completions" | "/embeddings"
  payload: Record<string, unknown>
  rawBody?: string
  options?: CustomProviderRequestOptions
}

interface CustomProviderErrorContext {
  response: Response
  reference: CustomProviderModelReference
  path: string
  payload: unknown
}

interface RequiredProviderFields {
  id: string
  name: string
  baseUrl: string
  apiKey?: string
  apiKeyEnv?: string
  models: Array<unknown>
}

const OPENAI_COMPATIBLE_TYPE = "openai-compatible"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined

  const headers: Record<string, string> = {}
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") continue
    const normalizedKey = key.trim()
    if (!normalizedKey) continue
    headers[normalizedKey] = headerValue
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function normalizeModel(raw: unknown): CustomProviderModelConfig | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    return undefined
  }
  if (raw.kind !== "chat" && raw.kind !== "embedding") return undefined

  const aliases =
    Array.isArray(raw.aliases) ?
      raw.aliases
        .filter((alias): alias is string => typeof alias === "string")
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0 && alias !== raw.id)
    : undefined

  const dimensions =
    (
      typeof raw.dimensions === "number"
      && Number.isInteger(raw.dimensions)
      && raw.dimensions > 0
    ) ?
      raw.dimensions
    : undefined

  return {
    id: raw.id.trim(),
    kind: raw.kind,
    ...(aliases && aliases.length > 0 ?
      { aliases: [...new Set(aliases)] }
    : {}),
    ...(dimensions ? { dimensions } : {}),
    ...(typeof raw.supportsStreaming === "boolean" ?
      { supportsStreaming: raw.supportsStreaming }
    : {}),
    ...(typeof raw.passReasoningEffort === "boolean" ?
      { passReasoningEffort: raw.passReasoningEffort }
    : {}),
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ?
      value.trim()
    : undefined
}

function getRequiredProviderFields(
  raw: unknown,
): RequiredProviderFields | undefined {
  if (!isRecord(raw)) return undefined
  const { id, name, type, baseUrl, apiKey, apiKeyEnv, models } = raw

  if (type !== OPENAI_COMPATIBLE_TYPE || !Array.isArray(models)) {
    return undefined
  }

  if (
    typeof id !== "string"
    || typeof name !== "string"
    || typeof baseUrl !== "string"
  ) {
    return undefined
  }

  const normalizedApiKey = normalizeOptionalString(apiKey)
  const normalizedApiKeyEnv = normalizeOptionalString(apiKeyEnv)

  const normalized = {
    id: id.trim(),
    name: name.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: normalizedApiKey,
    apiKeyEnv: normalizedApiKeyEnv,
  }
  if (
    normalized.id.length === 0
    || normalized.name.length === 0
    || normalized.baseUrl.length === 0
  ) {
    return undefined
  }

  return { ...normalized, models }
}

function normalizeProvider(raw: unknown): CustomProviderConfig | undefined {
  const fields = getRequiredProviderFields(raw)
  if (!fields) return undefined

  const models = fields.models.flatMap((model) => {
    const normalized = normalizeModel(model)
    return normalized ? [normalized] : []
  })
  if (models.length === 0) return undefined

  const rawRecord = raw as Record<string, unknown>
  const headers = normalizeHeaders(rawRecord.headers)

  return {
    id: fields.id,
    name: fields.name,
    type: OPENAI_COMPATIBLE_TYPE,
    baseUrl: fields.baseUrl.replace(/\/+$/, ""),
    ...(fields.apiKey ? { apiKey: fields.apiKey } : {}),
    ...(fields.apiKeyEnv ? { apiKeyEnv: fields.apiKeyEnv } : {}),
    ...(headers ? { headers } : {}),
    models,
    ...(typeof rawRecord.passReasoningEffort === "boolean" ?
      { passReasoningEffort: rawRecord.passReasoningEffort }
    : {}),
  }
}

export function normalizeCustomProviders(
  providers: unknown,
): Array<CustomProviderConfig> {
  if (!Array.isArray(providers)) return []
  return providers.flatMap((provider) => {
    const normalized = normalizeProvider(provider)
    return normalized ? [normalized] : []
  })
}

export function getCustomProviders(): Array<CustomProviderConfig> {
  const test = getConfigForTest()
  if (test) return normalizeCustomProviders(test.customProviders)
  return (
    getCurrentSnapshot(getStorageRuntime().snapshot).providers?.providers ?? []
  )
}

export function getGroqApiKey(): string | undefined {
  const test = getConfigForTest()
  if (test) return test.groqApiKey
  return getCurrentSnapshot(getStorageRuntime().snapshot).providers?.groqApiKey
}

export function getCustomProviderModels(): Array<CustomProviderModelListing> {
  return getCustomProviders().flatMap((provider) =>
    provider.models.flatMap((model) => [
      toModelListing({ provider, model, id: model.id }),
      ...(model.aliases ?? []).map((alias) =>
        toModelListing({ provider, model, id: alias, alias: true }),
      ),
    ]),
  )
}

function toModelListing(
  options: ModelListingOptions,
): CustomProviderModelListing {
  const { provider, model, id, alias = false } = options
  return {
    id,
    object: "model",
    type: model.kind,
    kind: model.kind,
    created: 0,
    created_at: new Date(0).toISOString(),
    owned_by: provider.name,
    provider: provider.name,
    provider_id: provider.id,
    display_name: alias ? `${id} (${model.id})` : model.id,
    ...(alias ? { alias: true, canonical_id: model.id } : {}),
    ...(model.aliases && model.aliases.length > 0 && !alias ?
      { aliases: model.aliases }
    : {}),
    ...(model.dimensions ? { dimensions: model.dimensions } : {}),
    ...(model.supportsStreaming !== undefined ?
      { supports_streaming: model.supportsStreaming }
    : {}),
  }
}

function findModelReference(options: {
  model: string
  kind?: CustomProviderModelKind
  exactOnly?: boolean
}): CustomProviderModelReference | undefined {
  for (const provider of getCustomProviders()) {
    for (const model of provider.models) {
      if (options.kind && model.kind !== options.kind) continue
      if (model.id === options.model) {
        return {
          provider,
          model,
          requestedModel: options.model,
          upstreamModel: model.id,
          matchedAlias: false,
        }
      }
    }
  }

  if (options.exactOnly) return undefined

  for (const provider of getCustomProviders()) {
    for (const model of provider.models) {
      if (options.kind && model.kind !== options.kind) continue
      if (!model.aliases?.includes(options.model)) continue
      return {
        provider,
        model,
        requestedModel: options.model,
        upstreamModel: model.id,
        matchedAlias: true,
      }
    }
  }

  return undefined
}

export function resolveCustomProviderModel(options: {
  model: string
  kind?: CustomProviderModelKind
  copilotModelIds?: Set<string>
}): CustomProviderModelReference | undefined {
  const aliasMatch = findModelReference({
    model: options.model,
    kind: options.kind,
  })
  if (aliasMatch?.matchedAlias) return aliasMatch

  if (options.copilotModelIds?.has(options.model)) return undefined

  return findModelReference({
    model: options.model,
    kind: options.kind,
    exactOnly: true,
  })
}

export function resolveCustomProviderAlias(options: {
  model: string
  kind?: CustomProviderModelKind
}): CustomProviderModelReference | undefined {
  const match = findModelReference({ model: options.model, kind: options.kind })
  return match?.matchedAlias ? match : undefined
}

function shouldPassReasoningEffort(
  reference: CustomProviderModelReference,
): boolean {
  return (
    reference.model.passReasoningEffort
    ?? reference.provider.passReasoningEffort
    ?? false
  )
}

function getProviderApiKey(provider: CustomProviderConfig): string {
  const apiKey = provider.apiKey?.trim()
  if (!apiKey) {
    const clientBody = {
      error: {
        message: `Missing API key for custom provider ${provider.name}. Configure its stored API key.`,
        type: "configuration_error",
        provider: provider.id,
      },
    }
    throw new LocalHTTPError(
      "Custom provider API key is not configured",
      Response.json(clientBody, { status: 500 }),
      clientBody,
    )
  }
  return apiKey
}

function buildHeaders(provider: CustomProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...provider.headers,
    Authorization: `Bearer ${getProviderApiKey(provider)}`,
  }
  return headers
}

function providerUrl(
  provider: CustomProviderConfig,
  path: "/chat/completions" | "/embeddings",
): string {
  return `${provider.baseUrl}${path}`
}

function customProviderOutcome(response: Response): UpstreamOutcome {
  if (response.status >= 500) return "server_error"
  if (response.status >= 400) return "client_error"
  return "success"
}

function recordCustomProviderCall(options: {
  outcome: UpstreamOutcome
  path: string
  reference: CustomProviderModelReference
}): void {
  const { outcome, path, reference } = options
  const requestState = getRoutingTelemetryRequestState()
  updateRoutingTelemetryRequestState({
    destination: reference.provider.name,
    model: reference.upstreamModel,
    provider: reference.provider.name,
  })
  recordUpstreamCall({
    model: reference.upstreamModel,
    outcome,
    provider: reference.provider.name,
    reason: "initial",
    route:
      requestState ?
        `${requestState.sourceProtocol} -> ${reference.provider.name}`
      : `${path} -> ${reference.provider.name}`,
  })
}

async function fetchCustomProvider(
  request: CustomProviderFetchRequest,
): Promise<Response> {
  const { reference, path, payload, options } = request
  const url = providerUrl(reference.provider, path)
  const headers = buildHeaders(reference.provider)
  const body = request.rawBody ?? JSON.stringify(payload)
  consola.info(
    `Custom provider request: ${reference.provider.name}/${reference.provider.id}/${reference.upstreamModel} POST ${path}`,
  )
  const logId = startLlmDebugLog({
    upstream: { kind: "custom", providerId: reference.provider.id },
    method: "POST",
    path,
    requestBody: body,
    requestHeaders: headers,
    url,
  })
  try {
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: options?.signal,
    })
    const captureSignal = getLlmDebugCaptureSignal(logId)
    const tapped = tapDebugResponse(
      upstreamResponse,
      options?.signal ?
        AbortSignal.any([options.signal, captureSignal])
      : captureSignal,
    )
    const response = tapped.response
    if (path === "/chat/completions") recordModelFallbackResponse(response)
    void captureCustomProviderDebugResponse(logId, response, tapped.capture)
    recordCustomProviderCall({
      outcome: customProviderOutcome(response),
      path,
      reference,
    })
    return response
  } catch (error) {
    if (isAbortLikeError(error)) {
      abortLlmDebugLog(logId, { error })
    } else {
      failLlmDebugLog(logId, error)
    }
    recordCustomProviderCall({
      outcome: isAbortLikeError(error) ? "aborted" : "transport_error",
      path,
      reference,
    })
    throw error
  }
}

async function captureCustomProviderDebugResponse(
  logId: string,
  response: Response,
  captured: Promise<CapturedBody>,
): Promise<void> {
  const headers = Object.fromEntries(response.headers.entries())
  try {
    const body = await captured
    finishLlmDebugLog(logId, {
      ...body,
      headers,
      status: response.status,
      statusText: response.statusText,
    })
  } catch (error) {
    const debugResponse = {
      body: null,
      bodyBytes: 0,
      bodyBytesComplete: false,
      omittedReason: "read-error" as const,
      ...(error instanceof DebugCaptureError ? error.capture : {}),
      bodyReadError: toLlmDebugLogError(
        error instanceof DebugCaptureError ? error.cause : error,
      ),
      headers,
      status: response.status,
      statusText: response.statusText,
    }
    const cause = error instanceof DebugCaptureError ? error.cause : error
    if (isAbortLikeError(cause) || isAbortLikeError(error)) {
      abortLlmDebugLog(logId, { error: cause, response: debugResponse })
      return
    }
    finishLlmDebugLog(logId, debugResponse)
  }
}

function createUpstreamErrorMessage(
  reference: CustomProviderModelReference,
  path: string,
): string {
  return `Custom provider ${reference.provider.name} failed ${path} for model ${reference.upstreamModel}`
}

async function throwCustomProviderError(
  context: CustomProviderErrorContext,
): Promise<never> {
  const { response, reference, path, payload } = context
  const body = await response.clone().text()
  consola.error(
    createUpstreamErrorMessage(reference, path),
    `Status: ${response.status}`,
  )
  throw new CustomProviderHTTPError(
    createUpstreamErrorMessage(reference, path),
    response,
    {
      requestPayload: payload,
      responseBody: body,
    },
  )
}

function buildChatPayload(
  reference: CustomProviderModelReference,
  payload: ChatCompletionsPayload,
  options?: CustomProviderRequestOptions,
): Record<string, unknown> {
  const outgoing: Record<string, unknown> = {
    ...(payload as unknown as Record<string, unknown>),
    model: reference.upstreamModel,
  }

  if (options?.reasoningEffort && shouldPassReasoningEffort(reference)) {
    outgoing.reasoning_effort = options.reasoningEffort
  } else if (!shouldPassReasoningEffort(reference)) {
    delete outgoing.reasoning_effort
  }

  if (outgoing.stream && !outgoing.stream_options) {
    outgoing.stream_options = { include_usage: true }
  }

  return outgoing
}

export async function createCustomProviderChatCompletions(
  reference: CustomProviderModelReference,
  payload: ChatCompletionsPayload,
  options?: CustomProviderRequestOptions,
) {
  const outgoing = buildChatPayload(reference, payload, options)
  const response = await fetchCustomProvider({
    reference,
    path: "/chat/completions",
    payload: outgoing,
    options,
  })

  if (!response.ok) {
    await throwCustomProviderError({
      response,
      reference,
      path: "/chat/completions",
      payload: redactProviderRequestPayload(outgoing),
    })
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

function validateEmbeddingResponse(
  response: EmbeddingResponse,
  reference: CustomProviderModelReference,
  requestedDimensions?: number,
): void {
  const expectedDimensions = requestedDimensions ?? reference.model.dimensions
  if (!expectedDimensions) return

  for (const item of response.data) {
    const dimensions =
      typeof item.embedding === "string" ?
        Buffer.from(item.embedding, "base64").byteLength
        / Float32Array.BYTES_PER_ELEMENT
      : item.embedding.length
    if (dimensions !== expectedDimensions) {
      const clientBody = {
        error: {
          message: `Embedding dimension mismatch for ${reference.upstreamModel}: expected ${expectedDimensions}, got ${dimensions}`,
          type: "upstream_response_error",
          provider: reference.provider.id,
          model: reference.upstreamModel,
        },
      }
      throw new LocalHTTPError(
        "Custom provider returned an invalid embedding dimension",
        Response.json(clientBody, { status: 502 }),
        clientBody,
      )
    }
  }
}

function normalizeEmbeddingIndexes(
  response: EmbeddingResponse,
): EmbeddingResponse {
  return {
    ...response,
    data: [...response.data].sort((a, b) => a.index - b.index),
  }
}

export async function createCustomProviderEmbeddings(
  reference: CustomProviderModelReference,
  payload: EmbeddingRequest,
  options?: CustomProviderRequestOptions,
): Promise<EmbeddingResponse> {
  const outgoing = {
    ...(payload as unknown as Record<string, unknown>),
    model: reference.upstreamModel,
  }
  const response = await fetchCustomProvider({
    reference,
    path: "/embeddings",
    payload: outgoing,
    options,
  })

  if (!response.ok) {
    await throwCustomProviderError({
      response,
      reference,
      path: "/embeddings",
      payload: redactProviderRequestPayload(outgoing),
    })
  }

  const body = normalizeEmbeddingIndexes(
    (await response.json()) as EmbeddingResponse,
  )
  validateEmbeddingResponse(body, reference, payload.dimensions)
  return body
}

/** Replay only a still-configured provider destination using its current credentials. */
export async function replayCustomProviderRequest(options: {
  providerId: string
  originalUrl: string
  payload: Record<string, unknown>
  rawBody?: string
  signal?: AbortSignal
}): Promise<Response> {
  const provider = getCustomProviders().find(
    (entry) => entry.id === options.providerId,
  )
  const model = provider?.models.find(
    (entry) => entry.kind === "chat" && entry.id === options.payload.model,
  )
  if (
    !provider
    || !model
    || providerUrl(provider, "/chat/completions") !== options.originalUrl
  ) {
    const clientBody = {
      error: {
        code: "replay_provider_unavailable",
        type: "configuration_error",
        message:
          "The original provider destination or model is no longer configured.",
      },
    }
    throw new LocalHTTPError(
      clientBody.error.message,
      Response.json(clientBody, { status: 409 }),
      clientBody,
    )
  }
  return await fetchCustomProvider({
    reference: {
      provider,
      model,
      requestedModel: model.id,
      upstreamModel: model.id,
      matchedAlias: false,
    },
    path: "/chat/completions",
    payload: options.payload,
    rawBody: options.rawBody,
    options: { signal: options.signal },
  })
}

function redactProviderRequestPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = { ...payload }
  delete redacted.api_key
  return redacted
}

export type DashboardCustomProvider = ProviderSummary

export async function listCustomProvidersForDashboard(): Promise<
  Array<DashboardCustomProvider>
> {
  return createProvidersRepository(getStorageRuntime().storage).list()
}

export function listCustomProviderPageForDashboard() {
  return createProvidersRepository(getStorageRuntime().storage).listPage()
}
export async function upsertCustomProvider(
  provider: ProviderInput,
  context?: MutationContext,
): Promise<Array<CustomProviderConfig>> {
  const runtime = getStorageRuntime()
  const detached = structuredClone(provider)
  const mutation =
    context ?? (await providerMutation("provider.upsert", detached))
  await createProvidersRepository(runtime.storage).upsert(detached, mutation)
  await runtime.snapshot.refreshIfChanged()
  return runtime.snapshot.get().providers?.providers ?? []
}

export async function removeCustomProvider(
  providerId: string,
  context?: MutationContext,
): Promise<boolean> {
  const runtime = getStorageRuntime()
  const mutation =
    context ?? (await providerMutation("provider.remove", { id: providerId }))
  const result = await createProvidersRepository(runtime.storage).remove(
    providerId,
    mutation,
  )
  await runtime.snapshot.refreshIfChanged()
  return result.value.removed
}

async function providerMutation(
  kind: string,
  input: unknown,
): Promise<MutationContext> {
  const actor =
    getSettingsActorId()
    ?? (getRequestSnapshot() ? undefined : "system:startup-cli")
  if (!actor)
    throw new StorageConflictError("A verified settings actor is required")
  return createProviderMutationContext(
    getStorageRuntime().storage,
    kind,
    input,
    actor,
  )
}

export function createNebiusQwen3EmbeddingProvider(
  apiKey?: string,
): CustomProviderConfig {
  return {
    id: "nebius",
    name: "Nebius",
    type: OPENAI_COMPATIBLE_TYPE,
    baseUrl: "https://api.studio.nebius.com/v1",
    ...(apiKey ? { apiKey } : {}),
    headers: {},
    models: [
      {
        id: "Qwen/Qwen3-Embedding-8B",
        aliases: ["qwen3-embedding-8b"],
        kind: "embedding",
        dimensions: 4096,
      },
    ],
  }
}
