import { randomUUID } from "node:crypto"

import type { Storage } from "~/lib/storage/types"
import type { Model } from "~/services/copilot/get-models"

import { getAccountsService } from "~/lib/accounts-service"
import { state } from "~/lib/state"
import { AccountsRepository } from "~/lib/storage/accounts-repository"
import { credentialDigest } from "~/lib/storage/credentials-repository"
import { getStoreRevision } from "~/lib/storage/operations"
import { tokenPool } from "~/lib/token-pool"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
  type ResponsesWebSocketData,
} from "~/routes/responses/websocket"
import { server } from "~/server"

function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Protocol smoke failed: ${label}`)
}
interface Terminal {
  type?: string
  response?: { id?: string; output_text?: string }
  error?: { code?: string }
  status?: number
}
function nextTerminal(socket: WebSocket): Promise<Terminal> {
  return new Promise((resolve, reject) => {
    const finish = (frame?: Terminal) => {
      clearTimeout(timer)
      socket.removeEventListener("message", onMessage)
      socket.removeEventListener("error", onError)
      if (frame) resolve(frame)
      else reject(new Error("Protocol smoke terminal unavailable"))
    }
    const onError = () => finish()
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Terminal
      if (
        [
          "error",
          "response.completed",
          "response.failed",
          "response.incomplete",
        ].includes(frame.type ?? "")
      )
        finish(frame)
    }
    const timer = setTimeout(() => finish(), 30_000)
    socket.addEventListener("message", onMessage)
    socket.addEventListener("error", onError, { once: true })
  })
}

// eslint-disable-next-line max-lines-per-function -- One isolated upstream lifetime owns public HTTP and WebSocket validation and cleanup.
export async function smokePublicProtocols(
  storage: Storage,
  gatewayKey: string,
) {
  const model: Model = {
    id: "remote-smoke-model",
    name: "Remote Smoke",
    object: "model",
    version: "1",
    supported_endpoints: ["/chat/completions", "/v1/messages", "/responses"],
    capabilities: {
      family: "gpt",
      limits: { max_output_tokens: 4096 },
      object: "model_capabilities",
      supports: { streaming: true },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
  const repository = new AccountsRepository(storage)
  const oauth = "synthetic-smoke-github-token"
  const created = await repository.create(
    {
      instanceDomain: "github.com",
      upstreamUserId: "987650001",
      login: "smoke-user",
      token: oauth,
      label: "Smoke only",
      accountType: "individual",
      modelCount: 1,
    },
    {
      operationId: randomUUID(),
      expectedRevision: await getStoreRevision(storage),
      actorId: "test:smoke",
      kind: "account.create",
      inputDigest: "smoke-account",
    },
  )
  const account = tokenPool.addAccount(oauth, {
    id: created.value.id,
    accountType: "individual",
    githubInstanceDomain: "github.com",
  })
  account.credentialRevision = created.value.credentialRevision
  account.copilotToken = "synthetic-smoke-copilot-token"
  account.copilotApiBaseUrl = "https://api.individual.githubcopilot.com"
  account.modelsData = [model]
  account.models = new Set([model.id])
  account.healthy = true
  await getAccountsService().refreshRuntime()
  state.isMultiToken = false
  const originalFetch = globalThis.fetch
  const sent: Array<{ path: string; body: Record<string, unknown> }> = []
  let serial = 0
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (
      url.origin !== "https://api.individual.githubcopilot.com"
      || headers.get("authorization") !== "Bearer synthetic-smoke-copilot-token"
    )
      return originalFetch(input, init)
    check(typeof init?.body === "string", "synthetic upstream JSON body")
    const body = JSON.parse(init.body) as Record<string, unknown>
    sent.push({ path: url.pathname, body })
    serial++
    if (url.pathname === "/chat/completions")
      return Promise.resolve(
        Response.json({
          id: `chat-${serial}`,
          object: "chat.completion",
          created: 1,
          model: model.id,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "smoke reply" },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      )
    if (url.pathname === "/v1/messages")
      return Promise.resolve(
        Response.json({
          id: `msg-${serial}`,
          type: "message",
          role: "assistant",
          model: model.id,
          content: [{ type: "text", text: "smoke reply" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
      )
    if (url.pathname === "/responses") {
      const response = {
        id: `resp-smoke-${serial}`,
        object: "response",
        created_at: 1,
        model: model.id,
        status: "completed",
        output: [
          {
            id: `msg-${serial}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "smoke reply", annotations: [] },
            ],
          },
        ],
        output_text: "smoke reply",
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        error: null,
        incomplete_details: null,
      }
      return Promise.resolve(
        body.stream ?
          new Response(
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json(response),
      )
    }
    return Promise.reject(new Error("Unexpected synthetic upstream path"))
  }) as typeof fetch
  let socket: WebSocket | undefined
  const http = Bun.serve<ResponsesWebSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request, bunServer) => {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = await tryUpgradeResponsesWebSocket(request, bunServer)
        if (upgraded === "upgraded") return undefined
        return new Response(null, { status: 401 })
      }
      return server.fetch(request)
    },
    websocket: responsesWebSocket,
  })
  try {
    const base = `http://127.0.0.1:${http.port}`
    const post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gatewayKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: model.id, ...(body as object) }),
      })
    const chat = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "first chat" }],
      stream: false,
    })
    check(
      chat.status === 200
        && JSON.stringify(await chat.json()).includes("smoke reply"),
      "Chat HTTP",
    )
    const messages = await post("/v1/messages", {
      messages: [{ role: "user", content: "first messages" }],
      max_tokens: 64,
      stream: false,
    })
    check(
      messages.status === 200
        && JSON.stringify(await messages.json()).includes("smoke reply"),
      "Messages HTTP",
    )
    const response = await post("/v1/responses", {
      input: "first responses",
      stream: false,
    })
    check(response.status === 200, "Responses HTTP")
    const first = (await response.json()) as {
      id: string
      output: Array<unknown>
    }
    const continuation = await post("/v1/responses", {
      input: [
        { role: "user", content: "first responses" },
        ...first.output,
        { role: "user", content: "second responses" },
      ],
      stream: false,
    })
    check(continuation.status === 200, "Responses HTTP second turn")
    await continuation.arrayBuffer()
    const wsKey = "synthetic-smoke-websocket-key"
    await storage.atomicBatch([
      {
        sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES(?,?,?,?)",
        args: [
          "smoke-websocket",
          credentialDigest(wsKey),
          "Smoke WebSocket",
          Date.now(),
        ],
      },
    ])
    socket = new WebSocket(`ws://127.0.0.1:${http.port}/responses`, {
      headers: { authorization: `Bearer ${wsKey}` },
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WebSocket opening timeout")),
        30_000,
      )
      socket?.addEventListener(
        "open",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      socket?.addEventListener(
        "error",
        () => {
          clearTimeout(timer)
          reject(new Error("WebSocket opening error"))
        },
        { once: true },
      )
    })
    const terminal = nextTerminal(socket)
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: model.id,
        input: "first WebSocket",
        max_output_tokens: 64,
      }),
    )
    const completed = await terminal
    check(
      completed.type === "response.completed" && completed.response?.id,
      "WebSocket first turn",
    )
    const next = nextTerminal(socket)
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: model.id,
        previous_response_id: completed.response.id,
        input: "second WebSocket",
        max_output_tokens: 64,
      }),
    )
    check((await next).type === "response.completed", "WebSocket continuation")
    check(
      JSON.stringify(sent.at(-1)?.body.input).includes("first WebSocket")
        && JSON.stringify(sent.at(-1)?.body.input).includes("second WebSocket"),
      "WebSocket continuation history",
    )
    await storage.atomicBatch([
      {
        sql: "UPDATE capi_gateway_credentials SET revoked_at=? WHERE id=?",
        args: [Date.now(), "smoke-websocket"],
      },
    ])
    const count = sent.length
    const denied = nextTerminal(socket)
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: model.id,
        input: "must reject",
      }),
    )
    const failure = await denied
    check(
      failure.type === "error"
        && failure.error?.code === "authentication_error"
        && failure.status === 401,
      "WebSocket rechecks revoked credential",
    )
    check(sent.length === count, "revoked turn never dispatched upstream")
    return {
      requests: sent.length,
      checks: [
        "Chat HTTP",
        "Messages HTTP",
        "Responses HTTP second turn",
        "Responses WebSocket continuation",
        "revoked WebSocket next turn",
      ],
    }
  } finally {
    socket?.close()
    await http.stop(true)
    // eslint-disable-next-line require-atomic-updates -- This fixture restores the fetch function it exclusively replaced.
    globalThis.fetch = originalFetch
  }
}
