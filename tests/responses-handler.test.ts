import { expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import { LocalHTTPError } from "../src/lib/error"
import {
  assertResponsesChatFallbackTranslation,
  responsesToChatCompletions,
  streamChatCompletionsAsResponses,
  useFunctionApplyPatch,
} from "../src/routes/responses/handler"
import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

function chatStream(
  chunks: Array<Record<string, unknown> | "[DONE]">,
): AsyncIterable<{ data: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        await Promise.resolve()
        yield { data: chunk === "[DONE]" ? chunk : JSON.stringify(chunk) }
      }
    },
  }
}

test("preserves trailing Chat usage before completing a Responses stream", async () => {
  const events: Array<{ data: Record<string, unknown>; event?: string }> = []
  const stream = {
    writeSSE(message: { data: string; event?: string }) {
      events.push({
        data: JSON.parse(message.data) as Record<string, unknown>,
        ...(message.event ? { event: message.event } : {}),
      })
      return Promise.resolve()
    },
  }

  const source = chatStream([
    {
      id: "chat_trailing_usage",
      created: 1,
      model: "chat-only",
      choices: [
        {
          index: 0,
          delta: { content: "kept" },
          finish_reason: "stop",
        },
      ],
    },
    {
      id: "chat_trailing_usage",
      created: 1,
      model: "chat-only",
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    },
    "[DONE]",
  ])

  const outcome = await streamChatCompletionsAsResponses(
    stream,
    source,
    "requested-model",
  )
  const terminals = events.filter(
    (event) =>
      event.event === "response.completed"
      || event.event === "response.incomplete",
  )

  expect(outcome.terminal).toBe("response.completed")
  expect(terminals).toHaveLength(1)
  expect(terminals[0]?.data.response).toMatchObject({
    output_text: "kept",
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 3 },
    },
  })
})

test("ignores Chat output deltas received after its finish chunk", async () => {
  const events: Array<{ data: Record<string, unknown>; event?: string }> = []
  const stream = {
    writeSSE(message: { data: string; event?: string }) {
      events.push({
        data: JSON.parse(message.data) as Record<string, unknown>,
        ...(message.event ? { event: message.event } : {}),
      })
      return Promise.resolve()
    },
  }

  const source = chatStream([
    {
      choices: [
        { index: 0, delta: { content: "before" }, finish_reason: "stop" },
      ],
    },
    {
      choices: [{ index: 0, delta: { content: "after" }, finish_reason: null }],
    },
    "[DONE]",
  ])

  await streamChatCompletionsAsResponses(stream, source, "requested-model")

  expect(JSON.stringify(events)).toContain("before")
  expect(JSON.stringify(events)).not.toContain("after")
})

test("keeps non-apply_patch custom tools unchanged on the native responses path", () => {
  const payload = {
    model: "gpt-4o",
    input: "Hello",
    tools: [
      {
        type: "custom",
        name: "run_sql",
        description: "Execute a SQL query",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ],
  } as ResponsesPayload

  useFunctionApplyPatch(payload)

  expect(payload.tools).toEqual([
    {
      type: "custom",
      name: "run_sql",
      description: "Execute a SQL query",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  ])
})

test("rejects custom tool semantics in chat completions fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: "Hello",
    tools: [
      {
        type: "custom",
        name: "run_sql",
        description: "Execute a SQL query",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ],
  } as ResponsesPayload

  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
})

test("preserves custom tool calls and results for compaction fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_custom",
        name: "exec",
        input: "run canonical command",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_custom",
        output: "canonical result",
      },
    ],
  } as ResponsesPayload

  const result = responsesToChatCompletions(payload, {
    preserveCustomToolContext: true,
  })

  expect(result.messages).toEqual([
    {
      role: "assistant",
      content: "[Custom tool call call_custom: exec(run canonical command)]",
    },
    {
      role: "user",
      content: "[Custom tool result call_custom: canonical result]",
    },
  ])
})

test("rejects ordinary computer output but preserves it for compaction", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "computer_call_output",
        call_id: "call_computer",
        output: "canonical computer result",
      },
    ],
  } as ResponsesPayload

  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
  expect(
    responsesToChatCompletions(payload, { preserveCustomToolContext: true })
      .messages,
  ).toEqual([
    {
      role: "user",
      content:
        "[Computer tool result call_computer: canonical computer result]",
    },
  ])
})

test("maps Responses parallel tools reasoning and user controls to Chat", () => {
  const result = responsesToChatCompletions({
    model: "gpt-4o",
    input: "hello",
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ],
    parallel_tool_calls: false,
    reasoning: { effort: "high" },
    user: "user-safe",
  })

  expect(result.parallel_tool_calls).toBe(false)
  expect(result.reasoning_effort).toBe("high")
  expect(result.user).toBe("user-safe")
})

test("rejects malformed function calls before Chat fallback conversion", () => {
  expect(() =>
    responsesToChatCompletions({
      model: "chat-only",
      input: [{ type: "function_call", call_id: "call_1", name: "lookup" }],
    } as ResponsesPayload),
  ).toThrow(LocalHTTPError)
})

test("rejects unknown and malformed tools before Chat fallback conversion", () => {
  for (const tool of [
    { type: "future_private_tool", secret: "private" },
    {
      type: "function",
      name: "lookup",
      parameters: "private-schema",
      strict: false,
    },
  ]) {
    expect(() =>
      responsesToChatCompletions({
        model: "chat-only",
        input: "hello",
        tools: [tool],
      } as ResponsesPayload),
    ).toThrow(LocalHTTPError)
  }
})

test("compaction fallback still rejects unrelated lossy Responses state", () => {
  expect(() =>
    assertResponsesChatFallbackTranslation(
      {
        model: "gpt-4o",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_custom",
            name: "exec",
            input: "run",
          },
        ],
        tools: [{ type: "namespace", name: "private_namespace" }],
      },
      true,
    ),
  ).toThrow(LocalHTTPError)
})

test("compaction fallback rejects unknown future input items", () => {
  expect(() =>
    assertResponsesChatFallbackTranslation(
      {
        model: "gpt-4o",
        input: [{ type: "future_SECRET_item", value: "private" }],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
      },
      true,
    ),
  ).toThrow(LocalHTTPError)
})

test("rejects ordinary custom tool history in chat completions fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_ordinary_custom",
        name: "exec",
        input: "ordinary command",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_ordinary_custom",
        output: "ordinary result",
      },
    ],
  } as ResponsesPayload

  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
})

test("rejects a lossy Responses to Chat fallback before conversion", () => {
  expect(() =>
    responsesToChatCompletions({
      model: "chat-only",
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-encrypted-state",
          summary: [],
        },
      ],
    }),
  ).toThrow(LocalHTTPError)

  try {
    responsesToChatCompletions({
      model: "chat-only",
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-encrypted-state",
          summary: [],
        },
      ],
    })
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect((error as LocalHTTPError).clientBody).toEqual({
      error: {
        code: "endpoint_translation_unsupported",
        message:
          "The selected Copilot model cannot accept this request without losing required protocol data.",
        param: "opaque_reasoning",
        type: "invalid_request_error",
      },
    })
  }
})
