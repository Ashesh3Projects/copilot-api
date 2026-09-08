import "./data-dir"

import { describe, test, expect, beforeAll } from "bun:test"

import {
  useIntegrationFixture,
  initializeTestState,
  request,
  postJSON,
  TEST_TIMEOUT,
} from "./setup"

useIntegrationFixture()

beforeAll(async () => {
  await initializeTestState()
}, TEST_TIMEOUT)

describe("Error handling and edge cases", () => {
  test(
    "GET / returns server running message",
    async () => {
      const res = await request("/")
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain("Server running")
    },
    TEST_TIMEOUT,
  )

  test(
    "chat completions with nonexistent model returns error",
    async () => {
      const res = await postJSON("/v1/chat/completions", {
        model: "this-model-definitely-does-not-exist-12345",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 5,
        stream: false,
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    },
    TEST_TIMEOUT,
  )

  test(
    "messages with nonexistent model returns error",
    async () => {
      const res = await postJSON("/v1/messages", {
        model: "this-model-definitely-does-not-exist-12345",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 5,
        stream: false,
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    },
    TEST_TIMEOUT,
  )

  test(
    "embeddings with nonexistent model returns error",
    async () => {
      const res = await postJSON("/v1/embeddings", {
        model: "this-embedding-model-does-not-exist-12345",
        input: ["Hello"],
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    },
    TEST_TIMEOUT,
  )

  test(
    "unknown route returns 404",
    async () => {
      const res = await request("/v1/nonexistent-endpoint")
      expect(res.status).toBe(404)
    },
    TEST_TIMEOUT,
  )
})
