import "./data-dir"

import { describe, test, expect, beforeAll } from "bun:test"

import {
  useIntegrationFixture,
  initializeTestState,
  request,
  TEST_TIMEOUT,
} from "./setup"

interface ModelEntry {
  id: string
  object: string
}

interface ModelsResponse {
  object: string
  data: Array<ModelEntry>
}

useIntegrationFixture()

beforeAll(async () => {
  await initializeTestState()
}, TEST_TIMEOUT)

describe("GET /v1/models", () => {
  test(
    "returns list with correct OpenAI shape",
    async () => {
      const res = await request("/v1/models")
      expect(res.status).toBe(200)
      const body = (await res.json()) as ModelsResponse
      expect(body.object).toBe("list")
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.data.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )

  test(
    "each model has required fields",
    async () => {
      const res = await request("/v1/models")
      const body = (await res.json()) as ModelsResponse
      for (const model of body.data) {
        expect(model.id).toBeDefined()
        expect(typeof model.id).toBe("string")
        expect(model.object).toBe("model")
      }
    },
    TEST_TIMEOUT,
  )

  test(
    "includes virtual reasoning-effort variants",
    async () => {
      const res = await request("/v1/models")
      const body = (await res.json()) as ModelsResponse
      const ids = body.data.map((m) => m.id)
      const hasVariants = ids.some(
        (id) =>
          id.includes(":high") || id.includes(":low") || id.includes(":medium"),
      )
      expect(hasVariants).toBe(true)
    },
    TEST_TIMEOUT,
  )

  test(
    "non-prefixed /models also works",
    async () => {
      const res = await request("/models")
      expect(res.status).toBe(200)
      const body = (await res.json()) as ModelsResponse
      expect(body.object).toBe("list")
      expect(body.data.length).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )

  for (const prefix of ["/v1/models", "/models"]) {
    test(
      `${prefix} serves the normalized list row from single-model discovery`,
      async () => {
        const list = await request(prefix)
        const listBody = (await list.json()) as ModelsResponse
        const expected = listBody.data.at(0)

        expect(expected).toBeDefined()
        if (!expected) throw new Error("Expected at least one discovered model")

        const single = await request(`${prefix}/${expected.id}`)
        expect(single.status).toBe(200)
        expect(await single.json()).toEqual(expected)
      },
      TEST_TIMEOUT,
    )
  }
})
