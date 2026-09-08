import "./data-dir"

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"

import { setIpAllowlistForTest } from "~/lib/ip-allowlist"
import { clearLlmDebugLogs, listLlmDebugLogs } from "~/lib/llm-debug-log"
import {
  getAllModelRedirects,
  setModelRedirectsForTest,
} from "~/lib/model-redirect"
import { state } from "~/lib/state"
import { peekHistoryRuntime } from "~/lib/telemetry-writer"
import {
  type ResponsesWebSocketData,
  responsesWebSocket,
} from "~/routes/responses/websocket"
import { handleStartFetch } from "~/start"

import {
  useIntegrationFixture,
  initializeTestState,
  registerGatewayCredential,
  removeGatewayCredential,
  TEST_TIMEOUT,
} from "./setup"

const LIVE_TIMEOUT = TEST_TIMEOUT * 3
const MAX_LIVE_MODEL_CANDIDATES = 3

interface WebSocketFrame {
  status?: number
  type?: string
  response?: {
    id?: string
    output_text?: string
    status?: string
    error?: { code?: string; type?: string } | null
    incomplete_details?: { reason?: string } | null
  }
  error?: { code?: string; param?: string }
}

let previousModelRedirects: Awaited<ReturnType<typeof getAllModelRedirects>> =
  []
let gatewayKey = ""
let localServer:
  | ReturnType<typeof Bun.serve<ResponsesWebSocketData>>
  | undefined

afterAll(async () => {
  try {
    await localServer?.stop(true)
  } finally {
    if (peekHistoryRuntime()) await clearLlmDebugLogs()
    if (gatewayKey) await removeGatewayCredential(gatewayKey)
    setIpAllowlistForTest([])
    setModelRedirectsForTest(previousModelRedirects)
  }
}, LIVE_TIMEOUT)

useIntegrationFixture()

await initializeTestState()
previousModelRedirects = await getAllModelRedirects()
const liveModels = state.models?.data ?? []
const nativeResponsesModels = liveModels.filter(
  (model) =>
    model.supported_endpoints?.includes("/responses")
    && model.capabilities.supports.streaming !== false,
)
const chatFallbackModels = liveModels.filter(
  (model) =>
    model.supported_endpoints?.includes("/chat/completions")
    && !model.supported_endpoints.includes("/responses")
    && model.capabilities.supports.streaming !== false,
)
const orderedChatFallbackModels = [...chatFallbackModels].sort(
  (left, right) =>
    Number(left.capabilities.supports.reasoning_effort !== undefined)
    - Number(right.capabilities.supports.reasoning_effort !== undefined),
)
const nativeResponsesCandidates = firstModelByProvider(
  nativeResponsesModels,
).slice(0, MAX_LIVE_MODEL_CANDIDATES)
const responsesModels = [
  ...nativeResponsesCandidates.slice(0, 1),
  ...firstModelByProvider(orderedChatFallbackModels),
].slice(0, MAX_LIVE_MODEL_CANDIDATES)

beforeAll(async () => {
  setIpAllowlistForTest([])
  setModelRedirectsForTest([])
  if (responsesModels.length === 0) return

  gatewayKey = randomBytes(32).toString("base64url")
  await registerGatewayCredential(gatewayKey)
  localServer = Bun.serve<ResponsesWebSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handleStartFetch,
    websocket: responsesWebSocket,
  })
}, LIVE_TIMEOUT)

beforeEach(() => {
  setIpAllowlistForTest([])
})

test.skipIf(nativeResponsesCandidates.length === 0)(
  "completes a native Responses WebSocket turn",
  async () => {
    await clearLlmDebugLogs()
    if (!localServer?.port) {
      throw new Error("Responses WebSocket endpoint unavailable")
    }
    const socket = new WebSocket(
      `ws://127.0.0.1:${localServer.port}/responses`,
      { headers: { Authorization: `Bearer ${gatewayKey}` } },
    )
    const frames = createFrameQueue(socket)
    try {
      await frames.opened
      const turn = await createFirstSuccessfulTurn(
        socket,
        frames,
        nativeResponsesCandidates,
      )

      expect(turn.frame.type).toBe("response.completed")
      expect(turn.frame.response?.status).toBe("completed")
      expect(turn.frame.response?.output_text).toBeString()
      await expectCompletedUpstreamPath(turn.model.id, "/responses")
    } finally {
      socket.close()
      await frames.closed
    }
  },
  LIVE_TIMEOUT,
)

test.skipIf(responsesModels.length === 0)(
  "continues only current-connection responses and keeps stale-ID errors recoverable",
  async () => {
    await clearLlmDebugLogs()
    if (!localServer?.port) {
      throw new Error("Responses WebSocket endpoint unavailable")
    }
    const socket = new WebSocket(
      `ws://127.0.0.1:${localServer.port}/responses`,
      { headers: { Authorization: `Bearer ${gatewayKey}` } },
    )
    const frames = createFrameQueue(socket)
    try {
      await frames.opened
      const firstTurn = await createFirstSuccessfulTurn(
        socket,
        frames,
        responsesModels,
      )
      const firstCompleted = firstTurn.frame
      const firstResponseId = firstCompleted.response?.id
      expect(firstResponseId).toBeString()

      socket.send(
        JSON.stringify({
          type: "response.create",
          model: `${firstTurn.model.id}-continuation-mismatch`,
          previous_response_id: firstResponseId,
          input: "This model mismatch must not reach upstream.",
          max_output_tokens: 256,
        }),
      )
      const mismatchError = await frames.nextTerminal()
      expect(mismatchError.type).toBe("error")
      expect(mismatchError.error?.code).toBe("invalid_request_error")
      expect(socket.readyState).toBe(WebSocket.OPEN)

      socket.send(
        JSON.stringify({
          type: "response.create",
          previous_response_id: firstResponseId,
          input: "Reply with OK again.",
          max_output_tokens: 256,
        }),
      )
      const secondCompleted = await frames.nextTerminal()
      if (secondCompleted.type !== "response.completed") {
        throw new Error(
          `Continuation terminal: ${JSON.stringify({
            code: secondCompleted.error?.code,
            param: secondCompleted.error?.param,
            status: secondCompleted.status,
            type: secondCompleted.type,
          })}`,
        )
      }
      expect(secondCompleted.response?.id).toBeString()

      socket.send(
        JSON.stringify({
          type: "response.create",
          model: firstTurn.model.id,
          previous_response_id: `stale_${randomBytes(16).toString("hex")}`,
          input: "This turn must not reach upstream.",
          max_output_tokens: 256,
        }),
      )
      const staleError = await frames.nextTerminal()
      expect(staleError.type).toBe("error")
      expect(staleError.error?.code).toBe("previous_response_not_found")

      expect(socket.readyState).toBe(WebSocket.OPEN)
    } finally {
      socket.close()
      await frames.closed
    }
  },
  LIVE_TIMEOUT,
)

function createFrameQueue(socket: WebSocket): {
  closed: Promise<void>
  opened: Promise<void>
  nextTerminal: () => Promise<WebSocketFrame>
} {
  const queued: Array<WebSocketFrame> = []
  const waiters: Array<{
    resolve: (frame: WebSocketFrame) => void
    reject: (error: Error) => void
  }> = []
  const opened = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out opening WebSocket")),
      15_000,
    )
    const finish = (callback: () => void) => {
      clearTimeout(timeout)
      callback()
    }
    socket.addEventListener("open", () => finish(resolve), { once: true })
    socket.addEventListener(
      "error",
      () => finish(() => reject(new Error("WebSocket error"))),
      { once: true },
    )
    socket.addEventListener(
      "close",
      () => finish(() => reject(new Error("WebSocket closed before opening"))),
      { once: true },
    )
  })
  const closed = new Promise<void>((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) resolve()
    else socket.addEventListener("close", () => resolve(), { once: true })
  })

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return
    const frame = JSON.parse(event.data) as WebSocketFrame
    if (!isTerminalFrame(frame)) return
    const waiter = waiters.shift()
    if (!waiter) {
      queued.push(frame)
      return
    }
    waiter.resolve(frame)
  })
  socket.addEventListener("close", () => {
    const error = new Error("WebSocket closed before expected frame")
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  })

  return {
    closed,
    opened,
    nextTerminal() {
      const frame = queued.shift()
      if (frame) return Promise.resolve(frame)
      return new Promise<WebSocketFrame>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.findIndex(
            (waiter) => waiter.resolve === wrappedResolve,
          )
          if (index !== -1) waiters.splice(index, 1)
          reject(new Error("Timed out waiting for WebSocket terminal frame"))
        }, 45_000)
        const wrappedResolve = (terminal: WebSocketFrame) => {
          clearTimeout(timeout)
          resolve(terminal)
        }
        const wrappedReject = (error: Error) => {
          clearTimeout(timeout)
          reject(error)
        }
        waiters.push({ resolve: wrappedResolve, reject: wrappedReject })
      })
    },
  }
}

async function expectCompletedUpstreamPath(
  modelId: string,
  expectedPath: string,
): Promise<void> {
  const entries = await waitFor(async () => {
    const matching = (await listLlmDebugLogs()).entries.filter(
      (entry) => entry.model === modelId,
    )
    if (
      matching.some((entry) => entry.status === "complete")
      && matching.every((entry) => entry.status !== "pending")
    ) {
      return matching
    }
    return undefined
  })
  expect([...new Set(entries.map((entry) => entry.path))]).toEqual([
    expectedPath,
  ])
}

async function createFirstSuccessfulTurn(
  socket: WebSocket,
  frames: ReturnType<typeof createFrameQueue>,
  models: ReadonlyArray<(typeof responsesModels)[number]>,
): Promise<{
  frame: WebSocketFrame
  model: (typeof responsesModels)[number]
}> {
  const failures: Array<{
    code?: string
    incompleteReason?: string
    responseCode?: string
    responseStatus?: string
    responseType?: string
    status?: number
    type?: string
    vendor?: string
  }> = []
  for (const model of models) {
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: model.id,
        input: "Reply with exactly OK.",
        max_output_tokens: 256,
      }),
    )
    const frame = await frames.nextTerminal()
    if (frame.type === "response.completed" && frame.response?.id) {
      return { frame, model }
    }
    failures.push({
      code: frame.error?.code,
      incompleteReason: frame.response?.incomplete_details?.reason,
      responseCode: frame.response?.error?.code,
      responseStatus: frame.response?.status,
      responseType: frame.response?.error?.type,
      status: frame.status,
      type: frame.type,
      vendor: model.vendor,
    })
  }
  throw new Error(
    `No live gateway-compatible model completed a local Responses WebSocket turn: ${JSON.stringify(failures)}`,
  )
}

function isTerminalFrame(frame: WebSocketFrame): boolean {
  return (
    frame.type === "error"
    || frame.type === "response.completed"
    || frame.type === "response.failed"
    || frame.type === "response.incomplete"
  )
}

function firstModelByProvider<T extends { vendor?: string }>(
  models: ReadonlyArray<T>,
): Array<T> {
  const firstByProvider: Array<T> = []
  const providers = new Set<string>()
  for (const model of models) {
    const provider = model.vendor ?? ""
    if (providers.has(provider)) continue
    providers.add(provider)
    firstByProvider.push(model)
  }
  return firstByProvider
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for test condition")
}
