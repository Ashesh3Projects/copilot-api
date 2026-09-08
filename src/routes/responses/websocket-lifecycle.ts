import type { HttpErrorInspection } from "~/lib/error"
import type { RoutingAffinity } from "~/lib/routing-affinity"
import type {
  StreamTerminalFailure,
  StreamTerminalLifecycle,
} from "~/lib/stream-terminal-lifecycle"

import { runWithCopilotContractObservabilityScope } from "~/lib/copilot-contract-observability"
import {
  type CopilotRequestAttribution,
  runWithCopilotRequestAttribution,
} from "~/lib/copilot-request-context"
import {
  isAbortError,
  isHTTPError,
  inspectHttpError,
  LocalHTTPError,
} from "~/lib/error"
import {
  type LogicalRequestLifecycle,
  startLogicalRequestLog,
} from "~/lib/request-logger"
import {
  createRoutingTelemetryRequestState,
  copilotResponseHeadersStorage,
  requestIdStorage,
  routedAccountStorage,
  type RoutingTelemetryRequestState,
  routingTelemetryStorage,
} from "~/lib/request-session"
import { runWithRoutingAffinity } from "~/lib/routing-affinity"
import { createStreamTerminalLifecycle } from "~/lib/stream-terminal-lifecycle"

import type { ResponsesStreamFailureState } from "./stream-lifecycle"

import { createResponsesStreamFailureState } from "./stream-lifecycle"

export interface ResponsesWebSocketTurn {
  abortController: AbortController
  failureState: ResponsesStreamFailureState
  failureWriters: WeakMap<StreamTerminalFailure, () => Promise<void>>
  outputStarted: boolean
  terminal: StreamTerminalLifecycle<ResponsesWebSocketTerminalSuccess>
  inputLength: number
  lifecycle?: LogicalRequestLifecycle
  model?: string
  reasoningEffort?: string
  requestedModel?: string
  continuationModel?: string
  routingState: { lastUsedAccountId?: number }
  telemetryState: RoutingTelemetryRequestState
  sequence: number
  turnId: string
}

export type ResponsesWebSocketTerminalSuccess = {
  kind: "completed" | "incomplete" | "received_failure"
  status: number
  terminalStatus: "COMPLETE" | "ERROR"
}

export interface WebSocketTerminalClassification {
  errorInspection?: HttpErrorInspection
  status: number
  terminalStatus: "ERROR" | "REJECTED" | "ABORTED"
}

interface ResponsesWebSocketLifecycleData {
  activeTurns: Map<number, ResponsesWebSocketTurn>
  nextTurnSequence: number
  requestId: string
}

export class WebSocketRequestError extends LocalHTTPError {
  readonly errorCode: string
  readonly errorType: string

  // The protocol-native error tuple is intentionally explicit at throw sites.
  // eslint-disable-next-line max-params
  constructor(
    message: string,
    status: number,
    errorType: string,
    errorCode = "bad_request",
  ) {
    const clientBody = {
      error: {
        code: errorCode,
        message,
        type: errorType,
      },
    }
    super(message, Response.json(clientBody, { status }), clientBody)
    this.errorCode = errorCode
    this.errorType = errorType
  }
}

export function createResponsesWebSocketTurn(
  data: ResponsesWebSocketLifecycleData,
  message: string,
): ResponsesWebSocketTurn {
  const sequence = ++data.nextTurnSequence
  const abortController = new AbortController()
  const turn = {} as ResponsesWebSocketTurn
  Object.assign(turn, {
    abortController,
    failureState: createResponsesStreamFailureState("unknown"),
    failureWriters: new WeakMap(),
    inputLength: new TextEncoder().encode(message).byteLength,
    outputStarted: false,
    routingState: {},
    telemetryState: createRoutingTelemetryRequestState("Responses WebSocket"),
    sequence,
    turnId: `${data.requestId}:${sequence}`,
  })
  turn.terminal = createStreamTerminalLifecycle({
    isDownstreamAborted: () => abortController.signal.aborted,
    onSuccess: (success) => {
      finalizeResponsesWebSocketTurn(data, turn, {
        status: success.status,
        terminalStatus: success.terminalStatus,
      })
    },
    onFailure: async (failure) => {
      await turn.failureWriters.get(failure)?.()
      const terminal = await classifyWebSocketTerminal(
        failure.kind === "thrown" ? failure.error : undefined,
        turn,
      )
      finalizeResponsesWebSocketTurn(data, turn, {
        error: failure.kind === "thrown" ? failure.error : undefined,
        ...terminal,
      })
    },
  })
  data.activeTurns.set(sequence, turn)
  return turn
}

export function ensureResponsesWebSocketLifecycle(
  turn: ResponsesWebSocketTurn,
  options?: {
    model?: string
    reasoningEffort?: string
    requestedModel?: string
  },
): LogicalRequestLifecycle {
  if (!turn.lifecycle) {
    turn.lifecycle = startLogicalRequestLog({
      inputLength: turn.inputLength,
      method: "POST",
      model: options?.model ?? turn.model ?? turn.requestedModel ?? "unknown",
      path: "/responses",
      reasoningEffort: options?.reasoningEffort,
      requestedModel: options?.requestedModel ?? turn.requestedModel,
      transport: "Responses WebSocket",
      telemetryState: turn.telemetryState,
      turnId: turn.turnId,
    })
  } else if (options) {
    turn.lifecycle.update(options)
  }
  return turn.lifecycle
}

export function finalizeResponsesWebSocketTurn(
  data: ResponsesWebSocketLifecycleData,
  turn: ResponsesWebSocketTurn,
  options: {
    error?: unknown
    errorInspection?: HttpErrorInspection
    status: number
    terminalStatus: "COMPLETE" | "ERROR" | "REJECTED" | "ABORTED"
  },
): void {
  const lifecycle = ensureResponsesWebSocketLifecycle(turn)
  lifecycle.finalize({
    accountId: turn.routingState.lastUsedAccountId,
    error: options.error,
    errorInspection: options.errorInspection,
    status: options.status,
    terminalStatus: options.terminalStatus,
  })
  data.activeTurns.delete(turn.sequence)
}

export function throwIfWebSocketTurnAborted(
  turn: ResponsesWebSocketTurn,
): void {
  if (!turn.abortController.signal.aborted) return
  const reason: unknown = turn.abortController.signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error("Responses WebSocket request aborted")
  error.name = "AbortError"
  throw error
}

export async function classifyWebSocketTerminal(
  error: unknown,
  turn: ResponsesWebSocketTurn,
): Promise<WebSocketTerminalClassification> {
  if (turn.abortController.signal.aborted || isAbortError(error)) {
    return { status: 499, terminalStatus: "ABORTED" }
  }
  if (isHTTPError(error)) {
    const errorInspection = await inspectHttpError(error)
    const { status } = errorInspection
    return {
      errorInspection,
      status,
      terminalStatus: status < 500 ? "REJECTED" : "ERROR",
    }
  }
  return { status: 500, terminalStatus: "ERROR" }
}

// The public lifecycle interface keeps affinity, attribution, turn, and work explicit.
// eslint-disable-next-line max-params
export async function runWithWebSocketRequestContext<T>(
  affinity: RoutingAffinity | undefined,
  attribution: CopilotRequestAttribution,
  turn: ResponsesWebSocketTurn,
  callback: () => Promise<T>,
): Promise<T> {
  const runTelemetryScope = async (): Promise<T> =>
    await routingTelemetryStorage.run(
      turn.telemetryState,
      async () => await runWithCopilotContractObservabilityScope(callback),
    )
  return await requestIdStorage.run(
    turn.turnId,
    async () =>
      await runWithRoutingAffinity(
        affinity,
        async () =>
          await runWithCopilotRequestAttribution(
            attribution,
            async () =>
              await copilotResponseHeadersStorage.run(
                {},
                async () =>
                  await routedAccountStorage.run(
                    turn.routingState,
                    runTelemetryScope,
                  ),
              ),
          ),
      ),
  )
}
