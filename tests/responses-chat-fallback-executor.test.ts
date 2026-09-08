import { expect, test } from "bun:test"
import { Hono } from "hono"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { LocalHTTPError } from "~/lib/error"
import { resolvePreparedResponsesWebSearchCalls } from "~/routes/responses/chat-fallback-completion"
import { handleWithChatCompletions } from "~/routes/responses/handler"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

function completion(callId?: string): ChatCompletionResponse {
  return completionWithCalls(callId ? [callId] : [])
}

function completionWithCalls(callIds: Array<string>): ChatCompletionResponse {
  return {
    id: "chat",
    object: "chat.completion",
    created: 1,
    model: "model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: callIds.length > 0 ? null : "done",
          ...(callIds.length > 0 ?
            {
              tool_calls: callIds.map((id) => ({
                id,
                type: "function",
                function: { name: "web_search", arguments: '{"query":"q"}' },
              })),
            }
          : {}),
        },
        finish_reason: callIds.length > 0 ? "tool_calls" : "stop",
        logprobs: null,
      },
    ],
  }
}

test("continues web search from every factory processed payload", async () => {
  const seen: Array<ChatCompletionsPayload> = []
  const retryFlags: Array<boolean | undefined> = []
  const processedMarkers = ["processed-one", "processed-two"]
  let call = 0
  const initialPayload: ChatCompletionsPayload = {
    model: "model",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  }
  const factory = (
    payload: ChatCompletionsPayload,
    options: { allowCompatibilityRetry?: boolean },
  ) => {
    seen.push(structuredClone(payload))
    retryFlags.push(options.allowCompatibilityRetry)
    const marker = processedMarkers[call]
    const processedPayload = {
      ...payload,
      messages: [
        ...payload.messages,
        { role: "system" as const, content: marker },
      ],
    }
    call += 1
    return Promise.resolve({
      processedPayload,
      response: call === 1 ? completion("call-two") : completion(),
    })
  }

  const result = await resolvePreparedResponsesWebSearchCalls({
    initial: {
      processedPayload: initialPayload,
      response: completion("call-one"),
    },
    completionFactory: factory,
    webSearch: () => Promise.resolve("result"),
  })

  expect(result.choices[0]?.message.content).toBe("done")
  expect(seen).toHaveLength(2)
  expect(retryFlags).toEqual([false, false])
  expect(JSON.stringify(seen[1])).toContain("processed-one")
})

test("uses the injected factory and search executor through multiple continuations", async () => {
  const seen: Array<ChatCompletionsPayload> = []
  const searched: Array<string> = []
  const initialPayload: ChatCompletionsPayload = {
    model: "model",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  }
  let call = 0
  const result = await resolvePreparedResponsesWebSearchCalls({
    initial: {
      processedPayload: initialPayload,
      response: completion("call-one"),
    },
    completionFactory: (payload) => {
      seen.push(structuredClone(payload))
      call += 1
      return Promise.resolve({
        processedPayload: structuredClone(payload),
        response: call === 1 ? completion("call-two") : completion(),
      })
    },
    webSearch: (query) => {
      searched.push(query)
      return Promise.resolve(`result-${searched.length}`)
    },
  })

  expect(result.choices[0]?.message.content).toBe("done")
  expect(seen).toHaveLength(2)
  expect(searched).toHaveLength(2)
  expect(JSON.stringify(seen[1])).toContain("result-1")
})

test("keeps a lower source max-use boundary ahead of search execution", async () => {
  let searches = 0
  let completions = 0
  let caught: unknown
  try {
    await resolvePreparedResponsesWebSearchCalls({
      initial: {
        processedPayload: {
          model: "model",
          messages: [{ role: "user", content: "hello" }],
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
        response: completionWithCalls(["call-one", "call-two"]),
      },
      maxUses: 1,
      completionFactory: (payload) => {
        completions += 1
        return Promise.resolve({
          processedPayload: payload,
          response: completion(),
        })
      },
      webSearch: () => {
        searches += 1
        return Promise.resolve("result")
      },
    })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(LocalHTTPError)
  expect(searches).toBe(0)
  expect(completions).toBe(0)
})

test("rejects a web-search batch before executing beyond a lower source use bound", async () => {
  const payload = {
    model: "model",
    messages: [{ role: "user" as const, content: "hello" }],
    tools: [
      {
        type: "function" as const,
        function: {
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  }
  let searches = 0
  let completions = 0
  let caught: unknown
  try {
    await resolvePreparedResponsesWebSearchCalls({
      initial: {
        processedPayload: payload,
        response: completion("call-one"),
      },
      maxUses: 1,
      completionFactory: (nextPayload) => {
        completions += 1
        return Promise.resolve({
          processedPayload: nextPayload,
          response: completion("call-two"),
        })
      },
      webSearch: () => {
        searches += 1
        return Promise.resolve("result")
      },
    })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(LocalHTTPError)
  expect(searches).toBe(1)
  expect(completions).toBe(1)
  expect((caught as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "web_search_limit_exceeded" },
  })
})

test("allows final synthesis after exactly eight web-search uses", async () => {
  let searches = 0
  let completions = 0
  const result = await resolvePreparedResponsesWebSearchCalls({
    initial: {
      processedPayload: {
        model: "model",
        messages: [{ role: "user", content: "hello" }],
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
      response: completionWithCalls(
        Array.from({ length: 8 }, (_, index) => `call-${index}`),
      ),
    },
    completionFactory: (payload) => {
      completions += 1
      return Promise.resolve({
        processedPayload: payload,
        response: completion(),
      })
    },
    webSearch: () => {
      searches += 1
      return Promise.resolve("result")
    },
  })

  expect(result.choices[0]?.message.content).toBe("done")
  expect(searches).toBe(8)
  expect(completions).toBe(1)
})

test.each([false, true])(
  "uses the injected factory for every web-search continuation with stream=%s",
  async (stream) => {
    const seen: Array<ChatCompletionsPayload> = []
    let call = 0
    const app = new Hono()
    app.post("/", async (c) => {
      return await handleWithChatCompletions(
        c,
        {
          model: "provider-wire-model",
          messages: [{ role: "user", content: "hello" }],
          stream,
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
          requestedModel: "public-model",
          completionFactory: (payload) => {
            seen.push(structuredClone(payload))
            call += 1
            let response = completion()
            if (call === 1) response = completion("call-one")
            else if (call === 2) response = completion("call-two")
            return Promise.resolve({
              processedPayload: structuredClone(payload),
              response,
            })
          },
        },
      )
    })

    const response = await app.request("/", { method: "POST" })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(seen).toHaveLength(3)
    expect(seen[0]?.model).toBe("provider-wire-model")
    expect(JSON.stringify(seen[1])).toContain('"role":"tool"')
    expect(JSON.stringify(seen[2])).toContain('"role":"tool"')
    expect(body).toContain("public-model")
    expect(body).not.toContain("provider-wire-model")
    if (stream) {
      expect(body).toContain("event: response.completed")
    } else {
      expect(JSON.parse(body)).toMatchObject({ model: "public-model" })
    }
  },
)
