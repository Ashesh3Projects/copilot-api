import "./data-dir"

import { describe, test, expect, beforeAll } from "bun:test"

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
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
  }
}

describe("Google AI - POST /v1/models/{model}:generateContent", () => {
  test(
    "generateContent (non-streaming)",
    async () => {
      const res = await postJSON("/v1/models/gpt-4o-mini:generateContent", {
        contents: [
          { role: "user", parts: [{ text: "Say hello in one word." }] },
        ],
        generationConfig: { maxOutputTokens: 10 },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as GoogleResponse
      expect(body.candidates).toBeDefined()
      expect(body.candidates.length).toBeGreaterThan(0)
      expect(body.candidates[0].content).toBeDefined()
      expect(body.candidates[0].content.parts).toBeDefined()
      expect(body.candidates[0].content.parts.length).toBeGreaterThan(0)
      expect(body.candidates[0].content.parts[0].text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "streamGenerateContent (streaming)",
    async () => {
      const res = await postJSON(
        "/v1/models/gpt-4o-mini:streamGenerateContent?alt=sse",
        {
          contents: [
            { role: "user", parts: [{ text: "Say hello in one word." }] },
          ],
          generationConfig: { maxOutputTokens: 10 },
        },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const events = await collectSSEEvents(res)
      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        const chunk = JSON.parse(event.data) as GoogleResponse
        expect(chunk.candidates).toBeDefined()
      }
    },
    TEST_TIMEOUT,
  )

  test(
    "multi-turn conversation",
    async () => {
      const res = await postJSON("/v1/models/gpt-4o-mini:generateContent", {
        contents: [
          { role: "user", parts: [{ text: "My name is Charlie." }] },
          {
            role: "model",
            parts: [{ text: "Nice to meet you, Charlie!" }],
          },
          { role: "user", parts: [{ text: "What is my name?" }] },
        ],
        generationConfig: { maxOutputTokens: 20 },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as GoogleResponse
      const text = body.candidates[0].content.parts[0].text?.toLowerCase() ?? ""
      expect(text).toContain("charlie")
    },
    TEST_TIMEOUT,
  )
})

describe("Google AI - system instruction and tools", () => {
  test(
    "system instruction",
    async () => {
      const res = await postJSON("/v1/models/gpt-4o-mini:generateContent", {
        contents: [{ role: "user", parts: [{ text: "Say hello." }] }],
        systemInstruction: {
          parts: [{ text: "Always respond in exactly one word." }],
        },
        generationConfig: { maxOutputTokens: 10 },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as GoogleResponse
      expect(body.candidates[0].content.parts[0].text).toBeTruthy()
    },
    TEST_TIMEOUT,
  )

  test(
    "tool/function calling",
    async () => {
      const res = await postJSON("/v1/models/gpt-4o-mini:generateContent", {
        contents: [
          {
            role: "user",
            parts: [{ text: "What is the weather in Rome?" }],
          },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                description: "Get the current weather",
                parameters: {
                  type: "object",
                  properties: {
                    location: { type: "string" },
                  },
                  required: ["location"],
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 100 },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as GoogleResponse
      expect(body.candidates).toBeDefined()
      const parts = body.candidates[0].content.parts
      expect(parts.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )

  test(
    "non-prefixed /models also works",
    async () => {
      const res = await postJSON("/models/gpt-4o-mini:generateContent", {
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        generationConfig: { maxOutputTokens: 5 },
      })
      expect(res.status).toBe(200)
    },
    TEST_TIMEOUT,
  )
})
