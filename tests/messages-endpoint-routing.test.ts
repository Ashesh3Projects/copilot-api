/* eslint-disable max-lines -- route, fidelity, and recovery matrix share one transport harness */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { parseFetchableHttpUrl } from "~/lib/attachments"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { selectMessagesUpstreamEndpoint } from "~/routes/messages/handler"
import {
  checkMessagesToChatTranslation,
  checkMessagesToResponsesTranslation,
} from "~/routes/messages/translation-fidelity"
import { server } from "~/server"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const upstreamBodies: Array<Record<string, unknown>> = []
const upstreamHeaders: Array<Headers> = []
const upstreamPaths: Array<string> = []
const queuedMessagesResults: Array<Error | Response> = []
const queuedChatResults: Array<Response> = []
const queuedResponsesResults: Array<Response> = []
let attachmentFetchCount = 0
const TEST_ACCOUNT_IDS = [91_001, 91_002, 92_001, 92_002, 93_001, 93_002]
const INVALID_TRANSLATED_DOCUMENT_URLS = [
  "ftp://example.test/report.pdf",
  "file:///tmp/report.pdf",
  "data:application/pdf;base64,JVBERi0=",
  "/relative/report.pdf",
  "not a URL",
  " ",
  "http:///attachment.test/report.pdf",
  "http:////attachment.test/report.pdf",
  " https://attachment.test/report.pdf",
  "https://attachment.test/report.pdf ",
  "\nhttps://attachment.test/report.pdf",
  "https://attachment.test/report.pdf\n",
  "https://attachment.test/\u0000report.pdf",
  "https://attachment.test/report.pdf\u007f",
  "https://user:pass@attachment.test/report.pdf",
  "https://user@attachment.test/report.pdf",
  "https://@attachment.test/report.pdf",
  "https://:@attachment.test/report.pdf",
  "http://[::1/report.pdf",
  "https://:443/report.pdf",
  "https://attachment.test:65536/report.pdf",
  "https://attachment..test/report.pdf",
  "https://-attachment.test/report.pdf",
  "https://attachment-.test/report.pdf",
  "https://attach_ment.test/report.pdf",
  "https://127.1/report.pdf",
  "https://2130706433/report.pdf",
  "https://0x7f000001/report.pdf",
  "https://0x7f.0.0.1/report.pdf",
  "https://0177.0.0.1/report.pdf",
  "https://./report.pdf",
  "https://../report.pdf",
  String.raw`http://attachment.test\report.pdf`,
  "https://attachment.test/a/../report.pdf",
  "https://attachment.test/report%zz.pdf",
  "https://[2001:0DB8:0000:0000:0000:0000:0000:0001]:8443/report.pdf",
  "https://[2001:DB8::1]:8443/report.pdf",
  "https://[::ffff:192.0.2.128]:8443/report.pdf",
  "http://[2001:db8::1]:080/report.pdf",
  "http://[2001:db8::1]:80/report.pdf",
  "https://[2001:db8::1]:443/report.pdf",
]
const DOCUMENT_URL_CANDIDATES = [
  ...INVALID_TRANSLATED_DOCUMENT_URLS,
  "https://attachment.test",
  "https://attachment.test?download=1#section",
  "https://attachment.test/?download=1#section",
  "http://attachment.test:80/report.pdf?download=1#section",
  "https://attachment.test:443/report.pdf?download=1#section",
  "http://attachment.test:8080/report.pdf?download=1#section",
  "https://LOCALHOST:8443/report.pdf?download=1#section",
  "https://127.0.0.1:8443/report.pdf?download=1#section",
  "https://[2001:db8::1]:8443/report.pdf?download=1#section",
  "https://attachment.test/report%20name.pdf?download=%E2%9C%93#section-1",
]
const FETCHABLE_TRANSLATED_DOCUMENT_URLS = DOCUMENT_URL_CANDIDATES.filter(
  (url) => parseFetchableHttpUrl(url) !== null,
)
const UNFETCHABLE_TRANSLATED_DOCUMENT_URLS = DOCUMENT_URL_CANDIDATES.filter(
  (url) => parseFetchableHttpUrl(url) === null,
)

async function expectSafeMessagesRejection(response: Response): Promise<void> {
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "The Copilot Messages request was rejected.",
    },
  })
}

function createAttachmentResponse(
  url: URL,
  init?: RequestInit,
): Response | undefined {
  if (init?.body !== undefined) {
    return undefined
  }
  attachmentFetchCount += 1
  const isImage = url.pathname.endsWith(".png")
  return new Response(
    isImage ? "normalized image" : "%PDF-1.4 normalized attachment",
    {
      headers: {
        "content-type": isImage ? "image/png" : "application/pdf",
      },
    },
  )
}

const fetchMock = mock(
  // eslint-disable-next-line complexity -- fixture branches mirror independent upstream protocols
  (url: string | URL | Request, init?: RequestInit): Response => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    const parsedUrl = new URL(rawUrl)
    const attachment = createAttachmentResponse(parsedUrl, init)
    if (attachment) return attachment
    const path = parsedUrl.pathname
    upstreamPaths.push(path)
    upstreamHeaders.push(new Headers(init?.headers))
    upstreamBodies.push(
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {},
    )

    if (path === "/v1/messages") {
      const queued = queuedMessagesResults.shift()
      if (queued instanceof Error) throw queued
      if (queued) return queued
      return Response.json({
        id: "msg_route",
        type: "message",
        role: "assistant",
        model: "route-model",
        content: [{ type: "text", text: "native" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
    if (path === "/mcp/readonly") {
      const requestBody = upstreamBodies.at(-1)
      if (requestBody?.method === "initialize") {
        return new Response(
          'data: {"jsonrpc":"2.0","id":"init","result":{}}\n\n',
          {
            headers: {
              "content-type": "text/event-stream",
              "Mcp-Session-Id": "route-session",
            },
          },
        )
      }
      return new Response(
        'data: {"jsonrpc":"2.0","id":"search","result":{"content":[{"type":"text","text":"current result"}]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (path === "/responses") {
      const queued = queuedResponsesResults.shift()
      if (queued) return queued
      return Response.json({
        id: "resp_route",
        object: "response",
        created_at: 1,
        model: "route-model",
        output: [
          {
            id: "msg_route",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "responses" }],
          },
        ],
        output_text: "responses",
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: true,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
      })
    }
    if (path === "/chat/completions") {
      const queued = queuedChatResults.shift()
      if (queued) return queued
      return Response.json({
        id: "chat_route",
        object: "chat.completion",
        created: 1,
        model: "route-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "chat" },
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
    return new Response("unexpected upstream path", { status: 500 })
  },
)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

afterEach(removeTestAccounts)

beforeEach(() => {
  fetchMock.mockClear()
  upstreamBodies.length = 0
  upstreamHeaders.length = 0
  upstreamPaths.length = 0
  queuedMessagesResults.length = 0
  queuedChatResults.length = 0
  queuedResponsesResults.length = 0
  resetWebSearchSessionsForTest()
  attachmentFetchCount = 0
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = undefined
  state.sessionId = "messages-routing-test"
  removeTestAccounts()
})

test.each([
  {
    name: "dual Messages and Responses",
    endpoints: ["/responses", "/v1/messages"],
    expected: "/v1/messages",
  },
  {
    name: "Messages only",
    endpoints: ["/v1/messages"],
    expected: "/v1/messages",
  },
  {
    name: "Responses only",
    endpoints: ["/responses"],
    expected: "/responses",
  },
  {
    name: "Chat only",
    endpoints: ["/chat/completions"],
    expected: "/chat/completions",
  },
  {
    name: "missing endpoint metadata",
    endpoints: undefined,
    expected: "/chat/completions",
  },
])(
  "routes ordinary Messages through $name",
  async ({ endpoints, expected }) => {
    installModel({
      supported_endpoints: endpoints ? [...endpoints] : undefined,
    })

    const response = await postMessages({
      messages: [{ role: "user", content: "hello" }],
    })

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual([expected])
  },
)

test.each([
  {
    endpoint: "/v1/messages",
    expectedTool: {
      name: "lookup",
      description: "Look something up",
    },
    expectedChoice: { type: "tool", name: "lookup" },
  },
  {
    endpoint: "/chat/completions",
    expectedTool: {
      type: "function",
      function: {
        name: "lookup",
        description: "Look something up",
        parameters: { type: "object", properties: {} },
      },
    },
    expectedChoice: {
      type: "function",
      function: { name: "lookup" },
    },
  },
  {
    endpoint: "/responses",
    expectedTool: {
      type: "function",
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
    expectedChoice: { type: "function", name: "lookup" },
  },
] as const)(
  "preserves a schema-less named tool on $endpoint wire dispatch",
  async ({ endpoint, expectedChoice, expectedTool }) => {
    installModel({ supported_endpoints: [endpoint] })

    const response = await postMessages({
      tools: [{ name: "lookup", description: "Look something up" }],
      tool_choice: { type: "tool", name: "lookup" },
    })

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual([endpoint])
    expect(upstreamBodies[0]).toHaveProperty("tools.0", expectedTool)
    expect(upstreamBodies[0]).toHaveProperty("tool_choice", expectedChoice)
    const serializedTool = JSON.stringify(
      (upstreamBodies[0]?.tools as Array<unknown> | undefined)?.[0],
    )
    expect(serializedTool).not.toContain('"required"')
    expect(serializedTool).not.toContain('"additionalProperties"')
  },
)

test.each([
  {
    name: "on translated routing without a URL image",
    endpoints: ["/responses", "/chat/completions"],
    messages: [{ role: "user", content: "search" }],
  },
  {
    name: "on translated routing with a URL image",
    endpoints: ["/responses", "/chat/completions"],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "url",
              url: "https://attachment.test/private.png",
            },
          },
        ],
      },
    ],
  },
  {
    name: "on the native compatibility loop without a URL image",
    endpoints: ["/v1/messages", "/responses"],
    messages: [{ role: "user", content: "search" }],
  },
  {
    name: "on the native compatibility loop with a URL image",
    endpoints: ["/v1/messages", "/responses"],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "url",
              url: "https://attachment.test/private.png",
            },
          },
        ],
      },
    ],
  },
] as const)(
  "dispatches a meaningful versioned web-search schema $name",
  async ({ endpoints, messages }) => {
    installModel({ supported_endpoints: [...endpoints] })
    const marker = "PRIVATE_WEB_SEARCH_SCHEMA"

    const response = await postMessages({
      messages: structuredClone(messages),
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          input_schema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: marker,
              },
            },
          },
        },
      ],
    })
    expect(response.status).toBe(200)
    expect(upstreamPaths).toHaveLength(1)
    expect(JSON.stringify(upstreamBodies[0])).toContain("web_search")
    expect(JSON.stringify(upstreamBodies[0])).not.toContain(marker)
  },
)

test("dispatches an unknown typed tool while preserving the request text", async () => {
  installModel({ supported_endpoints: ["/responses", "/chat/completions"] })
  const privateType = "PRIVATE_FUTURE_NATIVE_20270101"
  const privateName = "PRIVATE_FUTURE_TOOL"
  const tool = {
    type: privateType,
    name: privateName,
    input_schema: { type: "object", properties: {} },
  }

  const response = await postMessages({ tools: [tool] })
  expect(
    checkMessagesToResponsesTranslation({
      model: "route-model",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [tool],
    } as AnthropicMessagesPayload),
  ).toEqual({
    supported: false,
    blockers: ["tool_type"],
  })
  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(0)
  expect(upstreamPaths).toEqual(["/responses"])
  expect(JSON.stringify(upstreamBodies[0])).toContain("hello")
})

test("preserves an unknown typed tool with a schema on native Messages", async () => {
  installModel({ supported_endpoints: ["/v1/messages", "/responses"] })
  const tool = {
    type: "future_native_20270101",
    name: "future_native",
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
    },
    future_option: { enabled: true },
  }

  const response = await postMessages({ tools: [tool] })

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages"])
  expect(upstreamBodies[0]).toHaveProperty("tools.0", tool)
})

const WEB_SEARCH_TYPE_LOOKALIKES = [
  "web_searchfuture",
  "Web_search_20250305",
  "prefix_web_search_20250305",
  "web-search_20250305",
  "web_search_",
  "web_search__20250305",
]

test.each(WEB_SEARCH_TYPE_LOOKALIKES)(
  "preserves unknown web-search lookalike type %s on native Messages",
  async (type) => {
    installModel({ supported_endpoints: ["/v1/messages", "/responses"] })
    const tool = {
      type,
      name: "future_native",
      input_schema: { type: "object", properties: {} },
      future_option: { enabled: true },
    }

    const response = await postMessages({ tools: [tool] })

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual(["/v1/messages"])
    expect(upstreamBodies[0]).toHaveProperty("tools.0", tool)
  },
)

test.each(WEB_SEARCH_TYPE_LOOKALIKES)(
  "dispatches unknown web-search lookalike type %s with request text",
  async (type) => {
    installModel({ supported_endpoints: ["/responses", "/chat/completions"] })
    const tool = {
      type,
      name: "future_native",
      input_schema: { type: "object", properties: {} },
    }

    const response = await postMessages({ tools: [tool] })

    expect(response.status).toBe(200)
    expect(attachmentFetchCount).toBe(0)
    expect(upstreamPaths).toEqual(["/responses"])
    expect(JSON.stringify(upstreamBodies[0])).toContain("hello")
  },
)

test.each([
  "web_search",
  "web_search_20250305",
  "web_search_preview",
  "web_search_preview_2025_03_11",
])("retains schema-extension rules for valid web-search type %s", (type) => {
  const tool = {
    type,
    name: "web_search",
    input_schema: { type: "object", properties: { query: {} } },
  }
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    tools: [tool],
  } as AnthropicMessagesPayload

  expect(checkMessagesToResponsesTranslation(payload)).toEqual({
    supported: false,
    blockers: ["tool_extension"],
  })
})

test("recursively blocks lossy nested tool-result content", () => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_outer",
            content: [
              {
                type: "tool_result",
                tool_use_id: "PRIVATE_NESTED_ID",
                is_error: true,
                content: [
                  {
                    type: "image",
                    source: {
                      type: "url",
                      url: "https://attachment.test/private.png",
                      private_source_key: true,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as AnthropicMessagesPayload

  expect(checkMessagesToResponsesTranslation(payload).blockers).toEqual([
    "content_extension",
    "source_extension",
  ])
  expect(checkMessagesToChatTranslation(payload).blockers).toEqual([
    "content_extension",
    "tool_result.is_error",
    "source_extension",
  ])
  expect(
    JSON.stringify(checkMessagesToResponsesTranslation(payload)),
  ).not.toContain("PRIVATE_NESTED_ID")
})

test.each([
  {
    name: "primitive content",
    content: [null],
  },
  {
    name: "empty content",
    content: [],
  },
  {
    name: "nested native tool block",
    content: [
      {
        type: "tool_use",
        id: "PRIVATE_NESTED_TOOL_ID",
        name: "PRIVATE_NESTED_TOOL",
        input: {},
      },
    ],
  },
] as const)("blocks tool-result $name without throwing", ({ content }) => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_outer", content }],
      },
    ],
  } as unknown as AnthropicMessagesPayload

  expect(checkMessagesToResponsesTranslation(payload).blockers).toEqual([
    "content_extension",
  ])
  expect(checkMessagesToChatTranslation(payload).blockers).toEqual([
    "content_extension",
  ])
})

test("bounds cyclic, deep, and oversized tool-result traversal", () => {
  const cyclic = {
    type: "tool_result",
    tool_use_id: "toolu_cycle",
    content: [] as Array<unknown>,
  }
  cyclic.content.push(cyclic)

  let deep: Record<string, unknown> = {
    type: "text",
    text: "deep",
  }
  for (let index = 0; index < 40; index += 1) {
    deep = {
      type: "tool_result",
      tool_use_id: `toolu_${index}`,
      content: [deep],
    }
  }

  for (const content of [
    [cyclic],
    [deep],
    Array.from({ length: 2_049 }, () => ({ type: "text", text: "x" })),
  ]) {
    const payload = {
      model: "route-model",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_outer", content },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    expect(checkMessagesToResponsesTranslation(payload).blockers).toContain(
      "content_extension",
    )
    expect(checkMessagesToChatTranslation(payload).blockers).toContain(
      "content_extension",
    )
  }
})

test("keeps empty tool-result content eligible for tolerant Chat adaptation", async () => {
  installModel({ supported_endpoints: ["/chat/completions"] })

  const response = await postMessages({
    messages: [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_empty", content: [] },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(0)
  expect(upstreamPaths).toEqual(["/chat/completions"])
})

test("preserves recursively nested tool results on native Messages", async () => {
  installModel({ supported_endpoints: ["/v1/messages", "/responses"] })
  const nested = {
    type: "tool_result",
    tool_use_id: "toolu_outer",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_inner",
        content: [{ type: "text", text: "inner" }],
        is_error: true,
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ],
  }

  const response = await postMessages({
    messages: [{ role: "user", content: [nested] }],
  })

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages"])
  expect(upstreamBodies[0]).toHaveProperty("messages.0.content.0", nested)
})

test.each([
  {
    name: "metadata",
    extra: { metadata: { user_id: "safe", private_metadata_key: true } },
    blocker: "request_extension",
    expectedContent: "hello",
  },
  {
    name: "thinking control",
    extra: { thinking: { type: "enabled", private_thinking_key: true } },
    blocker: "request_extension",
    expectedContent: "hello",
  },
  {
    name: "output format",
    extra: {
      output_config: {
        format: { type: "json_object", private_format_key: true },
      },
    },
    blocker: "format_extension",
    expectedContent: "hello",
  },
  {
    name: "image source",
    extra: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                url: "https://attachment.test/private.png",
                private_source_key: true,
              },
            },
          ],
        },
      ],
    },
    blocker: "source_extension",
    expectedContent: "data:image/png;base64,",
  },
  {
    name: "document citations",
    extra: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "JVBERi0=",
              },
              citations: { enabled: true, private_citation_key: true },
            },
          ],
        },
      ],
    },
    blocker: "content_extension",
    expectedContent: "input_file",
  },
  {
    name: "cache control",
    extra: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              cache_control: {
                type: "ephemeral",
                private_cache_key: true,
              },
            },
          ],
        },
      ],
    },
    blocker: "content_extension",
    expectedContent: "hello",
  },
  {
    name: "tool schema",
    extra: {
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: {},
            private_schema_key: true,
          },
        },
      ],
    },
    blocker: "tool_extension",
    expectedContent: "lookup",
  },
  {
    name: "nested tool schema",
    extra: {
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                private_nested_schema_key: true,
              },
            },
          },
        },
      ],
    },
    blocker: "tool_extension",
    expectedContent: "lookup",
  },
  {
    name: "nested output schema",
    extra: {
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              answer: {
                type: "string",
                private_nested_format_key: true,
              },
            },
          },
        },
      },
    },
    blocker: "format_extension",
    expectedContent: "hello",
  },
] as const)(
  "dispatches nested $name extensions with meaningful translated content",
  async ({ extra, expectedContent }) => {
    installModel({ supported_endpoints: ["/responses", "/chat/completions"] })

    const response = await postMessages(extra)

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual(["/responses"])
    expect(JSON.stringify(upstreamBodies[0])).toContain(expectedContent)
  },
)

test("prefers native Messages and preserves signed thinking", async () => {
  installModel({ supported_endpoints: ["/responses", "/v1/messages"] })

  const response = await postMessages({
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "prior thought",
            signature: "valid-native-signature",
          },
        ],
      },
      { role: "user", content: "continue" },
    ],
  })

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages"])
  expect(JSON.stringify(upstreamBodies[0])).toContain("valid-native-signature")
})

test.each([
  {
    name: "exact identifier",
    beta: "context-1m-2025-08-07",
    expectedModel: "route-model-1m",
    expectedHeader: "context-1m-2025-08-07",
  },
  {
    name: "duplicate canonical identifiers",
    beta: " beta-one,context-1m-2025-08-07,beta-one ",
    expectedModel: "route-model-1m",
    expectedHeader: "beta-one,context-1m-2025-08-07",
  },
  {
    name: "substring only",
    beta: "not-context-1m-2025-08-07-extra",
    expectedModel: "route-model",
    expectedHeader: "not-context-1m-2025-08-07-extra",
  },
] as const)(
  "uses canonical beta membership for $name model routing",
  async ({ beta, expectedHeader, expectedModel }) => {
    state.isMultiToken = true
    const account = registerAccount(92_001, "beta-account-token")
    tokenPool.rebuildModelIndex()
    state.models = {
      object: "list",
      data: [
        createModel({ supported_endpoints: ["/v1/messages"] }),
        {
          ...createModel({ supported_endpoints: ["/v1/messages"] }),
          id: "route-model-1m",
          name: "route-model-1m",
        },
      ],
    } satisfies ModelsResponse
    account.modelsData = state.models.data
    account.models = new Set(state.models.data.map((model) => model.id))

    const response = await postMessages({}, { "anthropic-beta": beta })

    expect(response.status).toBe(200)
    expect(upstreamBodies[0]?.model).toBe(expectedModel)
    expect(upstreamHeaders[0]?.get("anthropic-beta")).toBe(expectedHeader)
  },
)

test("retains valid beta identifiers before model-variant routing", async () => {
  state.isMultiToken = true
  const account = registerAccount(92_001, "beta-account-token")
  tokenPool.rebuildModelIndex()
  state.models = {
    object: "list",
    data: [
      createModel({ supported_endpoints: ["/v1/messages"] }),
      {
        ...createModel({ supported_endpoints: ["/v1/messages"] }),
        id: "route-model-1m",
        name: "route-model-1m",
      },
    ],
  } satisfies ModelsResponse
  account.modelsData = state.models.data
  account.models = new Set(state.models.data.map((model) => model.id))

  const response = await postMessages(
    {},
    { "anthropic-beta": "context-1m-2025-08-07,bad beta" },
  )

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages"])
  expect(upstreamBodies[0]?.model).toBe("route-model-1m")
  expect(upstreamHeaders[0]?.get("anthropic-beta")).toBe(
    "context-1m-2025-08-07",
  )
})

test("rejects an unknown Messages model without fabricating Chat support", async () => {
  state.models = {
    object: "list",
    data: [
      {
        ...createModel({ supported_endpoints: ["/chat/completions"] }),
        id: "different-model",
        name: "different-model",
      },
    ],
  } satisfies ModelsResponse

  const response = await postMessages({ model: "unknown-model" })

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({
    type: "error",
    error: { type: "not_found_error", code: "model_not_found" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("recovers once from a deterministic native signature rejection", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  const debugSpy = spyOn(consola, "debug")
  queuedMessagesResults.push(
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
          "x-github-request-id": "signature-rejected",
        },
      },
    ),
    new Response(await nativeSuccess("recovered").text(), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-github-request-id": "signature-recovered",
        "x-quota-snapshot-premium": "final-quota",
      },
    }),
  )

  const response = await postMessages(
    {
      messages: signedThinkingHistory(),
      thinking: { type: "enabled" },
    },
    {
      "anthropic-beta": "beta-one, beta-two, beta-one",
      "anthropic-version": "2024-01-01",
      "x-model-provider-preference": "anthropic",
    },
  )

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages", "/v1/messages"])
  expect(JSON.stringify(upstreamBodies[0])).toContain("native-signature")
  expect(JSON.stringify(upstreamBodies[1])).not.toContain('"type":"thinking"')
  expect(upstreamBodies[1]).toHaveProperty("thinking", { type: "enabled" })
  for (const headers of upstreamHeaders) {
    expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
    expect(headers.get("anthropic-version")).toBe("2024-01-01")
    expect(headers.get("x-model-provider-preference")).toBe("anthropic")
  }
  const metadataEvents = contractEventData(
    debugSpy.mock.calls,
    "response_metadata",
  )
  expect(metadataEvents).toEqual([
    { kind: "response_metadata", headerCount: 2, quotaSnapshotCount: 1 },
  ])
  debugSpy.mockRestore()
})

test("rebuilds native image preparation before signature recovery dispatch", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    nativeSuccess("recovered-image"),
  )

  const response = await postMessages({
    messages: [
      ...signedThinkingHistory(),
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "url",
              url: "https://attachment.test/recovery.png",
            },
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(upstreamBodies[1]).toHaveProperty(
    "messages.3.content.0.source.type",
    "base64",
  )
  expect(JSON.stringify(upstreamBodies[1])).not.toContain("native-signature")
})

test("finalizes native tool-result merging before the selected first wire", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postMessages({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_review",
            content: "parsed",
          },
          { type: "text", text: "Use that result." },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(upstreamBodies[0]).toHaveProperty(
    "messages.0.content.0.content",
    "parsed\n\nUse that result.",
  )
})

test("keeps native signature recovery on the account used by the first send", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  state.isMultiToken = true
  registerAccount(91_001, "first-account-token")
  registerAccount(91_002, "alternate-account-token")
  tokenPool.rebuildModelIndex()
  queuedMessagesResults.push(
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    nativeSuccess("same-account-recovery"),
  )

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(200)
  expect(
    upstreamHeaders.map((headers) => headers.get("authorization")),
  ).toEqual(["Bearer first-account-token", "Bearer first-account-token"])
})

test.each([
  {
    name: "generic Bad Request",
    response: new Response("Bad Request", { status: 400 }),
  },
  {
    name: "unrelated invalid request",
    response: Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid max_tokens" },
      },
      { status: 400 },
    ),
  },
])("does not recover native thinking for $name", async ({ response }) => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(response, nativeSuccess("must-not-send"))

  const result = await postMessages({ messages: signedThinkingHistory() })

  expect(result.status).toBe(400)
  expect(upstreamPaths).toEqual(["/v1/messages"])
})

test("does not recover an unrelated 400 that merely contains invalid-signature words", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(
    Response.json(
      {
        error: {
          code: "different_error",
          message: "An unrelated validation mentions Invalid signature text",
        },
      },
      { status: 400 },
    ),
    nativeSuccess("must-not-send"),
  )

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(400)
  expect(upstreamPaths).toEqual(["/v1/messages"])
})

test.each([
  Response.json(
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Invalid signature in thinking block",
      },
    },
    { status: 400 },
  ),
  Response.json(
    {
      error: {
        code: "invalid_request_body",
        message: "Invalid `signature` in thinking block",
      },
    },
    { status: 400 },
  ),
])("recovers exact known native signature response %#", async (failure) => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(failure, nativeSuccess("recovered-exact"))

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages", "/v1/messages"])
})

test.each([
  new Response("{not-json", { status: 400 }),
  Response.json(
    { error: { code: "invalid_request_body", message: { private: true } } },
    { status: 400 },
  ),
])(
  "does not recover malformed or private signature body %#",
  async (failure) => {
    installModel({ supported_endpoints: ["/v1/messages"] })
    queuedMessagesResults.push(failure, nativeSuccess("must-not-send"))

    const response = await postMessages({ messages: signedThinkingHistory() })

    expect(response.status).toBe(400)
    expect(upstreamPaths).toEqual(["/v1/messages"])
  },
)

test("recovers a streaming native signature rejection before output", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    nativeSuccess("must-not-send"),
  )

  const response = await postMessages({
    messages: signedThinkingHistory(),
    stream: true,
  })

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages", "/v1/messages"])
})

test("streaming native web search keeps recovery inside the loop and emits Anthropic SSE", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    Response.json({
      id: "msg_search",
      type: "message",
      role: "assistant",
      model: "route-model",
      content: [
        {
          type: "tool_use",
          id: "toolu_search",
          name: "web_search",
          input: { query: "current facts" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    nativeSuccess("streamed-final"),
  )

  const response = await postMessages({
    messages: signedThinkingHistory(),
    stream: true,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
  })
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(body).toContain("event: message_start")
  expect(body).toContain("streamed-final")
  expect(body).toContain("event: message_stop")
  expect(body).not.toContain('"type":"tool_use"')
  expect(upstreamPaths.filter((path) => path === "/v1/messages")).toHaveLength(
    3,
  )
})

test("native web-search iterations emit one final metadata event", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  const debugSpy = spyOn(consola, "debug")
  queuedMessagesResults.push(
    Response.json(
      {
        id: "msg_search_metadata",
        type: "message",
        role: "assistant",
        model: "route-model",
        content: [
          {
            type: "tool_use",
            id: "toolu_search_metadata",
            name: "web_search",
            input: { query: "current facts" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { headers: { "x-github-request-id": "search-intermediate" } },
    ),
    new Response(await nativeSuccess("search-final").text(), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-github-request-id": "search-final",
      },
    }),
  )

  try {
    const response = await postMessages({
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    })

    expect(response.status).toBe(200)
    const metadataEvents = contractEventData(
      debugSpy.mock.calls,
      "response_metadata",
    )
    expect(metadataEvents).toEqual([
      { kind: "response_metadata", headerCount: 1, quotaSnapshotCount: 0 },
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test.each([
  { endpoint: "/chat/completions", name: "Chat" },
  { endpoint: "/responses", name: "Responses" },
])(
  "enforces translated Messages max_uses on $name without wire metadata",
  async ({ endpoint }) => {
    installModel({ supported_endpoints: [endpoint] })
    const threeCalls = Array.from({ length: 3 }, (_, index) => ({
      id: `item-${index}`,
      type: "function_call",
      call_id: `call-${index}`,
      name: "web_search",
      arguments: `{"query":"query ${index}"}`,
      status: "completed",
    }))
    if (endpoint === "/chat/completions") {
      queuedChatResults.push(
        Response.json({
          id: "chat_search_limit",
          object: "chat.completion",
          created: 1,
          model: "route-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: threeCalls.map((call) => ({
                  id: call.call_id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: call.arguments,
                  },
                })),
              },
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
        }),
      )
    } else {
      queuedResponsesResults.push(
        Response.json({
          id: "response_search_limit",
          object: "response",
          created_at: 1,
          model: "route-model",
          output: threeCalls,
          output_text: "",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: null,
          parallel_tool_calls: false,
          temperature: null,
          tool_choice: "auto",
          tools: [],
          top_p: null,
        }),
      )
    }

    const response = await postMessages({
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    })
    const body = await response.json()
    const inferenceBodies = upstreamPaths.flatMap((path, index) =>
      path === endpoint ? [upstreamBodies[index]] : [],
    )

    expect(response.status).toBe(400)
    expect(body).toMatchObject({
      error: { code: "web_search_limit_exceeded" },
    })
    expect(
      upstreamBodies.filter((body) => body.method === "tools/call"),
    ).toHaveLength(0)
    expect(JSON.stringify(inferenceBodies)).not.toContain("max_uses")
  },
)

test("native web-search follow-ups keep an issuer-matched session token on one account", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  state.isMultiToken = true
  registerAccount(93_001, "tid=web-issuer;exp=1900000000")
  registerAccount(93_002, "tid=other-issuer;exp=1900000000")
  tokenPool.rebuildModelIndex()
  const token = `e30.${Buffer.from(
    JSON.stringify({ selected_model: "route-model", sub: "web-issuer" }),
  ).toString("base64url")}.c2ln`
  queuedMessagesResults.push(
    Response.json({
      id: "msg_search_token",
      type: "message",
      role: "assistant",
      model: "route-model",
      content: [
        {
          type: "tool_use",
          id: "toolu_search_token",
          name: "web_search",
          input: { query: "current facts" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    nativeSuccess("done"),
  )

  const response = await postMessages(
    {
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    },
    { "copilot-session-token": token },
  )

  expect(response.status).toBe(200)
  const attempts = upstreamPaths.flatMap((path, index) =>
    path === "/v1/messages" ? [index] : [],
  )
  expect(
    attempts.map((index) =>
      upstreamHeaders[index]?.get("copilot-session-token"),
    ),
  ).toEqual([token, token])
  expect(
    attempts.map((index) => upstreamHeaders[index]?.get("authorization")),
  ).toEqual([
    "Bearer tid=web-issuer;exp=1900000000",
    "Bearer tid=web-issuer;exp=1900000000",
  ])
})

test("pins native web-search follow-up to the account selected by failover", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  state.isMultiToken = true
  registerAccount(93_001, "web-primary-token")
  registerAccount(93_002, "web-secondary-token")
  tokenPool.rebuildModelIndex()
  queuedMessagesResults.push(
    Response.json(
      { type: "error", error: { type: "overloaded_error" } },
      { status: 429, headers: { "retry-after": "0" } },
    ),
    Response.json(
      { type: "error", error: { type: "overloaded_error" } },
      { status: 429 },
    ),
    Response.json(
      {
        id: "msg_search",
        type: "message",
        role: "assistant",
        model: "route-model",
        content: [
          {
            type: "thinking",
            thinking: "searching",
            signature: "signed-on-secondary",
          },
          {
            type: "tool_use",
            id: "toolu_search",
            name: "web_search",
            input: { query: "current facts" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { status: 200 },
    ),
    nativeSuccess("done"),
  )

  const response = await postMessages({
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
  })

  expect(response.status).toBe(200)
  const messageAttempts = upstreamPaths.flatMap((path, index) =>
    path === "/v1/messages" ? [index] : [],
  )
  expect(
    messageAttempts.map((index) =>
      upstreamHeaders[index]?.get("authorization"),
    ),
  ).toEqual([
    "Bearer web-primary-token",
    "Bearer web-primary-token",
    "Bearer web-secondary-token",
    "Bearer web-secondary-token",
  ])
  expect(JSON.stringify(upstreamBodies[messageAttempts[3]])).toContain(
    "signed-on-secondary",
  )
})

test("suppresses signature recovery after transport retry exhausts the shared send budget", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  state.isMultiToken = true
  registerAccount(92_001, "budget-primary-token")
  registerAccount(92_002, "budget-secondary-token")
  tokenPool.rebuildModelIndex()
  queuedMessagesResults.push(
    Response.json(
      {
        type: "error",
        error: { type: "overloaded_error", message: "rate limited" },
      },
      { status: 429, headers: { "retry-after": "0" } },
    ),
    Response.json(
      {
        type: "error",
        error: { type: "overloaded_error", message: "still rate limited" },
      },
      { status: 429 },
    ),
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    nativeSuccess("fourth-send-must-not-happen"),
  )

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(400)
  expect(upstreamPaths).toEqual([
    "/v1/messages",
    "/v1/messages",
    "/v1/messages",
  ])
  expect(JSON.stringify(upstreamBodies[2])).toContain("native-signature")
})

test("allows a recovery transport retry as the third shared send", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    nativeSuccess("recovered-after-transport"),
    nativeSuccess("fourth-send-must-not-happen"),
  )

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual([
    "/v1/messages",
    "/v1/messages",
    "/v1/messages",
  ])
  expect(JSON.stringify(upstreamBodies[2])).not.toContain('"type":"thinking"')
})

test.each([
  {
    name: "ToolSearch reference",
    extra: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_search",
              content: [{ type: "tool_reference", tool_name: "Bash" }],
            },
          ],
        },
      ],
    },
    param: "tool_reference",
  },
  {
    name: "unknown native tool without schema",
    extra: {
      tools: [{ type: "future_native_tool", name: "future_tool" }],
    },
    param: "tool_extension",
  },
])(
  "dispatches a Responses-only $name with meaningful translated content",
  async ({ extra, name }) => {
    installModel({ supported_endpoints: ["/responses"] })

    const response = await postMessages(extra)

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual(["/responses"])
    expect(JSON.stringify(upstreamBodies[0])).toContain(
      name === "ToolSearch reference" ? "Bash" : "hello",
    )
  },
)

test("rejects an explicit empty endpoint list before upstream dispatch", async () => {
  installModel({ supported_endpoints: [] })

  const response = await postMessages({})

  await expectSafeMessagesRejection(response)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("selects native then Responses then Chat without mutating inputs", () => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [{ role: "user" as const, content: "hello" }],
  }
  const model = createModel({
    supported_endpoints: ["/chat/completions", "/responses", "/v1/messages"],
  })
  const payloadSnapshot = structuredClone(payload)
  const modelSnapshot = structuredClone(model)

  expect(
    selectMessagesUpstreamEndpoint({ payload, selectedModel: model }),
  ).toEqual({
    reason: "native",
    source: "messages",
    target: "/v1/messages",
    translated: false,
  })
  expect(payload).toEqual(payloadSnapshot)
  expect(model).toEqual(modelSnapshot)
})

test("allows the mapped Messages translation subset", () => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "inspect" },
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png" as const,
              data: "AA==",
            },
          },
          {
            type: "document" as const,
            source: {
              type: "base64" as const,
              media_type: "application/pdf",
              data: "JVBERi0=",
            },
          },
        ],
      },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "calling" },
          {
            type: "tool_use" as const,
            id: "toolu_lookup",
            name: "lookup",
            input: { query: "value" },
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "toolu_lookup",
            content: "done",
          },
        ],
      },
    ],
    system: [{ type: "text" as const, text: "system" }],
    stop_sequences: ["END"],
    temperature: 0.4,
    top_p: 0.8,
    output_config: { effort: "high" as const },
    tools: [
      {
        name: "lookup",
        description: "Lookup a value",
        input_schema: { type: "object", properties: {} },
      },
    ],
    tool_choice: { type: "tool" as const, name: "lookup" },
  }

  expect(checkMessagesToResponsesTranslation(payload)).toEqual({
    supported: false,
    blockers: ["stop_sequences", "temperature"],
  })
  expect(checkMessagesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: ["document"],
  })
})

test.each([
  {
    name: "stop sequences",
    extra: { stop_sequences: ["END"] },
    responses: ["stop_sequences"],
    chat: [],
  },
  {
    name: "temperature",
    extra: { temperature: 0.4 },
    responses: ["temperature"],
    chat: [],
  },
  {
    name: "top p",
    extra: { top_p: 0.8 },
    responses: [],
    chat: [],
  },
  {
    name: "top k",
    extra: { top_k: 20 },
    responses: ["top_k"],
    chat: ["top_k"],
  },
  {
    name: "service tier",
    extra: { service_tier: "standard_only" },
    responses: ["service_tier"],
    chat: ["service_tier"],
  },
  {
    name: "output format",
    extra: { output_config: { format: { type: "json_object" } } },
    responses: [],
    chat: [],
  },
  {
    name: "output effort",
    extra: { output_config: { effort: "high" } },
    responses: [],
    chat: [],
  },
  {
    name: "output task budget",
    extra: {
      output_config: {
        task_budget: { type: "tokens", total: 100, remaining: 80 },
      },
    },
    responses: [],
    chat: ["output_config.task_budget"],
  },
  {
    name: "unknown output config extension",
    extra: { output_config: { future_output_control: true } },
    responses: ["request_extension"],
    chat: ["request_extension"],
  },
  {
    name: "parallel tool control",
    extra: {
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    },
    responses: ["tool_choice.disable_parallel_tool_use"],
    chat: ["tool_choice.disable_parallel_tool_use"],
  },
  {
    name: "unknown root extension",
    extra: { future_native_field: { enabled: true } },
    responses: ["request_extension"],
    chat: ["request_extension"],
  },
])(
  "maps or blocks top-level Messages $name exactly",
  ({ extra, responses, chat }) => {
    const payload = {
      model: "route-model",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      ...extra,
    } as AnthropicMessagesPayload

    expect(checkMessagesToResponsesTranslation(payload).blockers).toEqual([
      ...responses,
    ])
    expect(checkMessagesToChatTranslation(payload).blockers).toEqual([...chat])
  },
)

test.each([
  {
    name: "text cache control",
    block: {
      type: "text",
      text: "hello",
      cache_control: { type: "ephemeral" },
    },
    blocker: "content_cache_control",
  },
  {
    name: "text extension",
    block: { type: "text", text: "hello", future_text_field: true },
    blocker: "content_extension",
  },
  {
    name: "message extension",
    messageExtra: { future_message_field: true },
    block: { type: "text", text: "hello" },
    blocker: "content_extension",
  },
  {
    name: "tool use extension",
    role: "assistant",
    block: {
      type: "tool_use",
      id: "toolu_1",
      name: "lookup",
      input: {},
      future_tool_use_field: true,
    },
    blocker: "content_extension",
  },
  {
    name: "tool result extension",
    block: {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "done",
      future_tool_result_field: true,
    },
    blocker: "content_extension",
  },
])(
  "fails closed for nested Messages $name",
  ({ blocker, block, messageExtra, role = "user" }) => {
    const payload = {
      model: "route-model",
      max_tokens: 64,
      messages: [{ role, content: [block], ...messageExtra }],
    } as unknown as AnthropicMessagesPayload

    expect(checkMessagesToResponsesTranslation(payload).blockers).toContain(
      blocker,
    )
    expect(checkMessagesToChatTranslation(payload).blockers).toContain(blocker)
  },
)

test("blocks thinking that the target converter cannot round-trip", () => {
  const unsigned = {
    model: "route-model",
    max_tokens: 64,
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "unsigned" }],
      },
    ],
  } as AnthropicMessagesPayload
  const responsesSigned = {
    ...unsigned,
    messages: [
      {
        role: "assistant" as const,
        content: [
          {
            type: "thinking" as const,
            thinking: "responses",
            signature: "encrypted@rs_1",
          },
        ],
      },
    ],
  }
  const chatSigned = {
    ...unsigned,
    messages: [
      {
        role: "assistant" as const,
        content: [
          {
            type: "thinking" as const,
            thinking: "chat",
            signature: "native-signature",
          },
        ],
      },
    ],
  }

  expect(checkMessagesToResponsesTranslation(unsigned).blockers).toEqual([
    "thinking_signature",
  ])
  expect(checkMessagesToChatTranslation(unsigned).blockers).toEqual([])
  expect(checkMessagesToResponsesTranslation(responsesSigned).blockers).toEqual(
    [],
  )
  expect(checkMessagesToChatTranslation(responsesSigned).blockers).toEqual([
    "thinking_signature",
  ])
  expect(checkMessagesToResponsesTranslation(chatSigned).blockers).toEqual([
    "thinking_signature",
  ])
  expect(checkMessagesToChatTranslation(chatSigned).blockers).toEqual([])
})

test("routes to Responses when translated Messages content is best-effort", () => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    stop_sequences: ["END"],
  } as AnthropicMessagesPayload
  const selectedModel = createModel({
    supported_endpoints: ["/responses", "/chat/completions"],
  })

  expect(selectMessagesUpstreamEndpoint({ payload, selectedModel })).toEqual({
    reason: "endpoint_unavailable",
    source: "messages",
    target: "/responses",
    translated: true,
  })
})

test.each([
  {
    name: "plain document",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
      title: "report.pdf",
    },
    responses: [],
    chat: ["document"],
  },
  {
    name: "document context",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
      context: "Read section two first.",
    },
    responses: ["document.context"],
    chat: ["document"],
  },
  {
    name: "document citations",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
      citations: { enabled: true },
    },
    responses: ["document.citations"],
    chat: ["document"],
  },
  {
    name: "text document source",
    document: {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "notes" },
      title: "notes.txt",
    },
    responses: ["document.source"],
    chat: ["document"],
  },
  {
    name: "content document source",
    document: {
      type: "document",
      source: { type: "content", content: "notes" },
      title: "notes.txt",
    },
    responses: ["document.source"],
    chat: ["document"],
  },
  {
    name: "non-PDF document source",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "text/plain",
        data: "bm90ZXM=",
      },
      title: "notes.txt",
    },
    responses: ["document.source"],
    chat: ["document"],
  },
  ...UNFETCHABLE_TRANSLATED_DOCUMENT_URLS.map((url) => ({
    name: `invalid URL document source ${url}`,
    document: {
      type: "document",
      source: { type: "url", url },
      title: "report.pdf",
    },
    responses: ["document.source"],
    chat: ["document"],
  })),
  ...FETCHABLE_TRANSLATED_DOCUMENT_URLS.map((url) => ({
    name: `runtime-valid URL document source ${url}`,
    document: {
      type: "document",
      source: { type: "url", url },
      title: "report.pdf",
    },
    responses: [],
    chat: ["document"],
  })),
  {
    name: "URL document source extension",
    document: {
      type: "document",
      source: {
        type: "url",
        url: "https://attachment.test/report.pdf",
        authorization: "private",
      },
      title: "report.pdf",
    },
    responses: ["source_extension", "document.source"],
    chat: ["source_extension", "document"],
  },
])("maps or blocks $name without loss", ({ document, responses, chat }) => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [{ role: "user", content: [document] }],
  } as unknown as AnthropicMessagesPayload

  expect(checkMessagesToResponsesTranslation(payload).blockers).toEqual([
    ...responses,
  ])
  expect(checkMessagesToChatTranslation(payload).blockers).toEqual([...chat])
})

test.each([true, false])(
  "preserves or blocks meaningful tool_result.is_error=%s",
  (isError) => {
    const payload = {
      model: "route-model",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "result",
              is_error: isError,
            },
          ],
        },
      ],
    } as AnthropicMessagesPayload

    expect(checkMessagesToResponsesTranslation(payload).blockers).toEqual([])
    expect(checkMessagesToChatTranslation(payload).blockers).toEqual([
      "tool_result.is_error",
    ])
  },
)

test("routes document context to Responses for best-effort translation", () => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0=",
            },
            context: "Preserve this context.",
          },
        ],
      },
    ],
  } as AnthropicMessagesPayload
  const selectedModel = createModel({
    supported_endpoints: ["/responses", "/chat/completions"],
  })

  expect(selectMessagesUpstreamEndpoint({ payload, selectedModel })).toEqual({
    reason: "endpoint_unavailable",
    source: "messages",
    target: "/responses",
    translated: true,
  })
})

test.each([
  {
    name: "text source with context",
    document: {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "notes" },
      title: "notes.txt",
      context: "preserve text context",
    },
    param: "document.source",
    expectedText: "notes",
  },
  {
    name: "content source with citations",
    document: {
      type: "document",
      source: { type: "content", content: "content source" },
      title: "content.txt",
      citations: { enabled: true },
    },
    param: "document.source",
    expectedText: "content source",
  },
  {
    name: "non-PDF base64 source with citations",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "text/plain",
        data: Buffer.from("encoded notes").toString("base64"),
      },
      title: "encoded.txt",
      citations: { enabled: false },
    },
    param: "document.source",
    expectedText: "encoded notes",
  },
])(
  "normalizes $name for Responses while preserving document text",
  async ({ document, expectedText }) => {
    installModel({ supported_endpoints: ["/responses", "/chat/completions"] })

    const response = await postMessages({
      messages: [{ role: "user", content: [document] }],
    })

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual(["/responses"])
    expect(JSON.stringify(upstreamBodies[0])).toContain(expectedText)
  },
)

test.each([
  {
    name: "text source",
    document: {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "notes" },
      title: "notes.txt",
      context: "preserve text context",
    },
    expectedText: "notes",
  },
  {
    name: "content source",
    document: {
      type: "document",
      source: { type: "content", content: "content source" },
      title: "content.txt",
      citations: { enabled: true },
    },
    expectedText: "content source",
  },
  {
    name: "non-PDF base64 source",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "text/plain",
        data: Buffer.from("encoded notes").toString("base64"),
      },
      title: "encoded.txt",
      citations: { enabled: false },
    },
    expectedText: "encoded notes",
  },
])(
  "normalizes $name for Chat while preserving document text",
  async ({ document, expectedText }) => {
    installModel({ supported_endpoints: ["/chat/completions"] })

    const response = await postMessages({
      messages: [{ role: "user", content: [document] }],
    })

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual(["/chat/completions"])
    expect(JSON.stringify(upstreamBodies[0])).toContain(expectedText)
  },
)

test.each([
  {
    name: "text source",
    document: {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "notes" },
      title: "notes.txt",
      context: "preserve text context",
      citations: { enabled: true },
    },
  },
  {
    name: "content source",
    document: {
      type: "document",
      source: {
        type: "content",
        content: [{ type: "text", text: "content source" }],
      },
      title: "content.txt",
      context: "preserve content context",
      citations: { enabled: false },
    },
  },
  {
    name: "non-PDF base64 source",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "text/plain",
        data: Buffer.from("encoded notes").toString("base64"),
      },
      title: "encoded.txt",
      context: "preserve encoded context",
      citations: { enabled: true },
    },
  },
])(
  "passes $name metadata through native Messages without normalization",
  async ({ document }) => {
    installModel({ supported_endpoints: ["/v1/messages", "/responses"] })

    const response = await postMessages({
      messages: [{ role: "user", content: [document] }],
    })

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual(["/v1/messages"])
    expect(upstreamBodies[0]).toHaveProperty("messages.0.content.0", document)
    expect(attachmentFetchCount).toBe(0)
  },
)

test.each(FETCHABLE_TRANSLATED_DOCUMENT_URLS)(
  "normalizes one remote PDF %s only after selecting Responses",
  async (url) => {
    installModel({ supported_endpoints: ["/responses", "/chat/completions"] })

    const response = await postMessages({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "url", url },
              title: "report.pdf",
            },
          ],
        },
      ],
    })

    expect(response.status).toBe(200)
    expect(attachmentFetchCount).toBe(1)
    expect(upstreamPaths).toEqual(["/responses"])
    expect(upstreamBodies[0]).toHaveProperty(
      "input.0.content.0.filename",
      "report.pdf",
    )
    expect(upstreamBodies[0]).toHaveProperty(
      "input.0.content.0.type",
      "input_file",
    )
  },
)

test("sends a base64 PDF with title to Responses without attachment fetch", async () => {
  installModel({ supported_endpoints: ["/responses", "/chat/completions"] })

  const response = await postMessages({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0=",
            },
            title: "report.pdf",
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(0)
  expect(upstreamPaths).toEqual(["/responses"])
  expect(upstreamBodies[0]).toHaveProperty(
    "input.0.content.0.filename",
    "report.pdf",
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("normalizes one remote image only after selecting Chat", async () => {
  installModel({ supported_endpoints: ["/chat/completions"] })

  const response = await postMessages({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://attachment.test/image.png" },
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(1)
  expect(upstreamPaths).toEqual(["/chat/completions"])
  const body = upstreamBodies[0] as {
    messages?: Array<{
      content?: Array<{ image_url?: { url?: string } }>
    }>
  }
  expect(body.messages?.[0]?.content?.[0]?.image_url?.url).toStartWith(
    "data:image/png;base64,",
  )
})

test("normalizes one remote image after selecting native Messages", async () => {
  installModel({ supported_endpoints: ["/v1/messages", "/responses"] })

  const response = await postMessages({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://attachment.test/image.png" },
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(1)
  expect(upstreamPaths).toEqual(["/v1/messages"])
  expect(upstreamBodies[0]).toHaveProperty(
    "messages.0.content.0.source.type",
    "base64",
  )
})

test("preserves nested native document metadata while normalizing its sibling image once", async () => {
  installModel({ supported_endpoints: ["/v1/messages", "/responses"] })
  const document = {
    type: "document",
    source: { type: "content", content: "nested content" },
    title: "nested.txt",
    context: "nested context",
    citations: { enabled: true },
  }

  const response = await postMessages({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_nested",
            content: [
              document,
              {
                type: "image",
                source: {
                  type: "url",
                  url: "https://attachment.test/image.png",
                },
              },
            ],
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(1)
  expect(upstreamPaths).toEqual(["/v1/messages"])
  expect(upstreamBodies[0]).toHaveProperty(
    "messages.0.content.0.content.0",
    document,
  )
  expect(upstreamBodies[0]).toHaveProperty(
    "messages.0.content.0.content.1.source.type",
    "base64",
  )
})

test("recovers remote document metadata through Responses", async () => {
  installModel({ supported_endpoints: ["/responses", "/chat/completions"] })

  const response = await postMessages({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "url", url: "https://attachment.test/report.pdf" },
            title: "report.pdf",
            context: "must remain structural",
            citations: { enabled: true },
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(1)
  expect(upstreamPaths).toEqual(["/responses"])
  expect(upstreamBodies[0]).toHaveProperty(
    "input.0.content.0.type",
    "input_file",
  )
  expect(upstreamBodies[0]).toHaveProperty(
    "input.0.content.0.filename",
    "report.pdf",
  )
})

test.each(UNFETCHABLE_TRANSLATED_DOCUMENT_URLS)(
  "omits parser-invalid translated document URL %s before fetch and dispatches meaningful text",
  async (url) => {
    installModel({ supported_endpoints: ["/responses", "/chat/completions"] })

    const response = await postMessages({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Keep this request content." },
            {
              type: "document",
              source: { type: "url", url },
              title: "report.pdf",
            },
          ],
        },
      ],
    })

    expect(response.status).toBe(200)
    expect(attachmentFetchCount).toBe(0)
    expect(upstreamPaths).toEqual(["/responses"])
    expect(upstreamBodies[0]).toHaveProperty("input.0.content.0", {
      type: "input_text",
      text: "Keep this request content.",
    })
    expect(upstreamBodies[0]).toHaveProperty("input.0.content.1", {
      type: "input_text",
      text: '[file attachment "report.pdf" omitted: the URL could not be fetched by the proxy]',
    })
  },
)

test("recovers translated URL source extensions through Responses", async () => {
  installModel({ supported_endpoints: ["/responses", "/chat/completions"] })

  const response = await postMessages({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "url",
              url: "https://attachment.test/report.pdf",
              future_source_field: "private",
            },
            title: "report.pdf",
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(attachmentFetchCount).toBe(1)
  expect(upstreamPaths).toEqual(["/responses"])
  expect(upstreamBodies[0]).toHaveProperty(
    "input.0.content.0.type",
    "input_file",
  )
})

test.each(INVALID_TRANSLATED_DOCUMENT_URLS)(
  "native Messages preserves document URL %s unchanged",
  async (url) => {
    installModel({ supported_endpoints: ["/v1/messages", "/responses"] })
    const document = {
      type: "document",
      source: { type: "url", url, future_source_field: "native" },
      title: "report.pdf",
    }

    const response = await postMessages({
      messages: [{ role: "user", content: [document] }],
    })

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual(["/v1/messages"])
    expect(upstreamBodies[0]).toHaveProperty("messages.0.content.0", document)
  },
)

test.each([
  {
    name: "Responses",
    endpoints: ["/responses"],
    extra: { future_native_field: { enabled: true } },
    param: "request_extension",
  },
  {
    name: "Chat",
    endpoints: ["/chat/completions"],
    extra: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello", future_text_field: true }],
        },
      ],
    },
    param: "content_extension",
  },
])(
  "dispatches unknown native extensions through translated $name",
  async ({ endpoints, extra }) => {
    installModel({ supported_endpoints: [...endpoints] })

    const response = await postMessages(extra)

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual([endpoints[0]])
    expect(JSON.stringify(upstreamBodies[0])).toContain("hello")
  },
)

test.each([
  {
    name: "native cache and context controls",
    extra: {
      cache_control: { type: "ephemeral" },
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      fallback_credit_token: "opaque-credit",
      stop_details: { reason: "native" },
    },
    responses: [
      "fallback_credit_token",
      "stop_details",
      "context_management",
      "cache_control",
    ],
    chat: [
      "fallback_credit_token",
      "stop_details",
      "context_management",
      "cache_control",
    ],
  },
  {
    name: "endpoint-specific reasoning signatures",
    extra: {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "responses state",
              signature: "encrypted@rs_1",
            },
            {
              type: "thinking",
              thinking: "native state",
              signature: "native-signature",
            },
          ],
        },
      ],
    },
    responses: ["thinking_signature"],
    chat: ["thinking_signature"],
  },
])("reports pure blockers for $name", ({ extra, responses, chat }) => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    ...extra,
  }
  const snapshot = structuredClone(payload)

  expect(
    checkMessagesToResponsesTranslation(payload as never).blockers,
  ).toEqual([...responses])
  expect(checkMessagesToChatTranslation(payload as never).blockers).toEqual([
    ...chat,
  ])
  expect(payload).toEqual(snapshot)
})

function postMessages(
  extra: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    seedProtocolDatabase().then(() =>
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          model: "route-model",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
          ...extra,
        }),
      }),
    ),
  )
}

function contractEventData(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
  kind: string,
): Array<Record<string, unknown>> {
  return calls.flatMap((call) => {
    const value = call[1]
    return (
        call[0] === "[copilot-contract]"
          && typeof value === "object"
          && value !== null
          && (value as { kind?: unknown }).kind === kind
      ) ?
        [value as Record<string, unknown>]
      : []
  })
}

test("emits one bounded Messages route event before dispatch", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  const debugSpy = spyOn(consola, "debug")

  try {
    const response = await postMessages({})

    expect(response.status).toBe(200)
    const routeEvents = debugSpy.mock.calls.filter(
      (call) =>
        call[0] === "[copilot-contract]"
        && (call[1] as { kind?: string; source?: string }).kind
          === "endpoint_route"
        && (call[1] as { kind?: string; source?: string }).source
          === "messages",
    )
    expect(routeEvents).toHaveLength(1)
    expect(routeEvents[0]?.[1]).toEqual({
      kind: "endpoint_route",
      source: "messages",
      target: "/v1/messages",
      translated: false,
      reason: "native",
    })
  } finally {
    debugSpy.mockRestore()
  }
})

function signedThinkingHistory(): Array<Record<string, unknown>> {
  return [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "prior thought",
          signature: "native-signature",
        },
        { type: "text", text: "answer" },
      ],
    },
    { role: "user", content: "continue" },
  ]
}

function nativeSuccess(text: string): Response {
  return Response.json({
    id: `msg_${text}`,
    type: "message",
    role: "assistant",
    model: "route-model",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

function installModel(options: { supported_endpoints?: Array<string> }): void {
  state.models = {
    object: "list",
    data: [createModel(options)],
  } satisfies ModelsResponse
}

function registerAccount(id: number, copilotToken: string) {
  const account = tokenPool.addAccount(`github-${id}`, "individual", id)
  account.copilotToken = copilotToken
  account.models = new Set(["route-model"])
  account.modelsData = [createModel({ supported_endpoints: ["/v1/messages"] })]
  account.healthy = true
  return account
}

function removeTestAccounts(): void {
  for (const accountId of TEST_ACCOUNT_IDS) {
    tokenPool.removeAccountForTest(accountId)
  }
  tokenPool.rebuildModelIndex()
}

function createModel(options: { supported_endpoints?: Array<string> }): Model {
  return {
    id: "route-model",
    name: "route-model",
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    ...(options.supported_endpoints === undefined ?
      {}
    : { supported_endpoints: options.supported_endpoints }),
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 1024 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}
