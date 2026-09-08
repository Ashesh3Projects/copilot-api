import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicToolResultContentBlock,
} from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { selectEvaluatedCopilotCandidate } from "~/lib/endpoint-routing"
import { asAnthropicUnknownContentType } from "~/routes/messages/anthropic-types"
import { prepareMessagesCandidates } from "~/routes/messages/messages-candidates"
import { prepareAnthropicMessagesRequest } from "~/services/copilot/messages-contract"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
let attachmentFetchCount = 0

const fetchMock = mock((url: string | URL | Request) => {
  attachmentFetchCount += 1
  const value = url instanceof Request ? url.url : String(url)
  const isPdf = value.endsWith(".pdf")
  return new Response(isPdf ? "%PDF-1.4 candidate" : "image", {
    headers: { "content-type": isPdf ? "application/pdf" : "image/png" },
  })
})

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  attachmentFetchCount = 0
  fetchMock.mockClear()
})

const selectedModel: Model = {
  id: "claude-current",
  name: "Claude Current",
  object: "model",
  version: "1",
  supported_endpoints: ["/v1/messages", "/responses", "/chat/completions"],
  capabilities: {
    family: "claude",
    limits: { max_output_tokens: 4096 },
    object: "model_capabilities",
    supports: {},
    tokenizer: "cl100k_base",
    type: "chat",
  },
}

function createSource(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-current",
    max_tokens: 512,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }
}

test("builds detached endpoint-correlated Messages candidates", async () => {
  const source = createSource()
  const snapshot = structuredClone(source)
  const candidates = await prepareMessagesCandidates({
    source,
    selectedModel,
  })

  expect(candidates.ordered.map((candidate) => candidate.endpoint)).toEqual([
    "/v1/messages",
    "/responses",
    "/chat/completions",
  ])
  candidates.native.payload.messages[0].content = "native mutation"
  expect(candidates.responses?.payload.input).not.toEqual(
    candidates.native.payload.messages,
  )
  expect(candidates.chat?.payload.messages[0]?.content).toBe("hello")
  expect(source).toEqual(snapshot)

  const selection = selectEvaluatedCopilotCandidate({
    source: "messages",
    support: {
      chat: true,
      embeddings: false,
      messages: true,
      responses: true,
      responsesWebSocket: false,
    },
    candidates: candidates.ordered,
  })
  expect("candidate" in selection && selection.candidate).toBe(
    candidates.native,
  )
})

test("appends text after existing array tool-result content without losing metadata", async () => {
  const existingContent: Array<AnthropicToolResultContentBlock> = [
    {
      type: "text" as const,
      text: "nested result",
      cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
    },
    {
      type: asAnthropicUnknownContentType("future_result_block"),
      nested: { keep: true },
    },
  ]
  const source = createSource({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_array",
            content: existingContent,
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
          { type: "text", text: "Use this result." },
        ],
      },
    ],
  })
  const snapshot = structuredClone(source)

  const candidates = await prepareMessagesCandidates({
    source,
    selectedModel,
  })

  expect(candidates.native.payload.messages[0].content).toEqual([
    {
      type: "tool_result",
      tool_use_id: "toolu_array",
      content: [...existingContent, { type: "text", text: "Use this result." }],
      cache_control: { type: "ephemeral", ttl: "5m" },
    },
  ])
  expect(source).toEqual(snapshot)
})

test.each(["scalar input", ["array input"]])(
  "keeps a tool call paired across Chat and Responses after coercing input %p",
  async (input) => {
    const rawSource = createSource({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_malformed",
              name: "lookup",
              input,
              future_call_field: { keep: true },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_malformed",
              content: "result",
            },
          ],
        },
      ],
    } as unknown as Partial<AnthropicMessagesPayload>)
    const rawSnapshot = structuredClone(rawSource)
    const prepared = prepareAnthropicMessagesRequest({ payload: rawSource })
    const preparedSnapshot = structuredClone(prepared.body)

    const candidates = await prepareMessagesCandidates({
      source: prepared.body,
      selectedModel: {
        ...selectedModel,
        supported_endpoints: ["/responses", "/chat/completions"],
      },
    })

    expect(candidates.chat?.endpoint).toBe("/chat/completions")
    expect(candidates.responses?.endpoint).toBe("/responses")
    expect(candidates.chat?.payload.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_malformed",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_malformed", content: "result" },
    ])
    expect(candidates.responses?.payload.input).toContainEqual({
      type: "function_call",
      call_id: "toolu_malformed",
      name: "lookup",
      arguments: "{}",
      status: "completed",
    })
    expect(candidates.responses?.payload.input).toContainEqual({
      type: "function_call_output",
      call_id: "toolu_malformed",
      output: "result",
      status: "completed",
    })
    expect(rawSource).toEqual(rawSnapshot)
    expect(prepared.body).toEqual(preparedSnapshot)
  },
)

test("preserves Messages web-search max uses out of band for translated candidates", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    }),
    selectedModel,
  })

  expect(candidates.chat?.webSearchMaxUses).toBe(2)
  expect(candidates.responses?.webSearchMaxUses).toBe(2)
  expect(JSON.stringify(candidates.chat?.payload)).not.toContain("max_uses")
  expect(JSON.stringify(candidates.responses?.payload)).not.toContain(
    "max_uses",
  )
})

test("Chat candidate maps controls without unconditional sampling or parallel defaults", async () => {
  const ordinary = await prepareMessagesCandidates({
    source: createSource({
      stop_sequences: ["STOP"],
      temperature: 0.4,
      top_p: 0.8,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: { effort: "high" },
    }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/chat/completions"],
    },
    effortOverride: "high",
  })

  expect(ordinary.chat?.payload).toMatchObject({
    stop: ["STOP"],
    temperature: 1,
    parallel_tool_calls: false,
    reasoning_effort: "high",
  })
  expect(ordinary.chat?.payload).not.toHaveProperty("top_p")

  const noControls = await prepareMessagesCandidates({
    source: createSource(),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/chat/completions"],
    },
  })
  expect(noControls.chat?.payload).not.toHaveProperty("temperature")
  expect(noControls.chat?.payload).not.toHaveProperty("parallel_tool_calls")
})

test("Responses candidate omits stops and adapts controls with bounded findings", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({
      stop_sequences: ["PRIVATE_STOP"],
      temperature: 0.3,
      top_p: 0.7,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", name: "answer" },
        task_budget: { type: "tokens", total: 100 },
      },
    }),
    selectedModel: { ...selectedModel, supported_endpoints: ["/responses"] },
    effortOverride: "medium",
  })

  expect(candidates.responses?.payload).toMatchObject({
    temperature: 1,
    parallel_tool_calls: false,
    reasoning: { effort: "medium" },
    text: { format: { type: "json_schema", name: "answer" } },
    task_budget: { type: "tokens", total: 100 },
    store: false,
  })
  expect(candidates.responses?.payload).not.toHaveProperty("top_p")
  expect(candidates.responses?.payload).not.toHaveProperty("stop_sequences")
  expect(candidates.responses?.check.findings).toContainEqual({
    class: "sampling",
    severity: "omitted",
  })
  expect(JSON.stringify(candidates.responses?.check.findings)).not.toContain(
    "PRIVATE_STOP",
  )
})

test("ordinary translated candidates do not invent sampling or parallel defaults", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({ temperature: 0.2, top_p: 0.9 }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(candidates.chat?.payload).toMatchObject({
    temperature: 0.2,
  })
  expect(candidates.chat?.payload).not.toHaveProperty("top_p")
  expect(candidates.chat?.payload).not.toHaveProperty("parallel_tool_calls")
  expect(candidates.responses?.payload).toMatchObject({
    temperature: 0.2,
    top_p: 0.9,
  })
  expect(candidates.responses?.payload).not.toHaveProperty(
    "parallel_tool_calls",
  )
})

test("does no attachment work for unadvertised translated candidates", async () => {
  await prepareMessagesCandidates({
    source: createSource({
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
    }),
    selectedModel: { ...selectedModel, supported_endpoints: ["/v1/messages"] },
  })

  expect(attachmentFetchCount).toBe(1)
})

test("shares one URL fetch while keeping Chat and Responses attachment semantics independent", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "keep sibling" },
            {
              type: "document",
              source: {
                type: "url",
                url: "https://attachment.test/report.pdf",
              },
              title: "report.pdf",
            },
          ],
        },
      ],
    }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(attachmentFetchCount).toBe(1)
  expect(JSON.stringify(candidates.responses?.payload)).toContain("input_file")
  expect(JSON.stringify(candidates.responses?.payload)).toContain(
    "keep sibling",
  )
  expect(JSON.stringify(candidates.chat?.payload)).not.toContain(
    '"type":"file"',
  )
  expect(JSON.stringify(candidates.chat?.payload)).toContain("keep sibling")
  expect(candidates.chat?.check.findings).toContainEqual({
    class: "attachment",
    severity: "omitted",
  })
})

test("degrades unsupported tools per target with bounded private findings", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({
      tools: [
        {
          name: "lookup_private",
          input_schema: { type: "object", properties: {} },
        },
        {
          type: "web_fetch_20250910",
          name: "PRIVATE_WEB_FETCH",
          allowed_domains: ["private.example"],
        },
      ],
    }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(candidates.chat?.check.findings).toContainEqual({
    class: "tool_shape",
    severity: "omitted",
  })
  expect(candidates.responses?.check.findings).toContainEqual({
    class: "tool_shape",
    severity: "omitted",
  })
  expect(JSON.stringify(candidates.chat?.check.findings)).not.toContain(
    "PRIVATE_WEB_FETCH",
  )
  expect(JSON.stringify(candidates.responses?.payload)).toContain(
    "lookup_private",
  )
})

test("treats schema-less named tools as translated candidates", async () => {
  const candidates = await prepareMessagesCandidates({
    source: createSource({
      tools: [{ name: "lookup", description: "Look something up" }],
      tool_choice: { type: "tool", name: "lookup" },
    }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(candidates.chat?.check.findings).not.toContainEqual({
    class: "tool_shape",
    severity: "omitted",
  })
  expect(candidates.responses?.check.findings).not.toContainEqual({
    class: "tool_shape",
    severity: "omitted",
  })
  expect(candidates.chat?.payload).toHaveProperty(
    "tools.0.function.parameters",
    { type: "object", properties: {} },
  )
  expect(candidates.chat?.payload).toHaveProperty("tool_choice", {
    type: "function",
    function: { name: "lookup" },
  })
  expect(candidates.responses?.payload).toHaveProperty("tools.0.parameters", {
    type: "object",
    properties: {},
  })
  expect(candidates.responses?.payload).toHaveProperty("tool_choice", {
    type: "function",
    name: "lookup",
  })
})

test("keys attachment cache by URL and expected PDF mode", async () => {
  const sharedUrl = "https://attachment.test/shared"
  await prepareMessagesCandidates({
    source: createSource({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: sharedUrl } },
            {
              type: "document",
              source: { type: "url", url: sharedUrl },
              title: "shared.pdf",
            },
          ],
        },
      ],
    }),
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(attachmentFetchCount).toBe(2)
})

test("propagates the caller abort reason from attachment adaptation", async () => {
  const controller = new AbortController()
  const reason = new Error("PRIVATE_ABORT_REASON")
  controller.abort(reason)

  const error = await prepareMessagesCandidates({
    source: createSource({
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
    }),
    selectedModel: { ...selectedModel, supported_endpoints: ["/responses"] },
    signal: controller.signal,
  }).catch((caught: unknown) => caught)

  expect(error).toBe(reason)
  expect(attachmentFetchCount).toBe(0)
})

test("associates duplicate and missing tool IDs without collisions", async () => {
  const source = createSource({
    system: "system prefix",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "dup", name: "first", input: {} },
          { type: "text", text: "between" },
          { type: "tool_use", id: "dup", name: "second", input: {} },
          { type: "tool_use", id: "", name: "third", input: {} },
          {
            type: "tool_use",
            id: "messages_call_0_2",
            name: "reserved",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "dup", content: "one" },
          { type: "text", text: "interleaved" },
          { type: "tool_result", tool_use_id: "dup", content: "two" },
          { type: "tool_result", tool_use_id: "", content: "three" },
          { type: "tool_result", tool_use_id: "dup", content: "orphan" },
        ],
      },
    ],
  })
  const snapshot = structuredClone(source)
  const candidates = await prepareMessagesCandidates({
    source,
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  const chat = JSON.stringify(candidates.chat?.payload)
  const responses = JSON.stringify(candidates.responses?.payload)
  expect(chat).toContain('"id":"dup"')
  expect(chat).toContain('"id":"messages_call_0_2_1"')
  expect(chat).toContain('"id":"messages_call_0_3"')
  expect(chat).toContain('"tool_call_id":"messages_call_0_2_1"')
  expect(responses).toContain('"call_id":"messages_call_0_2_1"')
  expect(chat).not.toContain('"tool_call_id":"dup","content":"orphan"')
  expect(responses).not.toContain('"call_id":"dup","output":"orphan"')
  expect(chat).toContain(String.raw`[Orphaned tool result]\norphan`)
  expect(responses).toContain(String.raw`[Orphaned tool result]\norphan`)
  expect(candidates.chat?.check.findings).toContainEqual({
    class: "tool_history",
    severity: "adapted",
  })
  expect(candidates.responses?.check.findings).toContainEqual({
    class: "tool_history",
    severity: "adapted",
  })
  expect(source).toEqual(snapshot)
})

test("falls back safely for cyclic orphaned tool-result content", async () => {
  const cyclicContent: Array<unknown> = []
  cyclicContent.push(cyclicContent)
  const source = createSource({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "missing",
            content:
              cyclicContent as unknown as Array<AnthropicToolResultContentBlock>,
          },
        ],
      },
    ],
  })

  const candidates = await prepareMessagesCandidates({
    source,
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  const chat = JSON.stringify(candidates.chat?.payload)
  const responses = JSON.stringify(candidates.responses?.payload)
  expect(chat).toContain(String.raw`[Orphaned tool result]\n`)
  expect(responses).toContain(String.raw`[Orphaned tool result]\n`)
  expect(chat).toContain("[Unserializable content]")
  expect(responses).toContain("[Unserializable content]")
  expect(chat).not.toContain('"tool_call_id":"missing"')
  expect(responses).not.toContain('"call_id":"missing"')
})

test("preserves marker content across Chat and Responses candidates", async () => {
  const marker =
    "<system-reminder>\nThe task tools haven't been used recently. Keep this quoted text."
  const source = createSource({
    messages: [
      { role: "user", content: marker },
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
            tool_use_id: "search-call",
            content:
              "IMPORTANT: This message and these instructions are NOT part of the actual user conversation.",
          },
        ],
      },
    ],
  })
  const snapshot = structuredClone(source)

  const candidates = await prepareMessagesCandidates({
    source,
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(candidates.chat?.payload.messages).toContainEqual({
    role: "user",
    content: marker,
  })
  expect(JSON.stringify(candidates.chat?.payload)).toContain("search-call")
  expect(JSON.stringify(candidates.responses?.payload.input)).toContain(
    JSON.stringify(marker).slice(1, -1),
  )
  expect(JSON.stringify(candidates.responses?.payload)).toContain("search-call")
  expect(source).toEqual(snapshot)
})

test("textualizes malformed thinking in translated candidates", async () => {
  const source = createSource({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: { future: "opaque-thought" },
            signature: 17,
          },
        ],
      },
    ],
  } as unknown as Partial<AnthropicMessagesPayload>)
  const snapshot = structuredClone(source)

  const candidates = await prepareMessagesCandidates({
    source,
    selectedModel: {
      ...selectedModel,
      supported_endpoints: ["/responses", "/chat/completions"],
    },
  })

  expect(JSON.stringify(candidates.chat?.payload)).toContain("opaque-thought")
  expect(JSON.stringify(candidates.responses?.payload)).toContain(
    "opaque-thought",
  )
  expect(source).toEqual(snapshot)
})

test.each([
  {
    name: "signed and signed",
    thinking: [
      { type: "thinking", thinking: "first", signature: "sig-first" },
      { type: "thinking", thinking: "second", signature: "sig-second" },
    ],
    representativeSignature: "sig-first",
  },
  {
    name: "signed and unsigned",
    thinking: [
      { type: "thinking", thinking: "signed", signature: "sig-only" },
      { type: "thinking", thinking: "unsigned" },
    ],
    representativeSignature: "sig-only",
  },
])(
  "preserves $name thinking context only in the lossy Chat candidate",
  async ({ representativeSignature, thinking }) => {
    const source = createSource({
      messages: [
        {
          role: "assistant",
          content: structuredClone(
            thinking,
          ) as unknown as Array<AnthropicAssistantContentBlock>,
        },
      ],
    })
    const snapshot = structuredClone(source)

    const candidates = await prepareMessagesCandidates({
      source,
      selectedModel: {
        ...selectedModel,
        supported_endpoints: [
          "/v1/messages",
          "/responses",
          "/chat/completions",
        ],
      },
    })

    expect(candidates.native.endpoint).toBe("/v1/messages")
    expect(candidates.responses?.endpoint).toBe("/responses")
    expect(candidates.chat?.endpoint).toBe("/chat/completions")
    expect(candidates.native.payload.messages).toEqual(source.messages)
    const responsesPayload = JSON.stringify(candidates.responses?.payload)
    for (const block of thinking) {
      expect(responsesPayload).toContain(block.thinking)
    }
    const chatMessage = candidates.chat?.payload.messages[0]
    expect(chatMessage?.reasoning_text).toBe(thinking[0].thinking)
    expect(chatMessage?.reasoning_opaque).toBe(representativeSignature)
    const chatContent =
      typeof chatMessage?.content === "string" ? chatMessage.content : ""
    for (const block of thinking) {
      expect(chatContent).toContain(block.thinking)
      if ("signature" in block) {
        expect(chatContent).toContain(block.signature)
      }
    }
    expect(candidates.chat?.check.findings).toContainEqual({
      class: "reasoning_state",
      severity: "adapted",
    })
    expect(candidates.responses?.check.findings).not.toContainEqual({
      class: "reasoning_state",
      severity: "adapted",
    })
    expect(source).toEqual(snapshot)
  },
)
