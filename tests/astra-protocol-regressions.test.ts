import "./helpers/auth-misc-data-dir"

import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  AccountsService,
  createAccountMutationContext,
  getAccountsService,
} from "~/lib/accounts-service"
import { isIpBlocked, resetIpSecurityForTest } from "~/lib/ip-blocker"
import { getLlmDebugLog, listLlmDebugLogs } from "~/lib/llm-debug-log"
import { state } from "~/lib/state"
import {
  createProviderMutationContext,
  createProvidersRepository,
} from "~/lib/storage/providers-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"
import {
  createHistoryRuntime,
  peekHistoryRuntime,
} from "~/lib/telemetry-writer"
import { tokenPool } from "~/lib/token-pool"
import {
  responsesWebSocket,
  type ResponsesWebSocketData,
} from "~/routes/responses/websocket"
import {
  VOICE_WS_PATH,
  voiceWebSocket,
  type VoiceSession,
} from "~/routes/voice/route"
import { server } from "~/server"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"
import { handleStartFetch } from "~/start"

import {
  adminHeaders,
  createTestAdminSession,
  TEST_GATEWAY_KEY,
  type TestAdminSession,
} from "./helpers/admin-session"
import { createAuthStorageFixture } from "./helpers/auth-storage"

const model: Model = {
  id: "audit-protocol-model",
  name: "Audit protocol model",
  object: "model",
  version: "1",
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    family: "gpt",
    limits: { max_output_tokens: 4096 },
    object: "model_capabilities",
    supports: { tool_calls: true },
    tokenizer: "cl100k_base",
    type: "chat",
  },
}
const requestPayload = {
  model: model.id,
  messages: [{ role: "user", content: "Protocol regression conversation" }],
  stream: false,
}
const inferenceHeaders = {
  authorization: `Bearer ${TEST_GATEWAY_KEY}`,
  "content-type": "application/json",
}
const originalFetch = globalThis.fetch
const originalState = { ...state }
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let admin: TestAdminSession
let service: AccountsService
const upstream: Array<{
  url: string
  headers: Headers
  body: Record<string, unknown>
}> = []
let respond: (url: URL, init?: RequestInit) => Response | Promise<Response>
type SocketData =
  | ResponsesWebSocketData
  | { type: "voice"; session: VoiceSession }
let listener: ReturnType<typeof Bun.serve<SocketData>> | undefined
const sockets = new Set<WebSocket>()

function chatResponse(search = false): Response {
  return Response.json({
    id: `chat-${upstream.length}`,
    object: "chat.completion",
    created: 1,
    model: model.id,
    choices: [
      {
        index: 0,
        message:
          search ?
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "search-call",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: '{"query":"fixture query"}',
                  },
                },
              ],
            }
          : { role: "assistant", content: "Protocol regression response" },
        finish_reason: search ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function fixtureResponse(url: URL, init?: RequestInit): Response {
  if (url.pathname === "/mcp/readonly") {
    if (typeof init?.body !== "string")
      throw new Error("Expected MCP JSON body")
    const body = JSON.parse(init.body) as { method?: string }
    return body.method === "initialize" ?
        Response.json(
          { jsonrpc: "2.0", id: "init", result: {} },
          { headers: { "Mcp-Session-Id": `session-${upstream.length}` } },
        )
      : Response.json({
          jsonrpc: "2.0",
          id: "search",
          result: { content: [{ type: "text", text: "Fixture web result" }] },
        })
  }
  if (url.hostname === "api.groq.com")
    return Response.json({ text: "Fixture transcript" })
  if (url.pathname === "/copilot_internal/user")
    return Response.json({
      copilot_plan: "individual",
      quota_reset_date: "2030-01-01",
    })
  return chatResponse()
}

beforeEach(async () => {
  resetIpSecurityForTest()
  resetWebSearchSessionsForTest()
  fixture = await createAuthStorageFixture()
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  state.githubToken = undefined
  state.copilotToken = undefined
  state.copilotApiBaseUrl = undefined
  state.isMultiToken = false
  state.apiKeyAuth = undefined
  state.models = { object: "list", data: [] }
  admin = await createTestAdminSession({ reuseStorage: true })
  await createHistoryRuntime(fixture.storage, { autoFlush: false })
  service = new AccountsService(fixture.storage, {
    pool: tokenPool,
    validate: async (input) => {
      await Promise.resolve()
      return {
        persisted: {
          token: input.token,
          instanceDomain: input.instanceDomain ?? "github.com",
          upstreamUserId: "fixture-user",
          login: "fixture",
          label: null,
          accountType: "individual",
          modelCount: 1,
        },
        resolved: {
          token: input.token,
          baseUrl: "https://api.githubcopilot.com",
          models: { object: "list", data: [model] },
        },
      }
    },
  })
  upstream.length = 0
  respond = fixtureResponse
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "127.0.0.1") return originalFetch(input, init)
    if (
      ![
        "api.fixture.ghe.com",
        "api.github.com",
        "api.githubcopilot.com",
        "api.groq.com",
      ].includes(url.hostname)
    )
      throw new Error("Unexpected upstream in isolated protocol fixture")
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    upstream.push({ url: url.href, headers: new Headers(init?.headers), body })
    return respond(url, init)
  }) as typeof fetch
})

afterEach(async () => {
  fixture.failReads(false)
  for (const socket of sockets) socket.close()
  sockets.clear()
  const closingListener = listener
  listener = undefined
  await closingListener?.stop(true)
  await peekHistoryRuntime()?.close(1000)
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  await fixture.close()
  Object.assign(state, originalState)
  globalThis.fetch = originalFetch
  resetWebSearchSessionsForTest()
  resetIpSecurityForTest()
})

async function seedAccount(
  id: number,
  options: { domain?: string; token?: string } = {},
): Promise<void> {
  const token = options.token ?? `fixture-github-${id}`
  const domain = options.domain ?? "github.com"
  const account = tokenPool.addAccount(token, {
    id,
    accountType: "individual",
    githubInstanceDomain: domain,
  })
  Object.assign(account, {
    credentialRevision: 0,
    healthy: true,
    copilotToken: token,
    copilotApiBaseUrl: "https://api.githubcopilot.com",
    models: new Set([model.id]),
    modelsData: [model],
  })
  await fixture.storage.transaction(async (session) => {
    await session.execute({
      sql: "INSERT INTO capi_accounts(id,domain,upstream_user_id,login,enabled,credential_revision,validation_json,created_at,updated_at) VALUES(?,?,?,'fixture',1,0,?,1,1)",
      args: [
        id,
        domain,
        id === 0 ? "fixture-user" : `fixture-user-${id}`,
        JSON.stringify({ accountType: "individual" }),
      ],
    })
    await session.execute({
      sql: "INSERT INTO capi_account_credentials(account_id,oauth_value,updated_at) VALUES(?,?,1)",
      args: [id, token],
    })
    await session.execute({
      sql: "UPDATE capi_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='config_revision'",
      args: [],
    })
  })
  await getAccountsService().refreshRuntime()
}

function mutation(kind: string, input: unknown) {
  return createAccountMutationContext(
    fixture.storage,
    kind,
    input,
    "test:protocol",
  )
}

function requestChat(body: unknown = requestPayload) {
  return server.request("/v1/chat/completions", {
    method: "POST",
    headers: inferenceHeaders,
    body: JSON.stringify(body),
  })
}

function requestSearch() {
  return server.request("/v1/alpha/search", {
    method: "POST",
    headers: inferenceHeaders,
    body: JSON.stringify({
      id: "fixture-search",
      model: model.id,
      commands: { search_query: [{ q: "fixture query" }] },
    }),
  })
}

test.each([0, 17])(
  "single-account debug replay retains account %d and rejects its removal",
  async (id) => {
    await seedAccount(id)
    const first = await requestChat()
    expect(first.status).toBe(200)
    await first.arrayBuffer()
    const logs = await listLlmDebugLogs()
    const entry = await getLlmDebugLog(logs.entries[0].id)
    expect(entry?.upstream).toEqual({ kind: "copilot", accountId: id })
    await service.remove(id, await mutation("account.remove", { id }))
    await service.whenIdle()
    await seedAccount(id + 100)
    const sends = upstream.length
    const replay = await server.request(
      `/dashboard/api/llm-debug/${entry?.id}/replay`,
      {
        method: "POST",
        headers: adminHeaders(admin),
        body: JSON.stringify({ body: requestPayload }),
      },
    )
    expect(replay.status).toBe(409)
    expect(upstream.length).toBe(sends)
  },
)

test("single-account standalone MCP search uses the stored credential without global tokens", async () => {
  await seedAccount(0)
  const response = await requestSearch()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ output: "Fixture web result" })
  expect(upstream).toHaveLength(2)
  expect(
    upstream.every(
      (request) =>
        request.headers.get("authorization") === "Bearer fixture-github-0",
    ),
  ).toBe(true)
})

test("hosted MCP follows its admitted credential through reconnect and later requests get a new session", async () => {
  await seedAccount(0)
  let chatCalls = 0
  respond = async (url, init) => {
    if (url.pathname === "/chat/completions" && chatCalls++ === 0) {
      await service.replaceCredential(
        0,
        "fixture-reconnected",
        await mutation("account.replace", { id: 0 }),
      )
      return chatResponse(true)
    }
    return fixtureResponse(url, init)
  }
  const response = await requestChat({
    ...requestPayload,
    tools: [{ type: "web_search" }],
  })
  expect(response.status).toBe(200)
  expect(JSON.stringify(await response.json())).toContain(
    "Protocol regression response",
  )
  const firstSearch = upstream.filter(
    (request) => new URL(request.url).pathname === "/mcp/readonly",
  )
  expect(firstSearch).toHaveLength(2)
  expect(
    firstSearch.every(
      (request) =>
        request.headers.get("authorization") === "Bearer fixture-github-0",
    ),
  ).toBe(true)
  expect(
    upstream
      .filter(
        (request) => new URL(request.url).pathname === "/chat/completions",
      )
      .map((request) => request.headers.get("authorization")),
  ).toEqual(["Bearer fixture-github-0", "Bearer fixture-github-0"])
  const next = await requestSearch()
  await next.arrayBuffer()
  const nextSearch = upstream
    .filter((request) => new URL(request.url).pathname === "/mcp/readonly")
    .slice(2)
  expect(nextSearch).toHaveLength(2)
  expect(nextSearch[0].body.method).toBe("initialize")
  expect(
    nextSearch.every(
      (request) =>
        request.headers.get("authorization") === "Bearer fixture-reconnected",
    ),
  ).toBe(true)
})

test.each([false, true])(
  "hosted inference stays on its admitted account after removal (pooled=%s)",
  async (pooled) => {
    await seedAccount(0)
    if (pooled) await seedAccount(1)
    state.isMultiToken = pooled
    let chatCalls = 0
    respond = async (url, init) => {
      if (url.pathname === "/chat/completions" && chatCalls++ === 0) {
        await service.remove(0, await mutation("account.remove", { id: 0 }))
        await seedAccount(100, { token: "fixture-other-identity" })
        return chatResponse(true)
      }
      return fixtureResponse(url, init)
    }
    const response = await requestChat({
      ...requestPayload,
      tools: [{ type: "web_search" }],
    })
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).toContain(
      "Protocol regression response",
    )
    const inference = upstream.filter(
      (request) => new URL(request.url).pathname === "/chat/completions",
    )
    expect(inference).toHaveLength(2)
    expect(
      inference.map((request) => request.headers.get("authorization")),
    ).toEqual(["Bearer fixture-github-0", "Bearer fixture-github-0"])
    await service.whenIdle()
    expect((await service.repository.get(0)).token).toBeNull()
  },
)

test.each(["github.com", "fixture.ghe.com"])(
  "public usage uses the stored %s credential and domain",
  async (domain) => {
    await seedAccount(0, { domain })
    const response = await server.request("/usage", {
      headers: inferenceHeaders,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ copilot_plan: "individual" })
    expect(upstream).toHaveLength(1)
    expect(upstream[0].headers.get("authorization")).toBe(
      "Bearer fixture-github-0",
    )
    expect(new URL(upstream[0].url).hostname).toBe(
      domain === "github.com" ? "api.github.com" : "api.fixture.ghe.com",
    )
  },
)

function startListener() {
  listener = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    fetch: handleStartFetch,
    websocket: {
      open(ws) {
        if (ws.data.type === "voice")
          voiceWebSocket.open(ws as { data: { session: VoiceSession } })
        else responsesWebSocket.open(ws as { data: ResponsesWebSocketData })
      },
      message(ws, message) {
        if (ws.data.type === "voice")
          voiceWebSocket.message(
            ws as unknown as Parameters<typeof voiceWebSocket.message>[0],
            message,
          )
        else
          void responsesWebSocket.message(
            ws as unknown as Parameters<typeof responsesWebSocket.message>[0],
            message,
          )
      },
      close(ws) {
        if (ws.data.type === "voice")
          voiceWebSocket.close(ws as { data: { session: VoiceSession } })
        else responsesWebSocket.close(ws as { data: ResponsesWebSocketData })
      },
    },
  })
  return listener
}

test.each(["/responses", VOICE_WS_PATH])(
  "%s upgrade returns typed no-store storage 503 without an IP strike",
  async (path) => {
    const http = startListener()
    fixture.failReads()
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await originalFetch(
        `http://127.0.0.1:${http.port}${path}`,
        {
          headers: {
            ...inferenceHeaders,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "YXVkaXQtdGVzdC1rZXkwMA==",
          },
        },
      )
      expect(response.status).toBe(503)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toMatchObject({
        error: { code: "storage_unavailable" },
      })
    }
    expect(isIpBlocked("127.0.0.1")).toBe(false)
  },
)

async function openVoice() {
  await createProvidersRepository(fixture.storage).setGroqSecret(
    { apiKey: "fixture-groq" },
    await createProviderMutationContext(
      fixture.storage,
      "groq.update",
      {},
      "test:protocol",
    ),
  )
  await getStorageRuntime().snapshot.refreshIfChanged()
  const http = startListener()
  const socket = new WebSocket(`ws://127.0.0.1:${http.port}${VOICE_WS_PATH}`, {
    headers: inferenceHeaders,
  })
  sockets.add(socket)
  const frames: Array<Record<string, unknown>> = []
  socket.addEventListener("message", (event) =>
    frames.push(JSON.parse(String(event.data)) as Record<string, unknown>),
  )
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener(
      "error",
      () => reject(new Error("Voice opening failed")),
      { once: true },
    )
  })
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Voice close timeout")),
      5000,
    )
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
  return { socket, frames, closed }
}

function finishVoice(socket: WebSocket) {
  socket.send(new Uint8Array([0, 0, 1, 0, 2, 0, 3, 0]))
  socket.send(JSON.stringify({ type: "CloseStream" }))
}

test.each(["outage", "revocation"])(
  "voice rejects a new transcription after %s",
  async (condition) => {
    const voice = await openVoice()
    if (condition === "outage") fixture.failReads()
    else
      await fixture.storage.atomicBatch([
        { sql: "UPDATE capi_gateway_credentials SET revoked_at=1", args: [] },
      ])
    finishVoice(voice.socket)
    await voice.closed
    expect(upstream).toHaveLength(0)
    expect(voice.frames).toEqual([
      {
        type: "TranscriptError",
        description:
          condition === "outage" ?
            "Database storage is temporarily unavailable."
          : "Authentication failed",
      },
    ])
  },
)

test("an admitted voice transcription finishes through a later database outage", async () => {
  const voice = await openVoice()
  const entered = Promise.withResolvers<undefined>()
  const completed = Promise.withResolvers<Response>()
  respond = () => {
    entered.resolve(undefined)
    return completed.promise
  }
  finishVoice(voice.socket)
  await entered.promise
  fixture.failReads()
  completed.resolve(Response.json({ text: "Admitted transcript" }))
  await voice.closed
  expect(voice.frames).toEqual([
    { type: "TranscriptText", data: "Admitted transcript" },
    { type: "TranscriptEndpoint" },
  ])
  expect(upstream[0].headers.get("authorization")).toBe("Bearer fixture-groq")
})

test("an initial 429 failover remains selected through hosted model continuation", async () => {
  await seedAccount(0)
  await seedAccount(100, { token: "fixture-secondary" })
  let secondaryCalls = 0
  respond = (url, init) => {
    if (url.pathname === "/chat/completions") {
      const authorization = new Headers(init?.headers).get("authorization")
      if (authorization === "Bearer fixture-github-0")
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      if (authorization === "Bearer fixture-secondary")
        return chatResponse(secondaryCalls++ === 0)
    }
    return fixtureResponse(url, init)
  }
  const response = await requestChat({
    ...requestPayload,
    tools: [{ type: "web_search" }],
  })
  expect(response.status).toBe(200)
  await response.arrayBuffer()
  expect(secondaryCalls).toBe(2)
  expect(
    upstream
      .filter((request) => new URL(request.url).pathname === "/mcp/readonly")
      .every(
        (request) =>
          request.headers.get("authorization") === "Bearer fixture-secondary",
      ),
  ).toBe(true)
})
