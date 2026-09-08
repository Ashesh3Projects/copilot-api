import "./data-dir"

import { describe, test, expect, beforeAll } from "bun:test"

import { state } from "~/lib/state"

import { runMessagesToolErrorFlow } from "./messages-tool-error-flow"
import {
  useIntegrationFixture,
  initializeTestState,
  postJSON,
  collectSSEEvents,
  TEST_TIMEOUT,
} from "./setup"

// ─── Shared Types ───

interface ChatCompletionMessage {
  role: string
  content: string | null
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
}

interface ChatCompletionChoice {
  index: number
  message: ChatCompletionMessage
  finish_reason: string
}

interface ChatCompletionResponse {
  id: string
  model: string
  choices: Array<ChatCompletionChoice>
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
}

interface AnthropicContentBlock {
  type: string
  text?: string
  name?: string
  id?: string
  input?: unknown
}

interface AnthropicMessageResponse {
  id: string
  type: string
  role: string
  content: Array<AnthropicContentBlock>
  stop_reason: string | null
}

interface ResponsesOutputItem {
  type: string
  name?: string
  call_id?: string
  arguments?: string
  content?: Array<{ type: string; text: string }>
}

interface ResponsesResult {
  id: string
  status: string
  output: Array<ResponsesOutputItem>
  output_text: string
}

interface GoogleCandidate {
  content: {
    parts: Array<{
      text?: string
      functionCall?: { name: string; args: Record<string, unknown> }
    }>
    role: string
  }
  finishReason: string | null
}

interface GoogleResponse {
  candidates: Array<GoogleCandidate>
}

// ─── Shared Tool Definitions ───

const OPENAI_WEATHER_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the current weather in a location",
    parameters: {
      type: "object",
      properties: { location: { type: "string", description: "City name" } },
      required: ["location"],
    },
  },
}

const OPENAI_TIME_TOOL = {
  type: "function" as const,
  function: {
    name: "get_time",
    description: "Get the current time in a timezone",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone" },
      },
      required: ["timezone"],
    },
  },
}

const ANTHROPIC_WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the current weather in a location",
  input_schema: {
    type: "object",
    properties: { location: { type: "string", description: "City name" } },
    required: ["location"],
  },
}

const ANTHROPIC_TIME_TOOL = {
  name: "get_time",
  description: "Get the current time in a timezone",
  input_schema: {
    type: "object",
    properties: { timezone: { type: "string", description: "IANA timezone" } },
    required: ["timezone"],
  },
}

const RESPONSES_WEATHER_TOOL = {
  type: "function" as const,
  name: "get_weather",
  description: "Get the current weather in a location",
  parameters: {
    type: "object",
    properties: { location: { type: "string", description: "City name" } },
    required: ["location"],
  },
  strict: false,
}

const RESPONSES_TIME_TOOL = {
  type: "function" as const,
  name: "get_time",
  description: "Get the current time in a timezone",
  parameters: {
    type: "object",
    properties: { timezone: { type: "string", description: "IANA timezone" } },
    required: ["timezone"],
  },
  strict: false,
}

const GOOGLE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "get_weather",
        description: "Get the current weather in a location",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
      {
        name: "get_time",
        description: "Get the current time in a timezone",
        parameters: {
          type: "object",
          properties: { timezone: { type: "string" } },
          required: ["timezone"],
        },
      },
    ],
  },
]

useIntegrationFixture()

beforeAll(async () => {
  await initializeTestState()
}, TEST_TIMEOUT)

// ─── ChatCompletions: Multi-turn ───

describe("Tool calling: ChatCompletions - multi-turn", () => {
  test(
    "multi-turn tool flow (non-streaming)",
    async () => {
      const res1 = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
        tools: [OPENAI_WEATHER_TOOL],
        tool_choice: "required",
        max_tokens: 200,
        stream: false,
      })
      expect(res1.status).toBe(200)
      const body1 = (await res1.json()) as ChatCompletionResponse
      expect(body1.choices.length).toBeGreaterThan(0)
      const choice1 = body1.choices[0]
      expect(choice1.finish_reason).toBe("tool_calls")
      expect(choice1.message.tool_calls).toBeDefined()
      expect(choice1.message.tool_calls?.length).toBeGreaterThan(0)
      const toolCall = choice1.message.tool_calls?.[0]
      expect(toolCall?.function.name).toBe("get_weather")

      const res2 = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "What's the weather in Tokyo?" },
          {
            role: "assistant",
            content: null,
            tool_calls: choice1.message.tool_calls,
          },
          {
            role: "tool",
            tool_call_id: toolCall?.id ?? "",
            content: "Sunny, 25C in Tokyo",
          },
        ],
        tools: [OPENAI_WEATHER_TOOL],
        max_tokens: 200,
        stream: false,
      })
      expect(res2.status).toBe(200)
      const body2 = (await res2.json()) as ChatCompletionResponse
      const choice2 = body2.choices[0]
      expect(choice2.message.content).toBeTruthy()
      expect(choice2.finish_reason).not.toBe("tool_calls")
    },
    TEST_TIMEOUT,
  )

  test(
    "streaming tool call argument reconstruction",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What's the weather in London?" }],
        tools: [OPENAI_WEATHER_TOOL],
        tool_choice: "required",
        max_tokens: 200,
        stream: true,
      })
      expect(res.status).toBe(200)
      const events = await collectSSEEvents(res)
      expect(events.at(-1)?.data).toBe("[DONE]")

      let concatenatedArgs = ""
      for (const ev of events) {
        if (ev.data === "[DONE]") continue
        const chunk = JSON.parse(ev.data) as ChatCompletionChunk
        const firstChoice = chunk.choices?.at(0)
        const tcs = firstChoice?.delta.tool_calls
        if (tcs) {
          for (const tc of tcs) {
            if (tc.function?.arguments) {
              concatenatedArgs += tc.function.arguments
            }
          }
        }
      }

      expect(concatenatedArgs.length).toBeGreaterThan(0)
      const parsed = JSON.parse(concatenatedArgs) as Record<string, unknown>
      expect(parsed).toBeDefined()
    },
    TEST_TIMEOUT,
  )
})

// ─── ChatCompletions: Tools & tool_choice ───

describe("Tool calling: ChatCompletions - tools & tool_choice", () => {
  test(
    "multiple tools, correct selection",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What's the weather in London?" }],
        tools: [OPENAI_WEATHER_TOOL, OPENAI_TIME_TOOL],
        tool_choice: "required",
        max_tokens: 200,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      const choice = body.choices[0]
      expect(choice.finish_reason).toBe("tool_calls")
      expect(choice.message.tool_calls).toBeDefined()
      const calledName = choice.message.tool_calls?.[0]?.function.name
      expect(calledName).toBe("get_weather")
    },
    TEST_TIMEOUT,
  )

  test(
    "tool_choice: none",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What's the weather in Berlin?" }],
        tools: [OPENAI_WEATHER_TOOL],
        tool_choice: "none",
        max_tokens: 100,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      const choice = body.choices[0]
      expect(choice.finish_reason).not.toBe("tool_calls")
      expect(choice.message.content).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "tool_choice: required",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello, how are you?" }],
        tools: [OPENAI_WEATHER_TOOL],
        tool_choice: "required",
        max_tokens: 200,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      const choice = body.choices[0]
      expect(choice.finish_reason).toBe("tool_calls")
      expect(choice.message.tool_calls).toBeDefined()
      expect(choice.message.tool_calls?.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )

  test(
    "tool_choice: specific function",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
        tools: [OPENAI_WEATHER_TOOL, OPENAI_TIME_TOOL],
        tool_choice: { type: "function", function: { name: "get_time" } },
        max_tokens: 200,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      const choice = body.choices[0]
      if (choice.message.tool_calls) {
        const calledName = choice.message.tool_calls[0]?.function.name
        expect(calledName).toBe("get_time")
      }
    },
    TEST_TIMEOUT,
  )
})

// ─── Messages: Multi-turn ───

describe("Tool calling: Messages - multi-turn", () => {
  test(
    "multi-turn tool flow (non-streaming)",
    async () => {
      const res1 = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
        tools: [ANTHROPIC_WEATHER_TOOL],
        tool_choice: { type: "any" },
        max_tokens: 200,
        stream: false,
      })
      expect(res1.status).toBe(200)
      const body1 = (await res1.json()) as AnthropicMessageResponse
      expect(body1.stop_reason).toBe("tool_use")
      const toolUseBlock = body1.content.find((b) => b.type === "tool_use")
      expect(toolUseBlock).toBeDefined()
      expect(toolUseBlock?.name).toBe("get_weather")

      const res2 = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "What's the weather in Tokyo?" },
          { role: "assistant", content: body1.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseBlock?.id ?? "",
                content: "Sunny, 25C in Tokyo",
              },
            ],
          },
        ],
        tools: [ANTHROPIC_WEATHER_TOOL],
        max_tokens: 200,
        stream: false,
      })
      expect(res2.status).toBe(200)
      const body2 = (await res2.json()) as AnthropicMessageResponse
      const textBlock = body2.content.find((b) => b.type === "text")
      expect(textBlock?.text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "multi-turn tool flow (streaming)",
    async () => {
      const res1 = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What's the weather in Berlin?" }],
        tools: [ANTHROPIC_WEATHER_TOOL],
        tool_choice: { type: "any" },
        max_tokens: 200,
        stream: true,
      })
      expect(res1.status).toBe(200)
      const events1 = await collectSSEEvents(res1)
      expect(events1.length).toBeGreaterThan(0)
      const eventTypes1 = events1.map((e) => e.event)
      expect(eventTypes1).toContain("message_start")
      expect(eventTypes1).toContain("message_stop")
    },
    TEST_TIMEOUT,
  )
})

// ─── Messages: tool_choice & errors ───

describe("Tool calling: Messages - tool_choice & errors", () => {
  test(
    "tool_choice: {type: none} - no tool calls",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
        tools: [ANTHROPIC_WEATHER_TOOL],
        tool_choice: { type: "none" },
        max_tokens: 100,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AnthropicMessageResponse
      expect(body.stop_reason).not.toBe("tool_use")
      const hasToolUse = body.content.some((b) => b.type === "tool_use")
      expect(hasToolUse).toBe(false)
    },
    TEST_TIMEOUT,
  )

  test(
    "tool_choice: {type: any} - must call some tool",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello, how are you?" }],
        tools: [ANTHROPIC_WEATHER_TOOL],
        tool_choice: { type: "any" },
        max_tokens: 200,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AnthropicMessageResponse
      expect(body.stop_reason).toBe("tool_use")
      const toolUse = body.content.find((b) => b.type === "tool_use")
      expect(toolUse).toBeDefined()
    },
    TEST_TIMEOUT,
  )

  test(
    "tool_choice: {type: tool, name: get_weather} - specific tool",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
        tools: [ANTHROPIC_WEATHER_TOOL, ANTHROPIC_TIME_TOOL],
        tool_choice: { type: "tool", name: "get_weather" },
        max_tokens: 200,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as AnthropicMessageResponse
      const toolUse = body.content.find((b) => b.type === "tool_use")
      if (toolUse) {
        expect(toolUse.name).toBe("get_weather")
      }
    },
    TEST_TIMEOUT,
  )

  test(
    "tool result with is_error: true",
    async () => {
      const result = await runMessagesToolErrorFlow({
        models: state.models?.data ?? [],
        tool: ANTHROPIC_WEATHER_TOOL,
      })
      if (!result) {
        console.log(
          "Skipping Messages tool-error flow — no tool-capable Responses model",
        )
        return
      }
      expect(result.content.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )
})

// ─── Responses: Multi-turn ───

describe("Tool calling: Responses - multi-turn", () => {
  test(
    "multi-turn tool flow (non-streaming)",
    async () => {
      const res1 = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        input: [
          {
            type: "message",
            role: "user",
            content: "What's the weather in Tokyo?",
          },
        ],
        tools: [RESPONSES_WEATHER_TOOL],
        tool_choice: "required",
        stream: false,
      })
      expect(res1.status).toBe(200)
      const body1 = (await res1.json()) as ResponsesResult
      expect(body1.output.length).toBeGreaterThan(0)
      const fnCall = body1.output.find((o) => o.type === "function_call")
      expect(fnCall).toBeDefined()
      expect(fnCall?.name).toBe("get_weather")

      const res2 = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        input: [
          {
            type: "message",
            role: "user",
            content: "What's the weather in Tokyo?",
          },
          {
            type: "function_call",
            call_id: fnCall?.call_id ?? "",
            name: fnCall?.name ?? "get_weather",
            arguments: fnCall?.arguments ?? '{"location":"Tokyo"}',
          },
          {
            type: "function_call_output",
            call_id: fnCall?.call_id ?? "",
            output: "Sunny, 25C in Tokyo",
          },
        ],
        tools: [RESPONSES_WEATHER_TOOL],
        stream: false,
      })
      expect(res2.status).toBe(200)
      const body2 = (await res2.json()) as ResponsesResult
      expect(body2.output_text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )
})

// ─── Responses: Tools ───

describe("Tool calling: Responses - tools", () => {
  test(
    "multiple tools",
    async () => {
      const res = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        input: [
          {
            type: "message",
            role: "user",
            content: "What's the weather in London?",
          },
        ],
        tools: [RESPONSES_WEATHER_TOOL, RESPONSES_TIME_TOOL],
        tool_choice: "required",
        parallel_tool_calls: true,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      expect(body.output.length).toBeGreaterThan(0)
      const fnCall = body.output.find((o) => o.type === "function_call")
      expect(fnCall).toBeDefined()
    },
    TEST_TIMEOUT,
  )

  test(
    "tool_choice: none",
    async () => {
      const res = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        input: [
          {
            type: "message",
            role: "user",
            content: "What's the weather in Berlin?",
          },
        ],
        tools: [RESPONSES_WEATHER_TOOL],
        tool_choice: "none",
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      const hasFnCall = body.output.some((o) => o.type === "function_call")
      expect(hasFnCall).toBe(false)
      expect(body.output_text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "tool_choice: required",
    async () => {
      const res = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        input: [
          {
            type: "message",
            role: "user",
            content: "Hello, how are you?",
          },
        ],
        tools: [RESPONSES_WEATHER_TOOL],
        tool_choice: "required",
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      const fnCall = body.output.find((o) => o.type === "function_call")
      expect(fnCall).toBeDefined()
    },
    TEST_TIMEOUT,
  )
})

// ─── Google AI: Flows ───

describe("Tool calling: Google AI - flows", () => {
  test(
    "multi-turn tool flow",
    async () => {
      const res1 = await postJSON("/v1/models/gpt-4o-mini:generateContent", {
        contents: [
          { role: "user", parts: [{ text: "What's the weather in Tokyo?" }] },
        ],
        tools: GOOGLE_TOOLS,
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { maxOutputTokens: 200 },
      })
      expect(res1.status).toBe(200)
      const body1 = (await res1.json()) as GoogleResponse
      expect(body1.candidates).toBeDefined()
      const parts1 = body1.candidates[0].content.parts
      const fnCallPart = parts1.find((p) => p.functionCall)
      expect(fnCallPart).toBeDefined()
      expect(fnCallPart?.functionCall?.name).toBe("get_weather")

      const res2 = await postJSON("/v1/models/gpt-4o-mini:generateContent", {
        contents: [
          { role: "user", parts: [{ text: "What's the weather in Tokyo?" }] },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  args: { location: "Tokyo" },
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "get_weather",
                  response: { result: "Sunny, 25C in Tokyo" },
                },
              },
            ],
          },
        ],
        tools: GOOGLE_TOOLS,
        generationConfig: { maxOutputTokens: 200 },
      })
      expect(res2.status).toBe(200)
      const body2 = (await res2.json()) as GoogleResponse
      expect(body2.candidates).toBeDefined()
      const textPart = body2.candidates[0].content.parts.find((p) => p.text)
      expect(textPart?.text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "multiple function declarations",
    async () => {
      const res = await postJSON("/v1/models/gpt-4o-mini:generateContent", {
        contents: [
          {
            role: "user",
            parts: [{ text: "What's the weather in London?" }],
          },
        ],
        tools: GOOGLE_TOOLS,
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { maxOutputTokens: 200 },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as GoogleResponse
      expect(body.candidates).toBeDefined()
      const parts = body.candidates[0].content.parts
      const fnCall = parts.find((p) => p.functionCall)
      expect(fnCall).toBeDefined()
      expect(fnCall?.functionCall?.name).toBe("get_weather")
    },
    TEST_TIMEOUT,
  )
})

// ─── Google AI: tool_choice ───

describe("Tool calling: Google AI - tool_choice", () => {
  test(
    "mode: NONE - no tool calls",
    async () => {
      const res = await postJSON("/v1/models/gpt-4o-mini:generateContent", {
        contents: [
          {
            role: "user",
            parts: [{ text: "What's the weather in Paris?" }],
          },
        ],
        tools: GOOGLE_TOOLS,
        toolConfig: { functionCallingConfig: { mode: "NONE" } },
        generationConfig: { maxOutputTokens: 100 },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as GoogleResponse
      expect(body.candidates).toBeDefined()
      const parts = body.candidates[0].content.parts
      const fnCall = parts.find((p) => p.functionCall)
      expect(fnCall).toBeUndefined()
      const textPart = parts.find((p) => p.text)
      expect(textPart?.text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "mode: ANY - must call a tool",
    async () => {
      const res = await postJSON("/v1/models/gpt-4o-mini:generateContent", {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello, how are you doing today?" }],
          },
        ],
        tools: GOOGLE_TOOLS,
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { maxOutputTokens: 200 },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as GoogleResponse
      expect(body.candidates).toBeDefined()
      const parts = body.candidates[0].content.parts
      const fnCall = parts.find((p) => p.functionCall)
      expect(fnCall).toBeDefined()
    },
    TEST_TIMEOUT,
  )
})
