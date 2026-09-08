import "./data-dir"

import { describe, test, expect, beforeAll } from "bun:test"

import type { EmbeddingResponse } from "~/services/copilot/create-embeddings"

import {
  useIntegrationFixture,
  initializeTestState,
  postJSON,
  TEST_TIMEOUT,
} from "./setup"

useIntegrationFixture()

beforeAll(async () => {
  await initializeTestState()
}, TEST_TIMEOUT)

describe("POST /v1/embeddings", () => {
  test(
    "single text embedding",
    async () => {
      const res = await postJSON("/v1/embeddings", {
        model: "text-embedding-3-small",
        input: ["Hello, world!"],
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as EmbeddingResponse
      expect(body.data).toHaveLength(1)
      expect(body.data[0].object).toBe("embedding")
      expect(Array.isArray(body.data[0].embedding)).toBe(true)
      expect(body.data[0].embedding.length).toBeGreaterThan(0)
      expect(body.data[0].index).toBe(0)
      expect(body.usage).toBeDefined()
      expect(body.usage.prompt_tokens).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )

  test(
    "multiple text embeddings",
    async () => {
      const res = await postJSON("/v1/embeddings", {
        model: "text-embedding-3-small",
        input: ["Hello", "World"],
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as EmbeddingResponse
      expect(body.data).toHaveLength(2)
      expect(body.data[0].index).toBe(0)
      expect(body.data[1].index).toBe(1)
    },
    TEST_TIMEOUT,
  )

  test(
    "non-prefixed /embeddings also works",
    async () => {
      const res = await postJSON("/embeddings", {
        model: "text-embedding-3-small",
        input: ["Test"],
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as EmbeddingResponse
      expect(body.data).toHaveLength(1)
    },
    TEST_TIMEOUT,
  )

  test(
    "invalid model returns error",
    async () => {
      const res = await postJSON("/v1/embeddings", {
        model: "nonexistent-embedding-model",
        input: ["Hello"],
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    },
    TEST_TIMEOUT,
  )
})
