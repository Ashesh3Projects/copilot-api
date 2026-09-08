/* eslint-disable max-lines */
import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
} from "~/routes/messages/anthropic-types"

import { asAnthropicUnknownContentType } from "~/routes/messages/anthropic-types"

import { stripThinkingBlocks } from "../src/routes/messages/handler"
import { translateToOpenAI } from "../src/routes/messages/non-stream-translation"
import { translateAnthropicMessagesToResponsesPayload } from "../src/routes/messages/responses-translation"
import {
  checkMessagesToChatTranslation,
  checkMessagesToResponsesTranslation,
} from "../src/routes/messages/translation-fidelity"
import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

// Zod schema for a single message in the chat completion request.
const messageSchema = z.object({
  role: z.enum([
    "system",
    "user",
    "assistant",
    "tool",
    "function",
    "developer",
  ]),
  content: z.union([z.string(), z.object({}), z.array(z.any())]),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
})

// Zod schema for the entire chat completion request payload.
// This is derived from the openapi.documented.yml specification.
const chatCompletionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1, "Messages array cannot be empty."),
  model: z.string(),
  frequency_penalty: z.number().min(-2).max(2).optional().nullable(),
  logit_bias: z.record(z.string(), z.number()).optional().nullable(),
  logprobs: z.boolean().optional().nullable(),
  top_logprobs: z.number().int().min(0).max(20).optional().nullable(),
  max_tokens: z.number().int().optional().nullable(),
  n: z.number().int().min(1).max(128).optional().nullable(),
  presence_penalty: z.number().min(-2).max(2).optional().nullable(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object", "json_schema"]),
      json_schema: z.object({}).optional(),
    })
    .optional(),
  seed: z.number().int().optional().nullable(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .nullable(),
  stream: z.boolean().optional().nullable(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.object({})]).optional(),
  user: z.string().optional(),
})

/**
 * Validates if a request payload conforms to the OpenAI Chat Completion v1 shape using Zod.
 * @param payload The request payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidChatCompletionRequest(payload: unknown): boolean {
  const result = chatCompletionRequestSchema.safeParse(payload)
  return result.success
}

// eslint-disable-next-line max-lines-per-function
describe("Anthropic to OpenAI translation logic", () => {
  test("types and preserves current native Messages extensions", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-current",
      max_tokens: 512,
      cache_control: { type: "ephemeral", ttl: "5m" },
      fallback_credit_token: "opaque-token",
      messages: [{ role: "user", content: "hello" }],
      future_native_field: { enabled: true },
    }

    expect(payload).toEqual({
      model: "claude-current",
      max_tokens: 512,
      cache_control: { type: "ephemeral", ttl: "5m" },
      fallback_credit_token: "opaque-token",
      messages: [{ role: "user", content: "hello" }],
      future_native_field: { enabled: true },
    })
  })

  test("types forward-compatible nested Messages wire records", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-current",
      max_tokens: 64,
      metadata: { user_id: "user", future_metadata: true },
      tool_choice: { type: "auto", future_choice: true },
      thinking: { type: "adaptive", future_thinking: true },
      output_config: {
        effort: "high",
        future_output: true,
        task_budget: {
          type: "tokens",
          total: 64,
          future_budget: true,
        },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "url",
                url: "https://example.test",
                future_source: true,
              },
              citations: { enabled: true, future_citation: true },
            },
          ],
        },
      ],
    }

    expect(payload).toMatchObject({
      model: "claude-current",
      max_tokens: 64,
      metadata: { user_id: "user", future_metadata: true },
      tool_choice: { type: "auto", future_choice: true },
      thinking: { type: "adaptive", future_thinking: true },
      output_config: {
        effort: "high",
        future_output: true,
        task_budget: {
          type: "tokens",
          total: 64,
          future_budget: true,
        },
      },
      messages: [{ role: "user" }],
    })
  })

  test("should translate minimal Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("retains temperature and omits top_p when translating Messages to Chat", () => {
    const translated = translateToOpenAI({
      model: "gpt-current",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.3,
      top_p: 0.8,
    })

    expect(translated.temperature).toBe(0.3)
    expect(translated).not.toHaveProperty("top_p")
  })

  test("defaults a schema-less named tool without closing its Chat schema", () => {
    const translated = translateToOpenAI({
      model: "gpt-current",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", description: "Look something up" }],
      tool_choice: { type: "tool", name: "lookup" },
    })

    expect(translated.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look something up",
          parameters: { type: "object", properties: {} },
        },
      },
    ])
    expect(translated.tool_choice).toEqual({
      type: "function",
      function: { name: "lookup" },
    })
    expect(translated.tools?.[0]?.function.parameters).not.toHaveProperty(
      "required",
    )
    expect(translated.tools?.[0]?.function.parameters).not.toHaveProperty(
      "additionalProperties",
    )
  })

  test("omits a Chat tool choice when its named tool did not translate", () => {
    const translated = translateToOpenAI({
      model: "gpt-current",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "kept", input_schema: { type: "object" } }, { name: 3 }],
      tool_choice: { type: "tool", name: "3" },
    } as unknown as AnthropicMessagesPayload)

    expect(translated.tools).toHaveLength(1)
    expect(translated).not.toHaveProperty("tool_choice")
  })

  test("omits typed server tools from the Chat fallback", () => {
    const translated = translateToOpenAI({
      model: "gpt-current",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup" }, { type: "bash_20250124", name: "bash" }],
      tool_choice: { type: "tool", name: "bash" },
    })

    expect(translated.tools?.map((tool) => tool.function.name)).toEqual([
      "lookup",
    ])
    expect(translated).not.toHaveProperty("tool_choice")
  })

  test("preserves tool references as explicit text on Chat Completions", () => {
    const openAIPayload = translateToOpenAI({
      model: "gpt-4o",
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

    expect(openAIPayload.messages).toContainEqual({
      role: "tool",
      tool_call_id: "toolu_search",
      content: '{"type":"tool_reference","tool_name":"Bash"}',
    })
  })

  test("should translate comprehensive Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "What is the weather like in Boston?" },
        {
          role: "assistant",
          content: "The weather in Boston is sunny and 75°F.",
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      stream: false,
      metadata: { user_id: "user-123" },
      tools: [
        {
          name: "getWeather",
          description: "Gets weather info",
          input_schema: { location: { type: "string" } },
        },
      ],
      tool_choice: { type: "auto" },
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should handle missing fields gracefully", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should disable snippy in translated chat completions payloads", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 32,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload) as {
      snippy?: { enabled: boolean }
    }

    expect(openAIPayload.snippy).toEqual({ enabled: false })
  })

  test("should map output_config.format to response_format", () => {
    const anthropicPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Return JSON." }],
      max_tokens: 32,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              answer: { type: "string" },
            },
          },
        },
      },
    } as AnthropicMessagesPayload & {
      output_config: {
        format: {
          type: "json_schema"
          schema: Record<string, unknown>
        }
      }
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
          },
        },
      },
    })
  })

  test("should handle invalid types in Anthropic payload", () => {
    const anthropicPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    // @ts-expect-error intended to be invalid
    const openAIPayload = translateToOpenAI(anthropicPayload)
    // Should fail validation
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(false)
  })

  test("should handle thinking blocks in assistant messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this simple math problem...",
              signature: "sig-123",
            },
            { type: "text", text: "2+2 equals 4." },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is mapped to reasoning fields
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.reasoning_text).toContain(
      "Let me think about this simple math problem...",
    )
    expect(assistantMessage?.reasoning_opaque).toBe("sig-123")
    expect(assistantMessage?.content).toBe("2+2 equals 4.")
  })

  test.each([
    {
      name: "signed then unsigned",
      content: [
        { type: "thinking", thinking: "signed", signature: "sig-first" },
        { type: "thinking", thinking: "unsigned" },
      ],
      expectedContent:
        '{"type":"thinking","thinking":"signed","signature":"sig-first"}\n\n{"type":"thinking","thinking":"unsigned"}',
      expectedReasoningOpaque: "sig-first",
    },
    {
      name: "unsigned then signed",
      content: [
        { type: "thinking", thinking: "unsigned" },
        { type: "thinking", thinking: "signed", signature: "sig-last" },
      ],
      expectedContent:
        '{"type":"thinking","thinking":"unsigned"}\n\n{"type":"thinking","thinking":"signed","signature":"sig-last"}',
      expectedReasoningOpaque: "sig-last",
    },
  ])(
    "degrades assistant history with mixed $name thinking blocks",
    ({ content, expectedContent, expectedReasoningOpaque }) => {
      const translated = translateToOpenAI({
        model: "claude-current",
        messages: [
          {
            role: "assistant",
            content: [...content] as Array<AnthropicAssistantContentBlock>,
          },
        ],
      })

      expect(translated.messages).toEqual([
        {
          role: "assistant",
          content: expectedContent,
          reasoning_text: "signed",
          reasoning_opaque: expectedReasoningOpaque,
        },
      ])
    },
  )

  test("preserves multiple signed thinking blocks as ordered Chat context", () => {
    const source: AnthropicMessagesPayload = {
      model: "claude-current",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "before" },
            { type: "thinking", thinking: "first", signature: "sig-first" },
            { type: "text", text: "between" },
            { type: "thinking", thinking: "second", signature: "sig-second" },
            { type: "text", text: "after" },
          ],
        },
      ],
    }
    const snapshot = structuredClone(source)

    const translated = translateToOpenAI(source)

    expect(translated.messages).toEqual([
      {
        role: "assistant",
        content:
          'before\n\n{"type":"thinking","thinking":"first","signature":"sig-first"}\n\nbetween\n\n{"type":"thinking","thinking":"second","signature":"sig-second"}\n\nafter',
        reasoning_text: "first",
        reasoning_opaque: "sig-first",
      },
    ])
    expect(source).toEqual(snapshot)
  })

  test("should handle thinking blocks with tool calls", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "I need to call the weather API to get current weather information.",
            },
            { type: "text", text: "I'll check the weather for you." },
            {
              type: "tool_use",
              id: "call_123",
              name: "get_weather",
              input: { location: "New York" },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is mapped to reasoning fields
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.reasoning_text).toContain(
      "I need to call the weather API",
    )
    expect(assistantMessage?.content).toBe("I'll check the weather for you.")
    expect(assistantMessage?.tool_calls).toHaveLength(1)
    expect(assistantMessage?.tool_calls?.[0].function.name).toBe("get_weather")
  })

  test("preserves future assistant blocks in source order beside valid blocks", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-current",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "before" },
            {
              type: asAnthropicUnknownContentType(
                "future_assistant_block_20270101",
              ),
              future_payload: { enabled: true },
            },
            { type: "text", text: "after" },
            {
              type: "thinking",
              thinking: "private reasoning",
              signature: "native-signature",
            },
            {
              type: "tool_use",
              id: "call_future",
              name: "lookup",
              input: { query: "docs" },
            },
          ],
        },
      ],
    }
    const snapshot = structuredClone(anthropicPayload)

    const translated = translateToOpenAI(anthropicPayload)

    expect(translated.messages[0]).toMatchObject({
      role: "assistant",
      content:
        'before\n\n{"type":"future_assistant_block_20270101","future_payload":{"enabled":true}}\n\nafter',
      reasoning_text: "private reasoning",
      reasoning_opaque: "native-signature",
      tool_calls: [
        {
          id: "call_future",
          type: "function",
          function: { name: "lookup", arguments: '{"query":"docs"}' },
        },
      ],
    })
    expect(anthropicPayload).toEqual(snapshot)
  })

  test("bounds future assistant block JSON without dropping neighboring text", () => {
    const translated = translateToOpenAI({
      model: "claude-current",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "before" },
            {
              type: asAnthropicUnknownContentType(
                "future_assistant_block_20270101",
              ),
              payload: "x".repeat(20_000),
            },
            { type: "text", text: "after" },
          ],
        },
      ],
    })

    const content = translated.messages[0]?.content
    expect(typeof content).toBe("string")
    expect(content).toStartWith("before\n\n")
    expect(content).toEndWith("\n\nafter")
    expect((content as string).length).toBeLessThanOrEqual(16_400)
  })
})

describe("public Messages content preservation", () => {
  test("preserves marker-prefixed conversation content in translated payloads", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      messages: [
        {
          role: "user",
          content:
            "<available-deferred-tools>\nAskUserQuestion\nTaskCreate\n</available-deferred-tools>",
        },
        {
          role: "user",
          content:
            "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- brainstorming\n</system-reminder>",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tooluse_skill",
              name: "Skill",
              input: { skill: "brainstorming" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tooluse_skill",
              content: "Tool loaded.",
            },
          ],
        },
        { role: "user", content: "Help me write an implementation plan." },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      {
        role: "user",
        content:
          "<available-deferred-tools>\nAskUserQuestion\nTaskCreate\n</available-deferred-tools>",
      },
      {
        role: "user",
        content:
          "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- brainstorming\n</system-reminder>",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tooluse_skill",
            type: "function",
            function: {
              name: "Skill",
              arguments: '{"skill":"brainstorming"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tooluse_skill",
        content: "Tool loaded.",
      },
      { role: "user", content: "Help me write an implementation plan." },
    ])
  })

  test("preserves mismatched generic tool calls and results", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "search-call",
              name: "WebSearch",
              input: { query: "compatibility" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "different-call",
              content:
                "IMPORTANT: This message and these instructions are NOT part of the actual user conversation.",
            },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "search-call",
            type: "function",
            function: {
              name: "WebSearch",
              arguments: '{"query":"compatibility"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "different-call",
        content:
          "IMPORTANT: This message and these instructions are NOT part of the actual user conversation.",
      },
    ])
  })
})

describe("Messages compatibility translation", () => {
  test("should preserve normal tool interactions that happen to say Tool loaded.", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: "Load the parser before answering." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tooluse_loader",
              name: "load_parser",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tooluse_loader",
              content: "Tool loaded.",
            },
          ],
        },
        { role: "assistant", content: "The parser is ready." },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      { role: "user", content: "Load the parser before answering." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tooluse_loader",
            type: "function",
            function: {
              name: "load_parser",
              arguments: "{}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tooluse_loader",
        content: "Tool loaded.",
      },
      { role: "assistant", content: "The parser is ready." },
    ])
  })

  test("should preserve deferred tool availability assistant notices for model policy handling", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      messages: [
        { role: "user", content: "Help me investigate an error." },
        {
          role: "assistant",
          content:
            'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded - calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\nCronCreate\nTaskCreate',
        },
      ],
      max_tokens: 100,
      stream: true,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      { role: "user", content: "Help me investigate an error." },
      {
        role: "assistant",
        content:
          'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded - calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\nCronCreate\nTaskCreate',
      },
    ])
  })

  test("should preserve deferred tool availability assistant text blocks for model policy handling", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      messages: [
        { role: "user", content: "Help me investigate an error." },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded - calling them directly will fail with InputValidationError.",
            },
          ],
        },
      ],
      max_tokens: 100,
      stream: true,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.messages).toEqual([
      { role: "user", content: "Help me investigate an error." },
      {
        role: "assistant",
        content:
          "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded - calling them directly will fail with InputValidationError.",
      },
    ])
  })
})

describe("OpenAI Chat Completion v1 Request Payload Validation with Zod", () => {
  test("should return true for a minimal valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test("should return true for a comprehensive valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather like in Boston?" },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
      n: 1,
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test('should return false if the "model" field is missing', () => {
    const invalidPayload = {
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" field is missing', () => {
    const invalidPayload = {
      model: "gpt-4o",
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" array is empty', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "model" is not a string', () => {
    const invalidPayload = {
      model: 12345,
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "messages" is not an array', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: { role: "user", content: "Hello!" },
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing a "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing "content"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user" }],
    }
    // Note: Zod considers 'undefined' as missing, so this will fail as expected.
    const result = chatCompletionRequestSchema.safeParse(invalidPayload)
    expect(result.success).toBe(false)
  })

  test('should return false if a message has an invalid "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "customer", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false if an optional field has an incorrect type", () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for a completely empty object", () => {
    const invalidPayload = {}
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for null or non-object payloads", () => {
    expect(isValidChatCompletionRequest(null)).toBe(false)
    expect(isValidChatCompletionRequest(undefined)).toBe(false)
    expect(isValidChatCompletionRequest("a string")).toBe(false)
    expect(isValidChatCompletionRequest(123)).toBe(false)
  })
})

describe("Messages translation fidelity", () => {
  test("round-trips a Responses-native thinking signature", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-current",
      max_tokens: 64,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "prior thought",
              signature: "encrypted-state@rs_1",
            },
          ],
        },
      ],
    }

    expect(checkMessagesToResponsesTranslation(payload)).toEqual({
      supported: true,
      blockers: [],
    })
    const translated = translateAnthropicMessagesToResponsesPayload(payload)
    expect(translated.input).toEqual([
      {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "prior thought" }],
        encrypted_content: "encrypted-state",
      },
    ])
  })

  test("round-trips a Chat-native thinking signature", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-current",
      max_tokens: 64,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "prior thought",
              signature: "native-signature",
            },
          ],
        },
      ],
    }

    expect(checkMessagesToChatTranslation(payload)).toEqual({
      supported: true,
      blockers: [],
    })
    const translated = translateToOpenAI(payload)
    expect(translated.messages[0]).toMatchObject({
      role: "assistant",
      reasoning_text: "prior thought",
      reasoning_opaque: "native-signature",
    })
  })

  test("blocks advanced and native-only tool declarations", () => {
    const payload = {
      model: "claude-current",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "custom",
          name: "advanced",
          input_schema: { type: "object", properties: {} },
          defer_loading: true,
        },
        { type: "web_fetch_20250910", name: "web_fetch" },
      ],
    } as AnthropicMessagesPayload

    expect(checkMessagesToResponsesTranslation(payload).blockers).toEqual([
      "tool_extension",
    ])
    expect(checkMessagesToChatTranslation(payload).blockers).toEqual([
      "tool_extension",
    ])
  })

  test("allows the existing web-search compatibility loop", () => {
    const payload = {
      model: "claude-current",
      max_tokens: 64,
      messages: [{ role: "user", content: "search" }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          allowed_domains: ["example.com"],
        },
      ],
    } as AnthropicMessagesPayload

    expect(checkMessagesToResponsesTranslation(payload)).toEqual({
      supported: true,
      blockers: [],
    })
    expect(checkMessagesToChatTranslation(payload)).toEqual({
      supported: true,
      blockers: [],
    })
  })

  test("Chat document conversion proves the Copilot fallback is not lossless", () => {
    const translated = translateToOpenAI({
      model: "chat-only",
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
            },
          ],
        },
      ],
    })

    expect(translated.messages[0]?.content).toEqual([
      {
        type: "file",
        file: {
          filename: "report.pdf",
          file_data: "data:application/pdf;base64,JVBERi0=",
        },
      },
    ])
  })

  test.each([true, false])(
    "Chat tool-result conversion drops is_error=%s",
    (isError) => {
      const translated = translateToOpenAI({
        model: "chat-only",
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

      expect(translated.messages[0]).toEqual({
        role: "tool",
        tool_call_id: "toolu_1",
        content: "result",
      })
    },
  )
})

describe("stripThinkingBlocks", () => {
  test("should remove thinking blocks from assistant messages", () => {
    const payload = {
      model: "claude-opus-4.6",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think...",
              signature: "sig-abc",
            },
            { type: "text", text: "Hi there!" },
          ],
        },
        { role: "user", content: "Follow up" },
      ],
      max_tokens: 100,
    }

    const stripped = stripThinkingBlocks(payload as AnthropicMessagesPayload)
    expect(stripped).toBe(true)

    const assistant = payload.messages[1]
    expect(Array.isArray(assistant.content)).toBe(true)
    const content = assistant.content as Array<{ type: string }>
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe("text")
  })

  test("should handle assistant messages with string content", () => {
    const payload = {
      model: "claude-opus-4.6",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Simple response" },
      ],
      max_tokens: 100,
    }

    const stripped = stripThinkingBlocks(payload as AnthropicMessagesPayload)
    expect(stripped).toBe(false)
    expect(payload.messages[1].content).toBe("Simple response")
  })

  test("should return false when no thinking blocks exist", () => {
    const payload = {
      model: "claude-opus-4.6",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Response" }],
        },
      ],
      max_tokens: 100,
    }

    const stripped = stripThinkingBlocks(payload as AnthropicMessagesPayload)
    expect(stripped).toBe(false)
  })

  test("should not modify user messages", () => {
    const payload = {
      model: "claude-opus-4.6",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      max_tokens: 100,
    }

    const stripped = stripThinkingBlocks(payload as AnthropicMessagesPayload)
    expect(stripped).toBe(false)
    const content = payload.messages[0].content as Array<{ type: string }>
    expect(content).toHaveLength(1)
  })
})
