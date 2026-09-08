import { expect, test } from "bun:test"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
} from "../src/routes/messages/anthropic-types"
import type {
  ResponsesPayload,
  ResponsesResult,
} from "../src/services/copilot/create-responses"

import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "../src/routes/messages/responses-translation"
import { normalizeResponsesReasoning } from "../src/routes/responses/handler"
import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

test("keeps Anthropics max_tokens when translating to Responses payload", () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 64,
  }

  const translated = translateAnthropicMessagesToResponsesPayload(payload)

  expect(translated.max_output_tokens).toBe(64)
})

test("omits tool_choice when no Messages tools translate to Responses", () => {
  const translated = translateAnthropicMessagesToResponsesPayload({
    model: "gpt-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    tool_choice: { type: "any" },
  })

  expect(translated).not.toHaveProperty("tool_choice")
})

test("defaults a schema-less named tool without closing its Responses schema", () => {
  const translated = translateAnthropicMessagesToResponsesPayload({
    model: "gpt-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "lookup", description: "Look something up" }],
    tool_choice: { type: "tool", name: "lookup" },
  })

  expect(translated.tools).toEqual([
    {
      type: "function",
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ])
  expect(translated.tool_choice).toEqual({
    type: "function",
    name: "lookup",
  })
  const parameters = (
    translated.tools?.[0] as { parameters?: Record<string, unknown> }
  ).parameters
  expect(parameters).not.toHaveProperty("required")
  expect(parameters).not.toHaveProperty("additionalProperties")
})

test("omits a Responses tool choice when its named tool did not translate", () => {
  const translated = translateAnthropicMessagesToResponsesPayload({
    model: "gpt-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "kept", input_schema: { type: "object" } }, { name: 3 }],
    tool_choice: { type: "tool", name: "3" },
  } as unknown as AnthropicMessagesPayload)

  expect(translated.tools).toHaveLength(1)
  expect(translated).not.toHaveProperty("tool_choice")
})

test("omits typed server tools from the Responses fallback", () => {
  const translated = translateAnthropicMessagesToResponsesPayload({
    model: "gpt-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { name: "lookup" },
      { type: "future_native_20270101", name: "future_native" },
    ],
    tool_choice: { type: "tool", name: "future_native" },
  })

  expect(translated.tools?.map((tool) => tool.name)).toEqual(["lookup"])
  expect(translated).not.toHaveProperty("tool_choice")
})

test("preserves tool references as explicit text on Responses", () => {
  const translated = translateAnthropicMessagesToResponsesPayload({
    model: "gpt-5.4",
    max_tokens: 64,
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
  })

  expect(translated.input).toContainEqual({
    type: "function_call_output",
    call_id: "toolu_search",
    output: [
      {
        type: "input_text",
        text: '{"type":"tool_reference","tool_name":"Bash"}',
      },
    ],
    status: "completed",
  })
})

test("Responses document conversion proves context and citations have no mapping", () => {
  const translated = translateAnthropicMessagesToResponsesPayload({
    model: "gpt-current",
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
            title: "report.pdf",
            context: "Read section two first.",
            citations: { enabled: true },
          },
        ],
      },
    ],
  })

  expect(translated.input).toEqual([
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_file",
          filename: "report.pdf",
          file_data: "data:application/pdf;base64,JVBERi0=",
        },
      ],
    },
  ])
  expect(JSON.stringify(translated.input)).not.toContain("section two")
  expect(JSON.stringify(translated.input)).not.toContain("citations")
})

test.each([true, false])(
  "Responses maps tool_result.is_error=%s to item status",
  (isError) => {
    const translated = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-current",
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
    })

    expect(translated.input).toEqual([
      {
        type: "function_call_output",
        call_id: "toolu_1",
        output: "result",
        status: isError ? "incomplete" : "completed",
      },
    ])
  },
)

test("derives safety and cache fields from Claude JSON metadata.user_id", () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 64,
    metadata: {
      user_id: JSON.stringify({
        device_id: "device-123",
        account_uuid: "account-456",
        session_id: "session-789",
      }),
    },
  }

  const translated = translateAnthropicMessagesToResponsesPayload(payload)

  expect(translated.safety_identifier).toBe("account-456")
  expect(translated.prompt_cache_key).toBe("session-789")
})

test.each([
  {
    name: "single signed@id",
    content: [
      { type: "thinking", thinking: "signed", signature: "sig-one@rs-one" },
    ],
    expected: [
      {
        id: "rs-one",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "signed" }],
        encrypted_content: "sig-one",
      },
    ],
  },
  {
    name: "single unsigned",
    content: [{ type: "thinking", thinking: "unsigned" }],
    expected: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "unsigned" }],
      },
    ],
  },
  {
    name: "multiple unsigned",
    content: [
      { type: "thinking", thinking: "first" },
      { type: "thinking", thinking: "second" },
    ],
    expected: [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "first" },
          { type: "output_text", text: "second" },
        ],
      },
    ],
  },
  {
    name: "signed then unsigned",
    content: [
      { type: "thinking", thinking: "signed", signature: "sig-one@rs-one" },
      { type: "thinking", thinking: "unsigned" },
    ],
    expected: [
      {
        id: "rs-one",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "signed" }],
        encrypted_content: "sig-one",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "unsigned" }],
      },
    ],
  },
  {
    name: "unsigned then signed",
    content: [
      { type: "thinking", thinking: "unsigned" },
      { type: "thinking", thinking: "signed", signature: "sig-two@rs-two" },
    ],
    expected: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "unsigned" }],
      },
      {
        id: "rs-two",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "signed" }],
        encrypted_content: "sig-two",
      },
    ],
  },
  {
    name: "malformed signed",
    content: [
      { type: "thinking", thinking: "signed", signature: "missing-id" },
    ],
    expected: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "signed" }],
      },
    ],
  },
  {
    name: "signed with empty id",
    content: [{ type: "thinking", thinking: "signed", signature: "sig-one@" }],
    expected: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "signed" }],
      },
    ],
  },
  {
    name: "signed with extra separator",
    content: [
      { type: "thinking", thinking: "signed", signature: "sig@rs@extra" },
    ],
    expected: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "signed" }],
      },
    ],
  },
  {
    name: "multiple signed",
    content: [
      { type: "thinking", thinking: "first", signature: "sig-one@rs-one" },
      { type: "thinking", thinking: "second", signature: "sig-two@rs-two" },
    ],
    expected: [
      {
        id: "rs-one",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "first" }],
        encrypted_content: "sig-one",
      },
      {
        id: "rs-two",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "second" }],
        encrypted_content: "sig-two",
      },
    ],
  },
])(
  "preserves $name thinking blocks on Messages to Responses",
  ({ content, expected }) => {
    const translated = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 64,
      messages: [
        {
          role: "assistant",
          content: [...content] as Array<AnthropicAssistantContentBlock>,
        },
      ],
    })

    expect(translated.input as unknown).toEqual(expected)
  },
)

test("returns unsigned thinking when Responses reasoning omits encrypted content", () => {
  const response = {
    id: "resp_unsigned_reasoning",
    object: "response",
    created_at: 1,
    model: "gpt-current",
    output: [
      {
        id: "rs_unsigned",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "visible reasoning" }],
        encrypted_content: null,
      },
    ],
    output_text: "",
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
  } as unknown as ResponsesResult

  expect(translateResponsesResultToAnthropic(response).content).toEqual([
    { type: "thinking", thinking: "visible reasoning" },
  ])
})

test("omits empty unsigned Responses reasoning without synthetic text", () => {
  const response = {
    id: "resp_empty_reasoning",
    object: "response",
    created_at: 1,
    model: "gpt-current",
    output: [
      {
        id: "rs_empty",
        type: "reasoning",
        summary: [],
        encrypted_content: null,
      },
    ],
    output_text: "",
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
  } as unknown as ResponsesResult

  expect(translateResponsesResultToAnthropic(response).content).toEqual([])
})

test("preserves integer Responses reasoning effort across named suffixes", () => {
  const payload = {
    model: "gpt-current",
    input: "hello",
    reasoning: { effort: 2048 },
  }

  const effort = normalizeResponsesReasoning(payload, "high")

  expect(effort).toBe(2048)
  expect(payload.reasoning).toEqual({ effort: 2048 })
})

test("preserves zero from the top-level Responses reasoning alias", () => {
  const payload: ResponsesPayload = {
    model: "gpt-current",
    input: "hello",
    reasoning_effort: 0,
  }

  const effort = normalizeResponsesReasoning(payload)

  expect(effort).toBe(0)
  expect(payload.reasoning).toEqual({ effort: 0 })
  expect(payload).not.toHaveProperty("reasoning_effort")
})

test("maps raw Responses reasoning content into Anthropic thinking", () => {
  const response: ResponsesResult = {
    id: "resp_reasoning_content",
    object: "response",
    created_at: 1,
    model: "gpt-5.3-codex",
    output_text: "done",
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    output: [
      {
        id: "rs_1",
        type: "reasoning",
        summary: [],
        content: [
          { type: "reasoning_text", text: "raw " },
          { type: "reasoning_text", text: "thinking" },
        ],
        encrypted_content: "encrypted-reasoning",
      },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    ],
  }

  const anthropic = translateResponsesResultToAnthropic(response)

  expect(anthropic.content[0]).toEqual({
    type: "thinking",
    thinking: "raw thinking",
    signature: "encrypted-reasoning@rs_1",
  })
})
