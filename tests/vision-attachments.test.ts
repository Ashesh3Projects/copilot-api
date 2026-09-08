import { afterEach, describe, expect, mock, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionsPayload,
  ContentPart,
  FilePart,
  ImagePart,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponseInputFile,
  ResponseInputMessage,
  ResponseFunctionCallOutputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

/* eslint-disable max-lines, max-lines-per-function */
import {
  isLikelyBase64,
  mediaTypeFromFilename,
  parseDataUri,
  toDataUri,
} from "~/lib/attachments"
import {
  anthropicResponseToChat,
  chatPayloadToAnthropic,
  streamAnthropicAsChatCompletions,
} from "~/routes/chat-completions/anthropic-bridge"
import { decodeAnthropicContent } from "~/routes/chat-completions/anthropic-reasoning"
import { chatCompletionsToResponses } from "~/routes/chat-completions/responses-fallback"
import { translateGoogleToOpenAI } from "~/routes/google-ai/request-translation"
import {
  normalizeAnthropicAttachments,
  payloadHasPdfDocuments,
} from "~/routes/messages/attachment-normalization"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"
import { responsesToChatCompletions } from "~/routes/responses/handler"
import { hasVisionContent } from "~/services/copilot/copilot-client"
import { normalizeChatAttachments } from "~/services/copilot/create-chat-completions"
import { normalizeResponsesAttachments } from "~/services/copilot/create-responses"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const PDF_B64 = Buffer.from("%PDF-1.4 fake pdf").toString("base64")
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PDF_DATA_URI = `data:application/pdf;base64,${PDF_B64}`
const PNG_DATA_URI = `data:image/png;base64,${PNG_B64}`
const originalFetch = globalThis.fetch

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

// ─── attachments lib ───

describe("attachments lib", () => {
  test("parseDataUri parses media type and payload", () => {
    const parsed = parseDataUri(PDF_DATA_URI)
    expect(parsed?.mediaType).toBe("application/pdf")
    expect(parsed?.data).toBe(PDF_B64)
  })

  test("parseDataUri returns null for non data URIs", () => {
    expect(parseDataUri("https://example.com/x.pdf")).toBeNull()
    expect(parseDataUri(PDF_B64)).toBeNull()
  })

  test("isLikelyBase64 detects raw base64 but not URLs", () => {
    expect(isLikelyBase64(PDF_B64)).toBe(true)
    expect(isLikelyBase64(PDF_DATA_URI)).toBe(false)
    expect(isLikelyBase64("https://example.com")).toBe(false)
  })

  test("mediaTypeFromFilename maps common extensions", () => {
    expect(mediaTypeFromFilename("report.PDF")).toBe("application/pdf")
    expect(mediaTypeFromFilename("photo.webp")).toBe("image/webp")
    expect(mediaTypeFromFilename("notes.txt")).toBeUndefined()
  })
})

// ─── vision detection ───

describe("hasVisionContent", () => {
  test("detects file and document parts in addition to images", () => {
    expect(
      hasVisionContent([
        { content: [{ type: "file" }] as unknown as Array<never> },
      ]),
    ).toBe(true)
    expect(
      hasVisionContent([
        { content: [{ type: "document" }] as unknown as Array<never> },
      ]),
    ).toBe(true)
    expect(
      hasVisionContent([
        { content: [{ type: "input_file" }] as unknown as Array<never> },
      ]),
    ).toBe(true)
    expect(hasVisionContent([{ content: "plain text" }])).toBe(false)
  })
})

// ─── Anthropic → OpenAI CC translation ───

describe("Anthropic document blocks → CC translation", () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-sonnet-4.6",
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this PDF?" },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: PDF_B64,
            },
            title: "report.pdf",
          },
        ],
      },
    ],
  }

  test("maps base64 pdf documents to file parts", () => {
    const openAI = translateToOpenAI(payload)
    const content = openAI.messages[0].content as Array<ContentPart>
    const filePart = content.find((part) => part.type === "file") as FilePart

    expect(filePart).toBeDefined()
    expect(filePart.file.filename).toBe("report.pdf")
    expect(filePart.file.file_data).toBe(PDF_DATA_URI)
  })

  test("keeps images working alongside documents", () => {
    const withImage: AnthropicMessagesPayload = {
      ...payload,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: PNG_B64,
              },
            },
          ],
        },
      ],
    }
    const openAI = translateToOpenAI(withImage)
    const content = openAI.messages[0].content as Array<ContentPart>
    const imagePart = content.find(
      (part) => part.type === "image_url",
    ) as ImagePart

    expect(imagePart.image_url.url).toBe(PNG_DATA_URI)
  })

  test("maps images inside tool_result blocks to tool message parts", () => {
    const withToolResult: AnthropicMessagesPayload = {
      ...payload,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: [
                { type: "text", text: "screenshot:" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: PNG_B64,
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const openAI = translateToOpenAI(withToolResult)
    const toolMessage = openAI.messages.find((m) => m.role === "tool")

    expect(toolMessage).toBeDefined()
    const parts = toolMessage?.content as Array<ContentPart>
    expect(parts.some((part) => part.type === "image_url")).toBe(true)
  })
})

// ─── Anthropic → Responses translation ───

describe("Anthropic document blocks → Responses translation", () => {
  test("maps documents to input_file in user content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize" },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: PDF_B64,
              },
              title: "doc.pdf",
            },
          ],
        },
      ],
    }
    const responses = translateAnthropicMessagesToResponsesPayload(payload)
    const message = (responses.input as Array<ResponseInputMessage>).find(
      (item) => item.type === "message",
    )
    const parts = message?.content as Array<{ type: string }> | undefined
    const filePart = parts?.find((part) => part.type === "input_file") as
      | ResponseInputFile
      | undefined

    expect(filePart?.filename).toBe("doc.pdf")
    expect(filePart?.file_data).toBe(PDF_DATA_URI)
  })

  test("maps documents and images inside tool_result content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: PNG_B64,
                  },
                },
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: PDF_B64,
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const responses = translateAnthropicMessagesToResponsesPayload(payload)
    const output = (
      responses.input as Array<{ type?: string; output?: unknown }>
    ).find((item) => item.type === "function_call_output")

    const parts = output?.output as Array<{ type: string }>
    expect(parts.some((part) => part.type === "input_image")).toBe(true)
    expect(parts.some((part) => part.type === "input_file")).toBe(true)
  })
})

// ─── attachment normalization (messages route) ───

describe("normalizeAnthropicAttachments", () => {
  test.each([
    "ftp://example.test/report.pdf",
    "file:///tmp/report.pdf",
    "data:application/pdf;base64,JVBERi0=",
    "/relative/report.pdf",
    "not a URL",
    " ",
  ])("does not fetch non-HTTP document URL %s", async (url) => {
    const fetchMock = mock(() => {
      throw new Error("unexpected fetch")
    })
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch
    const payload: AnthropicMessagesPayload = {
      model: "gpt-current",
      max_tokens: 100,
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
    }

    await normalizeAnthropicAttachments(payload)

    expect(fetchMock).not.toHaveBeenCalled()
    const content = payload.messages[0].content as Array<{
      text?: string
      type: string
    }>
    expect(content[0]?.type).toBe("text")
    expect(content[0]?.text).toContain("omitted")
  })

  test.each([
    "http://attachment.test/report.pdf",
    "https://attachment.test/report.pdf",
    "http://attachment.test:80/report.pdf?download=1#section",
    "https://attachment.test:443/report.pdf?download=1#section",
    "http://attachment.test:8080/report.pdf?download=1#section",
    "https://[2001:db8::1]:8443/report.pdf?download=1#section",
  ])("fetches absolute HTTP document URL %s once", async (url) => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response("%PDF-1.4", {
          headers: { "content-type": "application/pdf" },
        }),
      ),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch
    const payload: AnthropicMessagesPayload = {
      model: "gpt-current",
      max_tokens: 100,
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
    }

    await normalizeAnthropicAttachments(payload)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(payload.messages[0].content).toEqual([
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: Buffer.from("%PDF-1.4").toString("base64"),
        },
        title: "report.pdf",
      },
    ])
  })

  test("fetches userinfo and normalized numeric attachment URLs without exposing them", async () => {
    const requested: Array<string> = []
    const marker = "private-query-marker"
    globalThis.fetch = mock((input: string | URL | Request) => {
      requested.push(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response("", { status: 404 }))
    }) as unknown as typeof fetch
    const payload: AnthropicMessagesPayload = {
      model: "gpt-current",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            {
              type: "image",
              source: {
                type: "url",
                url: `HTTP://USER:PASS@127.1/a.png?secret=${marker}`,
              },
            },
            { type: "text", text: "after" },
          ],
        },
      ],
    }

    await normalizeAnthropicAttachments(payload)

    expect(requested).toEqual([
      `http://USER:PASS@127.0.0.1/a.png?secret=${marker}`,
    ])
    expect(JSON.stringify(payload)).toContain("before")
    expect(JSON.stringify(payload)).toContain("after")
    expect(JSON.stringify(payload)).not.toContain(marker)
  })

  test("inlines text-source documents as text blocks", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "hello world",
              },
              title: "notes.txt",
            },
          ],
        },
      ],
    }
    await normalizeAnthropicAttachments(payload)
    const content = payload.messages[0].content as Array<{
      type: string
      text?: string
    }>

    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("hello world")
    expect(content[0].text).toContain("notes.txt")
  })

  test("keeps base64 pdf documents intact", async () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: PDF_B64,
              },
            },
          ],
        },
      ],
    }
    await normalizeAnthropicAttachments(payload)
    const content = payload.messages[0].content as Array<{ type: string }>

    expect(content[0].type).toBe("document")
    expect(payloadHasPdfDocuments(payload)).toBe(true)
  })

  test("payloadHasPdfDocuments detects documents inside tool results", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: PDF_B64,
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    expect(payloadHasPdfDocuments(payload)).toBe(true)
  })

  test("payloadHasPdfDocuments is false for images only", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: PNG_B64,
              },
            },
          ],
        },
      ],
    }
    expect(payloadHasPdfDocuments(payload)).toBe(false)
  })
})

// ─── OpenAI CC → Anthropic bridge ───

describe("chatPayloadToAnthropic bridge", () => {
  test("does not invent a local max_tokens default", async () => {
    const anthropic = await chatPayloadToAnthropic({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "hello" }],
    })

    expect(anthropic.max_tokens).toBeUndefined()
  })

  test("preserves an explicit null max_tokens without using model fallback", async () => {
    const anthropic = await chatPayloadToAnthropic(
      {
        model: "claude-sonnet-4.6",
        max_tokens: null,
        messages: [{ role: "user", content: "hello" }],
      },
      {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
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
      },
    )

    expect(anthropic).toHaveProperty("max_tokens", null)
  })

  test("prefers max_completion_tokens when both token aliases are present", async () => {
    const anthropic = await chatPayloadToAnthropic({
      model: "claude-sonnet-4.6",
      max_tokens: null,
      max_completion_tokens: 321,
      messages: [{ role: "user", content: "hello" }],
    })

    expect(anthropic).toHaveProperty("max_tokens", 321)
  })

  test("maps file parts to document blocks and images to image blocks", async () => {
    const payload: ChatCompletionsPayload & { model: string } = {
      model: "claude-sonnet-4.6",
      max_tokens: 200,
      messages: [
        { role: "system", content: "You are helpful." },
        {
          role: "user",
          content: [
            { type: "text", text: "Read this" },
            { type: "image_url", image_url: { url: PNG_DATA_URI } },
            {
              type: "file",
              file: { filename: "spec.pdf", file_data: PDF_DATA_URI },
            },
          ],
        },
      ],
    }
    const anthropic = await chatPayloadToAnthropic(payload)

    expect(anthropic.system).toBe("You are helpful.")
    expect(anthropic.max_tokens).toBe(200)

    const blocks = anthropic.messages[0].content as Array<{
      type: string
      source?: { media_type?: string; data?: string }
      title?: string
    }>
    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "image",
      "document",
    ])
    expect(blocks[1].source?.media_type).toBe("image/png")
    expect(blocks[2].source?.media_type).toBe("application/pdf")
    expect(blocks[2].source?.data).toBe(PDF_B64)
    expect(blocks[2].title).toBe("spec.pdf")
  })

  test("fetches a runtime-valid remote image for Chat to Messages", async () => {
    const requested: Array<string> = []
    globalThis.fetch = mock((input: string | URL | Request) => {
      requested.push(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
      )
    }) as unknown as typeof fetch

    const anthropic = await chatPayloadToAnthropic({
      model: "claude-current",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            {
              type: "image_url",
              image_url: { url: "HTTP://USER:PASS@127.1/a.png" },
            },
            { type: "text", text: "after" },
          ],
        },
      ],
    })

    expect(requested).toEqual(["http://USER:PASS@127.0.0.1/a.png"])
    expect(JSON.stringify(anthropic)).toContain("AQID")
    expect(JSON.stringify(anthropic)).toContain("before")
    expect(JSON.stringify(anthropic)).toContain("after")
  })

  test.each([
    { name: "HTTP failure", response: new Response("", { status: 404 }) },
    {
      name: "unsupported media",
      response: new Response(new Uint8Array([1, 2]), {
        headers: { "content-type": "text/plain" },
      }),
    },
  ])(
    "degrades a Chat to Messages image $name between sibling text",
    async ({ response }) => {
      globalThis.fetch = mock(() =>
        Promise.resolve(response.clone()),
      ) as unknown as typeof fetch

      const anthropic = await chatPayloadToAnthropic({
        model: "claude-current",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "before" },
              {
                type: "image_url",
                image_url: {
                  url: "https://private.test/fail.png?secret=marker",
                },
              },
              { type: "text", text: "after" },
            ],
          },
        ],
      })

      expect(anthropic.messages[0].content).toEqual([
        { type: "text", text: "before" },
        { type: "text", text: "[Image attachment unavailable]" },
        { type: "text", text: "after" },
      ])
      expect(JSON.stringify(anthropic)).not.toContain("secret=marker")
    },
  )

  test("converts tool calls and tool results", async () => {
    const payload: ChatCompletionsPayload & { model: string } = {
      model: "claude-sonnet-4.6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "screenshot please" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "screenshot", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "done" },
            { type: "image_url", image_url: { url: PNG_DATA_URI } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "screenshot",
            description: "take a screenshot",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "auto",
    }
    const anthropic = await chatPayloadToAnthropic(payload)

    expect(anthropic.messages).toHaveLength(3)
    const assistant = anthropic.messages[1]
    const assistantBlocks = assistant.content as Array<{
      type: string
      id?: string
      name?: string
    }>
    expect(assistantBlocks[0].type).toBe("tool_use")
    expect(assistantBlocks[0].id).toBe("call_1")

    const toolResultMsg = anthropic.messages[2]
    const trBlocks = toolResultMsg.content as Array<{
      type: string
      tool_use_id?: string
      content?: Array<{ type: string }>
    }>
    expect(trBlocks[0].type).toBe("tool_result")
    expect(trBlocks[0].tool_use_id).toBe("call_1")
    expect(trBlocks[0].content?.some((b) => b.type === "image")).toBe(true)

    expect(anthropic.tools?.[0].name).toBe("screenshot")
    expect(anthropic.tool_choice).toEqual({ type: "auto" })
  })
})

describe("anthropicResponseToChat bridge", () => {
  test("maps content, tool_use and usage", () => {
    const chat = anthropicResponseToChat(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [
          { type: "text", text: "BANANA42" },
          { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: 1 } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 90,
        },
      },
      "claude-sonnet-4-6",
    )

    expect(chat.model).toBe("claude-sonnet-4-6")
    expect(chat.choices[0].message.content).toBe("BANANA42")
    expect(chat.choices[0].finish_reason).toBe("tool_calls")
    expect(chat.choices[0].message.tool_calls?.[0].id).toBe("toolu_9")
    expect(chat.usage?.prompt_tokens).toBe(100)
    expect(chat.usage?.prompt_tokens_details?.cached_tokens).toBe(90)
  })

  test("preserves multiple signed thinking blocks in native replay state", () => {
    const chat = anthropicResponseToChat(
      {
        id: "msg_multi_reasoning",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [
          { type: "thinking", thinking: "first", signature: "sig-first" },
          { type: "thinking", thinking: "second", signature: "sig-second" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      "claude-sonnet-4.6",
    )
    expect(chat.choices[0].message.reasoning_text).toBe("first\n\nsecond")
    expect(
      decodeAnthropicContent(chat.choices[0].message.reasoning_opaque),
    ).toEqual([
      { type: "thinking", thinking: "first", signature: "sig-first" },
      { type: "thinking", thinking: "second", signature: "sig-second" },
    ])
  })

  test.each([
    {
      name: "signed then unsigned",
      content: [
        { type: "thinking", thinking: "signed", signature: "sig-first" },
        { type: "thinking", thinking: "unsigned" },
      ],
    },
    {
      name: "unsigned then signed",
      content: [
        { type: "thinking", thinking: "unsigned" },
        { type: "thinking", thinking: "signed", signature: "sig-last" },
      ],
    },
  ])("preserves mixed $name thinking blocks", ({ content }) => {
    const chat = anthropicResponseToChat(
      {
        id: "msg_mixed_reasoning",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [...content] as AnthropicResponse["content"],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      "claude-sonnet-4.6",
    )
    expect(
      decodeAnthropicContent(chat.choices[0].message.reasoning_opaque),
    ).toEqual([...content] as AnthropicResponse["content"])
  })

  test("preserves multiple unsigned thinking blocks without a signature", () => {
    const chat = anthropicResponseToChat(
      {
        id: "msg_unsigned_reasoning",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [
          { type: "thinking", thinking: "first" },
          { type: "thinking", thinking: "second" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      "claude-sonnet-4.6",
    )

    expect(chat.choices[0]?.message).toMatchObject({
      reasoning_text: "first\n\nsecond",
    })
    expect(chat.choices[0]?.message).not.toHaveProperty("reasoning_opaque")
  })

  test("preserves one signed thinking block", () => {
    const chat = anthropicResponseToChat(
      {
        id: "msg_single_signed",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.6",
        content: [
          { type: "thinking", thinking: "signed", signature: "sig-only" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      "claude-sonnet-4.6",
    )

    expect(chat.choices[0]?.message).toMatchObject({
      reasoning_text: "signed",
      reasoning_opaque: "sig-only",
    })
  })
})

describe("streamAnthropicAsChatCompletions bridge", () => {
  test("translates Anthropic SSE into CC chunks", async () => {
    const events = [
      {
        event: "message_start",
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_s1",
            usage: { input_tokens: 7, output_tokens: 0 },
          },
        }),
      },
      {
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        }),
      },
      {
        event: "message_delta",
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 3 },
        }),
      },
      { event: "message_stop", data: '{"type":"message_stop"}' },
      { data: "[DONE]" },
    ]

    const written: Array<string> = []
    const stream = {
      writeSSE: (chunk: { data: string }) => {
        written.push(chunk.data)
        return Promise.resolve()
      },
    }

    async function* iterate() {
      for (const event of events) {
        yield await Promise.resolve(event)
      }
    }

    const usage = await streamAnthropicAsChatCompletions(
      stream,
      iterate(),
      "claude-sonnet-4.6",
    )

    expect(usage.inputTokens).toBe(7)
    expect(usage.outputTokens).toBe(3)
    expect(usage.responseText).toBe("hello")

    const parsed = written.map(
      (data) =>
        JSON.parse(data) as {
          choices: Array<{
            delta: { content?: string; role?: string }
            finish_reason: string | null
          }>
          model: string
        },
    )
    expect(parsed[0].choices[0].delta.role).toBe("assistant")
    expect(parsed.some((c) => c.choices[0].delta.content === "hello")).toBe(
      true,
    )
    expect(parsed.at(-1)?.choices[0].finish_reason).toBe("stop")
    expect(parsed.every((c) => c.model === "claude-sonnet-4.6")).toBe(true)
    expect(usage.terminalSeen).toBe(true)
    expect(written).not.toContain("[DONE]")
  })

  test("returns a native stream error for the Chat lifecycle owner", async () => {
    const privateMarker = "native-stream-private-marker"
    const written: Array<string> = []
    const stream = {
      writeSSE: (chunk: { data: string }) => {
        written.push(chunk.data)
        return Promise.resolve()
      },
    }

    async function* iterate() {
      yield await Promise.resolve({
        event: "error",
        data: JSON.stringify({
          type: "error",
          error: { type: "api_error", message: privateMarker },
        }),
      })
    }

    const usage = await streamAnthropicAsChatCompletions(
      stream,
      iterate(),
      "claude-sonnet-4.6",
    )

    expect(usage.receivedFailure).toEqual({
      type: "api_error",
      message: privateMarker,
    })
    expect(usage.terminalSeen).toBe(false)
    expect(written).toEqual([])
  })

  test("emits one complete thinking signature after later tools", async () => {
    const events = [
      {
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_signed",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "thought" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "final" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool_1",
            name: "lookup",
            input: {},
          },
        }),
      },
      { data: JSON.stringify({ type: "message_stop" }) },
    ]
    const written: Array<string> = []
    const stream = {
      writeSSE: (chunk: { data: string }) => {
        written.push(chunk.data)
        return Promise.resolve()
      },
    }
    async function* iterate() {
      for (const event of events) yield await Promise.resolve(event)
    }

    await streamAnthropicAsChatCompletions(stream, iterate(), "claude")

    const deltas = written.map(
      (data) =>
        (
          JSON.parse(data) as {
            choices: Array<{ delta: Record<string, unknown> }>
          }
        ).choices[0].delta,
    )
    const signatureIndex = deltas.findIndex(
      (delta) => delta.reasoning_opaque === "sig-final",
    )
    const toolIndex = deltas.findIndex((delta) => delta.tool_calls)
    expect(signatureIndex).toBeGreaterThan(-1)
    expect(signatureIndex).toBeGreaterThan(toolIndex)
    expect(deltas.filter((delta) => delta.reasoning_opaque)).toHaveLength(1)
  })
})

// ─── CC → Responses fallback ───

describe("chatCompletionsToResponses attachments", () => {
  test("maps file parts to input_file and keeps images", () => {
    const payload: ChatCompletionsPayload & { model: string } = {
      model: "gpt-5.4",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read" },
            { type: "image_url", image_url: { url: PNG_DATA_URI } },
            {
              type: "file",
              file: { filename: "a.pdf", file_data: PDF_DATA_URI },
            },
          ],
        },
      ],
    }
    const responses = chatCompletionsToResponses(payload)
    const message = (responses.input as Array<ResponseInputMessage>)[0]
    const parts = message.content as Array<{ type: string }>

    expect(parts.map((part) => part.type)).toEqual([
      "input_text",
      "input_image",
      "input_file",
    ])
  })

  test("keeps images in tool outputs as structured content", () => {
    const payload: ChatCompletionsPayload & { model: string } = {
      model: "gpt-5.4",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "screenshot", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_2",
          content: [
            { type: "text", text: "screenshot:" },
            { type: "image_url", image_url: { url: PNG_DATA_URI } },
          ],
        },
      ],
    }
    const responses = chatCompletionsToResponses(payload)
    const output = (responses.input as Array<ResponseFunctionCallOutputItem>)[1]

    expect(output.type).toBe("function_call_output")
    const parts = output.output as Array<{ type: string }>
    expect(parts.some((part) => part.type === "input_image")).toBe(true)
  })
})

// ─── Responses → CC fallback (codex on non-responses models) ───

describe("responsesToChatCompletions attachments", () => {
  test("preserves input_image and input_file parts", () => {
    const payload: ResponsesPayload = {
      model: "claude-sonnet-4.6",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: PNG_DATA_URI, detail: "auto" },
            {
              type: "input_file",
              filename: "b.pdf",
              file_data: PDF_DATA_URI,
            },
          ],
        },
      ],
    }
    const cc = responsesToChatCompletions(payload)
    const parts = cc.messages[0].content as Array<ContentPart>

    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "image_url",
      "file",
    ])
  })

  test("keeps text-only content as a plain string", () => {
    const payload: ResponsesPayload = {
      model: "gpt-4o-mini",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    }
    const cc = responsesToChatCompletions(payload)
    expect(cc.messages[0].content).toBe("hello")
  })

  test("maps structured function_call_output with image", () => {
    const payload: ResponsesPayload = {
      model: "gpt-4o-mini",
      input: [
        {
          type: "function_call_output",
          call_id: "call_9",
          output: [
            { type: "input_text", text: "shot" },
            { type: "input_image", image_url: PNG_DATA_URI, detail: "auto" },
          ],
        },
      ],
    }
    const cc = responsesToChatCompletions(payload)
    const toolMessage = cc.messages[0]

    expect(toolMessage.role).toBe("tool")
    const parts = toolMessage.content as Array<ContentPart>
    expect(parts.some((part) => part.type === "image_url")).toBe(true)
  })
})

// ─── Responses input normalization ───

describe("normalizeResponsesAttachments", () => {
  test("wraps raw base64 input_file data into a data URI", async () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.4",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_file", filename: "c.pdf", file_data: PDF_B64 },
          ],
        },
      ],
    }
    await normalizeResponsesAttachments(payload)
    const message = (payload.input as Array<ResponseInputMessage>)[0]
    const filePart = (message.content as Array<ResponseInputFile>)[0]

    expect(filePart.file_data).toBe(PDF_DATA_URI)
  })

  test("passes data URI input_file through unchanged", async () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.4",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "c.pdf",
              file_data: PDF_DATA_URI,
            },
          ],
        },
      ],
    }
    await normalizeResponsesAttachments(payload)
    const message = (payload.input as Array<ResponseInputMessage>)[0]
    const filePart = (message.content as Array<ResponseInputFile>)[0]

    expect(filePart.file_data).toBe(PDF_DATA_URI)
  })

  test("normalizes attachments inside function_call_output arrays", async () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.4",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_file", filename: "d.pdf", file_data: PDF_B64 },
          ],
        },
      ],
    }
    await normalizeResponsesAttachments(payload)
    const item = (payload.input as Array<ResponseFunctionCallOutputItem>)[0]
    const filePart = (item.output as Array<ResponseInputFile>)[0]

    expect(filePart.file_data).toBe(PDF_DATA_URI)
  })

  test("fetches unrestricted native Responses URLs and degrades only failures", async () => {
    const requested: Array<string> = []
    const marker = "native-responses-secret"
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
    const payload: ResponsesPayload = {
      model: "gpt-5.4",
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
    }

    await normalizeResponsesAttachments(payload)

    expect(requested).toEqual([
      "http://USER:PASS@127.0.0.1/ok.png",
      `http://169.254.169.254/a.pdf?secret=${marker}`,
    ])
    expect(JSON.stringify(payload)).toContain("data:image/png;base64,AQID")
    expect(JSON.stringify(payload)).toContain("before")
    expect(JSON.stringify(payload)).toContain("after")
    expect(JSON.stringify(payload)).not.toContain(marker)
  })
})

test("native Chat fetches unrestricted images and emits a URI-free failure note", async () => {
  const requested: Array<string> = []
  const marker = "native-chat-secret"
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
  const payload: ChatCompletionsPayload = {
    model: "gpt-current",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          {
            type: "image_url",
            image_url: { url: "HTTP://USER:PASS@127.1/ok.png" },
          },
          {
            type: "image_url",
            image_url: {
              url: `http://169.254.169.254/fail.png?secret=${marker}`,
            },
          },
          { type: "text", text: "after" },
        ],
      },
    ],
  }

  await normalizeChatAttachments(payload)

  expect(requested).toEqual([
    "http://USER:PASS@127.0.0.1/ok.png",
    `http://169.254.169.254/fail.png?secret=${marker}`,
  ])
  expect(JSON.stringify(payload)).toContain("data:image/png;base64,AQID")
  expect(JSON.stringify(payload)).toContain("before")
  expect(JSON.stringify(payload)).toContain("after")
  expect(JSON.stringify(payload)).not.toContain(marker)
})

// ─── Google AI translation ───

describe("Google inlineData PDF translation", () => {
  test("maps application/pdf inlineData to file parts", () => {
    const openAI = translateGoogleToOpenAI(
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: "read this" },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: PDF_B64,
                },
              },
            ],
          },
        ],
      },
      "claude-sonnet-4.6",
      false,
    )

    const parts = openAI.messages[0].content as Array<ContentPart>
    const filePart = parts.find((part) => part.type === "file") as FilePart
    expect(filePart.file.file_data).toBe(PDF_DATA_URI)
  })

  test("keeps image inlineData as image_url parts", () => {
    const openAI = translateGoogleToOpenAI(
      {
        contents: [
          {
            role: "user",
            parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }],
          },
        ],
      },
      "gpt-4.1",
      false,
    )

    const parts = openAI.messages[0].content as Array<ContentPart>
    expect((parts[0] as ImagePart).image_url.url).toBe(PNG_DATA_URI)
  })
})

// ─── utility round trip ───

describe("toDataUri", () => {
  test("round trips with parseDataUri", () => {
    const uri = toDataUri("application/pdf", PDF_B64)
    expect(parseDataUri(uri)).toEqual({
      mediaType: "application/pdf",
      data: PDF_B64,
    })
  })
})
