import { expect, mock, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { chatPayloadToAnthropic } from "~/routes/chat-completions/anthropic-bridge"
import {
  convertOpenAIContentPartToAnthropic,
  convertOpenAIToolsToAnthropic,
} from "~/routes/chat-completions/anthropic-conversion"
import {
  asAnthropicUnknownContentType,
  type AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import { emitResponsesResultAsStream } from "~/routes/messages/web-search-helpers"
import {
  adaptResponsesToMessagesCandidate,
  anthropicResponseToResponsesResult,
  executePreparedResponsesMessagesBridge,
  executeResponsesMessagesBridge,
  responsesPayloadToAnthropic,
} from "~/routes/responses/messages-bridge"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

/* eslint-disable max-lines */

test("adapts future Responses items and consumes Messages tool results once", async () => {
  const source = {
    model: "claude-current",
    instructions: "system",
    input: [
      { type: "future_item", value: "private-future" },
      {
        type: "function_call",
        call_id: "messages_call_0",
        name: "one",
        arguments: "not-json",
      },
      { type: "function_call", name: "two", arguments: 42 },
      {
        type: "function_call_output",
        call_id: "messages_call_0",
        output: "first",
      },
      {
        type: "function_call_output",
        call_id: "messages_call_0",
        output: "duplicate",
      },
      { type: "message", role: "private-role", content: "keep" },
    ],
    max_output_tokens: null,
    temperature: 0.1,
    top_p: 0.9,
    tools: [
      { type: "function", name: "one", parameters: { type: "OBJECT" } },
      { type: "future_tool", name: "private-tool" },
    ],
    tool_choice: { type: "private-choice" },
  }

  const candidate = await adaptResponsesToMessagesCandidate({ source })

  expect(candidate.endpoint).toBe("/v1/messages")
  expect(candidate.check.supported).toBe(true)
  expect(candidate.payload.max_tokens).toBeUndefined()
  expect(candidate.payload.top_p).toBeUndefined()
  expect(JSON.stringify(candidate.payload)).toContain("not-json")
  expect(JSON.stringify(candidate.payload)).toContain("duplicate")
  expect(JSON.stringify(candidate.payload)).toContain("keep")
  expect(JSON.stringify(candidate.check)).not.toContain("private-")
  expect(source.tools[0]?.parameters?.type).toBe("OBJECT")
})

test("fetches unrestricted Responses URLs for Messages with URI-free failure", async () => {
  const originalFetch = globalThis.fetch
  const requested: Array<string> = []
  const marker = "responses-messages-secret"
  globalThis.fetch = mock((input: string | URL | Request) => {
    const value = input instanceof Request ? input.url : input.toString()
    requested.push(value)
    return Promise.resolve(
      value.includes("ok.png") ?
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        })
      : new Response("", { status: 404 }),
    )
  }) as unknown as typeof fetch
  try {
    const candidate = await adaptResponsesToMessagesCandidate({
      source: {
        model: "claude-current",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "before" },
              {
                type: "input_image",
                image_url: "HTTP://USER:PASS@127.1/ok.png",
              },
              {
                type: "input_file",
                file_url: `http://169.254.169.254/a.pdf?secret=${marker}`,
              },
              { type: "input_text", text: "after" },
            ],
          },
        ],
      },
    })

    expect(requested).toEqual([
      "http://USER:PASS@127.0.0.1/ok.png",
      `http://169.254.169.254/a.pdf?secret=${marker}`,
    ])
    expect(JSON.stringify(candidate.payload)).toContain("AQID")
    expect(JSON.stringify(candidate.payload)).toContain("before")
    expect(JSON.stringify(candidate.payload)).toContain("after")
    expect(JSON.stringify(candidate.payload)).not.toContain(marker)
  } finally {
    // eslint-disable-next-line require-atomic-updates -- restore test-scoped global
    globalThis.fetch = originalFetch
  }
})

test("merges Responses format and effort in one Messages output config", async () => {
  const candidate = await adaptResponsesToMessagesCandidate({
    source: {
      model: "claude-current",
      input: "hello",
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      },
    },
  })

  expect(candidate.payload.output_config).toMatchObject({
    effort: "high",
    format: {
      type: "json_schema",
      name: "answer",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
      },
    },
  })
})

test("pairs generated and duplicate Responses calls legally in Messages", async () => {
  const source = {
    model: "claude-current",
    input: [
      { type: "function_call", name: "missing", arguments: "{}" },
      { type: "message", role: "user", content: "between" },
      { type: "function_call_output", output: "missing-result" },
      { type: "function_call", call_id: "dup", name: "one", arguments: "{}" },
      { type: "message", role: "assistant", content: "still pending" },
      { type: "function_call", call_id: "dup", name: "two", arguments: "{}" },
      { type: "function_call_output", call_id: "dup", output: "first-result" },
      { type: "function_call_output", call_id: "dup", output: "second-result" },
    ],
  }

  const [first, second] = await Promise.all([
    adaptResponsesToMessagesCandidate({ source }),
    adaptResponsesToMessagesCandidate({ source }),
  ])

  expect(first.payload).toEqual(second.payload)
  const toolUses = first.payload.messages.flatMap((message) =>
    Array.isArray(message.content) ?
      message.content.filter((block) => block.type === "tool_use")
    : [],
  )
  const toolResults = first.payload.messages.flatMap((message) =>
    Array.isArray(message.content) ?
      message.content.filter((block) => block.type === "tool_result")
    : [],
  )
  expect(toolUses.map((block) => block.id)).toEqual([
    "responses_messages_call_0",
    "dup",
    "responses_messages_call_5",
  ])
  expect(toolResults).toEqual([
    {
      type: "tool_result",
      tool_use_id: "responses_messages_call_0",
      content: "missing-result",
    },
    { type: "tool_result", tool_use_id: "dup", content: "first-result" },
    {
      type: "tool_result",
      tool_use_id: "responses_messages_call_5",
      content: "second-result",
    },
  ])
})

test("prepared Responses Messages executor skips source conversion", async () => {
  let sentBody: Record<string, unknown> | undefined
  state.copilotToken = "test-token"
  globalThis.fetch = mock(
    (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "{}"
      sentBody = JSON.parse(body) as Record<string, unknown>
      return Promise.resolve(
        Response.json({
          id: "msg_prepared",
          type: "message",
          role: "assistant",
          model: "claude-current",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      )
    },
  ) as unknown as typeof fetch
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-current",
        name: "Claude",
        object: "model",
        version: "1",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }

  const payload = {
    model: "claude-current",
    max_tokens: 128,
    messages: [{ role: "user" as const, content: "hello" }],
  }
  await seedProtocolDatabase()

  const result = await executePreparedResponsesMessagesBridge({
    payload,
    responseContext: { model: "public-model", input: "hello" },
    nativeOptions: { requestedModel: "public-model" },
  })

  expect(sentBody).toEqual({ ...payload, stream: false })
  expect(result.model).toBe("public-model")
})

test("maps text image document function tools and results to Messages", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    instructions: "Be concise.",
    max_output_tokens: 512,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Summarize" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,AA==",
            detail: "auto",
          },
          {
            type: "input_file",
            filename: "doc.pdf",
            file_data: "data:application/pdf;base64,AA==",
          },
        ],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ],
    tool_choice: "auto",
  })

  expect(payload).toMatchObject({
    model: "claude-current",
    max_tokens: 512,
    system: "Be concise.",
    tool_choice: { type: "auto" },
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        input_schema: { type: "object", properties: {} },
      },
    ],
  })
  expect(payload.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AA==" },
        },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "AA==",
          },
          title: "doc.pdf",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "lookup",
          input: {},
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "done" },
      ],
    },
  ])
})

test("preserves an explicit null max_output_tokens on the Responses bridge", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: "hello",
    max_output_tokens: null,
  })

  expect(payload).toHaveProperty("max_tokens", null)
})

test("passes explicit native options through the Responses Messages bridge", async () => {
  const originalFetch = globalThis.fetch
  const originalAccountType = state.accountType
  const originalCopilotToken = state.copilotToken
  const originalIsMultiToken = state.isMultiToken
  let headers: Headers | undefined
  const fetchMock = mock(
    (_url: string | URL | Request, init?: RequestInit): Response => {
      headers = new Headers(init?.headers)
      return Response.json({
        id: "msg_explicit_options",
        type: "message",
        role: "assistant",
        model: "claude-current",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  )

  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  try {
    await seedProtocolDatabase()

    const result = await executeResponsesMessagesBridge({
      nativeOptions: {
        anthropicBeta:
          "interleaved-thinking-2025-05-14, context-management-2025-06-27, interleaved-thinking-2025-05-14",
        anthropicVersion: "2023-06-01",
        modelProviderPreference: "anthropic",
        requestedModel: "requested-alias",
      },
      payload: {
        model: "claude-current",
        input: "hello",
        max_output_tokens: 64,
      },
    })

    expect(result.model).toBe("requested-alias")
    expect(headers?.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14,context-management-2025-06-27",
    )
    expect(headers?.get("anthropic-version")).toBe("2023-06-01")
    expect(headers?.get("x-model-provider-preference")).toBe("anthropic")
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
    // eslint-disable-next-line require-atomic-updates
    state.accountType = originalAccountType
    // eslint-disable-next-line require-atomic-updates
    state.copilotToken = originalCopilotToken
    // eslint-disable-next-line require-atomic-updates
    state.isMultiToken = originalIsMultiToken
  }
})

test("defaults translated null Responses max_output_tokens at Messages native dispatch", async () => {
  const originalFetch = globalThis.fetch
  const originalAccountType = state.accountType
  const originalCopilotToken = state.copilotToken
  const originalIsMultiToken = state.isMultiToken
  const originalModels = state.models
  let requestBody: Record<string, unknown> | undefined
  const fetchMock = mock(
    (_url: string | URL | Request, init?: RequestInit): Response => {
      requestBody =
        typeof init?.body === "string" ?
          (JSON.parse(init.body) as Record<string, unknown>)
        : undefined
      return Response.json({
        id: "msg_explicit_null",
        type: "message",
        role: "assistant",
        model: "claude-current",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
  )

  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-current",
        name: "Claude Current",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  try {
    await seedProtocolDatabase()

    const result = await executeResponsesMessagesBridge({
      nativeOptions: {
        anthropicVersion: "2023-06-01",
      },
      payload: {
        model: "claude-current",
        input: "hello",
        max_output_tokens: null,
      },
    })

    expect(result.model).toBe("claude-current")
    expect(requestBody).toHaveProperty("max_tokens", 1024)
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
    // eslint-disable-next-line require-atomic-updates
    state.accountType = originalAccountType
    // eslint-disable-next-line require-atomic-updates
    state.copilotToken = originalCopilotToken
    // eslint-disable-next-line require-atomic-updates
    state.isMultiToken = originalIsMultiToken
    // eslint-disable-next-line require-atomic-updates
    state.models = originalModels
  }
})

test.each([
  { temperature: 0.4, topP: undefined },
  { temperature: undefined, topP: 0.8 },
])(
  "maps Responses sampling reasoning output format and user metadata",
  async ({ temperature, topP }) => {
    const payload = await responsesPayloadToAnthropic({
      model: "claude-current",
      input: "Return JSON.",
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      user: "user-safe",
      reasoning: { effort: "high", summary: "auto" },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      },
      task_budget: { type: "tokens", total: 4000, remaining: 2500 },
      parallel_tool_calls: false,
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
    })

    expect(payload).toMatchObject({
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      metadata: { user_id: "user-safe" },
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
        task_budget: { type: "tokens", total: 4000, remaining: 2500 },
      },
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    })
  },
)

test.each([
  { name: "temperature", temperature: 0.4, topP: undefined },
  { name: "top_p", temperature: undefined, topP: 0.8 },
])(
  "round-trips accepted Responses $name request controls",
  async ({ temperature, topP }) => {
    const request = {
      model: "claude-current",
      input: "Return JSON.",
      max_output_tokens: 512,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      reasoning: { effort: "high", summary: "auto" as const },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object", properties: {} },
        },
      },
      tools: [
        {
          type: "function" as const,
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
      tool_choice: { type: "function", name: "lookup" },
      parallel_tool_calls: false,
    }
    const anthropic = await responsesPayloadToAnthropic(request)
    const response: AnthropicResponse = {
      id: "msg_round_trip",
      type: "message",
      role: "assistant",
      model: "resolved",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    expect(anthropic).toMatchObject({
      max_tokens: 512,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      output_config: {
        effort: "high",
        format: request.text.format,
      },
      tool_choice: {
        type: "tool",
        name: "lookup",
        disable_parallel_tool_use: true,
      },
    })
    expect(
      anthropicResponseToResponsesResult(response, "requested", request),
    ).toMatchObject({
      model: "requested",
      parallel_tool_calls: false,
      temperature: temperature ?? null,
      top_p: topP ?? null,
      tool_choice: request.tool_choice,
      tools: request.tools,
      max_output_tokens: 512,
      reasoning: request.reasoning,
      text: request.text,
    })
  },
)

test("round-trips integer reasoning request context", async () => {
  const request = {
    model: "claude-current",
    input: "Think.",
    reasoning: { effort: 2048, summary: "auto" as const },
  }
  const response: AnthropicResponse = {
    id: "msg_integer",
    type: "message",
    role: "assistant",
    model: "resolved",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }

  expect(await responsesPayloadToAnthropic(request)).toMatchObject({
    thinking: { type: "enabled", budget_tokens: 2048 },
  })
  expect(
    anthropicResponseToResponsesResult(response, "requested", request),
  ).toMatchObject({ reasoning: request.reasoning })
})

test("maps integer Responses reasoning effort to a Messages thinking budget", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: "Think carefully.",
    reasoning: { effort: 2048, summary: "auto" },
  })

  expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
})

test.each(["concise", "detailed", "future_private_summary"])(
  "refuses unmapped reasoning summary %s before Messages wire/result echo",
  async (summary) => {
    const request = {
      model: "claude-current",
      input: "Think carefully.",
      reasoning: { effort: "high", summary },
    }
    const error = await responsesPayloadToAnthropic(request as never).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(LocalHTTPError)
    expect((error as LocalHTTPError).clientBody).toMatchObject({
      error: {
        code: "endpoint_translation_unsupported",
        param: "reasoning_summary",
      },
    })
  },
)

test("accepts implicit Responses messages with omitted content", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [{ role: "user" }],
  })

  expect(payload.messages).toEqual([{ role: "user", content: "" }])
})

test.each([
  { name: "missing role", item: { type: "message", content: "hello" } },
  {
    name: "unknown role",
    item: { type: "message", role: "future_private_role", content: "hello" },
  },
  {
    name: "numeric role",
    item: { type: "message", role: 7, content: "hello" },
  },
])("refuses explicit Responses message with $name", async ({ item }) => {
  const error = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [item],
  } as never).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param: "message_role" },
  })
})

test("preserves separate assistant text and function calls in input order", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [
      { type: "message", role: "assistant", content: "I will look it up." },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
  })

  expect(payload.messages).toEqual([
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will look it up." },
        { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "done" },
      ],
    },
  ])
})

test("groups multiple function calls and results into legal Anthropic turns", async () => {
  const request = {
    model: "claude-current",
    input: [
      {
        type: "function_call" as const,
        call_id: "call_1",
        name: "lookup",
        arguments: '{"query":"one"}',
      },
      {
        type: "function_call" as const,
        call_id: "call_2",
        name: "lookup",
        arguments: '{"query":"two"}',
      },
      {
        type: "function_call_output" as const,
        call_id: "call_1",
        output: "first",
      },
      {
        type: "function_call_output" as const,
        call_id: "call_2",
        output: "second",
      },
    ],
  }

  const payload = await responsesPayloadToAnthropic(request)

  expect(payload.messages).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "lookup",
          input: { query: "one" },
        },
        {
          type: "tool_use",
          id: "call_2",
          name: "lookup",
          input: { query: "two" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "first" },
        { type: "tool_result", tool_use_id: "call_2", content: "second" },
      ],
    },
  ])
})

test.each([
  {
    name: "partial results at EOF",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "first" },
    ],
  },
  {
    name: "calls without results at EOF",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
    ],
  },
  {
    name: "partial results interrupted by a message",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "first" },
      { type: "message", role: "user", content: "continue" },
    ],
  },
])("refuses incomplete tool group: $name", async ({ input }) => {
  const error = await responsesPayloadToAnthropic({
    model: "claude-current",
    input,
  } as never).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "tool_result_pairing",
    },
  })
})

test.each([
  {
    name: "result order differs from call order",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_2", output: "second" },
      { type: "function_call_output", call_id: "call_1", output: "first" },
    ],
  },
])("refuses unrepresentable function grouping: $name", async ({ input }) => {
  const error = await responsesPayloadToAnthropic({
    model: "claude-current",
    input,
  } as never).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "tool_result_pairing",
    },
  })
})

test.each([
  {
    name: "invalid function call",
    payload: {
      model: "claude-current",
      input: [{ type: "function_call", call_id: "call_1", name: "lookup" }],
    },
    param: "function_call",
  },
  {
    name: "unknown tool declaration",
    payload: {
      model: "claude-current",
      input: "hello",
      tools: [{ type: "future_private_tool", secret: "do-not-log" }],
    },
    param: "tool_semantics",
  },
  {
    name: "malformed function declaration",
    payload: {
      model: "claude-current",
      input: "hello",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: "private-schema",
          strict: false,
        },
      ],
    },
    param: "function_tool",
  },
])("refuses Responses to Messages $name", async ({ payload, param }) => {
  const error = await responsesPayloadToAnthropic(payload as never).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param },
  })
  expect(JSON.stringify((error as LocalHTTPError).clientBody)).not.toContain(
    "private",
  )
})

test.each([
  {
    name: "meaningful status",
    payload: {
      model: "claude-current",
      input: [
        {
          type: "message",
          role: "user",
          content: "hello",
          status: "incomplete",
        },
      ],
    },
    param: "item_status",
  },
  {
    name: "wrong text direction",
    payload: {
      model: "claude-current",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "output_text", text: "answer" }],
        },
      ],
    },
    param: "content_direction",
  },
  {
    name: "unsupported image source",
    payload: {
      model: "claude-current",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:text/plain;base64,AA==",
              detail: "auto",
            },
          ],
        },
      ],
    },
    param: "input_image",
  },
  {
    name: "non-object function arguments",
    payload: {
      model: "claude-current",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "[]",
        },
      ],
    },
    param: "function_arguments",
  },
  {
    name: "undeclared named tool choice",
    payload: {
      model: "claude-current",
      input: "hello",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
      tool_choice: { type: "function", name: "missing" },
    },
    param: "tool_choice",
  },
])("direct bridge refuses $name", async ({ payload, param }) => {
  const error = await responsesPayloadToAnthropic(payload as never).catch(
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param },
  })
})

test("preserves bounded orphan tool results as user text without a call association", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [
      {
        type: "function_call_output",
        call_id: "missing",
        output: "x".repeat(20_000),
      },
    ],
  })

  expect(payload.messages).toEqual([
    {
      role: "user",
      content: `[Orphaned tool result]\n${"x".repeat(16_384)}`,
    },
  ])
})

test("refuses opaque Responses reasoning before Messages conversion", async () => {
  const error = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [
      {
        type: "reasoning",
        encrypted_content: "private-state",
        summary: [],
      },
    ],
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "opaque_reasoning",
    },
  })
})

test("converts Anthropic text thinking tools usage stop and model alias", () => {
  const response: AnthropicResponse = {
    id: "msg_native_1",
    type: "message",
    role: "assistant",
    model: "resolved-claude-model",
    content: [
      { type: "thinking", thinking: "considering", signature: "sig-native" },
      { type: "text", text: "answer" },
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: { query: "status" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
    },
  }

  const result = anthropicResponseToResponsesResult(response, "claude-current")
  expect(typeof result.created_at).toBe("number")
  expect({ ...result, created_at: 1 }).toEqual({
    id: "msg_native_1",
    object: "response",
    created_at: 1,
    model: "claude-current",
    output: [
      {
        id: "rs_msg_native_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "considering" }],
        encrypted_content: "sig-native",
        status: "completed",
      },
      {
        id: "msg_msg_native_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
      {
        id: "fc_call_1",
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"query":"status"}',
        status: "completed",
      },
    ],
    output_text: "answer",
    status: "completed",
    usage: {
      input_tokens: 19,
      output_tokens: 7,
      total_tokens: 26,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
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
})

test("preserves interleaved Anthropic blocks and every thinking signature", () => {
  const response: AnthropicResponse = {
    id: "msg_interleaved",
    type: "message",
    role: "assistant",
    model: "resolved",
    content: [
      { type: "thinking", thinking: "first", signature: "sig-first" },
      { type: "text", text: "alpha" },
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: { query: "one" },
      },
      { type: "thinking", thinking: "second", signature: "sig-second" },
      { type: "text", text: "omega" },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  }

  const result = anthropicResponseToResponsesResult(response, "requested")
  expect(result.output.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
    "function_call",
    "reasoning",
    "message",
  ])
  expect(result.output_text).toBe("alphaomega")
  expect(result.output).toMatchObject([
    {
      id: "rs_msg_interleaved",
      encrypted_content: "sig-first",
      summary: [{ type: "summary_text", text: "first" }],
    },
    {
      id: "msg_msg_interleaved",
      content: [{ type: "output_text", text: "alpha", annotations: [] }],
    },
    { id: "fc_call_1", call_id: "call_1" },
    {
      id: "rs_msg_interleaved_1",
      encrypted_content: "sig-second",
      summary: [{ type: "summary_text", text: "second" }],
    },
    {
      id: "msg_msg_interleaved_1",
      content: [{ type: "output_text", text: "omega", annotations: [] }],
    },
  ])
})

test("bridges future assistant blocks as text while preserving known block order", () => {
  const response: AnthropicResponse = {
    id: "msg_future",
    type: "message",
    role: "assistant",
    model: "resolved",
    content: [
      { type: "text", text: "alpha" },
      {
        type: asAnthropicUnknownContentType("future_block_20270101"),
        data: { ok: true },
      },
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: { query: "one" },
      },
      { type: "text", text: "omega" },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  }

  const result = anthropicResponseToResponsesResult(response, "requested")

  expect(result.output.map((item) => item.type)).toEqual([
    "message",
    "message",
    "function_call",
    "message",
  ])
  expect(result.output_text).toBe(
    'alpha{"type":"future_block_20270101","data":{"ok":true}}omega',
  )
  expect(result.output).toMatchObject([
    {
      id: "msg_msg_future",
      content: [{ type: "output_text", text: "alpha", annotations: [] }],
    },
    {
      id: "msg_msg_future_1",
      content: [
        {
          type: "output_text",
          text: '{"type":"future_block_20270101","data":{"ok":true}}',
          annotations: [],
        },
      ],
    },
    { id: "fc_call_1", call_id: "call_1", name: "lookup" },
    {
      id: "msg_msg_future_2",
      content: [{ type: "output_text", text: "omega", annotations: [] }],
    },
  ])
})

test.each([
  {
    name: "numeric thinking",
    block: { type: "thinking", thinking: 42, signature: "sig-invalid" },
  },
  {
    name: "object text",
    block: { type: "text", text: { answer: "future" } },
  },
  {
    name: "null tool input",
    block: {
      type: "tool_use",
      id: "call_invalid",
      name: "lookup",
      input: null,
    },
  },
])(
  "textualizes Anthropic $name instead of rejecting the response",
  ({ block }) => {
    const response = {
      id: "msg_malformed_known",
      type: "message",
      role: "assistant",
      model: "resolved",
      content: [block],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    } as unknown as AnthropicResponse

    const result = anthropicResponseToResponsesResult(response, "requested")
    const expectedText = JSON.stringify(block)

    expect(result.output).toEqual([
      {
        id: "msg_msg_malformed_known",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: expectedText, annotations: [] }],
      },
    ])
    expect(result.output_text).toBe(expectedText)
  },
)

test("preserves malformed known Anthropic block order without mutating the source", () => {
  const content = [
    { type: "text", text: "alpha" },
    { type: "thinking", thinking: 17, signature: "sig-invalid" },
    { type: "text", text: { answer: "future" } },
    { type: "tool_use", id: "call_invalid", name: "lookup", input: null },
    {
      type: "tool_use",
      id: "call_valid",
      name: "lookup",
      input: { query: "status" },
    },
    { type: "text", text: "omega" },
  ]
  const sourceSnapshot = structuredClone(content)
  const response = {
    id: "msg_malformed_order",
    type: "message",
    role: "assistant",
    model: "resolved",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  } as unknown as AnthropicResponse

  const result = anthropicResponseToResponsesResult(response, "requested")

  expect(result.output.map((item) => item.type)).toEqual([
    "message",
    "message",
    "message",
    "message",
    "function_call",
    "message",
  ])
  expect(result.output_text).toBe(
    'alpha{"type":"thinking","thinking":17,"signature":"sig-invalid"}'
      + '{"type":"text","text":{"answer":"future"}}'
      + '{"type":"tool_use","id":"call_invalid","name":"lookup","input":null}'
      + "omega",
  )
  expect(result.output[4]).toMatchObject({
    type: "function_call",
    call_id: "call_valid",
    name: "lookup",
    arguments: '{"query":"status"}',
  })
  expect(content).toEqual(sourceSnapshot)
})

test("bounds malformed Anthropic assistant block text", () => {
  const response = {
    id: "msg_malformed_bounded",
    type: "message",
    role: "assistant",
    model: "resolved",
    content: [{ type: "text", text: { value: "x".repeat(20_000) } }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  } as unknown as AnthropicResponse

  const result = anthropicResponseToResponsesResult(response, "requested")

  expect(result.output_text).toHaveLength(16_384)
  expect(result.output).toMatchObject([
    {
      type: "message",
      content: [{ type: "output_text", text: result.output_text }],
    },
  ])
})

test("maps Anthropic max-token and refusal stops to Responses status", () => {
  const base: AnthropicResponse = {
    id: "msg_stop",
    type: "message",
    role: "assistant",
    model: "resolved",
    content: [],
    stop_reason: "max_tokens",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  }

  expect(anthropicResponseToResponsesResult(base, "requested")).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  })
  expect(
    anthropicResponseToResponsesResult(
      { ...base, stop_reason: "refusal" },
      "requested",
    ),
  ).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "content_filter" },
  })
})

test("emits reasoning lifecycle and the result's terminal status", async () => {
  const writes: Array<{ event?: string; data: string }> = []
  const result = anthropicResponseToResponsesResult(
    {
      id: "msg_stream_reasoning",
      type: "message",
      role: "assistant",
      model: "resolved",
      content: [
        {
          type: "thinking",
          thinking: "considering",
          signature: "sig-stream",
        },
      ],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    "requested",
  )

  await emitResponsesResultAsStream(
    {
      writeSSE: (data) => {
        writes.push(data)
        return Promise.resolve()
      },
    },
    result,
  )

  expect(writes.map((entry) => entry.event)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.output_item.done",
    "response.incomplete",
  ])
  const parsedWrites = writes.map(
    (entry) => JSON.parse(entry.data) as Record<string, unknown>,
  )
  expect(parsedWrites).toMatchObject([
    {},
    {},
    { delta: "considering", summary_index: 0 },
    { text: "considering", summary_index: 0 },
    {},
    { type: "response.incomplete", response: { status: "incomplete" } },
  ])
})

test.each([
  {
    name: "unknown typed content",
    payload: {
      model: "claude-current",
      messages: [
        {
          role: "user",
          content: [{ type: "future_private_content", secret: "do-not-log" }],
        },
      ],
    },
    param: "message_content_part",
  },
  {
    name: "unknown typed tool",
    payload: {
      model: "claude-current",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "future_private_tool", secret: "do-not-log" }],
    },
    param: "tool_semantics",
  },
])("fails closed on Chat to Messages $name", async ({ payload, param }) => {
  const error = await chatPayloadToAnthropic(payload as never).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param },
  })
  expect(JSON.stringify((error as LocalHTTPError).clientBody)).not.toContain(
    "private",
  )
})

test("shared Anthropic conversion helpers reject unknown content and tools", async () => {
  const contentError = await convertOpenAIContentPartToAnthropic({
    type: "future_private_content",
    secret: "private",
  } as never).catch((caught: unknown) => caught)
  expect(contentError).toBeInstanceOf(LocalHTTPError)
  expect((contentError as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "message_content_part",
    },
  })

  expect(() =>
    convertOpenAIToolsToAnthropic([
      { type: "future_private_tool", secret: "private" },
    ] as never),
  ).toThrow(LocalHTTPError)
})

test.each([
  {
    name: "non-image data URI",
    part: {
      type: "image_url",
      image_url: { url: "data:text/plain;base64,AA==", detail: "auto" },
    },
  },
  {
    name: "malformed PDF file",
    part: {
      type: "file",
      file: {
        filename: "document.pdf",
        file_data: "data:text/plain;base64,AA==",
      },
    },
  },
])(
  "shared Anthropic converter refuses $name instead of omitting it",
  async ({ part }) => {
    const error = await convertOpenAIContentPartToAnthropic(
      part as never,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LocalHTTPError)
    expect((error as LocalHTTPError).clientBody).toMatchObject({
      error: {
        code: "endpoint_translation_unsupported",
        param: "message_content_part",
      },
    })
  },
)
