import "./data-dir"

import { describe, test, expect, beforeAll } from "bun:test"

import { state } from "~/lib/state"

import {
  useIntegrationFixture,
  initializeTestState,
  postJSON,
  collectSSEEvents,
  TEST_TIMEOUT,
} from "./setup"

useIntegrationFixture()

beforeAll(async () => {
  await initializeTestState()
}, TEST_TIMEOUT)

interface ResponsesOutputItem {
  type: string
  content?: Array<{ type: string; text: string }>
}

interface ResponsesResult {
  id: string
  status: string
  output: Array<ResponsesOutputItem>
  output_text: string
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  } | null
}

describe("POST /v1/responses - basic", () => {
  test(
    "simple text response (non-streaming)",
    async () => {
      const res = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        input: "Say hello in one word.",
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      expect(body.id).toBeDefined()
      expect(body.status).toBe("completed")
      expect(body.output).toBeDefined()
      expect(body.output.length).toBeGreaterThan(0)
      expect(body.output_text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "streaming response",
    async () => {
      const res = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        input: "Say hello in one word.",
        stream: true,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const events = await collectSSEEvents(res)
      expect(events.length).toBeGreaterThan(0)
      const eventTypes = new Set(events.map((e) => e.event))
      const hasCompletionEvent =
        eventTypes.has("response.completed")
        || eventTypes.has("response.output_text.done")
      expect(hasCompletionEvent).toBe(true)
    },
    TEST_TIMEOUT,
  )

  test(
    "with instructions",
    async () => {
      const res = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        instructions: "Always respond in exactly one word.",
        input: "Say hello.",
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      expect(body.output_text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )
})

describe("POST /v1/responses - advanced", () => {
  test(
    "tool use",
    async () => {
      const res = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        input: [
          {
            type: "message",
            role: "user",
            content: "What is the weather in Madrid?",
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get the current weather in a location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name" },
              },
              required: ["location"],
            },
            strict: false,
          },
        ],
        tool_choice: "auto",
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      expect(body.output).toBeDefined()
      expect(body.output.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )

  test(
    "multi-turn with input array",
    async () => {
      const res = await postJSON("/v1/responses", {
        model: "gpt-4o-mini",
        input: [
          { type: "message", role: "user", content: "My name is Diana." },
          {
            type: "message",
            role: "assistant",
            content: "Nice to meet you, Diana!",
          },
          { type: "message", role: "user", content: "What is my name?" },
        ],
        stream: false,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      expect(body.output_text.toLowerCase()).toContain("diana")
    },
    TEST_TIMEOUT,
  )

  test(
    "non-prefixed /responses also works",
    async () => {
      const res = await postJSON("/responses", {
        model: "gpt-4o-mini",
        input: "Hi",
        stream: false,
      })
      expect(res.status).toBe(200)
    },
    TEST_TIMEOUT,
  )

  test(
    "uses a live Messages-only model through the Responses bridge when advertised",
    async () => {
      const model = state.models?.data.find((entry) => {
        const endpoints = entry.supported_endpoints
        return (
          Array.isArray(endpoints)
          && endpoints.includes("/v1/messages")
          && !endpoints.includes("/responses")
          && !endpoints.includes("/chat/completions")
        )
      })
      if (!model) {
        console.log(
          "Skipping live Responses-to-Messages probe — no Messages-only model",
        )
        return
      }

      const res = await postJSON("/v1/responses", {
        model: model.id,
        input: "Say hello in one word.",
        max_output_tokens: 32,
        stream: false,
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as ResponsesResult
      expect(body.status).toBe("completed")
      expect(body.output_text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )
})
