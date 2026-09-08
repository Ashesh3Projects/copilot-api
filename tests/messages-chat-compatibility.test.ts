/* eslint-disable max-lines -- public compatibility and two-turn regressions share one isolated route fixture */
import { afterAll, beforeEach, expect, test } from "bun:test"

import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ResponseMessage,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { setReplacementsForTest } from "~/lib/auto-replace"
import { setConfigForTest } from "~/lib/config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const calls: Array<{ url: string; body: Record<string, unknown> }> = []
let resultOverride: Response | undefined
const modelId = "claude-sonnet-4.6"

test.each(["/responses", "/v1/messages"])(
  "raw PDF bytes survive Chat adaptation to %s",
  async (endpoint) => {
    state.models = {
      object: "list",
      data: [model(["/chat/completions", endpoint])],
    }
    const rawPdf = "JVBERi0xLjQK"
    const result = await post("/v1/chat/completions", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read the PDF" },
            {
              type: "file",
              file: { filename: "audit.pdf", file_data: rawPdf },
            },
          ],
        },
      ],
    })
    expect(result.status).toBe(200)
    expect(new URL(calls.at(-1)?.url ?? "").pathname).toBe(endpoint)
    const wire = JSON.stringify(calls.at(-1)?.body)
    expect(wire).toContain(
      endpoint === "/responses" ?
        `data:application/pdf;base64,${rawPdf}`
      : rawPdf,
    )
    expect(wire).not.toContain("[File attachment unavailable]")
  },
)

function nativeResult(
  content: AnthropicResponse["content"] = [{ type: "text", text: "answer" }],
): AnthropicResponse {
  return {
    id: "msg_compatibility",
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  }
}

function model(endpoints: Array<string>): Model {
  return {
    id: modelId,
    name: modelId,
    object: "model",
    version: "1",
    vendor: "anthropic",
    supported_endpoints: endpoints,
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      tokenizer: "cl100k_base",
      type: "chat",
      supports: { reasoning_effort: ["low", "medium", "high", "max"] },
    },
  }
}

function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}

async function post(
  route: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return await seedProtocolDatabase().then(() =>
    server.request(route, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 2048,
        ...extra,
      }),
    }),
  )
}

beforeEach(() => {
  calls.length = 0
  resultOverride = undefined
  state.accountType = "individual"
  state.copilotToken = "synthetic-copilot-token"
  state.githubToken = "synthetic-github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.apiKeyAuth = undefined
  state.models = { object: "list", data: [model(["/v1/messages"])] }
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setReplacementsForTest([])
  setConfigForTest({ auth: { apiKeys: [] }, extraPrompts: {} })
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    await Promise.resolve()
    const url = String(input instanceof Request ? input.url : input)
    if (typeof init?.body !== "string")
      throw new Error("Unexpected non-inference fetch")
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ url, body })
    if (resultOverride) {
      const result = resultOverride
      resultOverride = undefined
      return result
    }
    if (new URL(url).pathname.endsWith("/chat/completions")) {
      return Response.json({
        id: "chat_mock",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "answer" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })
    }
    if (new URL(url).pathname === "/responses") {
      return Response.json({
        id: "resp_mock",
        object: "response",
        created_at: 1,
        model: body.model,
        status: "completed",
        output: [
          {
            id: "msg_mock",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "answer", annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        error: null,
        incomplete_details: null,
      })
    }
    return Response.json(nativeResult())
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  setConfigForTest(null)
})

test("native Messages applies suffix and redirect effort while preserving output_config siblings", async () => {
  const taskBudget = { type: "tokens", total: 456 }
  const extra = {
    thinking: { type: "adaptive" },
    output_config: { effort: "low", task_budget: taskBudget },
  }
  expect(
    (await post("/v1/messages", { ...extra, model: `${modelId}:high` })).status,
  ).toBe(200)
  expect(calls.at(-1)?.body.output_config).toEqual({
    effort: "high",
    task_budget: taskBudget,
  })
  setModelRedirectsForTest([
    {
      id: "effort",
      sourceModel: modelId,
      sourceEffort: "all",
      targetModel: modelId,
      targetEffort: "high",
      enabled: true,
    },
  ])
  expect((await post("/v1/messages", extra)).status).toBe(200)
  expect(calls.at(-1)?.body.output_config).toEqual({
    effort: "high",
    task_budget: taskBudget,
  })
})

test.each(["/chat/completions", "/responses", "/v1/messages"])(
  "disabled thinking preserves sampling through %s",
  async (endpoint) => {
    state.models = { object: "list", data: [model([endpoint])] }
    expect(
      (
        await post("/v1/messages", {
          thinking: { type: "disabled" },
          temperature: 0.2,
        })
      ).status,
    ).toBe(200)
    expect(calls.at(-1)?.body.temperature).toBe(0.2)
    expect(calls.at(-1)?.body.reasoning_effort).toBeUndefined()
    expect(calls.at(-1)?.body).not.toHaveProperty("reasoning.effort", "medium")
    expect(
      (
        await post("/v1/messages", {
          thinking: { type: "disabled" },
          top_p: 0.7,
        })
      ).status,
    ).toBe(200)
    expect(calls.at(-1)?.body.top_p).toBe(0.7)
  },
)

test("Chat tool results preserve image and PDF blocks through Messages", async () => {
  const response = await post("/v1/chat/completions", {
    messages: [
      { role: "user", content: "read the output" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "capture", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "Screenshot and PDF follow" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aW1hZ2U=" },
          },
          {
            type: "file",
            file: {
              filename: "report.pdf",
              file_data: "data:application/pdf;base64,JVBERi0=",
            },
          },
        ],
      },
    ],
  })
  expect(response.status).toBe(200)
  expect(calls.at(-1)?.body).toHaveProperty("messages.2.content.0", {
    type: "tool_result",
    tool_use_id: "call_1",
    content: [
      { type: "text", text: "Screenshot and PDF follow" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
      },
      {
        type: "document",
        title: "report.pdf",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "JVBERi0=",
        },
      },
    ],
  })
})

test("custom provider receives native Messages PDF as a Chat file", async () => {
  setConfigForTest({
    auth: { apiKeys: [] },
    extraPrompts: {},
    customProviders: [
      {
        id: "custom",
        name: "custom",
        type: "openai-compatible",
        baseUrl: "https://custom.test/v1",
        apiKey: "synthetic-key",
        models: [{ id: "pdf-model", kind: "chat" }],
      },
    ],
  })
  expect(
    (
      await post("/v1/messages", {
        model: "pdf-model",
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
              },
            ],
          },
        ],
      })
    ).status,
  ).toBe(200)
  expect(new URL(calls.at(-1)?.url ?? "").hostname).toBe("custom.test")
  expect(calls.at(-1)?.body).toHaveProperty(
    "messages.0.content.0.file.file_data",
    "data:application/pdf;base64,JVBERi0=",
  )
})

test.each(["/v1/messages", "/responses"])(
  "Chat prefers viable %s PDF transport over native attachment loss",
  async (endpoint) => {
    state.models = {
      object: "list",
      data: [model(["/chat/completions", endpoint])],
    }
    expect(
      (
        await post("/v1/chat/completions", {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "file",
                  file: {
                    filename: "report.pdf",
                    file_data: "data:application/pdf;base64,JVBERi0=",
                  },
                },
              ],
            },
          ],
        })
      ).status,
    ).toBe(200)
    expect(new URL(calls.at(-1)?.url ?? "").pathname).toBe(endpoint)
    expect(JSON.stringify(calls.at(-1)?.body)).toContain("JVBERi0=")
  },
)

const signedContent: AnthropicResponse["content"] = [
  { type: "thinking", thinking: "first thought", signature: "sig-first" },
  { type: "text", text: "progress" },
  { type: "redacted_thinking", data: "native-redacted-data" },
  { type: "thinking", thinking: "second thought", signature: "sig-second" },
  { type: "text", text: "answer" },
  { type: "tool_use", id: "call_1", name: "capture", input: { value: 1 } },
]

function signedEvents(): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    { type: "message_start", message: { ...nativeResult(), content: [] } },
  ]
  for (const [index, block] of signedContent.entries()) {
    switch (block.type) {
      case "thinking": {
        events.push(
          {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: block.thinking },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: block.signature },
          },
        )

        break
      }
      case "text": {
        events.push(
          {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          },
        )

        break
      }
      case "tool_use": {
        events.push(
          {
            type: "content_block_start",
            index,
            content_block: { ...block, input: {} },
          },
          {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          },
        )

        break
      }
      default: {
        events.push({
          type: "content_block_start",
          index,
          content_block: block,
        })
      }
    }
    events.push({ type: "content_block_stop", index })
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  )
  return events
}

async function readChatAssistant(
  response: Response,
  streaming: boolean,
): Promise<ResponseMessage> {
  if (!streaming)
    return ((await response.json()) as ChatCompletionResponse).choices[0]
      .message
  const assistant = {
    role: "assistant" as const,
    content: "",
    reasoning_text: "",
    reasoning_opaque: "",
    tool_calls: [] as Array<ToolCall>,
  }
  for (const chunk of readChatChunks(await response.text())) {
    if (chunk.choices.length === 0) continue
    const delta = chunk.choices[0].delta
    assistant.content += delta.content ?? ""
    assistant.reasoning_text += delta.reasoning_text ?? ""
    assistant.reasoning_opaque += delta.reasoning_opaque ?? ""
    for (const call of delta.tool_calls ?? []) {
      assistant.tool_calls[call.index] ??= {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      }
      const current = assistant.tool_calls[call.index]
      current.id += call.id ?? ""
      current.function.name += call.function?.name ?? ""
      current.function.arguments += call.function?.arguments ?? ""
    }
  }
  return assistant
}

function readChatChunks(wire: string): Array<ChatCompletionChunk> {
  return wire
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as ChatCompletionChunk)
}

test.each([
  { streaming: false, webSearch: false },
  { streaming: true, webSearch: false },
  { streaming: false, webSearch: true },
  { streaming: true, webSearch: true },
])(
  "Chat delivers and exactly replays ordered signed/redacted content (stream=$streaming, web_search=$webSearch)",
  async ({ streaming, webSearch }) => {
    const tools = [
      ...(webSearch ? [{ type: "web_search" }] : []),
      {
        type: "function",
        function: {
          name: "capture",
          parameters: {
            type: "object",
            properties: { value: { type: "number" } },
          },
        },
      },
    ]
    resultOverride =
      streaming && !webSearch ?
        sse(signedEvents())
      : Response.json({
          ...nativeResult(signedContent),
          stop_reason: "tool_use",
        })
    const response = await post("/v1/chat/completions", {
      stream: streaming,
      tools,
    })
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0].url).pathname).toBe("/v1/messages")
    if (webSearch) expect(calls[0].body.stream).toBe(false)
    const chunks =
      streaming ? readChatChunks(await response.clone().text()) : []
    const assistant = await readChatAssistant(response, streaming)
    expect(assistant.content).toContain("answer")
    expect(assistant.reasoning_text).toContain("first thought")
    expect(assistant.reasoning_text).toContain("second thought")
    expect(assistant.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "capture", arguments: '{"value":1}' },
      },
    ])
    expect(
      (
        await post("/v1/chat/completions", {
          tools,
          messages: [
            { role: "user", content: "hello" },
            assistant,
            { role: "tool", tool_call_id: "call_1", content: "tool answer" },
          ],
        })
      ).status,
    ).toBe(200)
    expect(calls.at(-1)?.body).toHaveProperty(
      "messages.1.content",
      signedContent,
    )
    expect(calls.at(-1)?.body).toHaveProperty(
      "messages.2.content.0.type",
      "tool_result",
    )
    if (streaming) {
      expect(
        chunks.filter((chunk) => chunk.choices[0]?.delta.reasoning_opaque),
      ).toHaveLength(1)
    }
  },
)

test("search-buffered native stream preserves start-only redacted content", async () => {
  const redacted = {
    type: "redacted_thinking" as const,
    data: "signed-native-data",
    native_extension: "retained",
  }
  resultOverride = Response.json(
    nativeResult([redacted, { type: "text", text: "answer" }]),
  )
  const response = await post("/v1/messages", {
    stream: true,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  })
  expect(response.status).toBe(200)
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
  expect(
    events.find((event) => event.type === "content_block_start")?.content_block,
  ).toEqual(redacted)
})

test.each([false, true])(
  "Chat stream includes cache reads/writes (late update=%s)",
  async (late) => {
    resultOverride = sse([
      {
        type: "message_start",
        message: {
          ...nativeResult(),
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 1000,
            output_tokens: 0,
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage:
          late ?
            {
              input_tokens: 12,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 2000,
              output_tokens: 5,
            }
          : { output_tokens: 5 },
      },
      { type: "message_stop" },
    ])
    const response = await post("/v1/chat/completions", { stream: true })
    expect(response.status).toBe(200)
    const final = readChatChunks(await response.text()).findLast(
      (chunk) => chunk.usage,
    )
    expect(final?.usage).toMatchObject({
      prompt_tokens: late ? 2042 : 1030,
      completion_tokens: 5,
      total_tokens: late ? 2047 : 1035,
      prompt_tokens_details: { cached_tokens: late ? 30 : 20 },
    })
  },
)

test.each([
  {
    name: "redacted only",
    content: [{ type: "redacted_thinking", data: "redacted-only" }],
  },
  {
    name: "single legacy signature",
    content: [
      {
        type: "thinking",
        thinking: "one thought",
        signature: "legacy-signature",
      },
      { type: "text", text: "answer" },
    ],
  },
])("Chat replays $name reasoning", async ({ content }) => {
  resultOverride = Response.json(
    nativeResult([...content] as AnthropicResponse["content"]),
  )
  const first = await post("/v1/chat/completions")
  expect(first.status).toBe(200)
  const assistant = await readChatAssistant(first, false)
  expect(
    (
      await post("/v1/chat/completions", {
        messages: [
          { role: "user", content: "hello" },
          assistant,
          { role: "user", content: "continue" },
        ],
      })
    ).status,
  ).toBe(200)
  expect(calls.at(-1)?.body).toHaveProperty("messages.1.content", content)
})

test.each([false, true])(
  "Chat retains PDF best effort when no transport preserves a tool attachment (Responses=%s)",
  async (responses) => {
    state.models = {
      object: "list",
      data: [
        model(
          responses ?
            ["/chat/completions", "/responses"]
          : ["/chat/completions"],
        ),
      ],
    }
    const response = await post("/v1/chat/completions", {
      messages: [
        { role: "user", content: "read the output" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "capture", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "PDF result" },
            {
              type: "file",
              file: { file_data: "data:application/pdf;base64,JVBERi0=" },
            },
          ],
        },
      ],
    })
    expect(response.status).toBe(200)
    expect(new URL(calls.at(-1)?.url ?? "").pathname).toBe("/chat/completions")
    expect(JSON.stringify(calls.at(-1)?.body)).toContain("PDF result")
  },
)

test.each([
  { endpoints: ["/chat/completions", "/v1/messages"] },
  { endpoints: ["/responses", "/v1/messages"] },
])(
  "native replay survives endpoint competition $endpoints",
  async ({ endpoints }) => {
    resultOverride = Response.json(nativeResult(signedContent))
    const first = await post("/v1/chat/completions")
    expect(first.status).toBe(200)
    const assistant = await readChatAssistant(first, false)
    state.models = { object: "list", data: [model([...endpoints])] }
    const second = await post("/v1/chat/completions", {
      temperature: 0.2,
      top_p: 0.8,
      messages: [
        { role: "user", content: "hello" },
        assistant,
        { role: "tool", tool_call_id: "call_1", content: "output" },
      ],
    })
    expect(second.status).toBe(200)
    expect(new URL(calls.at(-1)?.url ?? "").pathname).toBe("/v1/messages")
    expect(calls.at(-1)?.body).toHaveProperty(
      "messages.1.content",
      signedContent,
    )
  },
)

test.each(["/chat/completions", "/responses"])(
  "synthetic native state stays out of %s fallback",
  async (endpoint) => {
    resultOverride = Response.json(nativeResult(signedContent))
    const first = await post("/v1/chat/completions")
    expect(first.status).toBe(200)
    const assistant = await readChatAssistant(first, false)
    state.models = { object: "list", data: [model([endpoint])] }
    expect(
      (
        await post("/v1/chat/completions", {
          messages: [
            { role: "user", content: "hello" },
            assistant,
            { role: "tool", tool_call_id: "call_1", content: "output" },
          ],
        })
      ).status,
    ).toBe(200)
    expect(new URL(calls.at(-1)?.url ?? "").pathname).toBe(endpoint)
    expect(JSON.stringify(calls.at(-1)?.body)).not.toContain(
      "copilot-anthropic-content-v1:",
    )
    expect(JSON.stringify(calls.at(-1)?.body)).toContain("first thought")
    expect(JSON.stringify(calls.at(-1)?.body)).toContain("answer")
    expect(JSON.stringify(calls.at(-1)?.body)).toContain("call_1")
  },
)

test("nonempty initial stream blocks remain in the signed next turn", async () => {
  resultOverride = sse([
    { type: "message_start", message: { ...nativeResult(), content: [] } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "initial", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: " tail" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-initial-tail" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "initial answer" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: " tail" },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_stop" },
  ])
  const assistant = await readChatAssistant(
    await post("/v1/chat/completions", { stream: true }),
    true,
  )
  expect(assistant.reasoning_text).toBe("initial tail")
  expect(assistant.content).toBe("initial answer tail")
  expect(
    (
      await post("/v1/chat/completions", {
        messages: [
          { role: "user", content: "hello" },
          assistant,
          { role: "user", content: "continue" },
        ],
      })
    ).status,
  ).toBe(200)
  expect(calls.at(-1)?.body).toHaveProperty("messages.1.content", [
    {
      type: "thinking",
      thinking: "initial tail",
      signature: "sig-initial-tail",
    },
    { type: "text", text: "initial answer tail" },
  ])
})

test("native Messages keeps body effort when no suffix or redirect overrides it", async () => {
  expect(
    (
      await post("/v1/messages", {
        thinking: { type: "adaptive" },
        output_config: { effort: "xhigh" },
      })
    ).status,
  ).toBe(200)
  expect(calls.at(-1)?.body).toHaveProperty("output_config.effort", "xhigh")
})

test.each([false, true])(
  "signature-only thinking round trips with stream=%s",
  async (streaming) => {
    const content: AnthropicResponse["content"] = [
      {
        type: "thinking",
        thinking: "",
        signature: "signature-without-visible-thinking",
      },
      { type: "text", text: "answer" },
    ]
    resultOverride =
      streaming ?
        sse([
          {
            type: "message_start",
            message: { ...nativeResult(), content: [] },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "signature_delta",
              signature: "signature-without-visible-thinking",
            },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "answer" },
          },
          { type: "content_block_stop", index: 1 },
          { type: "message_stop" },
        ])
      : Response.json(nativeResult(content))
    const first = await post("/v1/chat/completions", { stream: streaming })
    expect(first.status).toBe(200)
    const assistant = await readChatAssistant(first, streaming)
    expect(
      (
        await post("/v1/chat/completions", {
          messages: [
            { role: "user", content: "hello" },
            assistant,
            { role: "user", content: "continue" },
          ],
        })
      ).status,
    ).toBe(200)
    expect(calls.at(-1)?.body).toHaveProperty("messages.1.content", content)
  },
)
