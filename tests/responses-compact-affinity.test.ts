import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { ResponseInputItem } from "~/services/copilot/create-responses"

import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "~/services/copilot/compaction-payload"
import {
  CAPI_RESPONSES_MAX_REQUEST_BYTES,
  RESPONSES_RECOVERY_MARGIN_BYTES,
} from "~/services/copilot/responses-payload-recovery"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const compactAccountIds = [24_001, 24_002]
let capturedAffinity: RoutingAffinity | undefined
let lastRequestBody: Record<string, unknown> | undefined
let lastRequestUrl: string | undefined
let lastUpstreamHeaders: Headers | undefined

const fetchMock = mock((url: string, init?: RequestInit) => {
  capturedAffinity = getRoutingAffinity()
  lastUpstreamHeaders = new Headers(init?.headers)
  lastRequestUrl = url
  lastRequestBody =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined
  if (url.endsWith("/chat/completions")) {
    return Response.json({
      id: "chatcmpl_compact",
      object: "chat.completion",
      created: 1,
      model: "gpt-compact",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "summary" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    })
  }
  return Response.json({
    id: "resp_compact",
    object: "response",
    model: "gpt-compact",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "summary" }],
      },
    ],
    usage: null,
  })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.models = originalModels
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

afterEach(() => {
  for (const accountId of compactAccountIds)
    tokenPool.removeAccountForTest(accountId)
})

beforeEach(() => {
  capturedAffinity = undefined
  lastRequestBody = undefined
  lastRequestUrl = undefined
  lastUpstreamHeaders = undefined
  fetchMock.mockClear()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-compact",
        name: "gpt-compact",
        object: "model",
        version: "test",
        vendor: "openai",
        preview: false,
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
})

function compactRequest(
  clientMetadata: unknown,
  headers: Record<string, string> = {},
  input: Array<ResponseInputItem> = [],
) {
  return seedProtocolDatabase().then(() =>
    server.request("/v1/responses/compact", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model: "gpt-compact",
        input,
        prompt_cache_key: "must-not-be-affinity",
        client_metadata: clientMetadata,
      }),
    }),
  )
}

function compressedCompactRequest(
  clientMetadata: unknown,
  input: Array<ResponseInputItem> = [],
) {
  const body = Bun.zstdCompressSync(
    JSON.stringify({
      model: "gpt-compact",
      input,
      prompt_cache_key: "must-not-be-affinity",
      client_metadata: clientMetadata,
    }),
  )
  return seedProtocolDatabase().then(() =>
    server.request("/v1/responses/compact", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      body,
    }),
  )
}

test("compact decodes zstd-compressed Codex resume requests", async () => {
  const response = await compressedCompactRequest({
    session_id: "compressed-compact",
  })

  expect(response.status).toBe(200)
  expect(capturedAffinity).toEqual({
    key: "compressed-compact",
    source: "codex_metadata",
  })
  expect(lastRequestUrl).toEndWith("/responses")
})

test("compact returns a fixed 400 for malformed zstd JSON", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses/compact", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-compact",
        input: [],
        client_metadata: { session_id: "not-compressed" },
      }),
    }),
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      code: "invalid_json",
      message: "The request body must contain valid JSON.",
      param: "body",
      type: "invalid_request_error",
    },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  { name: "unencoded", contentEncoding: undefined },
  { name: "identity-encoded", contentEncoding: "identity" },
])(
  "compact preserves the existing 500 for $name malformed JSON",
  async ({ contentEncoding }) => {
    const headers = new Headers({ "content-type": "application/json" })
    if (contentEncoding) headers.set("content-encoding", contentEncoding)
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          ...Object.fromEntries(new Headers(headers)),
        },
        body: "{",
      }),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error",
        type: "server_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test("compact installs metadata affinity and preserves header precedence", async () => {
  expect((await compactRequest({ session_id: "compact-body" })).status).toBe(
    200,
  )
  expect(capturedAffinity).toEqual({
    key: "compact-body",
    source: "codex_metadata",
  })

  await compactRequest(
    { session_id: "compact-conflict" },
    { "x-client-session-id": "compact-header" },
  )
  expect(capturedAffinity).toEqual({
    key: "compact-header",
    source: "copilot_session",
  })

  await compactRequest("not json")
  expect(capturedAffinity).toBeUndefined()
})

test("compact routes Codex forks through the parent account and session", async () => {
  const model = state.models?.data[0]
  if (!model) throw new TypeError("Expected compact model")
  for (const [id, token] of [
    [24_001, "compact-child-token"],
    [24_002, "compact-parent-token"],
  ] as const) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = token
    account.healthy = true
    account.models = new Set([model.id])
    account.modelsData = [model]
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true

  const response = await compactRequest(
    {
      session_id: "compact-child-0",
      thread_id: "compact-child-0",
      "x-codex-turn-metadata": JSON.stringify({
        forked_from_thread_id: "compact-parent-0",
      }),
    },
    { "session-id": "compact-child-0" },
  )

  expect(response.status).toBe(200)
  expect(capturedAffinity).toEqual({
    key: "compact-parent-0",
    source: "codex_thread",
  })
  expect(lastUpstreamHeaders?.get("authorization")).toBe(
    "Bearer compact-parent-token",
  )
  expect(lastUpstreamHeaders?.get("x-client-session-id")).toBe(
    "47a2a41d-1ae9-500d-9021-a53db070bb88",
  )
  expect(lastUpstreamHeaders?.get("x-interaction-id")).toBe(
    "47a2a41d-1ae9-500d-9021-a53db070bb88",
  )
})

test(
  "compact fits oversized tool results before summary generation",
  async () => {
    const oversizedOutput =
      "BEGIN-COMPACT\n"
      + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
      + "\nEND-COMPACT"

    const response = await compactRequest(
      { session_id: "compact-oversized" },
      {},
      [
        {
          type: "custom_tool_call",
          call_id: "call_compact",
          name: "exec",
          input: "run compact diagnostic",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_compact",
          output: oversizedOutput,
        },
      ],
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(lastRequestBody)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      COMPACTION_PAYLOAD_MAX_BYTES,
    )
    expect(serialized).toContain("run compact diagnostic")
    expect(serialized).toContain("call_compact")
    expect(serialized).toContain("BEGIN-COMPACT")
    expect(serialized).toContain("END-COMPACT")
    expect(serialized).toContain("UTF-8 bytes omitted during compaction")
    expect(oversizedOutput).toEndWith("END-COMPACT")
  },
  { timeout: 15_000 },
)

test("compact fits and preserves custom tool context on ChatCompletions fallback", async () => {
  const model = state.models?.data[0]
  if (model) model.supported_endpoints = []
  const oversizedOutput =
    "BEGIN-FALLBACK\n"
    + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
    + "\nEND-FALLBACK"

  const response = await compactRequest(
    { session_id: "compact-fallback" },
    {},
    [
      {
        type: "custom_tool_call",
        call_id: "call_fallback",
        name: "exec",
        input: "run fallback diagnostic",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_fallback",
        output: oversizedOutput,
      },
      {
        type: "function_call",
        call_id: "call_standard_fallback",
        name: "shell",
        arguments: JSON.stringify({ command: "Get-Date" }),
      },
      {
        type: "function_call_output",
        call_id: "call_standard_fallback",
        output: "standard fallback result",
      },
    ],
  )

  expect(response.status).toBe(200)
  expect(lastRequestUrl).toEndWith("/chat/completions")
  const serialized = JSON.stringify(lastRequestBody)
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    COMPACTION_PAYLOAD_MAX_BYTES,
  )
  expect(serialized).toContain("run fallback diagnostic")
  expect(serialized).toContain("call_fallback")
  expect(serialized).toContain("call_standard_fallback")
  expect(serialized).toContain("standard fallback result")
  expect(serialized).toContain("BEGIN-FALLBACK")
  expect(serialized).toContain("END-FALLBACK")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
})

test("direct Responses HTTP fallback fits oversized compaction turns", async () => {
  const model = state.models?.data[0]
  if (model) model.supported_endpoints = ["/chat/completions"]
  const oversizedOutput =
    "BEGIN-HTTP-FALLBACK\n"
    + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
    + "\nEND-HTTP-FALLBACK"

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-compact",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_http_fallback",
            name: "exec",
            input: "run http fallback diagnostic",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_http_fallback",
            output: oversizedOutput,
          },
        ],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastRequestUrl).toEndWith("/chat/completions")
  const serialized = JSON.stringify(lastRequestBody)
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    COMPACTION_PAYLOAD_MAX_BYTES,
  )
  expect(serialized).toContain("run http fallback diagnostic")
  expect(serialized).toContain("call_http_fallback")
  expect(serialized).toContain("BEGIN-HTTP-FALLBACK")
  expect(serialized).toContain("END-HTTP-FALLBACK")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
})

test("direct Responses returns the safe local compaction error code", async () => {
  const model = state.models?.data[0]
  if (model) model.supported_endpoints = ["/responses"]
  const callsBefore = fetchMock.mock.calls.length

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-compact",
        input: [
          {
            type: "message",
            role: "developer",
            content: "preserved context ".repeat(
              Math.ceil((COMPACTION_PAYLOAD_MAX_BYTES + 1024) / 18),
            ),
          },
        ],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
      }),
    }),
  )
  const body = (await response.json()) as {
    error?: { code?: string; message?: string; type?: string }
  }

  expect(response.status).toBe(413)
  expect(fetchMock.mock.calls.length).toBe(callsBefore)
  expect(body.error?.code).toBe("compaction_payload_too_large")
  expect(body.error?.type).toBe("error")
  expect(body.error?.message).toContain("safe compaction payload budget")
})

test(
  "direct Responses HTTP recovers oversized ordinary turns before upstream",
  async () => {
    const preservedOutput =
      "BEGIN-HTTP-ORDINARY\n"
      + "x".repeat(26 * 1024 * 1024)
      + "\nEND-HTTP-ORDINARY"
    const inlineFile = `data:application/pdf;base64,${"A".repeat(7 * 1024 * 1024)}`

    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-compact",
          input: [
            {
              type: "custom_tool_call_output",
              call_id: "call_http_ordinary",
              output: [
                { type: "input_text", text: preservedOutput },
                {
                  type: "input_file",
                  filename: "ordinary.pdf",
                  file_data: inlineFile,
                },
              ],
            },
          ],
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
          },
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastRequestUrl).toEndWith("/responses")
    const serialized = JSON.stringify(lastRequestBody)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      CAPI_RESPONSES_MAX_REQUEST_BYTES - RESPONSES_RECOVERY_MARGIN_BYTES,
    )
    expect(serialized).toContain("BEGIN-HTTP-ORDINARY")
    expect(serialized).toContain("END-HTTP-ORDINARY")
    expect(serialized).toContain("call_http_ordinary")
    expect(serialized).not.toContain(inlineFile)
  },
  { timeout: 15_000 },
)

test("direct Responses HTTP rejects unrecoverable ordinary turns locally", async () => {
  const callsBefore = fetchMock.mock.calls.length
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-compact",
        input: [
          {
            type: "message",
            role: "developer",
            content: "preserved".repeat(4 * 1024 * 1024),
          },
        ],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
        },
      }),
    }),
  )
  const body = (await response.json()) as {
    error?: { code?: string; type?: string }
  }

  expect(response.status).toBe(413)
  expect(fetchMock.mock.calls.length).toBe(callsBefore)
  expect(body.error?.code).toBe("responses_payload_too_large")
  expect(body.error?.type).toBe("error")
})
