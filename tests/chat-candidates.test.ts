/* eslint-disable max-lines-per-function -- compact matrix shares one model fixture */
import { afterEach, describe, expect, mock, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  prepareChatCandidates,
  prepareCustomProviderChatCandidate,
} from "~/routes/chat-completions/chat-candidates"
import { prepareChatCompletionsRequest } from "~/routes/chat-completions/chat-contract"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const model = {
  id: "future-model",
  name: "Future Model",
  object: "model",
  preview: false,
  vendor: "openai",
  version: "1",
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions", "/responses", "/v1/messages"],
  capabilities: {
    family: "future",
    limits: { max_output_tokens: 4096 },
    object: "model_capabilities",
    supports: {},
    tokenizer: "cl100k_base",
    type: "chat",
  },
} satisfies Model

describe("Chat endpoint candidates", () => {
  test("builds detached native, Responses, and Messages candidates", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        { role: "future-private-role", content: "future content" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              function: { name: "lookup", arguments: "not-json" },
            },
          ],
        },
        { role: "tool", content: "orphan result" },
      ],
      max_tokens: 11,
      max_completion_tokens: 22,
      temperature: 0.2,
      seed: 7,
      tools: {
        type: "function",
        function: { name: "lookup", parameters: null },
      },
      tool_choice: { type: "future-private-choice" },
      future_top_level: { private: true },
    }).source

    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(candidates.chat.endpoint).toBe("/chat/completions")
    expect(candidates.responses.endpoint).toBe("/responses")
    expect(candidates.messages.endpoint).toBe("/v1/messages")
    expect(candidates.chat.payload).not.toBe(source)
    expect(candidates.chat.payload.messages).not.toBe(source.messages)
    expect(candidates.responses.payload).not.toBe(candidates.chat.payload)
    expect(candidates.messages.payload).not.toBe(candidates.chat.payload)

    expect(candidates.chat.payload).toMatchObject({
      max_completion_tokens: 22,
      future_top_level: { private: true },
    })
    expect(candidates.chat.payload.messages[0]).toMatchObject({
      role: "future-private-role",
      content: "future content",
    })
    expect(candidates.responses.payload.max_output_tokens).toBe(22)
    expect(candidates.responses.payload.store).toBe(false)
    expect(candidates.messages.payload.max_tokens).toBe(22)
    expect(JSON.stringify(candidates.responses.check)).not.toContain(
      "future-private",
    )
    expect(JSON.stringify(candidates.messages.check)).not.toContain(
      "future-private",
    )
  })

  test("preserves hosted Chat web-search max uses out of band", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [{ role: "user", content: "search" }],
      tools: [
        {
          type: "web_search",
          max_uses: 2,
          filters: { allowed_domains: ["example.com"] },
        },
      ],
    }).source

    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(candidates.chat.webSearchMaxUses).toBe(2)
    expect(candidates.responses.webSearchMaxUses).toBe(2)
    expect(JSON.stringify(candidates.chat.payload)).not.toContain("max_uses")
    expect(JSON.stringify(candidates.responses.payload)).not.toContain(
      "max_uses",
    )
  })

  test("uses deterministic request-local tool IDs and target argument fallbacks", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              function: { name: "lookup", arguments: "not-json" },
            },
            {
              id: "same",
              type: "function",
              function: { name: "lookup", arguments: "7" },
            },
            {
              id: "same",
              type: "function",
              function: { name: "lookup", arguments: { raw: true } },
            },
          ],
        },
      ],
    }).source

    const first = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })
    const second = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    const firstResponseCalls = (
      first.responses.payload.input as Array<Record<string, unknown>>
    ).filter((item) => item.type === "function_call")
    const secondResponseCalls = (
      second.responses.payload.input as Array<Record<string, unknown>>
    ).filter((item) => item.type === "function_call")
    expect(firstResponseCalls.map((item) => item.call_id)).toEqual(
      secondResponseCalls.map((item) => item.call_id),
    )
    expect(firstResponseCalls.map((item) => item.arguments)).toEqual([
      "not-json",
      "7",
      '{"raw":true}',
    ])

    const messageToolUses = first.messages.payload.messages.flatMap(
      (message) =>
        Array.isArray(message.content) ?
          message.content.filter((block) => block.type === "tool_use")
        : [],
    )
    expect(messageToolUses.map((block) => block.id)).toEqual([
      "chat_call_0_0",
      "same",
      "chat_call_0_2",
    ])
    expect(messageToolUses.map((block) => block.input)).toEqual([
      { raw_arguments: "not-json" },
      { raw_arguments: "7" },
      { raw_arguments: { raw: true } },
    ])
  })

  test("consumes each translated tool call result pairing once", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: {
            id: "call_a",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        },
        { role: "tool", tool_call_id: "call_a", content: "first result" },
        { role: "tool", tool_call_id: "call_a", content: "second result" },
      ],
    }).source

    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(candidates.responses.payload.input).toEqual([
      {
        type: "function_call",
        call_id: "call_a",
        name: "lookup",
        arguments: "{}",
        status: "completed",
      },
      {
        type: "function_call_output",
        call_id: "call_a",
        output: "first result",
      },
      {
        type: "message",
        role: "user",
        content: "[Unpaired tool result]\nsecond result",
      },
    ])
    expect(candidates.messages.payload.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_a",
            name: "lookup",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_a",
            content: "first result",
          },
        ],
      },
      {
        role: "user",
        content: "[Unpaired tool result]\nsecond result",
      },
    ])
  })

  test("pairs interleaved translated tool results by ID", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: {
            id: "call_a",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        },
        { role: "user", content: "interrupt" },
        { role: "tool", tool_call_id: "call_a", content: "late result" },
      ],
    }).source

    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(candidates.responses.payload.input).toEqual([
      {
        type: "function_call",
        call_id: "call_a",
        name: "lookup",
        arguments: "{}",
        status: "completed",
      },
      { type: "message", role: "user", content: "interrupt" },
      {
        type: "function_call_output",
        call_id: "call_a",
        output: "late result",
      },
    ])
    expect(candidates.messages.payload.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_a",
            name: "lookup",
            input: {},
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "interrupt" }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_a",
            content: "late result",
          },
        ],
      },
    ])
  })

  test("keeps generated tool IDs distinct from every caller-supplied ID", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              function: { name: "generated", arguments: "{}" },
            },
            {
              id: "chat_call_0_0",
              type: "function",
              function: { name: "reserved", arguments: "{}" },
            },
            {
              id: "chat_call_0_0_1",
              type: "function",
              function: { name: "also_reserved", arguments: "{}" },
            },
          ],
        },
      ],
    }).source

    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })
    const responseCalls = (
      candidates.responses.payload.input as Array<Record<string, unknown>>
    ).filter((item) => item.type === "function_call")
    const messageToolUses = candidates.messages.payload.messages.flatMap(
      (message) =>
        Array.isArray(message.content) ?
          message.content.filter((block) => block.type === "tool_use")
        : [],
    )

    expect(responseCalls.map((item) => item.call_id)).toEqual([
      "chat_call_0_0_2",
      "chat_call_0_0",
      "chat_call_0_0_1",
    ])
    expect(messageToolUses.map((block) => block.id)).toEqual([
      "chat_call_0_0_2",
      "chat_call_0_0",
      "chat_call_0_0_1",
    ])
  })

  test("repairs schemas on target copies without changing source", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: null },
        },
      ],
    }).source
    const before = structuredClone(source)
    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(source).toEqual(before)
    expect(candidates.responses.payload.tools?.[0]).toMatchObject({
      type: "function",
      name: "lookup",
      parameters: { type: "object", properties: {} },
      strict: false,
    })
    expect(candidates.messages.payload.tools?.[0]).toMatchObject({
      name: "lookup",
      input_schema: { type: "object", properties: {} },
    })
  })

  test("prepares candidate-local hosted web search representations", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [{ role: "user", content: "search" }],
      tools: [{ type: "web_search_preview", search_context_size: "high" }],
      parallel_tool_calls: true,
    }).source
    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(candidates.chat.payload.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "web_search" },
    })
    expect(candidates.chat.payload.parallel_tool_calls).toBe(false)
    expect(candidates.responses.payload.tools?.[0]).toMatchObject({
      type: "web_search",
      search_context_size: "high",
    })
    expect(candidates.responses.payload.parallel_tool_calls).toBe(false)
    expect(candidates.messages.payload.tools?.[0]).toMatchObject({
      name: "web_search",
    })
  })

  test("keeps viable candidates nonfatal after individual degradation", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "future-private-part", private: true },
            { type: "text", text: "survives" },
          ],
        },
      ],
      tools: [{ type: "future-private-tool", private: true }],
    }).source
    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(candidates.chat.check.supported).toBe(true)
    expect(candidates.responses.check.supported).toBe(true)
    expect(candidates.messages.check.supported).toBe(true)
  })

  test("keeps source and sibling candidates isolated under mutation", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "original" }],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        },
      ],
    }).source
    const sourceSnapshot = structuredClone(source)
    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    const chatContent = candidates.chat.payload.messages[0]?.content
    if (!Array.isArray(chatContent)) throw new Error("Expected Chat content")
    const firstPart = chatContent[0]
    if (firstPart.type !== "text") throw new Error("Expected text part")
    firstPart.text = "mutated"
    ;(
      candidates.responses.payload.tools?.[0] as {
        parameters: { properties: Record<string, unknown> }
      }
    ).parameters.properties.changed = true

    expect(source).toEqual(sourceSnapshot)
    expect(JSON.stringify(candidates.messages.payload)).not.toContain("mutated")
    expect(JSON.stringify(candidates.messages.payload)).not.toContain("changed")
  })

  test("maps missing and future roles without echoing private role values", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        { content: "missing" },
        { role: "future-private-role", content: "future" },
      ],
    }).source
    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(
      candidates.chat.payload.messages.map((message) => message.role as string),
    ).toEqual(["user", "future-private-role"])
    expect(JSON.stringify(candidates.responses.payload)).toContain(
      "[Future role content]",
    )
    expect(JSON.stringify(candidates.messages.payload)).toContain(
      "[Future role content]",
    )
    expect(JSON.stringify(candidates.responses.check)).not.toContain(
      "future-private-role",
    )
  })

  test("preserves interleaved and orphan tool history with target-local degradation", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: {
            id: "call_a",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        },
        { role: "user", content: "interrupt" },
        { role: "tool", tool_call_id: "orphan", content: "result" },
      ],
    }).source
    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(candidates.chat.payload.messages).toHaveLength(3)
    expect(JSON.stringify(candidates.responses.payload)).toContain(
      "[Unpaired tool result]",
    )
    expect(JSON.stringify(candidates.messages.payload)).toContain(
      "[Unpaired tool result]",
    )
  })

  test("applies target-specific sampling, schema, and token precedence", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [{ role: "user", content: "json" }],
      max_tokens: 11,
      max_completion_tokens: 22,
      temperature: 0.3,
      top_p: 0.9,
      seed: 7,
      response_format: {
        type: "json_schema",
        json_schema: { schema: { type: "object" } },
      },
    }).source
    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(candidates.chat.payload).toMatchObject({
      max_completion_tokens: 22,
      temperature: 0.3,
      top_p: 0.9,
      seed: 7,
      response_format: { type: "json_object" },
    })
    expect(candidates.responses.payload.max_output_tokens).toBe(22)
    expect(candidates.responses.payload.temperature).toBe(0.3)
    expect(candidates.responses.payload.text).toEqual({
      format: { type: "json_object" },
    })
    expect(candidates.messages.payload.max_tokens).toBe(22)
    expect(candidates.messages.payload.temperature).toBe(0.3)
    expect(candidates.messages.payload).not.toHaveProperty("top_p")
  })

  test("degrades unsupported attachments per target while preserving sibling text", async () => {
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "keep me" },
            { type: "file", file: { filename: "broken.pdf" } },
          ],
        },
      ],
    }).source
    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
    })

    expect(JSON.stringify(candidates.chat.payload)).toContain("keep me")
    expect(JSON.stringify(candidates.chat.payload)).toContain(
      "[File attachment unavailable]",
    )
    expect(JSON.stringify(candidates.responses.payload)).toContain("keep me")
    expect(JSON.stringify(candidates.messages.payload)).toContain("keep me")
    expect(candidates.messages.check.findings).toContainEqual({
      class: "attachment",
      severity: "omitted",
    })
  })

  test("fetches a runtime-valid noncanonical image once across advertised targets", async () => {
    const requests: Array<string> = []
    globalThis.fetch = mock((input: string | URL | Request) => {
      requests.push(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
      )
    }) as unknown as typeof fetch
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            {
              type: "image_url",
              image_url: { url: "HTTP://USER:PASS@PRIVATE.TEST:80/a.png" },
            },
            { type: "text", text: "after" },
          ],
        },
      ],
    }).source

    const candidates = await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
      support: {
        chat: true,
        responses: false,
        messages: true,
        embeddings: false,
        responsesWebSocket: false,
      },
    })

    expect(requests).toEqual(["http://USER:PASS@private.test/a.png"])
    expect(JSON.stringify(candidates.chat?.payload)).toContain(
      "data:image/png;base64,AQID",
    )
    expect(JSON.stringify(candidates.messages?.payload)).toContain("AQID")
    expect(JSON.stringify(source)).toContain(
      "HTTP://USER:PASS@PRIVATE.TEST:80/a.png",
    )
  })

  test("performs zero attachment I/O for unadvertised Chat and Messages targets", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("must not fetch")))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const source = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "http://127.1/a.png" } },
          ],
        },
      ],
    }).source

    await prepareChatCandidates({
      source,
      selectedModel: model,
      nativeMessagesOptions: {},
      support: {
        chat: false,
        responses: true,
        messages: false,
        embeddings: false,
        responsesWebSocket: false,
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test("does not proxy-fetch custom-provider Chat attachments", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("must not fetch")))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const source = prepareChatCompletionsRequest({
      model: "provider-model",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "http://127.1/provider.png" },
            },
          ],
        },
      ],
    }).source

    const candidate = await prepareCustomProviderChatCandidate({ source })

    expect(fetchMock).toHaveBeenCalledTimes(0)
    expect(JSON.stringify(candidate.payload)).toContain(
      "http://127.1/provider.png",
    )
  })
})
