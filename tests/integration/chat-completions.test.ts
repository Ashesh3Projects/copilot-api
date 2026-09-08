import "./data-dir"

import { describe, test, expect, beforeAll } from "bun:test"

import {
  useIntegrationFixture,
  initializeTestState,
  postJSON,
  collectSSEEvents,
  TEST_TIMEOUT,
} from "./setup"

interface ChatCompletionMessage {
  role: string
  content: string | null
  tool_calls?: Array<{
    id: string
    type: string
    function: {
      name: string
      arguments: string
    }
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
  choices?: Array<{ delta: Record<string, unknown> }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

useIntegrationFixture()

beforeAll(async () => {
  await initializeTestState()
}, TEST_TIMEOUT)

describe("POST /v1/chat/completions - basic", () => {
  test(
    "simple text completion (non-streaming)",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello in one word." }],
        max_tokens: 10,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      expect(body.id).toBeDefined()
      expect(body.model).toBeDefined()
      expect(body.choices).toHaveLength(1)
      expect(body.choices[0].message.role).toBe("assistant")
      expect(body.choices[0].message.content).toBeTruthy()
      expect(body.choices[0].finish_reason).toBeDefined()
    },
    TEST_TIMEOUT,
  )

  test(
    "simple text completion (streaming)",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello in one word." }],
        max_tokens: 10,
        stream: true,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const events = await collectSSEEvents(res)
      expect(events.length).toBeGreaterThan(0)
      const dataEvents = events.filter((e) => e.data !== "[DONE]")
      expect(dataEvents.length).toBeGreaterThan(0)
      for (const event of dataEvents) {
        const chunk = JSON.parse(event.data) as ChatCompletionChunk
        expect(chunk.choices).toBeDefined()
      }
      const lastEvent = events.at(-1)
      expect(lastEvent).toBeDefined()
      expect(lastEvent?.data).toBe("[DONE]")
    },
    TEST_TIMEOUT,
  )

  test(
    "multi-turn conversation",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "My name is Alice." },
          { role: "assistant", content: "Nice to meet you, Alice!" },
          { role: "user", content: "What is my name?" },
        ],
        max_tokens: 20,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      const content = body.choices[0].message.content
      expect(content).toBeTruthy()
      expect(content?.toLowerCase()).toContain("alice")
    },
    TEST_TIMEOUT,
  )

  test(
    "system message handling",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a pirate. Always respond with 'Arrr!'.",
          },
          { role: "user", content: "Hello!" },
        ],
        max_tokens: 20,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      expect(body.choices[0].message.content).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "empty messages array returns error",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [],
        stream: false,
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    },
    TEST_TIMEOUT,
  )

  test(
    "both token aliases prefer max_completion_tokens",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 10,
        max_completion_tokens: 10,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      expect(body.choices).toHaveLength(1)
    },
    TEST_TIMEOUT,
  )
})

describe("POST /v1/chat/completions - tools", () => {
  test(
    "tool/function calling (non-streaming)",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the current weather in a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string", description: "City name" },
                },
                required: ["location"],
              },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 100,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      const choice = body.choices[0]
      if (choice.finish_reason === "tool_calls") {
        expect(choice.message.tool_calls).toBeDefined()
        expect(choice.message.tool_calls?.length).toBeGreaterThan(0)
        const toolCall = choice.message.tool_calls?.[0]
        expect(toolCall?.function.name).toBe("get_weather")
        expect(toolCall?.id).toBeDefined()
        const args = JSON.parse(toolCall?.function.arguments ?? "{}") as Record<
          string,
          unknown
        >
        expect(args.location).toBeDefined()
      }
    },
    TEST_TIMEOUT,
  )

  test(
    "tool/function calling (streaming)",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What is the weather in Paris?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the current weather in a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string", description: "City name" },
                },
                required: ["location"],
              },
            },
          },
        ],
        tool_choice: "required",
        max_tokens: 100,
        stream: true,
      })
      expect(res.status).toBe(200)
      const events = await collectSSEEvents(res)
      expect(events.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )
})

describe("POST /v1/chat/completions - parameters", () => {
  test(
    "parameter variations (temperature, top_p, max_tokens, stop)",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Count from 1 to 5." }],
        temperature: 0,
        top_p: 0.9,
        max_tokens: 30,
        stop: ["4"],
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      expect(body.choices[0].message.content).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "response_format json_object",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Respond with JSON only." },
          {
            role: "user",
            content:
              'Return a JSON object with a key "greeting" set to "hello".',
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 50,
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ChatCompletionResponse
      const content = body.choices[0].message.content
      expect(content).toBeTruthy()
      const parsed = JSON.parse(content ?? "{}") as Record<string, unknown>
      expect(parsed).toBeDefined()
    },
    TEST_TIMEOUT,
  )

  test(
    "stream_options with include_usage",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
        stream: true,
        stream_options: { include_usage: true },
      })
      expect(res.status).toBe(200)
      const events = await collectSSEEvents(res)
      const dataEvents = events.filter((e) => e.data !== "[DONE]")
      const hasUsage = dataEvents.some((e) => {
        const chunk = JSON.parse(e.data) as ChatCompletionChunk
        return chunk.usage !== undefined
      })
      expect(hasUsage).toBe(true)
    },
    TEST_TIMEOUT,
  )
})
