import * as Sentry from "@sentry/bun"
/* eslint-disable max-lines, max-lines-per-function */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { NativeMessagesRequestOptions } from "../src/routes/messages/native-handler"
import type {
  ResponseInputItem,
  ResponsesPayload,
} from "../src/services/copilot/create-responses"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setConfigForTest } from "../src/lib/config"
import { getCopilotRequestAttribution } from "../src/lib/copilot-request-context"
import { HTTPError, LocalHTTPError } from "../src/lib/error"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { isIpBlocked, resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import {
  getCopilotResponseHeaders,
  getLastUsedRoutedAccountId,
  setCopilotResponseHeader,
  setLastUsedRoutedAccountId,
} from "../src/lib/request-session"
import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import {
  extractResponsesPayload,
  isSyntheticWarmupRequest,
  recordResponseSnapshotFromFrame,
  rehydrateContinuationPayload,
  type ResponsesWebSocketData,
  responsesWebSocket,
  rehydrateWarmupPayload,
  sendWebSocketError,
  setResponsesWebSocketDependenciesForTest,
  tryUpgradeResponsesWebSocket,
} from "../src/routes/responses/websocket"
import {
  createResponsesWebSocketTurn,
  runWithWebSocketRequestContext,
} from "../src/routes/responses/websocket-lifecycle"
import { addResponsesWebSocketMetadata } from "../src/routes/responses/websocket-protocol"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "../src/services/copilot/compaction-payload"
import {
  CAPI_RESPONSES_MAX_REQUEST_BYTES,
  RESPONSES_RECOVERY_MARGIN_BYTES,
} from "../src/services/copilot/responses-payload-recovery"
import { sanitizeResponsesStreamEvent } from "../src/services/copilot/responses-terminal-sanitizer"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalApiKeyAuth = state.apiKeyAuth
const originalFetch = globalThis.fetch
const originalModels = state.models
const webSocketAccountIds = [23_001, 23_002]
const queuedResponses: Array<Response> = []
const queuedFetchHandlers: Array<
  (init?: RequestInit) => Promise<Response> | Response
> = []
let lastRequestBody: Record<string, unknown> | undefined
let capturedAffinity: RoutingAffinity | undefined
const capturedAuthorization: Array<string | null> = []
const capturedUpstreamHeaders: Array<Headers> = []
let restoreResponsesWebSocketDependencies: (() => void) | undefined

interface WebSocketMetadataCase {
  expectedHeaders: Record<string, string> | undefined
  expectedQuota: Record<string, string> | undefined
  headers: Record<string, string>
  name: string
}

interface WebSocketResponseMetadataCase
  extends Omit<WebSocketMetadataCase, "headers"> {
  responseHeaders: Record<string, string>
}

function typedCases<T>(cases: Array<T>): Array<T> {
  return cases
}

function authenticatedResponsesRequest(): Request {
  return new Request("http://localhost/responses", {
    headers: { authorization: "Bearer cli-secret" },
  })
}

const responsesCapableModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

const fetchMock = mock((_url: string, init?: RequestInit) => {
  capturedAffinity = getRoutingAffinity()
  const headers = new Headers(init?.headers)
  capturedAuthorization.push(headers.get("authorization"))
  capturedUpstreamHeaders.push(headers)
  lastRequestBody =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined
  const handler = queuedFetchHandlers.shift()
  return (
    handler?.(init)
    ?? queuedResponses.shift()
    ?? createResponsesSseResponse("resp_default")
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  for (const accountId of webSocketAccountIds)
    tokenPool.removeAccountForTest(accountId)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  setIpAllowlistForTest([])
})

afterEach(() => {
  restoreResponsesWebSocketDependencies?.()
  restoreResponsesWebSocketDependencies = undefined
  fetchMock.mockClear()
  lastRequestBody = undefined
  capturedAffinity = undefined
  capturedAuthorization.length = 0
  capturedUpstreamHeaders.length = 0
  queuedResponses.length = 0
  queuedFetchHandlers.length = 0
  state.apiKeyAuth = originalApiKeyAuth
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = originalModels
  setModelRedirectsForTest([])
  setConfigForTest(null)
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
  resetRoutingTelemetryForTest()
})

describe("extractResponsesPayload", () => {
  test("merges top-level continuation fields with nested response payload", () => {
    const payload = extractResponsesPayload({
      type: "response.create",
      previous_response_id: "resp_prev",
      response: {
        model: "gpt-5.4",
        stream: true,
      },
    })

    expect(payload.model).toBe("gpt-5.4")
    expect(payload.stream).toBe(true)
    expect(payload.previous_response_id).toBe("resp_prev")
  })

  test("uses top-level payload when nested response object is absent", () => {
    const payload = extractResponsesPayload({
      type: "response.create",
      model: "gpt-5.4",
      input: "hello",
      stream: true,
    })

    expect(payload.model).toBe("gpt-5.4")
    expect(payload.input).toBe("hello")
    expect((payload as unknown as Record<string, unknown>).type).toBeUndefined()
  })

  test("prefers nested response values when keys overlap", () => {
    const payload = extractResponsesPayload({
      type: "response.create",
      model: "gpt-5-mini",
      response: {
        model: "gpt-5.4",
        input: "hello",
      },
    })

    expect(payload.model).toBe("gpt-5.4")
    expect(payload.input).toBe("hello")
  })
})

describe("responses websocket upgrade handling", () => {
  test("matches /responses and /v1/responses upgrade paths", async () => {
    state.apiKeyAuth = "route-secret"
    const upgraded: Array<ResponsesWebSocketData> = []
    const server = {
      upgrade(_req: Request, opts?: object): boolean {
        upgraded.push(
          (opts as { data: ResponsesWebSocketData } | undefined)?.data
            ?? ({} as ResponsesWebSocketData),
        )
        return true
      },
    }

    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/responses", {
            headers: {
              authorization: "Bearer route-secret",
              upgrade: "websocket",
              "x-client-request-id": "req-1",
            },
          }),
          server,
        ),
      ),
    ).toBe("upgraded")
    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/v1/responses", {
            headers: {
              authorization: "Bearer route-secret",
              upgrade: "websocket",
            },
          }),
          server,
        ),
      ),
    ).toBe("upgraded")
    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/v1/chat/completions", {
            headers: { upgrade: "websocket" },
          }),
          server,
        ),
      ),
    ).toBe("no_match")
    expect(upgraded[0]?.requestId).toBe("req-1")
    expect(upgraded[0]?.responseSnapshots).toBeInstanceOf(Map)
  })

  test("resolves every supported WebSocket upgrade affinity header", async () => {
    state.apiKeyAuth = "route-secret"
    for (const [header, key, source] of [
      ["x-claude-code-session-id", "claude", "claude_session"],
      ["x-client-session-id", "copilot", "copilot_session"],
      ["session-id", "codex", "codex_session"],
      ["thread-id", "thread", "codex_thread"],
    ] as const) {
      let upgraded: ResponsesWebSocketData | undefined
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/responses", {
            headers: {
              authorization: "Bearer route-secret",
              [header]: key,
            },
          }),
          {
            upgrade(_request, options): boolean {
              upgraded = (options as { data: ResponsesWebSocketData }).data
              return true
            },
          },
        ),
      )
      expect(upgraded?.affinity).toEqual({ key, source })
    }
  })

  test("captures canonical native Messages headers in upgrade state", async () => {
    const ws = await createUpgradedTestWebSocket({
      "anthropic-beta": " beta-one, beta-two, beta-one ",
      "anthropic-version": "2024-01-01",
      "x-model-provider-preference": "anthropic",
      "x-request-id": "req-ws-headers",
    })

    expect(readNativeMessagesOptions(ws.data)).toEqual({
      anthropicBeta: "beta-one,beta-two",
      anthropicVersion: "2024-01-01",
      modelProviderPreference: "anthropic",
    })
    expect(ws.data.requestId).toBe("req-ws-headers")
  })

  test("omits invalid native Messages headers from upgrade state", async () => {
    const ws = await createUpgradedTestWebSocket({
      "anthropic-beta": "beta one",
      "anthropic-version": "v".repeat(1025),
      "x-model-provider-preference": "p".repeat(1025),
    })

    expect(readNativeMessagesOptions(ws.data)).toEqual({})
  })

  test("uses upgrade affinity precedence and ignores request identifiers", async () => {
    state.apiKeyAuth = "route-secret"
    let upgraded: ResponsesWebSocketData | undefined
    const upgrade = async (headers: Record<string, string>) => {
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/responses", {
            headers: { authorization: "Bearer route-secret", ...headers },
          }),
          {
            upgrade(_request, options): boolean {
              upgraded = (options as { data: ResponsesWebSocketData }).data
              return true
            },
          },
        ),
      )
      return upgraded
    }

    expect(
      (
        await upgrade({
          "x-claude-code-session-id": "claude-wins",
          "x-client-session-id": "copilot-loses",
          "session-id": "session-loses",
          "thread-id": "thread-loses",
        })
      )?.affinity,
    ).toEqual({ key: "claude-wins", source: "claude_session" })
    expect(
      (
        await upgrade({
          "x-client-session-id": "copilot-wins",
          "session-id": "session-loses",
          "thread-id": "thread-loses",
        })
      )?.affinity,
    ).toEqual({ key: "copilot-wins", source: "copilot_session" })
    expect(
      (
        await upgrade({
          "session-id": "session-wins",
          "thread-id": "thread-loses",
        })
      )?.affinity,
    ).toEqual({ key: "session-wins", source: "codex_session" })
    expect((await upgrade({ "thread-id": "thread-wins" }))?.affinity).toEqual({
      key: "thread-wins",
      source: "codex_thread",
    })
    expect(
      (
        await upgrade({
          "x-request-id": "request-not-affinity",
          "x-client-request-id": "client-request-not-affinity",
        })
      )?.affinity,
    ).toBeUndefined()
  })

  test("enforces stored gateway and inference keys before upgrade", async () => {
    await seedProtocolDatabase({ inferenceKeys: ["config-secret"] })
    const server = {
      upgrade(): boolean {
        return true
      },
    }

    state.apiKeyAuth = "cli-secret"
    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/responses", {
            headers: { upgrade: "websocket" },
          }),
          server,
        ),
      ),
    ).toBe("auth_failed")
    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/responses", {
            headers: {
              authorization: "Bearer cli-secret",
              upgrade: "websocket",
            },
          }),
          server,
        ),
      ),
    ).toBe("upgraded")

    state.apiKeyAuth = undefined
    setConfigForTest({ auth: { apiKeys: ["config-secret"] } })
    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/responses", {
            headers: { upgrade: "websocket", "x-api-key": "wrong" },
          }),
          server,
        ),
      ),
    ).toBe("auth_failed")
    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/responses", {
            headers: { upgrade: "websocket", "x-api-key": "config-secret" },
          }),
          server,
        ),
      ),
    ).toBe("upgraded")
  })

  test("a valid inference upgrade recovers and promotes an actively banned IP", async () => {
    state.apiKeyAuth = "cli-secret"
    const clientIp = "198.51.100.91"
    const server = { upgrade: () => true }

    for (const apiKey of [undefined, undefined, "wrong-key"]) {
      const headers = new Headers({
        upgrade: "websocket",
        "x-copilot-peer-ip": clientIp,
      })
      if (apiKey) headers.set("x-api-key", apiKey)
      expect(
        await seedProtocolDatabase().then(() =>
          tryUpgradeResponsesWebSocket(
            new Request("http://localhost/responses", { headers }),
            server,
          ),
        ),
      ).toBe("auth_failed")
    }

    expect(isIpBlocked(clientIp)).toBe(true)
    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(
          new Request("http://localhost/responses", {
            headers: {
              "x-api-key": "cli-secret",
              upgrade: "websocket",
              "x-copilot-peer-ip": clientIp,
            },
          }),
          server,
        ),
      ),
    ).toBe("upgraded")
    expect(isIpBlocked(clientIp)).toBe(false)
  })

  test("allows multiple connections for one authenticated principal", async () => {
    state.apiKeyAuth = "cli-secret"
    const server = { upgrade: () => true }
    for (let index = 0; index < 5; index += 1) {
      expect(
        await seedProtocolDatabase().then(() =>
          tryUpgradeResponsesWebSocket(authenticatedResponsesRequest(), server),
        ),
      ).toBe("upgraded")
    }
  })
})

describe("responses websocket message handling", () => {
  test("rejects response.processed without starting a turn", async () => {
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({ type: "response.processed", response_id: "resp_1" }),
      ),
    )

    expect(ws.data.nextTurnSequence).toBe(0)
    expect(ws.data.activeTurns.size).toBe(0)
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "error",
      status: 400,
      error: { message: "Unsupported message type" },
    })
  })

  test("closing a socket does not affect later upgrades", async () => {
    state.apiKeyAuth = "cli-secret"
    let upgraded: ResponsesWebSocketData | undefined
    const server = {
      upgrade(_request: Request, options?: object): boolean {
        upgraded = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    }
    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(authenticatedResponsesRequest(), server),
      ),
    ).toBe("upgraded")
    if (!upgraded) throw new Error("Expected upgraded socket data")
    responsesWebSocket.close({ data: upgraded })
    responsesWebSocket.close({ data: upgraded })
    expect(
      await seedProtocolDatabase().then(() =>
        tryUpgradeResponsesWebSocket(authenticatedResponsesRequest(), server),
      ),
    ).toBe("upgraded")
  })

  test("accepts frames larger than the former local frame boundary", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "x".repeat(4 * 1024 * 1024 + 1),
          generate: false,
        }),
      ),
    )

    expect(
      ws.sent.some(
        (frame) =>
          (JSON.parse(frame) as { type?: string }).type
          === "response.completed",
      ),
    ).toBe(true)
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test("accepts a new turn while other turns are active", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    ws.data.nextTurnSequence = 5
    for (let index = 1; index <= 5; index += 1) {
      const turnData = {
        activeTurns: ws.data.activeTurns,
        nextTurnSequence: index - 1,
        requestId: "test",
      }
      const turn = createResponsesWebSocketTurn(turnData, "")
      ws.data.activeTurns.set(index, {
        ...turn,
        sequence: index,
      })
    }
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          generate: false,
        }),
      ),
    )

    expect(
      ws.sent.some(
        (frame) =>
          (JSON.parse(frame) as { type?: string }).type
          === "response.completed",
      ),
    ).toBe(true)
    expect(ws.data.activeTurns.size).toBe(5)
  })

  test("keeps the socket usable after invalid client messages", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(ws, new Uint8Array([1, 2, 3])),
    )
    await seedProtocolDatabase().then(() => responsesWebSocket.message(ws, "{"))
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(ws, JSON.stringify({ type: "unknown" })),
    )
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "still usable",
          generate: false,
        }),
      ),
    )

    const frames = ws.sent.slice(0, 3).map(
      (frame) =>
        JSON.parse(frame) as {
          error: { code: string; message: string; request_id: string }
          status: number
          type: string
        },
    )

    expect(frames).toHaveLength(3)
    expect(frames.every((frame) => frame.type === "error")).toBe(true)
    expect(frames.every((frame) => frame.status === 400)).toBe(true)
    expect(frames.every((frame) => frame.error.code === "bad_request")).toBe(
      true,
    )
    expect(frames.every((frame) => frame.error.request_id === "req-test")).toBe(
      true,
    )
    expect(frames[2]?.error.message).toContain("Unsupported message type")
    expect(
      ws.sent.some(
        (frame) =>
          (JSON.parse(frame) as { type?: string }).type
          === "response.completed",
      ),
    ).toBe(true)
    expect(ws.data.closed).toBe(false)
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test.each([
    { type: null as unknown },
    { type: 7 as unknown },
    { type: [] as unknown },
    { type: {} as unknown },
    { type: { toString: null } as unknown },
    { type: { toString: {}, valueOf: {} } as unknown },
  ])(
    "keeps the socket usable after hostile message type $type",
    async ({ type }) => {
      state.models = responsesCapableModels
      const ws = createTestWebSocket()

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(ws, JSON.stringify({ type })),
      )

      expect(ws.data.nextTurnSequence).toBe(0)
      expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
        type: "error",
        status: 400,
        error: { message: "Unsupported message type" },
      })

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            generate: false,
          }),
        ),
      )

      expect(
        ws.sent.some(
          (frame) =>
            (JSON.parse(frame) as { type?: string }).type
            === "response.completed",
        ),
      ).toBe(true)
      expect(ws.data.closed).toBe(false)
    },
  )

  test("coerces stream false and remains usable", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "do not start",
          stream: false,
        }),
      ),
    )

    expect(ws.data.nextTurnSequence).toBe(1)
    expect(ws.data.activeTurns.size).toBe(0)
    expect(
      ws.sent.some(
        (frame) =>
          (JSON.parse(frame) as { type?: string }).type
          === "response.completed",
      ),
    ).toBe(true)

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "continue",
          generate: false,
        }),
      ),
    )

    expect(
      ws.sent.some(
        (frame) =>
          (JSON.parse(frame) as { type?: string }).type
          === "response.completed",
      ),
    ).toBe(true)
    expect(ws.data.closed).toBe(false)
  })

  test("applies the top-level initiator without forwarding envelope fields", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    queuedResponses.push(createResponsesSseResponse("resp_attribution"))

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "hello",
          headers: {
            Authorization: "Bearer frame-secret",
            "Copilot-Session-Token": "frame-session-secret",
          },
          initiator: "agent",
          agent_task_id: "task-frame",
          parent_agent_id: "parent-frame",
        }),
      ),
    )

    expect(capturedUpstreamHeaders[0]?.get("x-initiator")).toBe("agent")
    expect(capturedUpstreamHeaders[0]?.get("x-agent-task-id")).toBe(
      "task-frame",
    )
    expect(capturedUpstreamHeaders[0]?.get("x-parent-agent-id")).toBe(
      "parent-frame",
    )
    expect(capturedUpstreamHeaders[0]?.get("authorization")).toBe(
      "Bearer copilot-token",
    )
    expect(capturedUpstreamHeaders[0]?.has("copilot-session-token")).toBe(false)
    expect(lastRequestBody).not.toHaveProperty("headers")
    expect(lastRequestBody).not.toHaveProperty("initiator")
    expect(lastRequestBody).not.toHaveProperty("agent_task_id")
    expect(lastRequestBody).not.toHaveProperty("parent_agent_id")
  })

  test("applies independent per-turn attribution while preserving connection identity", async () => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      createResponsesSseResponse("resp_turn_one"),
      createResponsesSseResponse("resp_turn_two"),
    )
    const ws = createTestWebSocket()

    for (const turn of [
      {
        agentTaskId: "task-one",
        clientExperiment: "experiment:one;",
        clientMachineId: "machine-one",
        input: "first",
        interactionType: "conversation-subagent",
        parentAgentId: "parent-one",
      },
      {
        agentTaskId: "task-two",
        clientExperiment: "experiment:two;",
        clientMachineId: "machine-two",
        input: "second",
        interactionType: "conversation-background",
        parentAgentId: "parent-two",
      },
    ]) {
      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            agent_task_id: turn.agentTaskId,
            headers: {
              Authorization: `Bearer spoof-${turn.input}`,
              "Copilot-Session-Token": `session-spoof-${turn.input}`,
              "X-Copilot-Client-Exp-Assignment-Context": turn.clientExperiment,
              "X-Client-Machine-Id": turn.clientMachineId,
              "X-GitHub-User": `user-spoof-${turn.input}`,
              "X-Interaction-Type": turn.interactionType,
            },
            input: turn.input,
            model: "gpt-5.4",
            parent_agent_id: turn.parentAgentId,
            type: "response.create",
          }),
        ),
      )
    }

    expect(capturedUpstreamHeaders).toHaveLength(2)
    for (const [index, expected] of [
      {
        agentTaskId: "task-one",
        clientExperiment: "experiment:one;",
        clientMachineId: "machine-one",
        interactionType: "conversation-subagent",
        parentAgentId: "parent-one",
      },
      {
        agentTaskId: "task-two",
        clientExperiment: "experiment:two;",
        clientMachineId: "machine-two",
        interactionType: "conversation-background",
        parentAgentId: "parent-two",
      },
    ].entries()) {
      const headers = capturedUpstreamHeaders[index]
      expect(headers.get("x-agent-task-id")).toBe(expected.agentTaskId)
      expect(headers.get("x-parent-agent-id")).toBe(expected.parentAgentId)
      expect(headers.get("x-interaction-type")).toBe(expected.interactionType)
      expect(headers.get("x-client-machine-id")).toBe(expected.clientMachineId)
      expect(headers.get("x-copilot-client-exp-assignment-context")).toBe(
        expected.clientExperiment,
      )
      expect(headers.get("authorization")).toBe("Bearer copilot-token")
      expect(headers.get("copilot-session-token")).toBeNull()
      expect(headers.get("x-github-user")).toBeNull()
    }
    expect(capturedUpstreamHeaders[0]?.get("x-interaction-id")).toBe(
      capturedUpstreamHeaders[1]?.get("x-interaction-id"),
    )
    expect(capturedUpstreamHeaders[0]?.get("x-client-session-id")).toBe(
      capturedUpstreamHeaders[1]?.get("x-client-session-id"),
    )
    expect(capturedAuthorization[0]).toBe(capturedAuthorization[1])
  })

  test.each([
    {
      expectedParent: "parent-header",
      expectedTask: null,
      frameFields: { agent_task_id: "" },
      name: "blank task id",
    },
    {
      expectedParent: "parent-header",
      expectedTask: null,
      frameFields: { agent_task_id: 7 },
      name: "non-string task id",
    },
    {
      expectedParent: "parent-header",
      expectedTask: null,
      frameFields: { agent_task_id: "x".repeat(1025) },
      name: "oversized task id",
    },
    {
      expectedParent: "parent-header",
      expectedTask: null,
      frameFields: { agent_task_id: "bad\nvalue" },
      name: "control-character task id",
    },
    {
      expectedParent: "parent-header",
      expectedTask: "task-header",
      frameFields: {},
      name: "absent task id",
    },
    {
      expectedParent: null,
      expectedTask: "task-header",
      frameFields: { parent_agent_id: " " },
      name: "blank parent id",
    },
    {
      expectedParent: null,
      expectedTask: "task-header",
      frameFields: { parent_agent_id: false },
      name: "non-string parent id",
    },
    {
      expectedParent: null,
      expectedTask: "task-header",
      frameFields: { parent_agent_id: "x".repeat(1025) },
      name: "oversized parent id",
    },
    {
      expectedParent: null,
      expectedTask: "task-header",
      frameFields: { parent_agent_id: "bad\rvalue" },
      name: "control-character parent id",
    },
    {
      expectedParent: "parent-header",
      expectedTask: "task-header",
      frameFields: {},
      name: "absent parent id",
    },
  ])(
    "applies top-level precedence upstream for $name",
    async ({ expectedParent, expectedTask, frameFields }) => {
      state.models = responsesCapableModels
      const ws = createTestWebSocket()
      queuedResponses.push(createResponsesSseResponse("resp_precedence"))

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: "hello",
            headers: {
              "X-Agent-Task-Id": "task-header",
              "X-Parent-Agent-Id": "parent-header",
            },
            ...frameFields,
          }),
        ),
      )

      expect(capturedUpstreamHeaders[0]?.get("x-agent-task-id")).toBe(
        expectedTask ?? capturedUpstreamHeaders[0]?.get("x-interaction-id"),
      )
      expect(capturedUpstreamHeaders[0]?.get("x-parent-agent-id")).toBe(
        expectedParent,
      )
    },
  )

  test("preserves the top-level initiator on Chat fallback", async () => {
    installWebSocketEndpoint("/chat/completions")
    state.copilotToken = "copilot-token"
    const ws = createTestWebSocket()
    queuedResponses.push(createChatCompletionsSseResponse())

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "hello",
          initiator: "agent",
        }),
      ),
    )

    expect(capturedUpstreamHeaders[0]?.get("x-initiator")).toBe("agent")
  })

  test("sendWebSocketError emits CAPI-style error envelopes", () => {
    const ws = createTestWebSocket()

    sendWebSocketError(ws, {
      code: "server_error",
      message: "upstream failed",
      status: 502,
    })

    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "error",
      status: 502,
      error: {
        code: "server_error",
        message: "upstream failed",
        type: "websocket_error",
        request_id: "req-test",
      },
    })
  })

  test("preserves a structured session affinity error in the terminal frame", async () => {
    const modelId = "responses-websocket-session-affinity-error"
    const model = {
      ...responsesCapableModels.data[0],
      id: modelId,
      name: modelId,
    }
    state.models = { data: [model], object: "list" }
    for (const [id, token] of [
      [23_001, "websocket-bound-token"],
      [23_002, "websocket-alternate-token"],
    ] as const) {
      const account = tokenPool.addAccount(`github-${id}`, "individual", id)
      account.copilotToken = token
      account.healthy = true
      account.models = new Set([modelId])
      account.modelsData = [model]
    }
    tokenPool.rebuildModelIndex()
    state.isMultiToken = true
    const selected = tokenPool.getAccountForModelBySession(
      modelId,
      "session-test",
    )
    if (!selected) throw new TypeError("Expected selected WebSocket account")
    queuedResponses.push(new Response("Unauthorized", { status: 401 }))
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          input: "continue",
          model: modelId,
          type: "response.create",
        }),
      ),
    )

    const errorFrame = JSON.parse(ws.sent[0] ?? "{}") as {
      error?: { code?: string; message?: string; type?: string }
      status?: number
      type?: string
    }
    expect(errorFrame).toMatchObject({
      type: "error",
      status: 409,
      error: {
        code: "bad_request",
        message:
          "The bound account rejected this conversation; affinity was preserved and no cross-account retry was attempted.",
        type: "session_affinity_error",
      },
    })
    expect(ws.data.activeTurns.size).toBe(0)
    expect(capturedAuthorization).not.toContain(
      selected.id === 23_001 ?
        "Bearer websocket-alternate-token"
      : "Bearer websocket-bound-token",
    )
  })

  test("uses immutable safe local metadata across every WebSocket boundary", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    const safeMessage =
      "The selected Copilot model cannot accept this request without losing required protocol data."
    const privateMarkers = [
      "local-error-type-private-marker",
      "local-error-message-private-marker",
      "local-client-body-private-marker",
      "local-response-private-marker",
    ]
    let getterCalls = 0
    queuedFetchHandlers.push(() => {
      const clientBody = {
        error: {
          code: "endpoint_translation_unsupported",
          message: safeMessage,
          param: "opaque_reasoning",
          type: "invalid_request_error",
        },
      }
      const error = new LocalHTTPError(
        safeMessage,
        Response.json(clientBody, { status: 400 }),
        clientBody,
      ) as LocalHTTPError & { errorType?: string }
      error.errorType = "invalid_request_error"
      Object.defineProperty(error, "errorType", {
        configurable: true,
        get() {
          getterCalls += 1
          return privateMarkers[0]
        },
      })
      Object.defineProperty(error, "message", {
        configurable: true,
        get() {
          getterCalls += 1
          return privateMarkers[1]
        },
      })
      Object.defineProperty(error, "clientBody", {
        configurable: true,
        get() {
          getterCalls += 1
          return {
            error: {
              code: "private_code",
              message: privateMarkers[2],
              type: "server_error",
            },
          }
        },
      })
      Object.defineProperty(error, "response", {
        configurable: true,
        get() {
          getterCalls += 1
          return Response.json(
            { error: { message: privateMarkers[3] } },
            { status: 503 },
          )
        },
      })
      throw error
    })
    const ws = createTestWebSocket()
    const errorSpy = spyOn(consola, "error")
    const infoSpy = spyOn(console, "info").mockImplementation(() => undefined)
    const sentryLogSpy = spyOn(Sentry.logger, "info")

    try {
      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: [],
            tools: [],
          }),
        ),
      )
      const frame = JSON.parse(ws.sent.at(-1) ?? "{}") as {
        error?: { code?: string; message?: string; type?: string }
        status?: number
      }
      const diagnostics = JSON.stringify([
        ws.sent,
        errorSpy.mock.calls,
        infoSpy.mock.calls,
        sentryLogSpy.mock.calls,
      ])
      const infoValues: Array<unknown> = infoSpy.mock.calls.flat()
      const lifecycleLine = infoValues.find(
        (value) => typeof value === "string" && value.includes("REJECTED"),
      )
      const sentryTerminalCall = sentryLogSpy.mock.calls.find(
        ([message]) =>
          typeof message === "string" && message.startsWith("REJECTED "),
      )
      const errorValues: Array<unknown> = errorSpy.mock.calls.flat()
      const structuredLog = errorValues.find(
        (value) => typeof value === "object" && value !== null,
      )
      const telemetry = getRoutingTelemetrySnapshot({
        accounts: [],
        multiToken: false,
        window: "1h",
      })

      expect(frame).toMatchObject({
        status: 400,
        error: {
          code: "bad_request",
          message: safeMessage,
          type: "invalid_request_error",
        },
      })
      expect(lifecycleLine).toContain(safeMessage)
      expect(sentryTerminalCall?.[1]).toMatchObject({
        error: safeMessage,
        status: 400,
        terminalStatus: "REJECTED",
      })
      expect(structuredLog).toMatchObject({
        code: "bad_request",
        status: 400,
      })
      expect(telemetry.models[0]).toMatchObject({
        model: "gpt-5.4",
        requests: 1,
      })
      expect(getterCalls).toBe(0)
      for (const marker of privateMarkers) {
        expect(diagnostics).not.toContain(marker)
      }
    } finally {
      sentryLogSpy.mockRestore()
      infoSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  test("streams native Responses SSE events as WebSocket JSON frames", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(createResponsesSseResponse("resp_ws"))
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Hello" }],
            },
          ],
          tools: [],
        }),
      ),
    )

    const eventTypes = ws.sent.map(
      (frame) => (JSON.parse(frame) as { type: string }).type,
    )
    expect(eventTypes).toEqual(["response.created", "response.completed"])
    expect(lastRequestBody?.previous_response_id).toBeUndefined()
    expect(ws.data.responseSnapshots.has("resp_ws")).toBe(true)
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test("applies redirect verbosity to native Responses WebSocket turns", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    setModelRedirectsForTest([
      {
        id: "responses-websocket-verbosity",
        sourceModel: "gpt-5.4",
        sourceEffort: "all",
        targetModel: "gpt-5.4",
        targetVerbosity: "high",
        enabled: true,
      },
    ])
    queuedResponses.push(createResponsesSseResponse("resp_ws_verbosity"))
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Explain this.",
          text: {
            verbosity: "low",
            format: { type: "json_object" },
          },
        }),
      ),
    )

    expect(lastRequestBody?.text).toEqual({
      verbosity: "high",
      format: { type: "json_object" },
    })
    expect(ws.data.responseSnapshots.has("resp_ws_verbosity")).toBe(true)
  })

  test("routes priority WebSocket turns to the available fast model", async () => {
    const normalModel = {
      ...responsesCapableModels.data[0],
      id: "gpt-ws-priority",
      name: "GPT WS Priority",
    }
    const fastModel = {
      ...responsesCapableModels.data[0],
      id: "gpt-ws-priority-fast",
      name: "GPT WS Priority Fast",
    }
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = { object: "list", data: [normalModel, fastModel] }
    queuedResponses.push(createResponsesSseResponse("resp_ws_priority"))
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: normalModel.id,
          input: "Use fast mode",
          service_tier: "priority",
        }),
      ),
    )

    expect(lastRequestBody?.model).toBe(fastModel.id)
    expect(lastRequestBody).not.toHaveProperty("service_tier")
    const completed = ws.sent
      .map(
        (frame) =>
          JSON.parse(frame) as {
            response?: { model?: string }
            type?: string
          },
      )
      .find((frame) => frame.type === "response.completed")
    expect(completed?.response?.model).toBe(normalModel.id)
    expect(ws.data.responseSnapshots.has("resp_ws_priority")).toBe(true)
  })

  test("does not change WebSocket reasoning effort when routing to fast", async () => {
    const normalModel = {
      ...responsesCapableModels.data[0],
      id: "gpt-ws-priority-effort",
      name: "GPT WS Priority Effort",
      capabilities: {
        ...responsesCapableModels.data[0].capabilities,
        supports: { reasoning_effort: ["high"] },
      },
    }
    const fastModel = {
      ...responsesCapableModels.data[0],
      id: "gpt-ws-priority-effort-fast",
      name: "GPT WS Priority Effort Fast",
      capabilities: {
        ...responsesCapableModels.data[0].capabilities,
        supports: { reasoning_effort: ["low"] },
      },
    }
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = { object: "list", data: [normalModel, fastModel] }
    queuedResponses.push(createResponsesSseResponse("resp_ws_priority_effort"))
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: normalModel.id,
          input: "Use fast mode",
          reasoning: { effort: "high" },
          service_tier: "priority",
        }),
      ),
    )

    expect(lastRequestBody?.model).toBe(fastModel.id)
    expect(lastRequestBody?.reasoning).toMatchObject({ effort: "high" })
  })

  test("keeps priority WebSocket continuations on the fast snapshot model", async () => {
    const normalModel = {
      ...responsesCapableModels.data[0],
      id: "gpt-ws-priority-continuation",
      name: "GPT WS Priority Continuation",
    }
    const fastModel = {
      ...responsesCapableModels.data[0],
      id: "gpt-ws-priority-continuation-fast",
      name: "GPT WS Priority Continuation Fast",
    }
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = { object: "list", data: [normalModel, fastModel] }
    queuedResponses.push(
      createResponsesSseResponse("resp_ws_priority_parent"),
      createResponsesSseResponse("resp_ws_priority_child"),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: normalModel.id,
          input: "First",
          service_tier: "priority",
        }),
      ),
    )
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: normalModel.id,
          input: "Continue",
          previous_response_id: "resp_ws_priority_parent",
          service_tier: "priority",
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(lastRequestBody?.model).toBe(fastModel.id)
    expect(lastRequestBody).not.toHaveProperty("service_tier")
    expect(ws.data.responseSnapshots.has("resp_ws_priority_child")).toBe(true)
  })

  test("does not route WebSocket turns to custom-only fast models", async () => {
    const normalModel = {
      ...responsesCapableModels.data[0],
      id: "gpt-ws-custom-only-fast",
      name: "GPT WS Custom Only Fast",
    }
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = { object: "list", data: [normalModel] }
    setConfigForTest({
      customProviders: [
        {
          id: "ws-fast-provider",
          name: "WS Fast Provider",
          type: "openai-compatible",
          baseUrl: "https://ws-fast.example/v1",
          apiKey: "ws-fast-key",
          models: [
            {
              id: `${normalModel.id}-fast`,
              kind: "chat",
              supportsStreaming: true,
            },
          ],
        },
      ],
    })
    queuedResponses.push(createResponsesSseResponse("resp_ws_normal"))
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: normalModel.id,
          input: "Use supported WebSocket routing",
          service_tier: "priority",
        }),
      ),
    )

    expect(lastRequestBody?.model).toBe(normalModel.id)
    expect(lastRequestBody).not.toHaveProperty("service_tier")
  })

  test("does not retry a native WebSocket compatibility 400", async () => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      Response.json(
        {
          error: {
            code: "invalid_request_body",
            message:
              "Unsupported parameter: 'temperature' is not supported with this model.",
          },
        },
        { status: 400 },
      ),
      createResponsesSseResponse("must_not_send"),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "hello",
          temperature: 1,
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "error",
      status: 400,
      error: { code: "invalid_request_body" },
    })
  })

  test("does not retry a Chat-backed WebSocket compatibility 400", async () => {
    installWebSocketEndpoint("/chat/completions")
    queuedResponses.push(
      Response.json(
        {
          error: {
            code: "invalid_request_body",
            message:
              "Unsupported parameter: 'temperature' is not supported with this model.",
          },
        },
        { status: 400 },
      ),
      createChatCompletionsSseResponse(),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "hello",
          temperature: 1,
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "error",
      status: 400,
      error: { code: "invalid_request_body" },
    })
  })

  test("completes a native turn when upstream omits terminal output_text", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      createResponsesSseResponse(
        "resp_ws_missing_output_text",
        [
          {
            id: "msg_ws_missing_output_text",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Hello world",
                annotations: [],
              },
            ],
          },
        ],
        { omitCompletedOutputText: true },
      ),
    )
    const ws = createTestWebSocket()
    const infoSpy = spyOn(console, "info").mockImplementation(() => undefined)

    try {
      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Hello" }],
              },
            ],
            tools: [],
          }),
        ),
      )

      const frames = ws.sent.map(
        (frame) =>
          JSON.parse(frame) as {
            response?: { output_text?: string }
            type?: string
          },
      )
      const terminal = frames.find(
        (frame) =>
          frame.type === "error"
          || frame.type === "response.completed"
          || frame.type === "response.failed",
      )
      const lifecycleLines = infoSpy.mock.calls
        .flat()
        .filter((value): value is string => typeof value === "string")
      const completeLines = lifecycleLines.filter((line) =>
        line.includes("COMPLETE"),
      )

      expect(terminal?.type).toBe("response.completed")
      expect(terminal?.response?.output_text).toBe("Hello world")
      expect(
        frames.some(
          (frame) => frame.type === "error" || frame.type === "response.failed",
        ),
      ).toBe(false)
      expect(ws.data.activeTurns.size).toBe(0)
      expect(completeLines).toHaveLength(1)
      expect(completeLines[0]).toContain("200")
      expect(lifecycleLines.some((line) => line.includes("ERROR"))).toBe(false)
    } finally {
      infoSpy.mockRestore()
    }
  })

  test("uses per-frame metadata affinity and preserves handshake precedence", async () => {
    state.models = responsesCapableModels
    queuedResponses.push(
      createResponsesSseResponse("resp_frame_affinity"),
      createResponsesSseResponse("resp_handshake_affinity"),
      createResponsesSseResponse("resp_malformed_affinity"),
    )
    const metadataOnly = createTestWebSocket()
    metadataOnly.data.affinity = undefined
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        metadataOnly,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "hello",
          client_metadata: { session_id: "frame-session" },
        }),
      ),
    )
    expect(capturedAffinity).toEqual({
      key: "frame-session",
      source: "codex_metadata",
    })

    const handshake = createTestWebSocket()
    handshake.data.affinity = {
      key: "handshake-session",
      source: "copilot_session",
    }
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        handshake,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "hello",
          client_metadata: { session_id: "conflicting-frame-session" },
        }),
      ),
    )
    expect(capturedAffinity).toEqual(handshake.data.affinity)

    const malformed = createTestWebSocket()
    malformed.data.affinity = undefined
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        malformed,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "hello",
          client_metadata: "not json",
        }),
      ),
    )
    expect(capturedAffinity).toBeUndefined()
  })

  test("routes a Codex fork through the parent account and upstream session", async () => {
    const model = "ws-fork-affinity-model"
    const firstAccount = tokenPool.addAccount(
      "github-ws-fork-a",
      "individual",
      webSocketAccountIds[0],
    )
    firstAccount.copilotToken = "ws-fork-child-token"
    firstAccount.healthy = true
    firstAccount.models = new Set([model])
    firstAccount.modelsData = [createWebSocketModel(model)]
    const secondAccount = tokenPool.addAccount(
      "github-ws-fork-b",
      "individual",
      webSocketAccountIds[1],
    )
    secondAccount.copilotToken = "ws-fork-parent-token"
    secondAccount.healthy = true
    secondAccount.models = new Set([model])
    secondAccount.modelsData = [createWebSocketModel(model)]
    tokenPool.rebuildModelIndex()
    state.isMultiToken = true
    queuedResponses.push(
      createResponsesSseResponse("resp_fork_affinity"),
      createResponsesSseResponse("resp_fork_follow_up"),
    )

    const ws = createTestWebSocket()
    ws.data.affinity = {
      key: "fork-child-1",
      source: "codex_session",
    }
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model,
          input: "continue the fork",
          client_metadata: {
            session_id: "fork-child-1",
            thread_id: "fork-child-1",
            "x-codex-turn-metadata": JSON.stringify({
              forked_from_thread_id: "fork-parent-0",
            }),
          },
        }),
      ),
    )

    expect(capturedAffinity).toEqual({
      key: "fork-parent-0",
      source: "codex_thread",
    })
    expect(capturedAuthorization).toEqual(["Bearer ws-fork-parent-token"])
    expect(capturedUpstreamHeaders[0]?.get("x-client-session-id")).toBe(
      "81e3167a-de1a-5ffa-8c20-f832dc0e2909",
    )
    expect(capturedUpstreamHeaders[0]?.get("x-interaction-id")).toBe(
      "81e3167a-de1a-5ffa-8c20-f832dc0e2909",
    )

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model,
          input: "continue after the first fork turn",
          client_metadata: {
            session_id: "fork-child-1",
            thread_id: "fork-child-1",
          },
        }),
      ),
    )

    expect(capturedAuthorization).toEqual([
      "Bearer ws-fork-parent-token",
      "Bearer ws-fork-parent-token",
    ])
    expect(
      capturedUpstreamHeaders.map((headers) =>
        headers.get("x-client-session-id"),
      ),
    ).toEqual([
      "81e3167a-de1a-5ffa-8c20-f832dc0e2909",
      "81e3167a-de1a-5ffa-8c20-f832dc0e2909",
    ])
  })

  test("preserves unrelated WebSocket handshake affinity over fork metadata", async () => {
    state.models = responsesCapableModels
    queuedResponses.push(createResponsesSseResponse("resp_fork_unrelated"))
    const ws = createTestWebSocket()
    ws.data.affinity = {
      key: "unrelated-handshake",
      source: "copilot_session",
    }

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "independent request",
          client_metadata: {
            session_id: "fork-child",
            thread_id: "fork-child",
            "x-codex-turn-metadata": JSON.stringify({
              forked_from_thread_id: "fork-parent",
            }),
          },
        }),
      ),
    )

    expect(capturedAffinity).toEqual({
      key: "unrelated-handshake",
      source: "copilot_session",
    })
  })

  test("inherits affinity from a completed continuation snapshot", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      createResponsesSseResponse("resp_affinity_parent"),
      createResponsesSseResponse("resp_affinity_child"),
    )
    const ws = createTestWebSocket()
    ws.data.affinity = undefined
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "first",
          client_metadata: { session_id: "snapshot-session" },
        }),
      ),
    )
    expect(ws.data.responseSnapshots.has("resp_affinity_parent")).toBe(true)

    capturedAffinity = undefined as RoutingAffinity | undefined
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "follow-up",
          previous_response_id: "resp_affinity_parent",
        }),
      ),
    )

    expect(capturedAffinity).toEqual({
      key: "snapshot-session",
      source: "codex_metadata",
    })
    expect(lastRequestBody?.previous_response_id).toBeUndefined()
  })

  test("normalizes redirected continuation models with the requested verbosity", async () => {
    const modelA = "ws-verbosity-cycle-a"
    const modelB = "ws-verbosity-cycle-b"
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      object: "list",
      data: [
        { ...responsesCapableModels.data[0], id: modelA, name: modelA },
        { ...responsesCapableModels.data[0], id: modelB, name: modelB },
      ],
    }
    setModelRedirectsForTest([
      {
        id: "verbosity-cycle-a-to-b",
        sourceModel: modelA,
        sourceEffort: "all",
        targetModel: modelB,
        targetVerbosity: "high",
        enabled: true,
      },
      {
        id: "verbosity-cycle-b-to-a",
        sourceModel: modelB,
        sourceEffort: "all",
        targetModel: modelA,
        targetVerbosity: "low",
        enabled: true,
      },
    ])
    queuedResponses.push(
      createResponsesSseResponse("resp_verbosity_cycle_parent"),
      createResponsesSseResponse("resp_verbosity_cycle_child"),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: modelA,
          input: "first",
          text: { verbosity: "low" },
        }),
      ),
    )
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: modelA,
          input: "follow-up",
          previous_response_id: "resp_verbosity_cycle_parent",
          text: { verbosity: "low" },
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ws.data.responseSnapshots.has("resp_verbosity_cycle_child")).toBe(
      true,
    )
  })

  test("rejects model or affinity replacement locally and keeps the socket on the original account", async () => {
    const modelA = "ws-continuation-model-a"
    const modelB = "ws-continuation-model-b"
    const firstAccount = tokenPool.addAccount(
      "github-ws-continuation-a",
      "individual",
      webSocketAccountIds[0],
    )
    firstAccount.copilotToken = "ws-continuation-token-a"
    firstAccount.healthy = true
    firstAccount.models = new Set([modelA, modelB])
    firstAccount.modelsData = [
      createWebSocketModel(modelA),
      createWebSocketModel(modelB),
    ]
    const secondAccount = tokenPool.addAccount(
      "github-ws-continuation-b",
      "individual",
      webSocketAccountIds[1],
    )
    secondAccount.copilotToken = "ws-continuation-token-b"
    secondAccount.healthy = true
    secondAccount.models = new Set([modelA, modelB])
    secondAccount.modelsData = [
      createWebSocketModel(modelA),
      createWebSocketModel(modelB),
    ]
    tokenPool.rebuildModelIndex()
    state.models = tokenPool.getAllModels()
    state.isMultiToken = true

    const firstAffinity = findWebSocketAffinity(modelA, firstAccount.id)
    const replacementAffinity = findWebSocketAffinity(modelA, secondAccount.id)
    const modelBReplacementAffinity = findWebSocketAffinity(
      modelB,
      secondAccount.id,
    )
    queuedResponses.push(
      createResponsesSseResponse("resp_ws_consistent_parent"),
      createResponsesSseResponse("resp_ws_consistent_child"),
    )
    const ws = createTestWebSocket()
    ws.data.affinity = undefined

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: modelA,
          input: "first",
          client_metadata: { session_id: firstAffinity },
        }),
      ),
    )
    expect(capturedAuthorization).toEqual(["Bearer ws-continuation-token-a"])

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: modelB,
          input: "must reject",
          client_metadata: { session_id: modelBReplacementAffinity },
          previous_response_id: "resp_ws_consistent_parent",
        }),
      ),
    )

    const rejection = JSON.parse(ws.sent.at(-1) ?? "{}") as {
      error?: {
        code?: string
        message?: string
        request_id?: string
        type?: string
      }
      status?: number
      type?: string
    }
    expect(rejection).toEqual({
      type: "error",
      status: 400,
      error: {
        code: "invalid_request_error",
        message: "Continuation model must match the previous response model.",
        type: "invalid_request_error",
        request_id: "req-test",
      },
    })
    expect(JSON.stringify(rejection)).not.toContain(modelA)
    expect(JSON.stringify(rejection)).not.toContain(modelB)
    expect(JSON.stringify(rejection)).not.toContain(firstAffinity)
    expect(JSON.stringify(rejection)).not.toContain(modelBReplacementAffinity)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ws.data.closed).toBe(false)

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          input: "valid continuation",
          client_metadata: { session_id: replacementAffinity },
          previous_response_id: "resp_ws_consistent_parent",
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(capturedAuthorization).toEqual([
      "Bearer ws-continuation-token-a",
      "Bearer ws-continuation-token-a",
    ])
    expect(capturedAffinity).toEqual({
      key: firstAffinity,
      source: "codex_metadata",
    })
    expect(lastRequestBody).toMatchObject({
      model: modelA,
      client_metadata: { session_id: firstAffinity },
    })
    expect(ws.data.responseSnapshots.has("resp_ws_consistent_child")).toBe(true)
    expect(ws.data.closed).toBe(false)
  })

  test("keeps serialized continuation metadata on the original account", async () => {
    const model = "ws-string-continuation-model"
    const firstAccount = tokenPool.addAccount(
      "github-ws-string-continuation-a",
      "individual",
      webSocketAccountIds[0],
    )
    firstAccount.copilotToken = "ws-string-continuation-token-a"
    firstAccount.healthy = true
    firstAccount.models = new Set([model])
    firstAccount.modelsData = [createWebSocketModel(model)]
    const secondAccount = tokenPool.addAccount(
      "github-ws-string-continuation-b",
      "individual",
      webSocketAccountIds[1],
    )
    secondAccount.copilotToken = "ws-string-continuation-token-b"
    secondAccount.healthy = true
    secondAccount.models = new Set([model])
    secondAccount.modelsData = [createWebSocketModel(model)]
    tokenPool.rebuildModelIndex()
    state.models = tokenPool.getAllModels()
    state.isMultiToken = true

    const firstAffinity = findWebSocketAffinity(model, firstAccount.id)
    const replacementAffinity = findWebSocketAffinity(model, secondAccount.id)
    queuedResponses.push(
      createResponsesSseResponse("resp_ws_string_parent"),
      createResponsesSseResponse("resp_ws_string_child"),
    )
    const ws = createTestWebSocket()
    ws.data.affinity = undefined

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model,
          input: "first history item",
          client_metadata: JSON.stringify({
            session_id: firstAffinity,
            thread_id: "original-thread",
          }),
        }),
      ),
    )
    expect(capturedAuthorization).toEqual([
      "Bearer ws-string-continuation-token-a",
    ])

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          input: "valid continuation",
          client_metadata: JSON.stringify({
            session_id: replacementAffinity,
            thread_id: "replacement-thread",
            request_kind: "compaction",
          }),
          previous_response_id: "resp_ws_string_parent",
        }),
      ),
    )

    expect(capturedAuthorization).toEqual([
      "Bearer ws-string-continuation-token-a",
      "Bearer ws-string-continuation-token-a",
    ])
    expect(capturedAffinity).toEqual({
      key: firstAffinity,
      source: "codex_metadata",
    })
    expect(lastRequestBody).toMatchObject({
      model,
      client_metadata: {
        session_id: firstAffinity,
        thread_id: "original-thread",
        request_kind: "compaction",
      },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first history item" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "valid continuation" }],
        },
      ],
    })
    expect(JSON.stringify(lastRequestBody)).not.toContain(replacementAffinity)
    expect(ws.data.responseSnapshots.has("resp_ws_string_child")).toBe(true)
    expect(ws.data.closed).toBe(false)
  })

  test("isolates concurrent WebSocket turn lifecycle contexts", async () => {
    const firstWs = createTestWebSocket()
    const secondWs = createTestWebSocket()
    const firstTurn = createResponsesWebSocketTurn(firstWs.data, "first")
    const secondTurn = createResponsesWebSocketTurn(secondWs.data, "second")
    let releaseFirst: (() => void) | undefined
    let releaseSecond: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const observed: Array<{
      accountId?: number
      affinity?: string
      metadata?: string
      taskId?: string
    }> = []

    const first = runWithWebSocketRequestContext(
      { key: "first-turn", source: "codex_metadata" },
      { agentTaskId: "first-task" },
      firstTurn,
      async () => {
        setCopilotResponseHeader("x-copilot-service-request-id", "first")
        setLastUsedRoutedAccountId(101)
        observed.push(readCurrentWebSocketLifecycleContext())
        await firstGate
        observed.push(readCurrentWebSocketLifecycleContext())
      },
    )
    const second = runWithWebSocketRequestContext(
      { key: "second-turn", source: "codex_metadata" },
      { agentTaskId: "second-task" },
      secondTurn,
      async () => {
        setCopilotResponseHeader("x-copilot-service-request-id", "second")
        setLastUsedRoutedAccountId(202)
        observed.push(readCurrentWebSocketLifecycleContext())
        await secondGate
        observed.push(readCurrentWebSocketLifecycleContext())
      },
    )

    releaseSecond?.()
    await second
    releaseFirst?.()
    await first
    expect(observed).toEqual([
      {
        accountId: 101,
        affinity: "first-turn",
        metadata: "first",
        taskId: "first-task",
      },
      {
        accountId: 202,
        affinity: "second-turn",
        metadata: "second",
        taskId: "second-task",
      },
      {
        accountId: 202,
        affinity: "second-turn",
        metadata: "second",
        taskId: "second-task",
      },
      {
        accountId: 101,
        affinity: "first-turn",
        metadata: "first",
        taskId: "first-task",
      },
    ])
    expect(getRoutingAffinity()).toBeUndefined()
    expect(getCopilotRequestAttribution()).toBeUndefined()
    expect(getCopilotResponseHeaders()).toEqual({})
    expect(firstTurn.routingState.lastUsedAccountId).toBe(101)
    expect(secondTurn.routingState.lastUsedAccountId).toBe(202)
  })

  test.each(
    typedCases<WebSocketResponseMetadataCase>([
      {
        expectedHeaders: undefined,
        expectedQuota: undefined,
        name: "neither metadata category",
        responseHeaders: {},
      },
      {
        expectedHeaders: {
          "x-copilot-service-request-id": "service-nonquota",
        },
        expectedQuota: undefined,
        name: "non-quota metadata only",
        responseHeaders: {
          "x-copilot-service-request-id": "service-nonquota",
        },
      },
      {
        expectedHeaders: undefined,
        expectedQuota: { premium_interactions: "ent=100&rem=50" },
        name: "quota metadata only",
        responseHeaders: {
          "x-quota-snapshot-premium_interactions": "ent=100&rem=50",
        },
      },
      {
        expectedHeaders: {
          "x-copilot-api-exp-assignment-context": "flight:1;",
          "x-copilot-service-request-id": "service-both",
        },
        expectedQuota: { premium_interactions: "ent=100&rem=50" },
        name: "both metadata categories",
        responseHeaders: {
          "retry-after": "15",
          "x-copilot-api-exp-assignment-context": "flight:1;",
          "x-copilot-service-request-id": "service-both",
          "x-quota-snapshot-premium_interactions": "ent=100&rem=50",
          "x-usage-ratelimit-remaining": "private-rate-state",
        },
      },
    ]),
  )(
    "reconstructs $name from only the safe response store",
    async ({ expectedHeaders, expectedQuota, responseHeaders }) => {
      state.copilotToken = "copilot-token"
      state.models = responsesCapableModels
      queuedResponses.push(
        createResponsesSseResponse("resp_metadata", [], {
          frameFields: {
            copilot_quota_snapshots: {
              private_quota: "frame-private-quota",
            },
            headers: {
              authorization: "Bearer frame-private-auth",
              cookie: "frame-private-cookie",
              private: "frame-private-header",
            },
          },
          headers: responseHeaders,
        }),
      )
      const ws = createTestWebSocket()

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            input: "metadata",
            model: "gpt-5.4",
            type: "response.create",
          }),
        ),
      )

      const frames = ws.sent.map(
        (frame) =>
          JSON.parse(frame) as {
            copilot_quota_snapshots?: Record<string, string>
            headers?: Record<string, string>
            type?: string
          },
      )
      expect(frames.map((frame) => frame.type)).toEqual([
        "response.created",
        "response.completed",
      ])
      for (const frame of frames) {
        expect(frame.headers).toEqual(expectedHeaders)
        expect(frame.copilot_quota_snapshots).toEqual(expectedQuota)
        const serialized = JSON.stringify(frame)
        expect(serialized).not.toContain("frame-private-auth")
        expect(serialized).not.toContain("frame-private-cookie")
        expect(serialized).not.toContain("frame-private-header")
        expect(serialized).not.toContain("frame-private-quota")
        expect(serialized).not.toContain("retry-after")
        expect(serialized).not.toContain("usage-ratelimit")
        expect(serialized).not.toContain("private-rate-state")
      }
    },
  )

  test("keeps metadata isolated across concurrent WebSocket turns", async () => {
    state.models = responsesCapableModels
    const resolvers: Array<(response: Response) => void> = []
    for (let index = 0; index < 2; index += 1) {
      queuedFetchHandlers.push(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve)
          }),
      )
    }
    const ws = createTestWebSocket()

    const first = seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          input: "first",
          model: "gpt-5.4",
          type: "response.create",
        }),
      ),
    )
    const second = seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          input: "second",
          model: "gpt-5.4",
          type: "response.create",
        }),
      ),
    )
    await waitFor(() => resolvers.length === 2)

    resolvers[1]?.(
      createResponsesSseResponse("resp_metadata_second", [], {
        headers: { "x-copilot-service-request-id": "service-second" },
      }),
    )
    resolvers[0]?.(
      createResponsesSseResponse("resp_metadata_first", [], {
        headers: { "x-copilot-service-request-id": "service-first" },
      }),
    )
    await Promise.all([first, second])

    const terminalById = new Map(
      ws.sent
        .map(
          (frame) =>
            JSON.parse(frame) as {
              headers?: Record<string, string>
              response?: { id?: string }
              type?: string
            },
        )
        .filter((frame) => frame.type === "response.completed")
        .map((frame) => [frame.response?.id, frame.headers] as const),
    )
    expect(terminalById.get("resp_metadata_first")).toEqual({
      "x-copilot-service-request-id": "service-first",
    })
    expect(terminalById.get("resp_metadata_second")).toEqual({
      "x-copilot-service-request-id": "service-second",
    })
  })

  test.each(
    typedCases<WebSocketMetadataCase>([
      {
        expectedHeaders: undefined,
        expectedQuota: undefined,
        headers: {},
        name: "neither metadata category",
      },
      {
        expectedHeaders: {
          "x-copilot-service-request-id": "service-nonquota",
        },
        expectedQuota: undefined,
        headers: { "x-copilot-service-request-id": "service-nonquota" },
        name: "non-quota metadata only",
      },
      {
        expectedHeaders: undefined,
        expectedQuota: { chat: "ent=10&rem=9" },
        headers: { "x-quota-snapshot-chat": "ent=10&rem=9" },
        name: "quota metadata only",
      },
      {
        expectedHeaders: {
          "x-copilot-service-request-id": "service-both",
        },
        expectedQuota: { chat: "ent=10&rem=9" },
        headers: {
          "retry-after": "15",
          "x-copilot-service-request-id": "service-both",
          "x-quota-snapshot-chat": "ent=10&rem=9",
          "x-usage-ratelimit-remaining": "private-rate-state",
        },
        name: "both metadata categories",
      },
    ]),
  )(
    "replaces reserved frame fields for $name while preserving usage",
    ({ expectedHeaders, expectedQuota, headers, name: _name }) => {
      const invalid = "not-json"
      const delta = JSON.stringify({
        delta: "hello",
        type: "response.output_text.delta",
      })
      const completed = JSON.stringify({
        copilot_usage: { total_nano_aiu: 123 },
        copilot_quota_snapshots: { private: "frame-private-quota" },
        headers: {
          authorization: "Bearer frame-private-auth",
          cookie: "frame-private-cookie",
          private: "frame-private-header",
        },
        response: { id: "resp_usage" },
        type: "response.completed",
      })

      expect(addResponsesWebSocketMetadata(invalid, headers)).toBe(invalid)
      expect(addResponsesWebSocketMetadata(delta, headers)).toBe(delta)
      expect(
        JSON.parse(addResponsesWebSocketMetadata(completed, headers)),
      ).toEqual({
        copilot_usage: { total_nano_aiu: 123 },
        response: { id: "resp_usage" },
        type: "response.completed",
        ...(expectedHeaders === undefined ? {} : { headers: expectedHeaders }),
        ...(expectedQuota === undefined ?
          {}
        : { copilot_quota_snapshots: expectedQuota }),
      })
    },
  )

  test("streams the Chat Completions fallback with a per-turn abort signal", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        supported_endpoints: ["/chat/completions"],
      })),
    }
    let upstreamSignal: AbortSignal | null | undefined
    queuedFetchHandlers.push((init) => {
      upstreamSignal = init?.signal
      return createChatCompletionsSseResponse()
    })
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Hello",
          tools: [],
        }),
      ),
    )

    expect(upstreamSignal).toBeInstanceOf(AbortSignal)
    expect(
      ws.sent.some(
        (frame) =>
          (JSON.parse(frame) as { type?: string }).type
          === "response.completed",
      ),
    ).toBe(true)
    expect(ws.data.activeTurns.size).toBe(0)
    const frames = ws.sent.map(
      (frame) => JSON.parse(frame) as { type?: string },
    )
    expect(frames.at(-1)?.type).toBe("response.completed")
    expect(ws.sent).not.toContain("[DONE]")
  })

  test("routes a Messages-only WebSocket model through native Messages", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          ...model.capabilities,
          limits: { max_output_tokens: 4096 },
          supports: { reasoning_effort: ["medium"] },
        },
      })),
    }
    queuedResponses.push(
      Response.json({
        id: "msg_ws_messages",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Hello from Messages" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Hello",
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ws.sent.some((frame) => frame.includes("Hello from Messages"))).toBe(
      true,
    )
    expect(lastRequestBody).toMatchObject({
      model: "gpt-5.4",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    })
  })

  test("forwards handshake native headers on a Messages-only WebSocket turn", async () => {
    installWebSocketEndpoint("/v1/messages")
    queuedResponses.push(createAnthropicMessageResponse("msg_ws_headers"))
    const ws = await createUpgradedTestWebSocket({
      "anthropic-beta": "beta-one, beta-two, beta-one",
      "anthropic-version": "2024-01-01",
      "x-client-session-id": "ws-native-session",
      "x-model-provider-preference": "anthropic",
      "x-request-id": "req-ws-native",
    })

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Hello",
        }),
      ),
    )

    const headers = capturedUpstreamHeaders[0]
    expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
    expect(headers.get("anthropic-version")).toBe("2024-01-01")
    expect(headers.get("x-model-provider-preference")).toBe("anthropic")
    expect(headers.get("x-request-id")).toBe("req-ws-native:1")
    expect(headers.get("x-initiator")).toBe("user")
    expect(capturedAffinity).toEqual({
      key: "ws-native-session",
      source: "copilot_session",
    })
    expect(ws.data.responseSnapshots.has("msg_ws_headers")).toBe(true)
  })

  test("persists only frame native Messages options across turns", async () => {
    installWebSocketEndpoint("/v1/messages")
    queuedResponses.push(
      createAnthropicMessageResponse("msg_ws_frame_one"),
      createAnthropicMessageResponse("msg_ws_frame_two"),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "one",
          headers: {
            "anthropic-beta": "beta-one,beta-one",
            "anthropic-version": "2024-01-01",
            "x-model-provider-preference": "anthropic",
            authorization: "Bearer must-not-pass",
            "copilot-session-token": "must-not-pass",
            "x-agent-task-id": "task-first",
          },
        }),
      ),
    )
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "two",
        }),
      ),
    )

    expect(capturedUpstreamHeaders).toHaveLength(2)
    for (const headers of capturedUpstreamHeaders) {
      expect(headers.get("anthropic-beta")).toBe("beta-one")
      expect(headers.get("anthropic-version")).toBe("2024-01-01")
      expect(headers.get("x-model-provider-preference")).toBe("anthropic")
      expect(headers.get("authorization")).not.toBe("Bearer must-not-pass")
      expect(headers.get("copilot-session-token")).not.toBe("must-not-pass")
    }
    expect(capturedUpstreamHeaders[0]?.get("x-agent-task-id")).toBe(
      "task-first",
    )
    expect(capturedUpstreamHeaders[1]?.get("x-agent-task-id")).not.toBe(
      "task-first",
    )
  })

  test("reports the requested model after a Messages WebSocket redirect", async () => {
    const requestedModel = "claude-ws-alias"
    const targetModel = "claude-ws-target"
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.isMultiToken = false
    installWebSocketMessagesModel(targetModel)
    setModelRedirectsForTest([
      {
        id: "ws-alias-to-target",
        sourceModel: requestedModel,
        sourceEffort: "default",
        targetModel,
        enabled: true,
      },
    ])
    queuedResponses.push(
      createAnthropicMessageResponse("msg_ws_redirect", targetModel),
    )
    const ws = await createUpgradedTestWebSocket({
      "anthropic-beta": "beta-one, beta-two",
      "anthropic-version": "2024-01-01",
      "x-client-session-id": "ws-redirect-session",
      "x-model-provider-preference": "anthropic",
      "x-request-id": "req-ws-redirect",
    })

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: requestedModel,
          input: "Hello",
        }),
      ),
    )

    expect(lastRequestBody?.model).toBe(targetModel)
    const completed = ws.sent
      .map(
        (frame) =>
          JSON.parse(frame) as {
            response?: { model?: string }
            type?: string
          },
      )
      .find((frame) => frame.type === "response.completed")
    expect(completed?.response?.model).toBe(requestedModel)
    const headers = capturedUpstreamHeaders[0]
    expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
    expect(headers.get("anthropic-version")).toBe("2024-01-01")
    expect(headers.get("x-model-provider-preference")).toBe("anthropic")
    expect(headers.get("x-request-id")).toBe("req-ws-redirect:1")
    expect(headers.get("x-initiator")).toBe("user")
    expect(capturedAffinity).toEqual({
      key: "ws-redirect-session",
      source: "copilot_session",
    })
  })

  test("preserves handshake native headers across transport retry", async () => {
    installWebSocketEndpoint("/v1/messages")
    queuedResponses.push(
      new Response("retry", {
        status: 503,
        headers: { "retry-after": "0" },
      }),
      createAnthropicMessageResponse("msg_ws_retry"),
    )
    const ws = await createUpgradedTestWebSocket({
      "anthropic-beta": "beta-one, beta-two",
      "anthropic-version": "2024-01-01",
      "x-model-provider-preference": "anthropic",
      "x-request-id": "req-ws-retry",
    })

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Hello",
        }),
      ),
    )

    expect(capturedUpstreamHeaders).toHaveLength(2)
    for (const headers of capturedUpstreamHeaders) {
      expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
      expect(headers.get("anthropic-version")).toBe("2024-01-01")
      expect(headers.get("x-model-provider-preference")).toBe("anthropic")
      expect(headers.get("x-request-id")).toBe("req-ws-retry:1")
    }
  })

  test("omits invalid handshake native headers without failing a Messages turn", async () => {
    installWebSocketEndpoint("/v1/messages")
    queuedResponses.push(createAnthropicMessageResponse("msg_ws_invalid"))
    const ws = await createUpgradedTestWebSocket({
      "anthropic-beta": "beta one",
      "anthropic-version": "v".repeat(1025),
      "x-model-provider-preference": "p".repeat(1025),
    })

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Hello",
        }),
      ),
    )

    const headers = capturedUpstreamHeaders[0]
    expect(headers.get("anthropic-beta")).toBeNull()
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(headers.get("x-model-provider-preference")).toBeNull()
    expect(
      ws.sent.some(
        (frame) => (JSON.parse(frame) as { type?: string }).type === "error",
      ),
    ).toBe(false)
    expect(ws.sent.some((frame) => frame.includes("response.completed"))).toBe(
      true,
    )
  })

  test("does not leak handshake native headers to native Responses", async () => {
    state.models = responsesCapableModels
    queuedResponses.push(createResponsesSseResponse("resp_ws_no_headers"))
    const ws = await createUpgradedTestWebSocket({
      "anthropic-beta": "beta-one",
      "anthropic-version": "2024-01-01",
      "x-model-provider-preference": "anthropic",
    })

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Hello",
        }),
      ),
    )

    const headers = capturedUpstreamHeaders[0]
    expect(headers.get("anthropic-beta")).toBeNull()
    expect(headers.get("anthropic-version")).toBeNull()
    expect(headers.get("x-model-provider-preference")).toBeNull()
  })

  test("does not leak handshake native headers to Chat fallback", async () => {
    installWebSocketEndpoint("/chat/completions")
    queuedResponses.push(createChatCompletionsSseResponse())
    const ws = await createUpgradedTestWebSocket({
      "anthropic-beta": "beta-one",
      "anthropic-version": "2024-01-01",
      "x-model-provider-preference": "anthropic",
    })

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Hello",
        }),
      ),
    )

    const headers = capturedUpstreamHeaders[0]
    expect(headers.get("anthropic-beta")).toBeNull()
    expect(headers.get("anthropic-version")).toBeNull()
    expect(headers.get("x-model-provider-preference")).toBeNull()
  })

  test("returns a recoverable error when a WebSocket model has no endpoint", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        supported_endpoints: [],
      })),
    }
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Hello",
        }),
      ),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ws.data.closed).toBe(false)
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "error",
      status: 400,
      error: { code: "bad_request" },
    })
  })

  test("normalizes stateful controls and preserves formerly blocked native tools on WebSocket", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "Hello",
          store: true,
          tools: [{ type: "code_interpreter", future: { retained: true } }],
          context_management: [{ type: "future_unknown" }],
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastRequestBody).toMatchObject({
      store: false,
      tools: [{ type: "code_interpreter", future: { retained: true } }],
      context_management: [{ type: "future_unknown" }],
    })
    expect(ws.data.closed).toBe(false)
    expect(ws.sent.some((frame) => frame.includes("response.completed"))).toBe(
      true,
    )
  })

  test("dispatches the exact tolerant Chat candidate for reasoning, future items, and references", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        supported_endpoints: ["/chat/completions"],
      })),
    }
    const ws = createTestWebSocket()
    queuedResponses.push(createChatCompletionsSseResponse())

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: [
            {
              type: "reasoning",
              encrypted_content: "private-encrypted-state",
              summary: [{ type: "summary_text", text: "visible summary" }],
            },
            { type: "future_item", payload: "future-private-value" },
            {
              type: "item_reference",
              id: "item-reference-private-value",
            },
            { type: "message", role: "user", content: "finish" },
          ],
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ws.data.closed).toBe(false)
    expect(ws.data.activeTurns.size).toBe(0)
    expect(lastRequestBody).toEqual({
      model: "gpt-5.4",
      messages: [
        { role: "assistant", content: "visible summary" },
        { role: "user", content: "[Future Responses item]" },
        { role: "user", content: "[Future Responses item]" },
        { role: "user", content: "finish" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(ws.sent.some((frame) => frame.includes("response.completed"))).toBe(
      true,
    )
  })

  test("allows final WebSocket synthesis after exactly the source search limit", async () => {
    installWebSocketEndpoint("/chat/completions")
    const searches: Array<string> = []
    restoreResponsesWebSocketDependencies =
      setResponsesWebSocketDependenciesForTest({
        webSearch: (query) => {
          searches.push(query)
          return Promise.resolve(`result-${searches.length}`)
        },
      })
    queuedResponses.push(
      createChatCompletionsResponseWithWebSearchCalls(["search-1", "search-2"]),
      createChatCompletionsResponse("final synthesis"),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "search and synthesize",
          tools: [{ type: "web_search", max_uses: 2 }],
        }),
      ),
    )

    expect(searches).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(lastRequestBody).toMatchObject({
      stream: false,
      tool_choice: "auto",
    })
    expect(JSON.stringify(lastRequestBody)).toContain("result-1")
    expect(JSON.stringify(lastRequestBody)).toContain("result-2")
    expect(ws.sent.some((frame) => frame.includes("final synthesis"))).toBe(
      true,
    )
    expect(ws.sent.at(-1)).toContain("response.completed")
  })

  test("rejects an over-budget WebSocket search batch before partial execution", async () => {
    installWebSocketEndpoint("/chat/completions")
    let searches = 0
    restoreResponsesWebSocketDependencies =
      setResponsesWebSocketDependenciesForTest({
        webSearch: () => {
          searches += 1
          return Promise.resolve("unexpected")
        },
      })
    queuedResponses.push(
      createChatCompletionsResponseWithWebSearchCalls(["search-1", "search-2"]),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "do not partially search",
          tools: [{ type: "web_search", max_uses: 1 }],
        }),
      ),
    )

    expect(searches).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "error",
      status: 400,
      error: { code: "bad_request" },
    })
  })

  test("fits rehydrated compaction turns on ChatCompletions fallback", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        supported_endpoints: ["/chat/completions"],
      })),
    }
    queuedResponses.push(createChatCompletionsSseResponse())
    const ws = createTestWebSocket()
    const oversizedOutput =
      "BEGIN-WS-FALLBACK\n"
      + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
      + "\nEND-WS-FALLBACK"

    recordResponseSnapshotFromFrame(
      ws.data.responseSnapshots,
      {
        model: "gpt-5.4",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_ws_fallback",
            name: "exec",
            input: "run ws fallback diagnostic",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_ws_fallback",
            output: oversizedOutput,
          },
        ],
        stream: true,
      },
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ws_fallback", output: [] },
      }),
    )

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          previous_response_id: "resp_ws_fallback",
          input: [],
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              request_kind: "compaction",
            }),
          },
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(lastRequestBody)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      COMPACTION_PAYLOAD_MAX_BYTES,
    )
    expect(serialized).toContain("run ws fallback diagnostic")
    expect(serialized).toContain("call_ws_fallback")
    expect(serialized).toContain("BEGIN-WS-FALLBACK")
    expect(serialized).toContain("END-WS-FALLBACK")
    expect(serialized).toContain("UTF-8 bytes omitted during compaction")
  })

  test("tracks concurrent turns independently", async () => {
    state.models = responsesCapableModels
    const resolvers: Array<(response: Response) => void> = []
    const upstreamSignals: Array<AbortSignal | null | undefined> = []
    for (let index = 0; index < 2; index++) {
      queuedFetchHandlers.push(
        (init) =>
          new Promise<Response>((resolve) => {
            upstreamSignals.push(init?.signal)
            resolvers.push(resolve)
          }),
      )
    }
    const ws = createTestWebSocket()

    const first = seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "first",
          tools: [],
        }),
      ),
    )
    const second = seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "second",
          tools: [],
        }),
      ),
    )
    await waitFor(() => resolvers.length === 2)

    expect(ws.data.activeTurns.size).toBe(2)
    expect(upstreamSignals[0]).not.toBe(upstreamSignals[1])
    resolvers[1]?.(createResponsesSseResponse("resp_second"))
    resolvers[0]?.(createResponsesSseResponse("resp_first"))
    await Promise.all([first, second])

    expect(ws.data.activeTurns.size).toBe(0)
    expect(ws.data.responseSnapshots.has("resp_first")).toBe(true)
    expect(ws.data.responseSnapshots.has("resp_second")).toBe(true)
  })

  test("aborts and finalizes active turns exactly once when the socket closes", async () => {
    state.models = responsesCapableModels
    let upstreamSignal: AbortSignal | null | undefined
    queuedFetchHandlers.push(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("upstream fetch aborted")
            error.name = "AbortError"
            reject(error)
          })
        }),
    )
    const ws = createTestWebSocket()
    const infoLines: Array<string> = []
    const originalConsoleInfo = console.info
    console.info = (...args: Array<unknown>) => {
      infoLines.push(args.map(String).join(" "))
    }

    try {
      const pending = seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: "keep streaming",
            tools: [],
          }),
        ),
      )
      await waitFor(() => upstreamSignal !== undefined)

      responsesWebSocket.close(ws)
      await pending

      expect(upstreamSignal?.aborted).toBe(true)
      expect(ws.data.closed).toBe(true)
      expect(ws.data.activeTurns.size).toBe(0)
      expect(ws.data.effectiveNativeMessagesOptions).toEqual({})
      expect(ws.data.responseSnapshots.size).toBe(0)
      expect(infoLines.filter((line) => line.includes("STARTED"))).toHaveLength(
        1,
      )
      expect(infoLines.filter((line) => line.includes("ABORTED"))).toHaveLength(
        1,
      )
      expect(infoLines.some((line) => line.includes("499"))).toBe(true)
      expect(
        ws.sent.some(
          (frame) => (JSON.parse(frame) as { type?: string }).type === "error",
        ),
      ).toBe(false)
    } finally {
      // eslint-disable-next-line require-atomic-updates
      console.info = originalConsoleInfo
    }
  })

  test.each([
    { eventType: "response.failed", terminalStatus: "ERROR" },
    { eventType: "response.incomplete", terminalStatus: "COMPLETE" },
    { eventType: "response.completed", terminalStatus: "ERROR" },
    { eventType: "error", terminalStatus: "ERROR" },
  ])(
    "preserves native $eventType terminal frames unchanged",
    async ({ eventType, terminalStatus }) => {
      state.copilotToken = "copilot-token"
      state.models = responsesCapableModels
      const privateMarker = `ws-${eventType}-private-marker`
      queuedResponses.push(
        createResponsesTerminalSseResponse(eventType, privateMarker),
      )
      const ws = createTestWebSocket()
      const infoSpy = spyOn(console, "info").mockImplementation(() => undefined)
      const errorSpy = spyOn(consola, "error")
      const breadcrumbSpy = spyOn(Sentry, "addBreadcrumb").mockImplementation(
        () => undefined,
      )
      const captureSpy = spyOn(Sentry, "captureException").mockImplementation(
        () => "event-id",
      )
      const sentryLogSpy = spyOn(Sentry.logger, "info")

      try {
        await seedProtocolDatabase().then(() =>
          responsesWebSocket.message(
            ws,
            JSON.stringify({
              type: "response.create",
              model: "gpt-5.4",
              input: "fail",
              tools: [],
            }),
          ),
        )

        const clientOutput = ws.sent.join("\n")
        expect(clientOutput).toContain("partial-output")
        expect(clientOutput).toContain(privateMarker)
        expect(clientOutput).not.toContain("[DONE]")

        const terminal = JSON.parse(ws.sent.at(-1) ?? "{}") as {
          code?: string
          message?: string
          param?: string | null
          response?: {
            error?: {
              code?: string
              message?: string
              param?: string | null
              status?: number
            }
            status?: string
          }
          status?: number
          type?: string
        }
        expect(terminal.type).toBe(eventType)
        const terminalError = terminal.response?.error ?? terminal
        expect(terminalError.message).toBe(privateMarker)

        const infoOutput = JSON.stringify(infoSpy.mock.calls)
        expect(infoOutput.match(new RegExp(terminalStatus, "g"))).toHaveLength(
          1,
        )
        expect(ws.data.responseSnapshots.has("resp_terminal")).toBe(false)
      } finally {
        sentryLogSpy.mockRestore()
        captureSpy.mockRestore()
        breadcrumbSpy.mockRestore()
        errorSpy.mockRestore()
        infoSpy.mockRestore()
      }
    },
  )

  test.each(["response.completed", "response.incomplete", "response.failed"])(
    "preserves native %s copilot_usage through sanitization, ID sync, and metadata",
    async (eventType) => {
      state.copilotToken = "copilot-token"
      state.models = responsesCapableModels
      const copilotUsage = {
        completion_tokens: 9,
        total_nano_aiu: 123_456,
      }
      queuedResponses.push(
        createResponsesUsageTerminalSseResponse(eventType, copilotUsage, {
          "x-copilot-service-request-id": `service-${eventType}`,
        }),
      )
      const ws = createTestWebSocket()

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            input: "terminal usage",
            model: "gpt-5.4",
            tools: [],
            type: "response.create",
          }),
        ),
      )

      const terminal = JSON.parse(ws.sent.at(-1) ?? "{}") as {
        copilot_usage?: unknown
        headers?: Record<string, string>
        private?: unknown
        type?: string
      }
      expect(terminal.type).toBe(eventType)
      expect(terminal.copilot_usage).toEqual(copilotUsage)
      expect(terminal.headers).toEqual({
        "x-copilot-service-request-id": `service-${eventType}`,
      })
      expect(terminal.private).toBe("terminal-private-field")
    },
  )

  test("classifies the post-sanitization emitted terminal type", async () => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    const privateMarker = "ws-mismatched-terminal-private-marker"
    queuedResponses.push(
      createResponsesTerminalSseResponse(
        "response.failed",
        privateMarker,
        "response.output_text.delta",
      ),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "fail",
          tools: [],
        }),
      ),
    )

    const terminal = JSON.parse(ws.sent.at(-1) ?? "{}") as {
      response?: Record<string, unknown>
      type?: string
    }
    expect(terminal.type).toBe("response.failed")
    expect(terminal.response).toEqual({
      id: "resp_terminal",
      object: "response",
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    })
    expect(ws.sent.join("\n")).not.toContain(privateMarker)
  })

  test.each([
    { data: "null", name: "null" },
    { data: '"ws-terminal-private-string"', name: "string" },
    { data: "17", name: "number" },
    { data: '["ws-terminal-private-array"]', name: "array" },
  ])("fails closed for native terminal $name JSON", async ({ data }) => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(createRawResponsesTerminalSseResponse(data))
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "fail",
          tools: [],
        }),
      ),
    )

    const output = ws.sent.join("\n")
    expect(output).toContain("partial-output")
    expect(output).not.toContain("ws-terminal-private")
    expect(output).not.toContain("[DONE]")
    expect(JSON.parse(ws.sent.at(-1) ?? "{}") as unknown).toEqual({
      type: "response.failed",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    })
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test.each([
    { dataLine: "data:", eventType: "error" },
    { dataLine: undefined, eventType: "response.failed" },
    { dataLine: "data:", eventType: "response.incomplete" },
    { dataLine: undefined, eventType: "response.completed" },
  ])(
    "canonicalizes native $eventType with empty or missing data",
    async ({ dataLine, eventType }) => {
      state.copilotToken = "copilot-token"
      state.models = responsesCapableModels
      queuedResponses.push(
        createEmptyResponsesTerminalSseResponse(eventType, dataLine),
      )
      const ws = createTestWebSocket()

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: "fail",
            tools: [],
          }),
        ),
      )

      const terminal = JSON.parse(ws.sent.at(-1) ?? "{}") as { type?: string }
      expect(ws.sent.join("\n")).toContain("partial-output")
      expect(terminal.type).toBe(
        eventType === "response.completed" ? "response.failed" : eventType,
      )
      expect(ws.sent.join("\n")).toContain("Upstream Responses stream failed.")
      expect(ws.data.activeTurns.size).toBe(0)
    },
  )

  test("treats missing completed status as a successful terminal", async () => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      createRawResponsesTerminalSseResponse(
        JSON.stringify({
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "resp_missing_status",
            object: "response",
            output: [],
            private: "ws-missing-status-private-marker",
          },
        }),
      ),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "fail",
          tools: [],
        }),
      ),
    )

    const terminal = JSON.parse(ws.sent.at(-1) ?? "{}") as {
      response?: { id?: string; private?: string }
      type?: string
    }
    expect(terminal.type).toBe("response.completed")
    expect(terminal.response?.private).toBe("ws-missing-status-private-marker")
    expect(ws.data.responseSnapshots.has("resp_missing_status")).toBe(true)
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test("keeps a delivered completed frame COMPLETE when the socket closes", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    const infoLines: Array<string> = []
    const originalConsoleInfo = console.info
    console.info = (...args: Array<unknown>) => {
      infoLines.push(args.map(String).join(" "))
    }
    queuedFetchHandlers.push(() =>
      createResponsesSseResponse("resp_close_after_complete"),
    )
    const originalSend = ws.send.bind(ws)
    ws.send = (data: string) => {
      originalSend(data)
      if (
        (JSON.parse(data) as { type?: string }).type === "response.completed"
      ) {
        queueMicrotask(() => responsesWebSocket.close(ws))
      }
    }

    try {
      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: "finish",
            tools: [],
          }),
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        infoLines.filter((line) => line.includes("COMPLETE")),
      ).toHaveLength(1)
      expect(infoLines.some((line) => line.includes("ABORTED"))).toBe(false)
    } finally {
      // eslint-disable-next-line require-atomic-updates
      console.info = originalConsoleInfo
    }
  })

  test("returns a recoverable previous_response_not_found without echoing the id", async () => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    const debugSpy = spyOn(consola, "debug")

    try {
      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            previous_response_id: "missing",
            input: [],
            tools: [],
          }),
        ),
      )

      const errorFrame = JSON.parse(ws.sent[0] ?? "{}") as {
        error?: {
          code?: string
          message?: string
          request_id?: string
          type?: string
        }
        status?: number
        type?: string
      }
      expect(errorFrame.type).toBe("error")
      expect(errorFrame.status).toBe(400)
      expect(errorFrame.error).toEqual({
        code: "previous_response_not_found",
        message:
          "The previous response is not available on this WebSocket connection.",
        type: "invalid_request_error",
        request_id: "req-test",
      })
      expect(JSON.stringify(errorFrame)).not.toContain("missing")
      expect(fetchMock).not.toHaveBeenCalled()
      expect(ws.data.closed).toBe(false)

      queuedResponses.push(createResponsesSseResponse("resp_after_stale"))
      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: "new local thread",
          }),
        ),
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(ws.data.responseSnapshots.has("resp_after_stale")).toBe(true)
      const continuationOutcomes = debugSpy.mock.calls
        .filter(
          (call) =>
            call[0] === "[copilot-contract]"
            && (call[1] as { kind?: string }).kind === "websocket_continuation",
        )
        .map((call) => (call[1] as { outcome: string }).outcome)
      expect(continuationOutcomes).toEqual(["not_found", "new_thread"])
    } finally {
      debugSpy.mockRestore()
    }
  })

  test.each([
    [null, "previous_response_id must be a string"],
    ["", "previous_response_id must not be empty"],
    [17, "previous_response_id must be a string"],
  ] as const)(
    "rejects malformed previous_response_id %p without dispatch",
    async (previousResponseId, message) => {
      state.models = responsesCapableModels
      const ws = createTestWebSocket()

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            previous_response_id: previousResponseId,
            input: [],
            tools: [],
          }),
        ),
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(ws.data.closed).toBe(false)
      expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toEqual({
        type: "error",
        status: 400,
        error: {
          code: "invalid_request_error",
          message,
          type: "invalid_request_error",
          request_id: "req-test",
        },
      })
    },
  )
})

describe("responses websocket upstream handling", () => {
  test(
    "recovers an oversized ordinary rehydrated continuation before forwarding",
    async () => {
      state.accountType = "individual"
      state.copilotToken = "copilot-token"
      state.models = responsesCapableModels
      queuedResponses.push(createResponsesSseResponse("resp_ordinary_fit"))
      const ws = createTestWebSocket()
      const preservedHistory =
        "BEGIN-ORDINARY-WS\n"
        + "x".repeat(26 * 1024 * 1024)
        + "\nEND-ORDINARY-WS"
      const inlineScreenshot = `data:image/png;base64,${"A".repeat(7 * 1024 * 1024)}`

      recordResponseSnapshotFromFrame(
        ws.data.responseSnapshots,
        {
          model: "gpt-5.4",
          input: [
            {
              type: "function_call_output",
              call_id: "call_ws_history",
              output: preservedHistory,
              internal_chat_message_metadata_passthrough: {
                turn_id: "turn_history",
              },
            },
          ],
          stream: true,
        },
        JSON.stringify({
          type: "response.completed",
          response: { id: "resp_before_ordinary", output: [] },
        }),
      )

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            previous_response_id: "resp_before_ordinary",
            input: [
              {
                type: "function_call_output",
                call_id: "call_ws_current",
                output: [
                  {
                    type: "computer_screenshot",
                    image_url: inlineScreenshot,
                  },
                ],
                internal_chat_message_metadata_passthrough: {
                  turn_id: "turn_current",
                },
              },
            ],
            client_metadata: {
              "x-codex-turn-metadata": JSON.stringify({
                request_kind: "turn",
                turn_id: "turn_current",
              }),
            },
          }),
        ),
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const serialized = JSON.stringify(lastRequestBody)
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
        CAPI_RESPONSES_MAX_REQUEST_BYTES - RESPONSES_RECOVERY_MARGIN_BYTES,
      )
      expect(serialized).toContain("BEGIN-ORDINARY-WS")
      expect(serialized).toContain("END-ORDINARY-WS")
      expect(serialized).toContain("call_ws_current")
      expect(serialized).not.toContain(inlineScreenshot)
      expect(serialized).toContain(
        "omitted to fit the CAPI Responses request-size limit",
      )
      expect(lastRequestBody?.previous_response_id).toBeUndefined()
    },
    { timeout: 15_000 },
  )

  test("fits a rehydrated pre-compaction continuation before forwarding", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(createResponsesSseResponse("resp_compaction_fit"))
    const ws = createTestWebSocket()
    const oversizedLength = COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024
    const originalLargeOutput =
      "BEGIN-WEBSOCKET\n" + "x".repeat(oversizedLength) + "\nEND-WEBSOCKET"

    recordResponseSnapshotFromFrame(
      ws.data.responseSnapshots,
      {
        model: "gpt-5.4",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_websocket",
            name: "exec",
            input: "run diagnostic",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_websocket",
            output: originalLargeOutput,
          },
        ],
        stream: true,
      },
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_before_compaction",
          output: [],
        },
      }),
    )

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          previous_response_id: "resp_before_compaction",
          input: [],
          tools: [],
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              request_kind: "compaction",
            }),
          },
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(lastRequestBody)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      COMPACTION_PAYLOAD_MAX_BYTES,
    )
    expect(serialized).toContain("run diagnostic")
    expect(serialized).toContain("call_websocket")
    expect(serialized).toContain("BEGIN-WEBSOCKET")
    expect(serialized).toContain("END-WEBSOCKET")
    expect(serialized).toContain("UTF-8 bytes omitted during compaction")
    expect(originalLargeOutput).toHaveLength(
      oversizedLength + "BEGIN-WEBSOCKET\n".length + "\nEND-WEBSOCKET".length,
    )
  })

  test("rejects preserved-text-only compaction payloads locally", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    const preservedContent = "preserved-context-".repeat(
      Math.ceil((COMPACTION_PAYLOAD_MAX_BYTES + 1024) / 18),
    )

    recordResponseSnapshotFromFrame(
      ws.data.responseSnapshots,
      {
        model: "gpt-5.4",
        input: [
          {
            type: "message",
            role: "developer",
            content: preservedContent,
          },
        ],
        stream: true,
      },
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_preserved_only", output: [] },
      }),
    )

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          previous_response_id: "resp_preserved_only",
          input: [],
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              request_kind: "compaction",
            }),
          },
        }),
      ),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    const errorFrame = JSON.parse(ws.sent[0] ?? "{}") as {
      error?: { code?: string; message?: string }
      status?: number
      type?: string
    }
    expect(errorFrame.type).toBe("error")
    expect(errorFrame.status).toBe(413)
    expect(errorFrame.error?.code).toBe("bad_request")
    expect(errorFrame.error?.message).toContain(
      "safe compaction payload budget",
    )
  })

  test("strips encrypted reasoning from rehydrated continuation input before forwarding", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(createResponsesSseResponse("resp_continuation_clean"))
    const ws = createTestWebSocket()

    recordResponseSnapshotFromFrame(
      ws.data.responseSnapshots,
      {
        model: "gpt-5.4",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "First" }],
          },
        ],
        stream: true,
      },
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_with_reasoning",
          output: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "Thought" }],
              encrypted_content: "token-bound-secret",
            },
          ],
        },
      }),
    )

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          previous_response_id: "resp_with_reasoning",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Follow up" }],
            },
          ],
          tools: [],
        }),
      ),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastRequestBody?.previous_response_id).toBeUndefined()
    expect(JSON.stringify(lastRequestBody?.input)).not.toContain(
      "encrypted_content",
    )
    expect(JSON.stringify(lastRequestBody?.input)).not.toContain(
      "token-bound-secret",
    )
  })

  test("turns deterministic upstream HTTP errors into terminal WebSocket error frames", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      new Response(
        JSON.stringify({ error: { message: "Too many requests" } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: [],
          tools: [],
        }),
      ),
    )

    const errorFrame = JSON.parse(ws.sent[0] ?? "{}") as {
      error?: {
        code?: string
        upstream_body?: string
        upstream_content_type?: string
      }
      status?: number
      type?: string
    }
    expect(errorFrame.type).toBe("error")
    expect(errorFrame.status).toBe(400)
    expect(errorFrame.error?.code).toBe("bad_request")
    expect(errorFrame.error?.upstream_body).toBe(
      JSON.stringify({ error: { message: "Too many requests" } }),
    )
    expect(errorFrame.error?.upstream_content_type).toBe("application/json")
  })

  test("emits one Responses failure family when a native source ends after a delta", async () => {
    state.models = responsesCapableModels
    queuedResponses.push(
      new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_eof","output_index":0,"content_index":0,"delta":"partial"}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    const ws = createTestWebSocket()
    const originalSend = ws.send.bind(ws)
    ws.send = (frame) => {
      originalSend(frame)
      if ((JSON.parse(frame) as { type?: string }).type === "error") {
        responsesWebSocket.close(ws)
      }
    }
    ws.data.effectiveNativeMessagesOptions = {
      anthropicBeta: "beta-one",
    }
    ws.data.responseSnapshots.set("resp_close_state", {
      model: "gpt-5.4",
      input: [],
    })

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "eof",
        }),
      ),
    )

    const types = ws.sent.map(
      (frame) => (JSON.parse(frame) as { type?: string }).type,
    )
    expect(types).toEqual(["response.output_text.delta", "error"])
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test("binds a concurrent failure writer to the winning failure identity", async () => {
    const data = {
      activeTurns: new Map<
        number,
        ReturnType<typeof createResponsesWebSocketTurn>
      >(),
      nextTurnSequence: 0,
      requestId: "failure-race",
    }
    const turn = createResponsesWebSocketTurn(data, "failure-race")
    const calls: Array<string> = []
    const first = { kind: "thrown" as const, error: new Error("first") }
    const second = { kind: "thrown" as const, error: new Error("second") }
    turn.failureWriters.set(first, async () => {
      await Promise.resolve()
      calls.push("first")
    })
    turn.failureWriters.set(second, () => {
      calls.push("second")
      return Promise.resolve()
    })

    const results = await Promise.all([
      turn.terminal.fail(first),
      turn.terminal.fail(second),
    ])

    expect(results).toEqual([true, false])
    expect(calls).toEqual(["first"])
  })

  test.each(["failed"])(
    "does not snapshot response.completed with embedded %s status",
    async (status) => {
      state.copilotToken = "copilot-token"
      state.models = responsesCapableModels
      queuedResponses.push(
        createRawResponsesTerminalSseResponse(
          JSON.stringify({
            type: "response.completed",
            sequence_number: 2,
            response: {
              id: `resp_embedded_${status}`,
              object: "response",
              status,
              output: [{ type: "future_output", value: status }],
            },
          }),
        ),
      )
      const ws = createTestWebSocket()

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: status,
          }),
        ),
      )

      expect(
        (JSON.parse(ws.sent.at(-1) ?? "{}") as { type?: string }).type,
      ).toBe("response.completed")
      expect(ws.data.responseSnapshots.has(`resp_embedded_${status}`)).toBe(
        false,
      )
    },
  )

  test("snapshots response.completed carrying an incomplete partial response", async () => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      createRawResponsesTerminalSseResponse(
        JSON.stringify({
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "resp_embedded_incomplete",
            object: "response",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              {
                type: "message",
                role: "assistant",
                status: "incomplete",
                content: [{ type: "output_text", text: "partial" }],
              },
            ],
          },
        }),
      ),
    )
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "incomplete",
        }),
      ),
    )

    expect(ws.data.responseSnapshots.has("resp_embedded_incomplete")).toBe(true)
  })

  test("preserves binary upstream HTTP error bytes in the terminal frame", async () => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedFetchHandlers.push(() => {
      throw new HTTPError(
        "Failed to create responses",
        new Response(new Uint8Array([0, 255, 1, 2]), {
          status: 502,
          headers: { "content-type": "application/octet-stream" },
        }),
      )
    })
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: [],
        }),
      ),
    )

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      status: 502,
      error: {
        upstream_body: [0, 255, 1, 2],
        upstream_content_type: "application/octet-stream",
      },
    })
  })

  test("uses one immutable HTTP inspection for WebSocket reporting", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    const privateMarkers = [
      "ws-status-getter-private-marker",
      "ws-message-getter-private-marker",
    ]
    let getterCalls = 0
    queuedFetchHandlers.push(() => {
      const response = Response.json({}, { status: 429 })
      Object.defineProperty(response, "status", {
        configurable: true,
        get() {
          getterCalls += 1
          throw new Error(privateMarkers[0])
        },
      })
      const error = new HTTPError("Failed to create responses", response)
      Object.defineProperty(error, "message", {
        configurable: true,
        get() {
          getterCalls += 1
          throw new Error(privateMarkers[1])
        },
      })
      throw error
    })
    const ws = createTestWebSocket()
    const errorSpy = spyOn(consola, "error")
    const infoSpy = spyOn(console, "info").mockImplementation(() => undefined)
    const captureSpy = spyOn(Sentry, "captureException").mockImplementation(
      () => "event-id",
    )

    try {
      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: [],
            tools: [],
          }),
        ),
      )
      const errorFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as {
        error?: { code?: string; message?: string }
        status?: number
      }
      const diagnostics = JSON.stringify([
        ws.sent,
        errorSpy.mock.calls,
        infoSpy.mock.calls,
        captureSpy.mock.calls,
      ])
      const infoValues: Array<unknown> = infoSpy.mock.calls.flat()
      const lifecycleLine = infoValues.find(
        (value) => typeof value === "string" && value.includes("REJECTED"),
      )
      const errorValues: Array<unknown> = errorSpy.mock.calls.flat()
      const wsLog = errorValues.find(
        (value) =>
          typeof value === "object"
          && value !== null
          && "upstreamResponseBody" in value,
      )

      expect(errorFrame.status).toBe(429)
      expect(errorFrame.error).toMatchObject({
        code: "rate_limited",
        message: "Upstream request failed",
      })
      expect(lifecycleLine).toContain("REJECTED")
      expect(lifecycleLine).toContain("429")
      expect(lifecycleLine).toContain("Failed to create responses")
      expect(wsLog).toMatchObject({
        upstreamResponseBody: "{}",
        upstreamResponseBodyBytes: [123, 125],
      })
      expect(getterCalls).toBe(0)
      for (const marker of privateMarkers) {
        expect(diagnostics).not.toContain(marker)
      }
    } finally {
      errorSpy.mockRestore()
      infoSpy.mockRestore()
      captureSpy.mockRestore()
    }
  })
})

describe("responses websocket warmup handling", () => {
  test("detects generate=false Codex prewarm requests", () => {
    expect(
      isSyntheticWarmupRequest({
        model: "gpt-5.4",
        instructions: "You are Codex.",
        input: [],
        tools: [],
        generate: false,
        stream: true,
      }),
    ).toBe(true)

    expect(
      isSyntheticWarmupRequest({
        model: "gpt-5.4",
        instructions: "You are Codex.",
        input: [],
        tools: [],
        stream: true,
      }),
    ).toBe(false)
  })

  test.each([
    {
      name: "missing endpoint",
      configure: () => {
        state.models = {
          ...responsesCapableModels,
          data: responsesCapableModels.data.map((model) => ({
            ...model,
            supported_endpoints: [],
          })),
        }
      },
      payload: {},
      code: "bad_request",
    },
  ])(
    "rejects warmup $name before success",
    async ({ configure, payload, code }) => {
      configure()
      const ws = createTestWebSocket()

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: "warmup",
            generate: false,
            ...payload,
          }),
        ),
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(ws.data.closed).toBe(false)
      expect(ws.sent).toHaveLength(1)
      expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
        type: "error",
        status: 400,
        error: { code },
      })
    },
  )

  test("evaluates a tolerant Messages-only warmup without dispatching upstream", async () => {
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
      })),
    }
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: [
            { type: "future_item", payload: "private-future-value" },
            { type: "message", role: "user", content: "warmup" },
          ],
          generate: false,
          tools: [],
          tool_choice: "none",
          reasoning: { effort: "none" },
        }),
      ),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ws.sent.some((frame) => frame.includes("response.completed"))).toBe(
      true,
    )
    const snapshot = ws.data.responseSnapshots.values().next().value
    expect(snapshot).toMatchObject({
      model: "gpt-5.4",
      input: [
        { type: "future_item", payload: "private-future-value" },
        { type: "message", role: "user", content: "warmup" },
      ],
      stream: true,
    })
    expect(snapshot).not.toHaveProperty("generate")
  })

  test("evaluates a tolerant Chat-only warmup without dispatching upstream", async () => {
    installWebSocketEndpoint("/chat/completions")
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: [
            { type: "future_item", payload: "private-future-value" },
            { type: "message", role: "user", content: "warmup" },
          ],
          generate: false,
          tools: [],
        }),
      ),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ws.sent.some((frame) => frame.includes("response.completed"))).toBe(
      true,
    )
    expect(ws.data.responseSnapshots.values().next().value).toMatchObject({
      model: "gpt-5.4",
      input: [
        { type: "future_item", payload: "private-future-value" },
        { type: "message", role: "user", content: "warmup" },
      ],
      stream: true,
    })
    expect(ws.data.responseSnapshots.values().next().value).not.toHaveProperty(
      "generate",
    )
  })

  test("evaluates attachment-bearing tolerant warmups without attachment I/O", async () => {
    installWebSocketEndpoint("/chat/completions")
    const ws = createTestWebSocket()

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: [
            { type: "future_item", payload: "private-future-value" },
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "warmup" },
                {
                  type: "input_image",
                  image_url: "https://attachments.invalid/private.png",
                },
              ],
            },
          ],
          generate: false,
          tools: [],
        }),
      ),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ws.sent.some((frame) => frame.includes("response.completed"))).toBe(
      true,
    )
    expect(
      JSON.stringify(ws.data.responseSnapshots.values().next().value),
    ).toContain("https://attachments.invalid/private.png")
  })

  test("preserves native header options across warmup continuation", async () => {
    installWebSocketEndpoint("/v1/messages")
    const ws = await createUpgradedTestWebSocket({
      "anthropic-beta": "beta-one, beta-two",
      "anthropic-version": "2024-01-01",
      "x-client-session-id": "ws-warmup-session",
      "x-model-provider-preference": "anthropic",
      "x-request-id": "req-ws-warmup",
    })

    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "warmup",
          generate: false,
          tools: [],
        }),
      ),
    )
    expect(fetchMock).not.toHaveBeenCalled()
    const warmupId = ws.sent
      .map((frame) => JSON.parse(frame) as { response?: { id?: string } })
      .find((frame) => frame.response?.id?.startsWith("warmup_"))?.response?.id
    if (!warmupId) throw new Error("Expected synthetic warmup response id")

    queuedResponses.push(createAnthropicMessageResponse("msg_ws_warmup"))
    await seedProtocolDatabase().then(() =>
      responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          previous_response_id: warmupId,
          input: "Continue",
          tools: [],
        }),
      ),
    )

    const headers = capturedUpstreamHeaders[0]
    expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
    expect(headers.get("anthropic-version")).toBe("2024-01-01")
    expect(headers.get("x-model-provider-preference")).toBe("anthropic")
    expect(headers.get("x-request-id")).toBe("req-ws-warmup:2")
    expect(capturedAffinity).toEqual({
      key: "ws-warmup-session",
      source: "copilot_session",
    })
    expect(lastRequestBody?.previous_response_id).toBeUndefined()
  })

  test("rehydrates follow-up requests that reference a synthetic warmup", () => {
    const warmupPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the failing tests." }],
        },
      ],
      tools: [],
      generate: false,
      stream: true,
    }

    const followUpPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      previous_response_id: "warmup_123",
      input: [],
      tools: [],
      stream: true,
    }

    const rehydratedWarmup = rehydrateWarmupPayload(
      warmupPayload,
      followUpPayload,
    )

    expect(rehydratedWarmup).toMatchObject({
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: warmupPayload.input,
      tools: [],
      stream: true,
    })
    expect(rehydratedWarmup.generate).toBeUndefined()

    const startupWarmup: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: [],
      tools: [],
      generate: false,
      stream: true,
    }
    const firstTurnPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      previous_response_id: "warmup_456",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
      tools: [],
      stream: true,
    }

    const rehydratedStartupWarmup = rehydrateWarmupPayload(
      startupWarmup,
      firstTurnPayload,
    )

    expect(rehydratedStartupWarmup).toMatchObject({
      input: firstTurnPayload.input,
      stream: true,
    })
    expect(rehydratedStartupWarmup.generate).toBeUndefined()
  })
})

describe("responses websocket continuation handling", () => {
  test.each([
    {
      expectedInput: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first prompt" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "current delta" }],
        },
      ],
      name: "empty completed output",
      output: [],
    },
    {
      expectedInput: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first prompt" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "assistant answer" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "current delta" }],
        },
      ],
      name: "substantive completed output",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "assistant answer" }],
        },
      ],
    },
  ])(
    "sends full history after a string first turn with $name",
    async ({ expectedInput, output }) => {
      state.models = responsesCapableModels
      queuedResponses.push(
        createResponsesSseResponse("resp_string_parent", output),
        createResponsesSseResponse("resp_string_child"),
      )
      const ws = createTestWebSocket()

      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            instructions: "Keep the stable instructions.",
            input: "first prompt",
            metadata: { nested: { source: "first-turn" } },
            tools: [
              {
                type: "function",
                name: "run",
                parameters: { type: "object", properties: {} },
              },
            ],
          }),
        ),
      )
      await seedProtocolDatabase().then(() =>
        responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            previous_response_id: "resp_string_parent",
            input: "current delta",
          }),
        ),
      )

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(lastRequestBody).toMatchObject({
        input: expectedInput,
        instructions: "Keep the stable instructions.",
        metadata: { nested: { source: "first-turn" } },
        tools: [
          {
            type: "function",
            name: "run",
            parameters: { type: "object", properties: {} },
          },
        ],
      })
      expect(lastRequestBody?.previous_response_id).toBeUndefined()
      expect(ws.data.closed).toBe(false)
    },
  )

  test("rehydrates arbitrary completed response continuations", () => {
    const snapshots = new Map<string, ResponsesPayload>()
    const priorPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "First" }],
        },
      ],
      tools: [{ type: "function", name: "shell", parameters: {} }],
      stream: true,
    }

    recordResponseSnapshotFromFrame(
      snapshots,
      priorPayload,
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_done",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done" }],
            },
          ],
        },
      }),
    )

    const followUpPayload: ResponsesPayload = {
      model: "gpt-5.4",
      previous_response_id: "resp_done",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "ok",
        },
      ],
      stream: true,
    }

    const rehydrated = rehydrateContinuationPayload(snapshots, followUpPayload)

    expect(rehydrated?.previous_response_id).toBeUndefined()
    expect(rehydrated?.instructions).toBe("You are Codex.")
    expect(rehydrated?.tools).toEqual(priorPayload.tools)
    expect(rehydrated?.input).toEqual([
      ...(priorPayload.input as Array<ResponseInputItem>),
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done" }],
      },
      ...(followUpPayload.input as Array<ResponseInputItem>),
    ])
  })

  test("preserves partial snapshots from completed events marked incomplete", () => {
    const snapshots = new Map<string, ResponsesPayload>()
    const priorPayload: ResponsesPayload = {
      model: "gpt-5.4",
      input: "First",
      stream: true,
    }

    recordResponseSnapshotFromFrame(
      snapshots,
      priorPayload,
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_partial_completed",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              id: "msg_partial",
              type: "message",
              role: "assistant",
              status: "incomplete",
              content: [{ type: "output_text", text: "Partial answer" }],
            },
          ],
        },
      }),
    )

    const rehydrated = rehydrateContinuationPayload(snapshots, {
      model: "gpt-5.4",
      previous_response_id: "resp_partial_completed",
      input: "Continue",
      stream: true,
    })

    expect(rehydrated?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "First" }],
      },
      {
        id: "msg_partial",
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [{ type: "output_text", text: "Partial answer" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue" }],
      },
    ])
  })

  test("rehydrates a sanitized namespaced function call before its output", () => {
    const snapshots = new Map<string, ResponsesPayload>()
    const priorPayload: ResponsesPayload = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the failure" }],
        },
      ],
      stream: true,
    }
    const sanitized = sanitizeResponsesStreamEvent({
      event: "response.completed",
      data: JSON.stringify({
        type: "response.completed",
        sequence_number: 7,
        response: {
          id: "resp_namespaced_continuation",
          object: "response",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_spawn_agent",
              name: "spawn_agent",
              namespace: "collaboration",
              arguments: '{"task_name":"inspect"}',
              status: "completed",
            },
          ],
          output_text: "",
          usage: null,
          error: null,
          incomplete_details: null,
        },
      }),
    })

    recordResponseSnapshotFromFrame(
      snapshots,
      priorPayload,
      sanitized.data ?? "",
    )

    const rehydrated = rehydrateContinuationPayload(snapshots, {
      model: "gpt-5.6-sol",
      previous_response_id: "resp_namespaced_continuation",
      input: [
        {
          type: "function_call_output",
          call_id: "call_spawn_agent",
          output: "inspection complete",
        },
      ],
      stream: true,
    })

    expect(rehydrated?.input).toEqual([
      ...(priorPayload.input as Array<ResponseInputItem>),
      {
        type: "function_call",
        call_id: "call_spawn_agent",
        name: "spawn_agent",
        namespace: "collaboration",
        arguments: '{"task_name":"inspect"}',
        status: "completed",
      },
      {
        type: "function_call_output",
        call_id: "call_spawn_agent",
        output: "inspection complete",
      },
    ])
  })

  test("returns undefined for unknown previous_response_id", () => {
    expect(
      rehydrateContinuationPayload(new Map(), {
        model: "gpt-5.4",
        previous_response_id: "missing",
        input: [],
      }),
    ).toBeUndefined()
  })

  test("retains continuation snapshots without local eviction", () => {
    const snapshots = new Map<string, ResponsesPayload>()
    for (let index = 0; index < 34; index += 1) {
      recordResponseSnapshotFromFrame(
        snapshots,
        { input: `input-${index}`, model: "gpt-5.4" },
        JSON.stringify({
          type: "response.completed",
          response: { id: `resp_${index}`, output: [] },
        }),
      )
    }
    expect(snapshots).toHaveLength(34)
    expect(snapshots.has("resp_0")).toBe(true)
    expect(snapshots.has("resp_33")).toBe(true)
  })
})

function createWebSocketModel(modelId: string) {
  return {
    id: modelId,
    name: modelId,
    object: "model" as const,
    preview: false,
    vendor: "openai",
    version: "test",
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: {
      family: "gpt",
      limits: {},
      object: "model_capabilities",
      supports: { streaming: true },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function findWebSocketAffinity(modelId: string, accountId: number): string {
  const affinity = Array.from(
    { length: 10_000 },
    (_, index) => `ws-continuation-affinity-${accountId}-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountForModelBySession(modelId, candidate)?.id
      === accountId,
  )
  if (!affinity) throw new TypeError("Expected WebSocket account affinity")
  return affinity
}

function createTestWebSocket(data?: ResponsesWebSocketData): {
  close: () => void
  data: ResponsesWebSocketData
  sent: Array<string>
  send: (data: string) => void
} {
  const sent: Array<string> = []
  return {
    data: data ?? {
      activeTurns: new Map(),
      closed: false,
      nextTurnSequence: 0,
      type: "responses",
      requestId: "req-test",
      affinity: { key: "session-test", source: "claude_session" },
      nativeMessagesOptions: {},
      effectiveNativeMessagesOptions: {},
      responseSnapshots: new Map(),
    },
    sent,
    send(data: string): void {
      sent.push(data)
    },
    close(): void {},
  }
}

function readCurrentWebSocketLifecycleContext(): {
  accountId?: number
  affinity?: string
  metadata?: string
  taskId?: string
} {
  return {
    accountId: getLastUsedRoutedAccountId(),
    affinity: getRoutingAffinity()?.key,
    metadata: getCopilotResponseHeaders()["x-copilot-service-request-id"],
    taskId: getCopilotRequestAttribution()?.agentTaskId,
  }
}

async function createUpgradedTestWebSocket(
  headers: Record<string, string>,
): Promise<ReturnType<typeof createTestWebSocket>> {
  state.apiKeyAuth = "cli-secret"
  let data: ResponsesWebSocketData | undefined
  const result = await seedProtocolDatabase().then(() =>
    tryUpgradeResponsesWebSocket(
      new Request("http://localhost/responses", {
        headers: {
          authorization: "Bearer cli-secret",
          upgrade: "websocket",
          ...headers,
        },
      }),
      {
        upgrade(_request, options): boolean {
          data = (options as { data: ResponsesWebSocketData }).data
          return true
        },
      },
    ),
  )
  if (result !== "upgraded" || !data) {
    throw new Error("Expected Responses WebSocket upgrade")
  }
  return createTestWebSocket(data)
}

function readNativeMessagesOptions(
  data: ResponsesWebSocketData,
): NativeMessagesRequestOptions {
  return data.nativeMessagesOptions
}

function installWebSocketEndpoint(endpoint: string): void {
  state.models = {
    ...responsesCapableModels,
    data: responsesCapableModels.data.map((model) => ({
      ...model,
      vendor: endpoint === "/v1/messages" ? "anthropic" : model.vendor,
      supported_endpoints: [endpoint],
      capabilities: {
        ...model.capabilities,
        limits: { max_output_tokens: 4096 },
        supports: { reasoning_effort: ["medium"] },
      },
    })),
  }
}

function installWebSocketMessagesModel(modelId: string): void {
  const base = responsesCapableModels.data[0]
  state.models = {
    object: "list",
    data: [
      {
        ...base,
        id: modelId,
        name: modelId,
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          ...base.capabilities,
          limits: { max_output_tokens: 4096 },
          supports: { reasoning_effort: ["medium"] },
        },
      },
    ],
  }
}

function createAnthropicMessageResponse(
  id: string,
  model = "gpt-5.4",
): Response {
  return Response.json({
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "Hello from Messages" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 3 },
  })
}

function createResponsesSseResponse(
  responseId: string,
  output: ReadonlyArray<ResponseInputItem> = [],
  options: {
    frameFields?: Record<string, unknown>
    headers?: Record<string, string>
    omitCompletedOutputText?: boolean
  } = {},
): Response {
  const {
    frameFields = {},
    headers = {},
    omitCompletedOutputText = false,
  } = options
  const created = JSON.stringify({
    ...frameFields,
    type: "response.created",
    sequence_number: 0,
    response: {
      id: responseId,
      object: "response",
      created_at: 1,
      model: "gpt-5.4",
      output,
      output_text: "",
      status: "in_progress",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    },
  })
  const completed = JSON.stringify({
    ...frameFields,
    type: "response.completed",
    sequence_number: 1,
    response: {
      id: responseId,
      object: "response",
      created_at: 1,
      model: "gpt-5.4",
      output,
      ...(omitCompletedOutputText ? {} : { output_text: "" }),
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    },
  })

  return new Response(
    `event: response.created\ndata: ${created}\n\n`
      + `event: response.completed\ndata: ${completed}\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers },
    },
  )
}

function createResponsesUsageTerminalSseResponse(
  eventType: string,
  copilotUsage: Record<string, unknown>,
  headers: Record<string, string>,
): Response {
  const response =
    eventType === "response.completed" ?
      {
        error: null,
        id: "resp_usage_terminal",
        incomplete_details: null,
        object: "response",
        output: [],
        output_text: "",
        status: "completed",
        usage: null,
      }
    : {
        error: {
          code: "server_error",
          message: "terminal-private-field",
          param: "input",
          status: 502,
        },
        id: "resp_usage_terminal",
        incomplete_details:
          eventType === "response.incomplete" ?
            { reason: "max_output_tokens" }
          : null,
        object: "response",
        output: [],
        output_text: "",
        status: eventType === "response.incomplete" ? "incomplete" : "failed",
        usage: null,
      }
  const terminal = JSON.stringify({
    copilot_usage: copilotUsage,
    private: "terminal-private-field",
    response,
    sequence_number: 2,
    type: eventType,
  })
  return new Response(`event: ${eventType}\ndata: ${terminal}\n\n`, {
    headers: { "content-type": "text/event-stream", ...headers },
    status: 200,
  })
}

function createChatCompletionsSseResponse(): Response {
  const content = JSON.stringify({
    id: "chatcmpl_ws",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "Hello" },
        finish_reason: null,
      },
    ],
  })
  const done = JSON.stringify({
    id: "chatcmpl_ws",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.4",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })
  return new Response(`data: ${content}\n\ndata: ${done}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  })
}

function createChatCompletionsResponse(content: string): Response {
  return Response.json({
    id: "chatcmpl_ws_search",
    object: "chat.completion",
    created: 1,
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  })
}

function createChatCompletionsResponseWithWebSearchCalls(
  callIds: Array<string>,
): Response {
  return Response.json({
    id: "chatcmpl_ws_search",
    object: "chat.completion",
    created: 1,
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: callIds.map((id) => ({
            id,
            type: "function",
            function: {
              name: "web_search",
              arguments: JSON.stringify({ query: id }),
            },
          })),
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
  })
}

function createResponsesTerminalSseResponse(
  type: string,
  message: string,
  jsonType = type,
): Response {
  const delta = {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_terminal",
    output_index: 0,
    content_index: 0,
    delta: "partial-output",
  }
  const responseStatus =
    type === "response.failed" || type === "response.completed" ?
      "failed"
    : "incomplete"
  const frame =
    type === "error" ?
      {
        type: jsonType,
        message,
        code: "server_error",
        param: "input",
        status: 502,
        sequence_number: 2,
      }
    : {
        type: jsonType,
        sequence_number: 2,
        response: {
          id: "resp_terminal",
          object: "response",
          status: responseStatus,
          output: [
            {
              id: "msg_terminal",
              type: "message",
              role: "assistant",
              status: "incomplete",
              content: [
                {
                  type: "output_text",
                  text: "partial-output",
                  annotations: [],
                },
              ],
            },
          ],
          error: {
            code: "server_error",
            message,
            param: "input",
            status: 502,
            private: message,
          },
          message,
          metadata: { private: message },
          incomplete_details: { private: message },
          prompt_cache_key: message,
        },
        private: message,
      }
  return new Response(
    `event: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\n`
      + `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    },
  )
}

function createRawResponsesTerminalSseResponse(data: string): Response {
  const delta = JSON.stringify({
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_terminal",
    output_index: 0,
    content_index: 0,
    delta: "partial-output",
  })
  return new Response(
    `event: response.output_text.delta\ndata: ${delta}\n\n`
      + `event: response.completed\ndata: ${data}\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function createEmptyResponsesTerminalSseResponse(
  eventType: string,
  dataLine: string | undefined,
): Response {
  const delta = JSON.stringify({
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_terminal",
    output_index: 0,
    content_index: 0,
    delta: "partial-output",
  })
  const terminal = [
    `event: ${eventType}`,
    ...(dataLine === undefined ? [] : [dataLine]),
    "",
    "",
  ].join("\n")
  return new Response(
    `event: response.output_text.delta\ndata: ${delta}\n\n${terminal}`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for test condition")
}
