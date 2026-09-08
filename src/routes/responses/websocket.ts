/* eslint-disable max-lines */
import consola from "consola"
import { randomUUID } from "node:crypto"

import type { CopilotInferenceEndpoint } from "~/lib/endpoint-routing"
import type { HttpErrorInspection } from "~/lib/error"
import type { RoutingAffinity } from "~/lib/routing-affinity"
import type { NativeMessagesRequestOptions } from "~/routes/messages/native-handler"
import type { Model } from "~/services/copilot/get-models"

import { withAccountLeaseScope } from "~/lib/account-lease-context"
import {
  runWithRoutedModelSelection,
  selectRoutedModel,
} from "~/lib/account-router"
import {
  recordCopilotEndpointRoute,
  recordCopilotContractEvent,
  recordCopilotMessagesBeta,
  recordCopilotRequestNormalization,
  recordCopilotTranslationFindings,
} from "~/lib/copilot-contract-observability"
import { resolveRequestCredential } from "~/lib/credential-resolver"
import {
  createCustomProviderChatCompletions,
  resolveCustomProviderModel,
  type CustomProviderModelReference,
} from "~/lib/custom-providers"
import {
  createEndpointTranslationError,
  isHTTPError,
  reportHttpErrorForTransport,
} from "~/lib/error"
import {
  applyModelFallbackToPayload,
  createModelFallbackCredentialScope,
  isModelFallbackActive,
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
  getModelReasoningConfig,
  normalizeReasoningEffortForModel,
  parseReasoningEffort,
  parseModelSuffix,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import { resolveProtectedCredential } from "~/lib/protected-credential"
import { parseRecoverableStreamJson } from "~/lib/recoverable-stream-json"
import { reportNonDefaultBehavior } from "~/lib/request-logger"
import { getCopilotResponseHeaders } from "~/lib/request-session"
import {
  resolveResponsesForkRoutingAffinity,
  resolveResponsesRoutingAffinity,
  resolveRoutingAffinityFromHeaders,
} from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { admitWebSocketTurn } from "~/lib/storage/websocket-admission"
import { isResponsesCompactionRequest } from "~/services/copilot/compaction-payload"
import {
  createChatCompletions,
  createChatCompletionsWithProcessedPayload,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  type ResponsesResult,
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"
import { sanitizeAnthropicRequestHeaderOptions } from "~/services/copilot/messages-contract"
import {
  finalizeNativeResponsesRequest,
  prepareResponsesRequest,
} from "~/services/copilot/responses-contract"

import {
  resolvePreparedResponsesWebSearchCalls,
  type ResponsesChatCompletionFactory,
} from "./chat-fallback-completion"
import {
  prepareResponsesCandidates,
  type ResponsesEndpointCandidate,
  selectResponsesCandidate,
} from "./fallback-candidates"
import {
  disableParallelWebSearch,
  normalizeResponsesReasoning,
  rewriteResponseModelInEvent,
  streamChatCompletionsAsResponses,
} from "./handler"
import { executePreparedResponsesMessagesBridge } from "./messages-bridge"
import {
  adaptResponsesToChatCandidate,
  getResponsesChatWebSearchMaxUses,
} from "./responses-chat-adapter"
import { applyResponsesServiceTierRouting } from "./service-tier"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  emitResponsesFailureAsStream,
  updateResponsesFailureState,
} from "./stream-lifecycle"
import {
  expandCompactionItems,
  getResponsesRequestOptions,
  getResponsesVerbosity,
} from "./utils"
import {
  classifyWebSocketTerminal,
  createResponsesWebSocketTurn,
  ensureResponsesWebSocketLifecycle,
  finalizeResponsesWebSocketTurn,
  type ResponsesWebSocketTurn,
  runWithWebSocketRequestContext,
  throwIfWebSocketTurnAborted,
  WebSocketRequestError,
} from "./websocket-lifecycle"
import {
  addResponsesWebSocketMetadata,
  classifyEmittedWebSocketTerminal,
  mergeEffectiveNativeMessagesOptions,
  mergeFallbackIdentityHeaders,
  mergeContinuationInput,
  parseResponsesWebSocketFrame,
  rehydrateContinuationPayloadFromSnapshot,
  resolveResponsesContinuation,
} from "./websocket-protocol"

const WS_PATHS = new Set(["/v1/responses", "/responses"])

export interface ResponsesWebSocketData {
  authenticationRequest?: Request
  activeTurns: Map<number, ResponsesWebSocketTurn>
  closed: boolean
  nextTurnSequence: number
  type: "responses"
  requestId: string
  affinity?: RoutingAffinity
  nativeMessagesOptions: NativeMessagesRequestOptions
  effectiveNativeMessagesOptions: NativeMessagesRequestOptions
  responseSnapshots: Map<string, ResponsesPayload>
  fallbackHeaders?: Headers
  fallbackCredentialScope?: string
}

export interface ResponsesWebSocketState {
  data: ResponsesWebSocketData
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface WebSocketErrorFrameOptions {
  code: string
  message: string
  status: number
  param?: string
  requestId?: string
  type?: string
  upstreamBody?: string | ReadonlyArray<number>
  upstreamContentType?: string
}

interface ResponsesWebSocketDependencies {
  readonly webSearch?: (query: string, signal?: AbortSignal) => Promise<string>
}

let responsesWebSocketDependencies: ResponsesWebSocketDependencies = {}

export function setResponsesWebSocketDependenciesForTest(
  dependencies: ResponsesWebSocketDependencies,
): () => void {
  const previous = responsesWebSocketDependencies
  responsesWebSocketDependencies = dependencies
  return () => {
    responsesWebSocketDependencies = previous
  }
}

interface ResponseCompletedFrame {
  response?: {
    id?: unknown
    incomplete_details?: unknown
    output?: unknown
    status?: unknown
  }
  type?: string
}

/**
 * Check if a request is a responses WebSocket upgrade and handle it.
 * Returns "upgraded" if the upgrade was handled, "auth_failed" if auth failed,
 * or "no_match" if the path didn't match.
 */
export async function tryUpgradeResponsesWebSocket(
  req: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): Promise<"upgraded" | "auth_failed" | "no_match"> {
  const url = new URL(req.url)
  if (!WS_PATHS.has(url.pathname)) {
    return "no_match"
  }

  const auth = await resolveProtectedCredential(
    req,
    async () => await resolveRequestCredential(req, ["user:inference"]),
    { trustClientIp: true },
  )
  if (auth.status !== "authorized") return "auth_failed"

  const requestId =
    req.headers.get("x-request-id")
    ?? req.headers.get("x-client-request-id")
    ?? randomUUID()
  const affinity = resolveRoutingAffinityFromHeaders(req.headers)
  const nativeMessagesOptions = sanitizeAnthropicRequestHeaderOptions({
    anthropicBeta: req.headers.get("anthropic-beta"),
    anthropicVersion: req.headers.get("anthropic-version"),
    modelProviderPreference: req.headers.get("x-model-provider-preference"),
  })

  const data: ResponsesWebSocketData = {
    authenticationRequest: new Request(req.url, { headers: req.headers }),
    type: "responses",
    activeTurns: new Map<number, ResponsesWebSocketTurn>(),
    closed: false,
    nextTurnSequence: 0,
    requestId,
    affinity,
    nativeMessagesOptions,
    effectiveNativeMessagesOptions: { ...nativeMessagesOptions },
    responseSnapshots: new Map<string, ResponsesPayload>(),
    fallbackHeaders: mergeFallbackIdentityHeaders(req.headers),
    fallbackCredentialScope: createModelFallbackCredentialScope(req.headers),
  }
  if (!server.upgrade(req, { data })) return "no_match"
  return "upgraded"
}

// Bun WebSocket handler for responses
export const responsesWebSocket = {
  open(_ws: { data: ResponsesWebSocketData }) {
    consola.debug("[responses-ws] WebSocket connected")
  },

  // Protocol validation and turn lifecycle intentionally share one dispatcher.

  // The dispatcher is intentionally linear so every preflight/stream branch
  // shares one turn owner and one terminal guard.

  async message(
    ws: ResponsesWebSocketState,
    message: string | Buffer | Uint8Array,
  ) {
    if (ws.data.authenticationRequest) {
      const admission = await admitWebSocketTurn(ws.data.authenticationRequest)
      if (admission.status !== "authorized") {
        sendWebSocketError(ws, {
          code:
            admission.status === "unauthorized" ?
              "authentication_error"
            : "storage_unavailable",
          message:
            admission.status === "unauthorized" ?
              "Authentication failed"
            : "Database storage is temporarily unavailable.",
          status: admission.status === "unauthorized" ? 401 : 503,
        })
        return
      }
      await withRequestSnapshot(admission.snapshot, () =>
        handleResponsesWebSocketMessage(ws, message),
      )
      return
    }
    // Explicit test sockets may inject routing without a network upgrade.
    await handleResponsesWebSocketMessage(ws, message)
  },

  close(ws: { data: ResponsesWebSocketData }) {
    closeResponsesWebSocket(ws)
  },
}

async function handleResponsesWebSocketMessage(
  ws: ResponsesWebSocketState,
  message: string | Buffer | Uint8Array,
) {
  if (ws.data.closed) return

  const parsed = parseResponsesWebSocketFrame(message)
  if (!parsed.ok) {
    sendWebSocketError(ws, parsed.error)
    return
  }
  if (typeof message !== "string") return

  const {
    attribution,
    initiator,
    nativeMessagesOptions,
    payload: parsedPayload,
    requestHeaders,
    requestedModel,
  } = parsed.value
  parsedPayload.stream = true
  ws.data.effectiveNativeMessagesOptions = mergeEffectiveNativeMessagesOptions(
    ws.data.effectiveNativeMessagesOptions,
    nativeMessagesOptions,
  )
  const turnNativeMessagesOptions = {
    ...ws.data.effectiveNativeMessagesOptions,
  }
  const turn = createResponsesWebSocketTurn(ws.data, message)
  turn.requestedModel = requestedModel
  turn.model = requestedModel
  ensureResponsesWebSocketLifecycle(turn, {
    model: requestedModel ?? "unknown",
    requestedModel,
  })

  try {
    const { affinity, payload } = await prepareResponseCreate(
      ws.data,
      parsedPayload,
    )
    await runWithWebSocketRequestContext(affinity, attribution, turn, () =>
      withAccountLeaseScope(turn.abortController.signal, async () => {
        await runWithModelFallback(
          {
            headers: mergeFallbackIdentityHeaders(
              ws.data.fallbackHeaders,
              requestHeaders,
            ),
            credentialScope: ws.data.fallbackCredentialScope,
            payload,
            signal: turn.abortController.signal,
            canRetry: () =>
              !turn.outputStarted && turn.terminal.state === "open",
          },
          async () => {
            await handleResponseCreate(ws, {
              initiator,
              payload: structuredClone(payload),
              requestedModel,
              nativeMessagesOptions: turnNativeMessagesOptions,
              turn,
            })
          },
        )
      }),
    )
    if (turn.terminal.state === "open") {
      await failWebSocketTurn(ws, turn, { kind: "source_ended" })
    }
  } catch (error) {
    await handleResponsesWebSocketError(ws, turn, error)
  }
}

async function handleResponsesWebSocketError(
  ws: ResponsesWebSocketState,
  turn: ResponsesWebSocketTurn,
  error: unknown,
) {
  const terminal = await classifyWebSocketTerminal(error, turn)
  const errorInspection = terminal.errorInspection
  if (
    terminal.terminalStatus !== "ABORTED"
    && turn.outputStarted
    && turn.terminal.state === "open"
  ) {
    await failWebSocketTurn(ws, turn, {
      kind: "thrown",
      error,
      ...(errorInspection ? { inspection: errorInspection } : {}),
    })
    if (errorInspection?.kind === "upstream") {
      reportHttpErrorForTransport(errorInspection, {
        method: "POST",
        path: "/responses",
      })
    }
    return
  }
  const normalized = normalizeWebSocketError(error, errorInspection)
  const committed = await turn.terminal.fail({
    kind: "thrown",
    error,
    ...(errorInspection ? { inspection: errorInspection } : {}),
  })
  if (terminal.terminalStatus === "ABORTED") {
    consola.debug(`[responses-ws] ${turn.turnId} aborted`)
    return
  }
  if (!committed) return
  if (errorInspection?.kind === "upstream") {
    reportHttpErrorForTransport(errorInspection, {
      method: "POST",
      path: "/responses",
    })
  }
  consola.error(`[responses-ws] ${turn.turnId} error`, {
    code: normalized.code,
    status: terminal.status,
  })
  try {
    sendWebSocketError(ws, normalized)
  } catch {
    // Client already disconnected, nothing to do
  }
}

function closeResponsesWebSocket(ws: { data: ResponsesWebSocketData }) {
  ws.data.closed = true
  for (const turn of ws.data.activeTurns.values()) {
    const abortError = new Error("Responses WebSocket closed")
    abortError.name = "AbortError"
    turn.abortController.abort(abortError)
    if (!turn.terminal.abort()) continue
    ensureResponsesWebSocketLifecycle(turn)
    finalizeResponsesWebSocketTurn(ws.data, turn, {
      error: abortError,
      status: 499,
      terminalStatus: "ABORTED",
    })
  }
  ws.data.responseSnapshots.clear()
  ws.data.effectiveNativeMessagesOptions = {}
  ws.data.fallbackHeaders = undefined
  ws.data.authenticationRequest = undefined
  consola.debug("[responses-ws] WebSocket closed")
}

async function prepareResponseCreate(
  data: ResponsesWebSocketData,
  rawPayload: ResponsesPayload,
): Promise<{
  affinity: RoutingAffinity | undefined
  payload: ResponsesPayload
}> {
  const previousResponseId = rawPayload.previous_response_id
  const payloadForResolution =
    (
      typeof previousResponseId === "string"
      && typeof rawPayload.model === "string"
    ) ?
      {
        ...rawPayload,
        model: await normalizeRequestedWebSocketModel(rawPayload),
      }
    : rawPayload
  const resolution = resolveResponsesContinuation(
    data.responseSnapshots,
    payloadForResolution,
  )
  if (!resolution.ok) {
    if (resolution.code === "previous_response_not_found") {
      recordCopilotContractEvent({
        kind: "websocket_continuation",
        outcome: "not_found",
      })
    }
    throw new WebSocketRequestError(
      resolution.message,
      resolution.status,
      "invalid_request_error",
      resolution.code,
    )
  }
  recordCopilotContractEvent({
    kind: "websocket_continuation",
    outcome:
      rawPayload.previous_response_id === undefined ?
        "new_thread"
      : "rehydrated",
  })
  const payload = resolution.payload
  const forkAffinity = resolveResponsesForkRoutingAffinity(
    payload.client_metadata,
    data.affinity,
  )
  if (forkAffinity) data.affinity = forkAffinity
  const frameAffinity = resolveResponsesRoutingAffinity(payload.client_metadata)
  return { affinity: forkAffinity ?? data.affinity ?? frameAffinity, payload }
}

function storeResponseSnapshot(
  snapshots: Map<string, ResponsesPayload>,
  responseId: string,
  payload: ResponsesPayload,
): void {
  snapshots.set(responseId, payload)
}

// Routing preparation and dispatch remain together to preserve the per-turn
// request context through native and translated writers.
// eslint-disable-next-line max-lines-per-function
async function handleResponseCreate(
  ws: ResponsesWebSocketState,
  options: {
    initiator?: "agent" | "user"
    nativeMessagesOptions: NativeMessagesRequestOptions
    payload: ResponsesPayload
    requestedModel: string | undefined
    turn: ResponsesWebSocketTurn
  },
): Promise<void> {
  const {
    initiator: initiatorOverride,
    payload,
    requestedModel,
    nativeMessagesOptions,
    turn,
  } = options
  turn.requestedModel = requestedModel
  turn.model = requestedModel

  const routing = await waitForWebSocketTurn(
    applyResponsesWebSocketRouting(payload),
    turn,
  )
  // Each turn owns its snapshot model, including retries of that same turn.
  // eslint-disable-next-line require-atomic-updates
  turn.continuationModel = payload.model
  applyModelFallbackToPayload(payload)
  if (!turn.requestedModel && payload.model !== turn.continuationModel) {
    turn.requestedModel = turn.continuationModel
  }
  const reasoningEffort =
    payload.model === turn.continuationModel ?
      routing.reasoningEffort
    : normalizeReasoningEffortForModel(payload.model, routing.reasoningEffort)
  if (payload.model !== turn.continuationModel) {
    applyRedirectedResponsesEffort(payload, payload.model, reasoningEffort)
  }
  throwIfWebSocketTurnAborted(turn)
  turn.model = payload.model
  turn.reasoningEffort = reasoningEffort
  ensureResponsesWebSocketLifecycle(turn, {
    model: payload.model,
    reasoningEffort,
    requestedModel,
  })

  expandCompactionItems(payload)
  disableParallelWebSearch(payload)
  throwIfWebSocketTurnAborted(turn)

  const customReference =
    isModelFallbackActive() ?
      resolveCustomProviderModel({
        model: payload.model,
        kind: "chat",
        copilotModelIds: new Set(
          state.models?.data.map((model) => model.id) ?? [],
        ),
      })
    : undefined
  if (customReference) {
    await streamCustomFallbackOverWs({
      ws,
      payload,
      turn,
      reference: customReference,
    })
    return
  }

  const routedModel = selectRoutedModel(payload.model)
  const selectedModel = routedModel.model
  const selectedCandidate = await waitForWebSocketTurn(
    prepareResponsesWebSocketCandidate({
      payload,
      reasoningEffort,
      responsesVerbosity: routing.responsesVerbosity,
      selectedModel,
      signal: turn.abortController.signal,
    }),
    turn,
  )
  const candidate = selectedCandidate.candidate
  if (selectedCandidate.endpoint === "/v1/messages") {
    recordCopilotMessagesBeta(nativeMessagesOptions.anthropicBeta)
  }

  if (isSyntheticWarmupRequest(payload)) {
    await handleSyntheticWarmupRequest(ws, payload, turn)
    return
  }

  const { vision, initiator: inferredInitiator } =
    getResponsesRequestOptions(payload)
  const initiator = initiatorOverride ?? inferredInitiator

  await runWithRoutedModelSelection(routedModel, async () => {
    if (
      await dispatchTranslatedWebSocketEndpoint({
        initiator,
        nativeMessagesOptions,
        candidate,
        responseContext: payload,
        requestedModel,
        turn,
        ws,
      })
    ) {
      return
    }

    if (candidate.endpoint !== "/responses") {
      throw new TypeError("Expected a native Responses WebSocket candidate")
    }

    await waitForWebSocketTurn(candidate.prepareForDispatch(), turn)

    // Native responses streaming
    const response = await waitForWebSocketTurn(
      createResponses(candidate.payload, {
        allowCompatibilityRetry: false,
        vision,
        initiator,
        prepared: true,
        signal: turn.abortController.signal,
      }),
      turn,
    )
    throwIfWebSocketTurnAborted(turn)

    if (!isAsyncIterable(response)) {
      // Shouldn't happen since we forced stream: true, but handle gracefully
      await handleNonStreamingResponsesResult(ws, {
        payload: candidate.payload,
        response,
        turn,
      })
      return
    }

    const idTracker = createStreamIdTracker()
    for await (const chunk of response) {
      const data = (chunk as { data?: string }).data
      if (!data) continue

      const event = (chunk as { event?: string }).event
      const synchronized = fixStreamIds(data, event, idTracker)
      if (synchronized === undefined) continue
      const processed = addResponsesWebSocketMetadata(
        synchronized,
        getCopilotResponseHeaders(),
      )
      await emitTurnFrame(ws, turn, candidate.payload, processed, event)
      if (turn.terminal.state !== "open") break
    }
  })
}

async function handleNonStreamingResponsesResult(
  ws: ResponsesWebSocketState,
  options: {
    payload: ResponsesPayload
    response: ResponsesResult
    turn: ResponsesWebSocketTurn
  },
): Promise<void> {
  const { payload, response, turn } = options
  await emitTurnFrame(
    ws,
    turn,
    payload,
    JSON.stringify({ type: "response.completed", response }),
    "response.completed",
  )
}

async function dispatchTranslatedWebSocketEndpoint(options: {
  candidate: ResponsesEndpointCandidate
  initiator: "agent" | "user"
  nativeMessagesOptions: NativeMessagesRequestOptions
  responseContext: ResponsesPayload
  requestedModel: string | undefined
  turn: ResponsesWebSocketTurn
  ws: ResponsesWebSocketState
}): Promise<boolean> {
  const {
    candidate,
    initiator,
    nativeMessagesOptions,
    responseContext,
    requestedModel,
    turn,
    ws,
  } = options
  if (candidate.endpoint === "/v1/messages") {
    reportResponsesWebSocketEndpointFallback(
      candidate.payload.model,
      "AnthropicMessages",
    )
    await streamAnthropicMessagesOverWs({
      nativeOptions: {
        ...nativeMessagesOptions,
        allowCompatibilityRetry: false,
        initiatorOverride: initiator,
        requestedModel,
      },
      payload: candidate.payload,
      responseContext,
      turn,
      ws,
    })
    return true
  }

  if (candidate.endpoint !== "/chat/completions") return false
  reportResponsesWebSocketEndpointFallback(
    candidate.payload.model,
    "ChatCompletions",
  )
  await streamChatCompletionsOverWs({
    initiator,
    payload: candidate.payload,
    responseContext,
    turn,
    ws,
  })
  return true
}

async function prepareResponsesWebSocketCandidate(options: {
  payload: ResponsesPayload
  reasoningEffort: ReasoningEffort | undefined
  responsesVerbosity?: ModelRedirectVerbosity
  selectedModel: Model | undefined
  signal?: AbortSignal
}): Promise<{
  candidate: ResponsesEndpointCandidate
  endpoint: CopilotInferenceEndpoint
}> {
  const candidate = await prepareEvaluatedResponsesWebSocketCandidate({
    ...options,
    evaluationOnly: isSyntheticWarmupRequest(options.payload),
  })
  return {
    candidate,
    endpoint: candidate.endpoint,
  }
}

async function prepareEvaluatedResponsesWebSocketCandidate(options: {
  evaluationOnly?: boolean
  payload: ResponsesPayload
  reasoningEffort: ReasoningEffort | undefined
  responsesVerbosity?: ModelRedirectVerbosity
  selectedModel: Model | undefined
  signal?: AbortSignal
}): Promise<ResponsesEndpointCandidate> {
  const evaluationPayload = structuredClone(options.payload)
  if (options.evaluationOnly) delete evaluationPayload.generate
  const preparedSource = prepareResponsesRequest(evaluationPayload)
  const nativeBody = finalizeNativeResponsesRequest(preparedSource, {
    model: evaluationPayload.model,
    defaultEffort: getModelReasoningConfig(evaluationPayload.model)
      ?.defaultEffort,
    implicitDefault: usesImplicitReasoningDefault(evaluationPayload.model),
  })
  disableParallelWebSearch(nativeBody.body)
  const candidates = await prepareResponsesCandidates({
    adaptationSource: preparedSource.source,
    finalReasoningEffort: options.reasoningEffort,
    nativeBody,
    preservedSource: preparedSource,
    resolveRemoteAttachments: !options.evaluationOnly,
    responsesVerbosity: options.responsesVerbosity,
    selectedModel: options.selectedModel,
    signal: options.signal,
  })
  const selection = selectResponsesCandidate({
    candidates,
    selectedModel: options.selectedModel,
  })
  if ("code" in selection) throw createEndpointTranslationError(selection)
  recordCopilotRequestNormalization("responses", [
    ...nativeBody.normalizationClasses,
  ])
  if (selection.candidate.check.findings.length > 0) {
    recordCopilotTranslationFindings(
      "responses",
      selection.candidate.endpoint,
      selection.candidate.check,
    )
  }
  recordCopilotEndpointRoute(selection.decision)
  return selection.candidate
}

async function waitForWebSocketTurn<T>(
  promise: Promise<T>,
  turn: ResponsesWebSocketTurn,
): Promise<T> {
  throwIfWebSocketTurnAborted(turn)
  const signal = turn.abortController.signal
  let abortListener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      const reason: unknown = signal.reason
      if (reason instanceof Error) {
        reject(reason)
        return
      }
      const error = new Error("Responses WebSocket request aborted")
      error.name = "AbortError"
      reject(error)
    }
    signal.addEventListener("abort", abortListener, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener)
  }
}

async function failWebSocketTurn(
  ws: ResponsesWebSocketState,
  turn: ResponsesWebSocketTurn,
  failure:
    | { kind: "source_ended" }
    | { kind: "thrown"; error: unknown; inspection?: HttpErrorInspection },
): Promise<boolean> {
  if (
    ws.data.closed
    || turn.abortController.signal.aborted
    || turn.terminal.state !== "open"
  ) {
    return false
  }
  const state = turn.failureState
  if (state.model === "unknown" && turn.model) state.model = turn.model
  const writeFailure = async () => {
    await emitResponsesFailureAsStream(
      {
        get aborted() {
          return turn.abortController.signal.aborted
        },
        get closed() {
          return ws.data.closed
        },
        writeSSE: (data) => {
          if (!ws.data.closed && !turn.abortController.signal.aborted) {
            ws.send(
              addResponsesWebSocketMetadata(
                data.data,
                getCopilotResponseHeaders(),
              ),
            )
          }
          return Promise.resolve()
        },
      },
      {
        responseId: state.responseId,
        model: state.model,
        sequenceNumber: state.sequenceNumber,
        ...(failure.kind === "thrown" && failure.inspection ?
          { inspection: failure.inspection }
        : {}),
      },
    )
  }
  turn.failureWriters.set(failure, writeFailure)
  try {
    return await turn.terminal.fail(failure)
  } finally {
    turn.failureWriters.delete(failure)
  }
}

// Terminal frame classification has intentionally explicit branches so close
// races cannot overwrite a client-visible completion.

// eslint-disable-next-line max-params
async function emitTurnFrame(
  ws: ResponsesWebSocketState,
  turn: ResponsesWebSocketTurn,
  payload: ResponsesPayload,
  frame: string,
  eventName?: string,
): Promise<boolean> {
  if (
    ws.data.closed
    || turn.abortController.signal.aborted
    || turn.terminal.state !== "open"
  ) {
    return false
  }
  const parsed = parseRecoverableStreamJson({
    data: frame,
    event: eventName,
    protocol: "Responses WebSocket",
    terminal: isResponsesTerminalEventName(eventName),
  }) as { response?: { id?: unknown }; type?: unknown } | undefined
  if (parsed === undefined) return true

  const terminalType = classifyEmittedWebSocketTerminal(parsed, eventName)
  const completedFrame = addWebSocketCompletedOutputText(frame, parsed)
  const publicFrame =
    turn.requestedModel ?
      rewriteResponseModelInEvent(completedFrame, turn.requestedModel)
    : completedFrame
  const processed = addResponsesWebSocketMetadata(
    publicFrame,
    getCopilotResponseHeaders(),
  )
  ws.send(processed)
  turn.outputStarted = true
  updateResponsesFailureState(turn.failureState, {
    data: processed,
    event: typeof terminalType === "string" ? terminalType : eventName,
  })

  if (terminalType === "response.completed") {
    const responseStatus = readEmittedResponseStatus(parsed)
    if (responseStatus !== "failed") {
      recordResponseSnapshotFromFrame(
        ws.data.responseSnapshots,
        turn.continuationModel ?
          { ...payload, model: turn.continuationModel }
        : payload,
        processed,
      )
    }
    if (responseStatus === "failed") {
      return await turn.terminal.succeed({
        kind: "received_failure",
        status: 502,
        terminalStatus: "ERROR",
      })
    }
    if (responseStatus === "incomplete") {
      return await turn.terminal.succeed({
        kind: "incomplete",
        status: 200,
        terminalStatus: "COMPLETE",
      })
    }
    return await turn.terminal.succeed({
      kind: "completed",
      status: 200,
      terminalStatus: "COMPLETE",
    })
  }
  if (terminalType === "response.incomplete") {
    return await turn.terminal.succeed({
      kind: "incomplete",
      status: 200,
      terminalStatus: "COMPLETE",
    })
  }
  if (terminalType === "response.failed" || terminalType === "error") {
    return await turn.terminal.succeed({
      kind: "received_failure",
      status: 502,
      terminalStatus: "ERROR",
    })
  }
  return true
}

function addWebSocketCompletedOutputText(
  frame: string,
  parsed: { response?: { id?: unknown }; type?: unknown },
): string {
  if (parsed.type !== "response.completed") return frame
  const response = parsed.response as Record<string, unknown> | undefined
  if (!response || Object.hasOwn(response, "output_text")) return frame
  if (!Array.isArray(response.output)) return frame

  let outputText = ""
  for (const item of response.output) {
    if (
      !isWebSocketRecord(item)
      || item.type !== "message"
      || item.role !== "assistant"
    )
      continue
    if (!Array.isArray(item.content)) continue
    for (const block of item.content) {
      if (
        isWebSocketRecord(block)
        && block.type === "output_text"
        && typeof block.text === "string"
      ) {
        outputText += block.text
      }
    }
  }

  return JSON.stringify({
    ...(parsed as Record<string, unknown>),
    response: { ...response, output_text: outputText },
  })
}

function isWebSocketRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isResponsesTerminalEventName(event: string | undefined): boolean {
  return (
    event === "error"
    || event === "response.completed"
    || event === "response.failed"
    || event === "response.incomplete"
  )
}

function readEmittedResponseStatus(parsed: {
  response?: { id?: unknown }
}): unknown {
  const response = parsed.response as Record<string, unknown> | undefined
  return response?.status
}

function getRedirectReasoningEffort(
  effort: NonNullable<ResponsesPayload["reasoning"]>["effort"] | undefined,
): ReasoningEffort | undefined {
  return parseReasoningEffort(effort)
}

async function applyResponsesWebSocketRouting(
  payload: ResponsesPayload,
): Promise<{
  reasoningEffort: ReasoningEffort | undefined
  responsesVerbosity: ModelRedirectVerbosity | undefined
}> {
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    payload.model,
  )
  payload.model = normalizeModelName(baseModel)
  const effectiveEffort = normalizeResponsesReasoning(payload, suffixEffort)
  const redirect = await resolveResponsesWebSocketRedirect(
    payload.model,
    effectiveEffort,
    getResponsesVerbosity(payload),
  )

  // eslint-disable-next-line require-atomic-updates
  payload.model = normalizeModelName(redirect.model)
  const redirectedEffort = normalizeReasoningEffortForModel(
    payload.model,
    redirect.effort,
  )
  reportClampedWebSocketEffort({
    model: payload.model,
    requestedEffort: redirect.effort,
    effectiveEffort: redirectedEffort,
    redirected: true,
  })
  applyRedirectedResponsesEffort(payload, payload.model, redirectedEffort)
  applyResponsesServiceTierRouting(undefined, payload, {
    allowCustomProvider: false,
  })
  return {
    reasoningEffort:
      redirectedEffort ?? getRedirectReasoningEffort(effectiveEffort),
    responsesVerbosity: redirect.verbosity,
  }
}

async function normalizeRequestedWebSocketModel(
  payload: ResponsesPayload,
): Promise<string> {
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    payload.model,
  )
  const normalizedModel = normalizeModelName(baseModel)
  const effectiveEffort = normalizeResponsesReasoning(
    structuredClone(payload),
    suffixEffort,
  )
  const redirect = await applyModelRedirect({
    model: normalizedModel,
    effort: getRedirectReasoningEffort(effectiveEffort),
    verbosity: getResponsesVerbosity(payload),
  })
  const normalizedPayload = structuredClone(payload)
  normalizedPayload.model = normalizeModelName(redirect.model)
  applyResponsesServiceTierRouting(undefined, normalizedPayload, {
    allowCustomProvider: false,
  })
  return normalizedPayload.model
}

async function resolveResponsesWebSocketRedirect(
  model: string,
  effectiveEffort:
    | NonNullable<ResponsesPayload["reasoning"]>["effort"]
    | undefined,
  verbosity?: ModelRedirectVerbosity,
): Promise<Awaited<ReturnType<typeof applyModelRedirect>>> {
  const redirectRawEffort = getRedirectReasoningEffort(effectiveEffort)
  const requestedEffort = normalizeReasoningEffortForModel(
    model,
    redirectRawEffort,
  )
  reportClampedWebSocketEffort({
    model,
    requestedEffort: redirectRawEffort,
    effectiveEffort: requestedEffort,
  })

  const redirect = await applyModelRedirect({
    model,
    effort: requestedEffort,
    verbosity,
  })
  if (redirect.redirected) {
    reportNonDefaultBehavior({
      kind: "model_redirect",
      message: `Responses WebSocket model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: model,
        sourceEffort: requestedEffort,
        targetModel: redirect.model,
        targetEffort: redirect.effort,
        targetVerbosity: redirect.verbosity,
        ruleId: redirect.ruleId,
        ruleIds: redirect.ruleIds?.join(","),
        transport: "websocket",
      },
    })
  }
  return redirect
}

function reportClampedWebSocketEffort(options: {
  model: string
  requestedEffort?: ReasoningEffort
  effectiveEffort?: ReasoningEffort
  redirected?: boolean
}): void {
  if (
    !options.requestedEffort
    || options.effectiveEffort === options.requestedEffort
  ) {
    return
  }
  const prefix = options.redirected ? "redirected" : "requested"
  reportNonDefaultBehavior({
    kind: "reasoning_effort_clamped",
    message: `Responses WebSocket ${prefix} effort ${options.requestedEffort} for ${options.model} was clamped to ${options.effectiveEffort}`,
    data: {
      model: options.model,
      requestedEffort: options.requestedEffort,
      effectiveEffort: options.effectiveEffort,
      transport: "websocket",
    },
  })
}

function reportResponsesWebSocketEndpointFallback(
  model: string,
  targetEndpoint: "AnthropicMessages" | "ChatCompletions",
): void {
  reportNonDefaultBehavior({
    kind: "endpoint_fallback",
    message: `Responses WebSocket model ${model} does not support /responses; falling back to ${targetEndpoint}`,
    data: {
      model,
      sourceEndpoint: "Responses WebSocket",
      targetEndpoint,
      transport: "websocket",
    },
  })
}

function applyRedirectedResponsesEffort(
  payload: ResponsesPayload,
  model: string,
  effort: ReasoningEffort | undefined,
): void {
  if (!effort) {
    if (usesImplicitReasoningDefault(model) && payload.reasoning) {
      reportNonDefaultBehavior({
        kind: "reasoning_effort_implicit_default",
        message: `Responses WebSocket ${model} is configured for implicit reasoning defaults; removing explicit reasoning config`,
        data: { model, transport: "websocket" },
      })
      delete payload.reasoning
    }
    return
  }
  if (usesImplicitReasoningDefault(model)) {
    reportNonDefaultBehavior({
      kind: "reasoning_effort_implicit_default",
      message: `Responses WebSocket ${model} is configured for implicit reasoning defaults; removing explicit reasoning.effort=${effort}`,
      data: {
        model,
        requestedEffort: effort,
        transport: "websocket",
      },
    })
    delete payload.reasoning
    return
  }
  payload.reasoning =
    payload.reasoning ? { ...payload.reasoning, effort } : { effort }
}

export {
  extractResponsesPayload,
  rehydrateContinuationPayload,
} from "./websocket-protocol"

export function isSyntheticWarmupRequest(payload: ResponsesPayload): boolean {
  return (payload as Record<string, unknown>).generate === false
}

export function rehydrateWarmupPayload(
  warmupPayload: ResponsesPayload,
  payload: ResponsesPayload,
): ResponsesPayload {
  return rehydrateContinuationPayloadFromSnapshot(warmupPayload, payload)
}

async function handleSyntheticWarmupRequest(
  ws: ResponsesWebSocketState,
  payload: ResponsesPayload,
  turn: ResponsesWebSocketTurn,
): Promise<void> {
  const responseId = `warmup_${randomUUID().replaceAll("-", "")}`
  storeResponseSnapshot(ws.data.responseSnapshots, responseId, payload)

  const createdAt = Math.floor(Date.now() / 1000)
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    model: payload.model,
    output: [],
    output_text: "",
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: payload.instructions ?? null,
    metadata: payload.metadata ?? null,
    parallel_tool_calls: payload.parallel_tool_calls ?? false,
    temperature: payload.temperature ?? null,
    tool_choice: payload.tool_choice ?? "auto",
    tools: payload.tools ?? [],
    top_p: payload.top_p ?? null,
  }

  await emitTurnFrame(
    ws,
    turn,
    payload,
    JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: {
        ...baseResponse,
        status: "in_progress",
      },
    }),
    "response.created",
  )

  const completedFrame = JSON.stringify({
    type: "response.completed",
    sequence_number: 1,
    response: {
      ...baseResponse,
      status: "completed",
    },
  })
  await emitTurnFrame(ws, turn, payload, completedFrame, "response.completed")
}

async function streamAnthropicMessagesOverWs(options: {
  nativeOptions: NativeMessagesRequestOptions
  payload: Extract<
    ResponsesEndpointCandidate,
    { endpoint: "/v1/messages" }
  >["payload"]
  responseContext: ResponsesPayload
  turn: ResponsesWebSocketTurn
  ws: ResponsesWebSocketState
}): Promise<void> {
  const { nativeOptions, payload, responseContext, turn, ws } = options
  const result = await waitForWebSocketTurn(
    executePreparedResponsesMessagesBridge({
      compaction: isResponsesCompactionRequest(responseContext),
      nativeOptions,
      payload,
      responseContext,
      signal: turn.abortController.signal,
    }),
    turn,
  )
  throwIfWebSocketTurnAborted(turn)
  const wsStream = {
    writeSSE: async (data: { event?: string; data: string }) => {
      if (data.data === "[DONE]") return
      await emitTurnFrame(ws, turn, responseContext, data.data, data.event)
    },
  }
  await emitResponsesResultAsWebSocketFrames(wsStream, result)
}

async function emitResponsesResultAsWebSocketFrames(
  stream: {
    writeSSE: (data: { event?: string; data: string }) => Promise<void>
  },
  result: ResponsesResult,
): Promise<void> {
  const created = { ...result, status: "in_progress" as const }
  await stream.writeSSE({
    event: "response.created",
    data: JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: created,
    }),
  })
  await stream.writeSSE({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 1,
      response: result,
    }),
  })
}

async function streamChatCompletionsOverWs(options: {
  initiator: "agent" | "user"
  payload: Extract<
    ResponsesEndpointCandidate,
    { endpoint: "/chat/completions" }
  >["payload"]
  responseContext: ResponsesPayload
  turn: ResponsesWebSocketTurn
  ws: ResponsesWebSocketState
}): Promise<void> {
  const { initiator, payload, responseContext, turn, ws } = options
  const compaction = isResponsesCompactionRequest(responseContext)
  const ccPayload = structuredClone(payload)
  const needsWebSearch =
    ccPayload.tools?.some((tool) => tool.function.name === "web_search")
    ?? false
  if (needsWebSearch) {
    await streamChatWebSearchOverWs({
      ws,
      responseContext,
      ccPayload,
      compaction,
      initiator,
      maxUses: getResponsesChatWebSearchMaxUses(responseContext),
      turn,
    })
    return
  }
  ccPayload.stream = true
  ccPayload.stream_options = { include_usage: true }

  const response = await waitForWebSocketTurn(
    createChatCompletions(ccPayload, {
      allowCompatibilityRetry: false,
      candidatePrepared: true,
      compaction,
      initiator,
      signal: turn.abortController.signal,
    }),
    turn,
  )
  throwIfWebSocketTurnAborted(turn)
  const ccStream = response as AsyncIterable<{ data?: string; event?: string }>

  // Reuse the CC→Responses streaming translator with a WebSocket-backed writer
  const wsStream = {
    writeSSE: async (data: { event?: string; data: string }) => {
      if (data.data === "[DONE]") return
      await emitTurnFrame(ws, turn, responseContext, data.data, data.event)
    },
  }

  await streamChatCompletionsAsResponses(
    wsStream,
    ccStream,
    responseContext.model,
  )
}

async function streamCustomFallbackOverWs(options: {
  ws: ResponsesWebSocketState
  payload: ResponsesPayload
  turn: ResponsesWebSocketTurn
  reference: CustomProviderModelReference
}): Promise<void> {
  const { ws, payload, turn, reference } = options
  const candidate = await waitForWebSocketTurn(
    adaptResponsesToChatCandidate({
      source: payload,
      finalModel: payload.model,
      finalReasoningEffort: payload.reasoning?.effort ?? undefined,
      signal: turn.abortController.signal,
    }),
    turn,
  )
  if (!candidate.check.supported)
    throw createEndpointTranslationError({
      blockers: candidate.check.findings
        .filter((finding) => finding.severity === "fatal")
        .map((finding) => finding.class),
      code: "endpoint_translation_unsupported",
      source: "responses",
    })
  if (isSyntheticWarmupRequest(payload)) {
    await handleSyntheticWarmupRequest(ws, payload, turn)
    return
  }
  const completionFactory: ResponsesChatCompletionFactory = async (
    request,
    options,
  ) => ({
    processedPayload: structuredClone(request),
    response: await createCustomProviderChatCompletions(
      reference,
      { ...request, stream: false },
      {
        signal: options.signal,
        reasoningEffort: parseReasoningEffort(turn.reasoningEffort),
      },
    ),
  })
  const initial = await waitForWebSocketTurn(
    completionFactory(candidate.payload, {
      signal: turn.abortController.signal,
    }),
    turn,
  )
  const response = await waitForWebSocketTurn(
    resolvePreparedResponsesWebSearchCalls({
      completionFactory,
      initial,
      maxUses: getResponsesChatWebSearchMaxUses(payload),
      signal: turn.abortController.signal,
      webSearch: responsesWebSocketDependencies.webSearch,
    }),
    turn,
  )
  await streamChatCompletionsAsResponses(
    {
      writeSSE: async (event) => {
        if (event.data !== "[DONE]")
          await emitTurnFrame(ws, turn, payload, event.data, event.event)
      },
    },
    chatResponseAsStream(response),
    payload.model,
  )
}

async function streamChatWebSearchOverWs(options: {
  ws: ResponsesWebSocketState
  responseContext: ResponsesPayload
  ccPayload: Extract<
    ResponsesEndpointCandidate,
    { endpoint: "/chat/completions" }
  >["payload"]
  compaction: boolean
  initiator: "agent" | "user"
  maxUses?: number
  turn: ResponsesWebSocketTurn
}): Promise<void> {
  const {
    ws,
    responseContext,
    ccPayload,
    compaction,
    initiator,
    maxUses,
    turn,
  } = options
  ccPayload.stream = false
  ccPayload.stream_options = null
  const completionFactory: ResponsesChatCompletionFactory = async (
    payload,
    factoryOptions,
  ) =>
    await createChatCompletionsWithProcessedPayload(payload, {
      allowCompatibilityRetry: false,
      candidatePrepared: true,
      compaction,
      initiator,
      signal: factoryOptions.signal,
    })
  const initial = await waitForWebSocketTurn(
    completionFactory(ccPayload, {
      allowCompatibilityRetry: false,
      signal: turn.abortController.signal,
    }),
    turn,
  )
  const response = await resolvePreparedResponsesWebSearchCalls({
    completionFactory,
    initial,
    maxUses,
    signal: turn.abortController.signal,
    webSearch: responsesWebSocketDependencies.webSearch,
  })
  const wsStream = {
    writeSSE: async (data: { event?: string; data: string }) => {
      if (data.data === "[DONE]") return
      await emitTurnFrame(ws, turn, responseContext, data.data, data.event)
    },
  }
  await streamChatCompletionsAsResponses(
    wsStream,
    chatResponseAsStream(response),
    responseContext.model,
  )
}

function chatResponseAsStream(
  response: ChatCompletionResponse,
): AsyncIterable<{ data: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      // Keep this a real async iterable so it matches live SSE streams.
      await Promise.resolve()
      for (const choice of response.choices) {
        yield {
          data: JSON.stringify({
            id: response.id,
            object: "chat.completion.chunk",
            created: response.created,
            model: response.model,
            choices: [
              {
                index: choice.index,
                delta: {
                  role: "assistant",
                  content: choice.message.content,
                  reasoning_text: choice.message.reasoning_text,
                  reasoning_opaque: choice.message.reasoning_opaque,
                  encrypted_content: choice.message.encrypted_content,
                  tool_calls: choice.message.tool_calls?.map(
                    (toolCall, index) => ({
                      ...toolCall,
                      index,
                    }),
                  ),
                },
                finish_reason: choice.finish_reason,
                logprobs: choice.logprobs,
              },
            ],
            usage: response.usage,
          }),
        }
      }
      yield { data: "[DONE]" }
    },
  }
}

export function recordResponseSnapshotFromFrame(
  responseSnapshots: Map<string, ResponsesPayload>,
  payload: ResponsesPayload,
  frame: string,
): void {
  let parsed: ResponseCompletedFrame
  try {
    parsed = JSON.parse(frame) as ResponseCompletedFrame
  } catch {
    return
  }

  if (parsed.type !== "response.completed") return
  const responseId = parsed.response?.id
  if (typeof responseId !== "string" || !responseId) return

  storeResponseSnapshot(
    responseSnapshots,
    responseId,
    createCompletedResponseSnapshot(payload, parsed),
  )
}

function createCompletedResponseSnapshot(
  payload: ResponsesPayload,
  frame: ResponseCompletedFrame,
): ResponsesPayload {
  const output = frame.response?.output
  const snapshotPayload = structuredClone(payload)
  const completedInput =
    Array.isArray(output) ?
      mergeContinuationInput(snapshotPayload.input, structuredClone(output))
    : snapshotPayload.input

  const snapshot: ResponsesPayload = {
    ...snapshotPayload,
    input: completedInput,
  }
  delete snapshot.previous_response_id
  delete snapshot.generate
  return snapshot
}

export function sendWebSocketError(
  ws: Pick<ResponsesWebSocketState, "data" | "send">,
  options: WebSocketErrorFrameOptions,
): void {
  ws.send(
    JSON.stringify({
      type: "error",
      status: options.status,
      error: {
        code: options.code,
        message: options.message,
        ...(options.param ? { param: options.param } : {}),
        type: options.type ?? "websocket_error",
        request_id: options.requestId ?? ws.data.requestId,
        ...(options.upstreamBody === undefined ?
          {}
        : { upstream_body: options.upstreamBody }),
        ...(options.upstreamContentType ?
          { upstream_content_type: options.upstreamContentType }
        : {}),
      },
    }),
  )
}

function normalizeWebSocketError(
  error: unknown,
  inspection?: HttpErrorInspection,
): WebSocketErrorFrameOptions {
  if (isHTTPError(error) && error instanceof WebSocketRequestError) {
    const status = error.response.status
    return {
      code: error.errorCode,
      message: error.message,
      status,
      type: error.errorType,
    }
  }
  if (inspection?.localError) {
    const local = inspection.localError
    const code = mapLocalWebSocketErrorCode(local, inspection.status)
    return {
      code,
      message: local.message,
      ...(local.param ? { param: local.param } : {}),
      status: inspection.status,
      type: local.type,
    }
  }
  if (inspection?.kind === "upstream") {
    return {
      code:
        inspection.clientError?.code
        ?? mapHttpStatusToWebSocketErrorCode(inspection.status),
      message: "Upstream request failed",
      status: inspection.status,
      type: "websocket_error",
      upstreamBody: inspection.bodyText ?? Array.from(inspection.bodyBytes),
      ...(inspection.contentType ?
        { upstreamContentType: inspection.contentType }
      : {}),
    }
  }
  if (inspection) {
    return {
      code: mapHttpStatusToWebSocketErrorCode(inspection.status),
      message: "Upstream request failed",
      status: inspection.status,
      type: "websocket_error",
    }
  }

  return {
    code: "internal_error",
    message: "Internal server error",
    status: 500,
    type: "websocket_error",
  }
}

function mapLocalWebSocketErrorCode(
  local: NonNullable<HttpErrorInspection["localError"]>,
  status: number,
): string {
  return normalizeLocalWebSocketErrorCode(local.code, status)
}

function normalizeLocalWebSocketErrorCode(
  code: string | undefined,
  status: number,
): string {
  if (status >= 400 && status < 500) return "bad_request"
  return code ?? mapHttpStatusToWebSocketErrorCode(status)
}

function mapHttpStatusToWebSocketErrorCode(status: number): string {
  switch (status) {
    case 400: {
      return "bad_request"
    }
    case 404: {
      return "not_found"
    }
    case 413: {
      return "request_too_large"
    }
    case 429: {
      return "rate_limited"
    }
    case 503: {
      return "service_unavailable"
    }
    default: {
      return status >= 500 ? "internal_error" : "bad_request"
    }
  }
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
