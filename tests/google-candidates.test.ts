import { expect, test } from "bun:test"
import { Hono } from "hono"

import type { PreparedChatCompletionsSource } from "~/routes/chat-completions/chat-contract"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesPayload,
  ResponsesResult,
} from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import {
  getModelEndpointSupport,
  selectEvaluatedCopilotCandidate,
} from "~/lib/endpoint-routing"
import {
  orderPreparedChatCandidates,
  prepareChatCandidates,
} from "~/routes/chat-completions/chat-candidates"
import {
  createCopilotGoogleChatCompletion,
  type GoogleChatCompletionFactory,
} from "~/routes/google-ai/chat-completion"
import { prepareGoogleRequest } from "~/routes/google-ai/google-request-normalization"
import { handleWithChatCompletions } from "~/routes/google-ai/handler"
import { handleWithResponsesApi } from "~/routes/google-ai/handler"
import { adaptGoogleToChatCandidate } from "~/routes/google-ai/request-translation"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const model = {
  id: "test-model",
  name: "test-model",
  vendor: "openai",
  version: "1",
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions", "/responses"],
  capabilities: {
    family: "test",
    limits: { max_context_window_tokens: 1000, max_output_tokens: 100 },
    supports: {},
  },
} as Model

test("builds only advertised Chat candidates and preserves source findings once", async () => {
  const google = await adaptGoogleToChatCandidate({
    source: prepareGoogleRequest({
      contents: [{ role: "future", parts: [{ text: "hello" }] }],
    }),
    finalModel: model.id,
    stream: false,
  })
  const candidates = await prepareChatCandidates({
    source: google.payload as unknown as PreparedChatCompletionsSource,
    sourceFindings: google.check.findings,
    selectedModel: model,
    nativeMessagesOptions: {},
    support: getModelEndpointSupport(model),
  })
  expect(candidates.chat?.endpoint).toBe("/chat/completions")
  expect(candidates.responses?.endpoint).toBe("/responses")
  expect(candidates.messages).toBeUndefined()
  expect(candidates.chat?.check.findings).toContainEqual({
    class: "message_role",
    severity: "adapted",
  })
  expect(
    candidates.chat?.check.findings.filter(
      (finding) => finding.class === "message_role",
    ),
  ).toHaveLength(1)
})

test("reuses shared candidate ordering and selector returns exact candidate", async () => {
  const google = await adaptGoogleToChatCandidate({
    source: prepareGoogleRequest({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }),
    finalModel: model.id,
    stream: false,
  })
  const candidates = await prepareChatCandidates({
    source: google.payload as unknown as PreparedChatCompletionsSource,
    sourceFindings: google.check.findings,
    selectedModel: model,
    nativeMessagesOptions: {},
    support: { ...getModelEndpointSupport(model), chat: false },
  })
  const ordered = orderPreparedChatCandidates({
    candidates,
    selectedModel: model,
    source: google.payload as unknown as PreparedChatCompletionsSource,
  })
  const selected = selectEvaluatedCopilotCandidate({
    source: "chat",
    support: { ...getModelEndpointSupport(model), chat: false },
    candidates: ordered,
  })
  expect("candidate" in selected).toBe(true)
  if ("candidate" in selected) {
    const responses = candidates.responses
    if (!responses) throw new Error("Expected Responses candidate")
    expect(selected.candidate).toBe(responses)
    expect(selected.candidate.payload).toBe(responses.payload)
  }
})

test("exports a narrow provider completion factory contract", async () => {
  const calls: Array<unknown> = []
  const factory: GoogleChatCompletionFactory = (payload, options) => {
    calls.push({ payload, signal: options.signal })
    return Promise.resolve({
      processedPayload: structuredClone(payload),
      response: {
        id: "id",
        object: "chat.completion",
        created: 1,
        model: "upstream",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
      },
    })
  }
  const payload = {
    model: "public",
    messages: [{ role: "user" as const, content: "hello" }],
  }
  const result = await factory(payload, {})
  expect(calls).toEqual([{ payload, signal: undefined }])
  expect(result.processedPayload).not.toBe(payload)
  expect(typeof createCopilotGoogleChatCompletion).toBe("function")
})

test("uses one injected handler factory and advances from processed payload through bounded search", async () => {
  const payloads: Array<ChatCompletionsPayload> = []
  const responses = [
    chatResult("web_search", "call-1"),
    chatResult("web_search", "call-2"),
    chatResult(undefined, undefined, "finished"),
  ]
  const factory: GoogleChatCompletionFactory = (payload) => {
    payloads.push(structuredClone(payload))
    const response = responses.shift()
    if (!response) throw new Error("Unexpected completion")
    return Promise.resolve({
      processedPayload: {
        ...structuredClone(payload),
        messages: [
          ...payload.messages,
          { role: "system", content: `processed-${payloads.length}` },
        ],
      },
      response,
    })
  }
  const app = new Hono()
  app.get("/", async (c) => {
    try {
      return await handleWithChatCompletions(
        c,
        {
          model: "public",
          messages: [{ role: "user", content: "search" }],
          tools: [
            {
              type: "function",
              function: {
                name: "web_search",
                parameters: { type: "object", properties: {} },
                max_uses: 2,
              } as never,
            },
          ],
        },
        {
          outputMode: "json",
          requestedModel: "public",
          completionFactory: factory,
          webSearch: (query) => Promise.resolve(`result:${query}`),
        },
      )
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "response" in error
        && error.response instanceof Response
      ) {
        return error.response
      }
      throw error
    }
  })
  const response = await app.request("/")
  expect(response.status).toBe(200)
  expect(payloads).toHaveLength(3)
  expect(JSON.stringify(payloads[1]?.messages)).toContain("processed-1")
  expect(JSON.stringify(payloads[2]?.messages)).toContain("processed-2")
  expect((await response.json()) as object).toMatchObject({
    modelVersion: "public",
  })
})

test("marks every Google Chat web-search continuation as post-output", async () => {
  const retryFlags: Array<boolean | undefined> = []
  const responses = [
    chatResult("web_search", "call-1"),
    chatResult(undefined, undefined, "finished"),
  ]
  const app = new Hono()
  app.get(
    "/",
    async (c) =>
      await handleWithChatCompletions(
        c,
        {
          model: "public",
          messages: [{ role: "user", content: "search" }],
          tools: [
            {
              type: "function",
              function: {
                name: "web_search",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        },
        {
          outputMode: "json",
          requestedModel: "public",
          completionFactory: (payload, options) => {
            retryFlags.push(options.allowCompatibilityRetry)
            const response = responses.shift()
            if (!response) throw new Error("Unexpected completion")
            return Promise.resolve({
              processedPayload: structuredClone(payload),
              response,
            })
          },
          webSearch: () => Promise.resolve("result"),
        },
      ),
  )

  expect((await app.request("/")).status).toBe(200)
  expect(retryFlags).toEqual([undefined, false])
})

test("uses a separate post-output Google Responses continuation factory", async () => {
  const sends: Array<ResponsesPayload> = []
  const retryFlags: Array<boolean | undefined> = []
  const queue = [responsesSearchResult(["call-1"]), responsesSearchResult([])]
  const app = new Hono()
  app.get(
    "/",
    async (c) =>
      await handleWithResponsesApi(
        c,
        {
          model: "public",
          input: [{ type: "message", role: "user", content: "search" }],
          stream: false,
          tools: [
            {
              type: "function",
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: false,
            },
          ],
        },
        {
          isStream: false,
          outputMode: "json",
          requestedModel: "public",
          createResponse: (payload, options) => {
            sends.push(structuredClone(payload))
            retryFlags.push(options.allowCompatibilityRetry)
            const result = queue.shift()
            if (!result) throw new Error("Unexpected Responses send")
            return Promise.resolve(result)
          },
          webSearch: () => Promise.resolve("result"),
        },
      ),
  )

  expect((await app.request("/")).status).toBe(200)
  expect(sends).toHaveLength(2)
  expect(retryFlags).toEqual([undefined, false])
})

test("rejects an over-limit search batch before executing any search", async () => {
  let searches = 0
  const app = new Hono()
  app.get("/", async (c) => {
    try {
      return await handleWithChatCompletions(
        c,
        {
          model: "public",
          messages: [{ role: "user", content: "search" }],
          tools: [
            {
              type: "function",
              function: {
                name: "web_search",
                parameters: { type: "object", properties: {} },
                max_uses: 1,
              } as never,
            },
          ],
        },
        {
          outputMode: "json",
          requestedModel: "public",
          completionFactory: () =>
            Promise.resolve({
              processedPayload: {
                model: "public",
                messages: [{ role: "user", content: "search" }],
              },
              response: {
                ...chatResult("web_search", "call-1"),
                choices: [
                  {
                    ...chatResult("web_search", "call-1").choices[0],
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call-1",
                          type: "function",
                          function: { name: "web_search", arguments: "{}" },
                        },
                        {
                          id: "call-2",
                          type: "function",
                          function: { name: "web_search", arguments: "{}" },
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          webSearch: () => {
            searches += 1
            return Promise.resolve("result")
          },
        },
      )
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "response" in error
        && error.response instanceof Response
      ) {
        return error.response
      }
      throw error
    }
  })
  const response = await app.request("/")
  expect(response.status).toBe(400)
  expect(searches).toBe(0)
})

test("preserves the Responses search lower bound through final synthesis", async () => {
  const sent: Array<ResponsesPayload> = []
  const queue: Array<ResponsesResult> = [
    responsesSearchResult(["call-1"]),
    responsesSearchResult([]),
  ]
  const app = new Hono()
  app.get(
    "/",
    async (c) =>
      await handleWithResponsesApi(
        c,
        {
          model: "public",
          input: [{ type: "message", role: "user", content: "search" }],
          stream: false,
          tools: [
            {
              type: "function",
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: false,
            },
          ],
        },
        {
          isStream: false,
          outputMode: "json",
          requestedModel: "public",
          webSearchMaxUses: 1,
          createResponse: (payload) => {
            sent.push(structuredClone(payload))
            const result = queue.shift()
            if (!result) throw new Error("Unexpected Responses send")
            return Promise.resolve(result)
          },
          webSearch: () => Promise.resolve("search-result"),
        },
      ),
  )
  const response = await app.request("/")
  expect(response.status).toBe(200)
  expect(sent).toHaveLength(2)
  expect(JSON.stringify(sent[1]?.input)).toContain("search-result")
})

test("rejects a Responses search batch above the lower bound atomically", async () => {
  let searches = 0
  const app = new Hono()
  app.get("/", async (c) => {
    try {
      return await handleWithResponsesApi(
        c,
        {
          model: "public",
          input: [{ type: "message", role: "user", content: "search" }],
          stream: false,
          tools: [
            {
              type: "function",
              name: "web_search",
              parameters: { type: "object", properties: {} },
              strict: false,
            },
          ],
        },
        {
          isStream: false,
          outputMode: "json",
          requestedModel: "public",
          webSearchMaxUses: 1,
          createResponse: () =>
            Promise.resolve(responsesSearchResult(["call-1", "call-2"])),
          webSearch: () => {
            searches += 1
            return Promise.resolve("result")
          },
        },
      )
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "response" in error
        && error.response instanceof Response
      ) {
        return error.response
      }
      throw error
    }
  })
  const response = await app.request("/")
  expect(response.status).toBe(400)
  expect(searches).toBe(0)
})

function chatResult(
  toolName?: string,
  callId?: string,
  content: string | null = null,
): ChatCompletionResponse {
  return {
    id: "id",
    object: "chat.completion",
    created: 1,
    model: "upstream-private",
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: toolName ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content,
          ...(toolName && callId ?
            {
              tool_calls: [
                {
                  id: callId,
                  type: "function",
                  function: { name: toolName, arguments: '{"query":"q"}' },
                },
              ],
            }
          : {}),
        },
      },
    ],
  }
}

function responsesSearchResult(callIds: Array<string>): ResponsesResult {
  return {
    id: "resp",
    object: "response",
    created_at: 1,
    model: "upstream",
    status: "completed",
    output: callIds.map((callId) => ({
      type: "function_call" as const,
      id: callId,
      call_id: callId,
      name: "web_search",
      arguments: '{"query":"q"}',
      status: "completed" as const,
    })),
    output_text: "finished",
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
}
