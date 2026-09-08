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

// Models grouped by their primary API endpoint
const MESSAGES_MODELS = [
  "claude-opus-4.6",
  "claude-opus-4.6-1m",
  "claude-opus-4.6-fast",
  "claude-sonnet-4.6",
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "claude-opus-4.5",
  "claude-haiku-4.5",
]

const RESPONSES_ONLY_MODELS = [
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
]

const CHAT_COMPLETIONS_MODELS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4o-mini-2024-07-18",
  "gpt-4o-2024-11-20",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-05-13",
  "gpt-4-o-preview",
  "gpt-4",
  "gpt-4-0613",
  "gpt-4-0125-preview",
  "gpt-4.1",
  "gpt-4.1-2025-04-14",
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0613",
  "gpt-5-mini",
  "gpt-5.1",
  "gpt-5.2",
  "gemini-2.5-pro",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
]

const EMBEDDING_MODELS = [
  "text-embedding-3-small",
  "text-embedding-3-small-inference",
  "text-embedding-ada-002",
]

function isModelAvailable(modelId: string): boolean {
  return state.models?.data.some((m) => m.id === modelId) ?? false
}

// Error response shape from the API (wrapped by forwardError)
interface ErrorBody {
  error?: { code?: string; message?: string; type?: string }
}

/**
 * Check if a response is a "model not supported" error (400/404).
 * The upstream error JSON is stringified into error.message by forwardError,
 * so we check for the code inside the serialized message string.
 * Returns true if the response should be skipped (caller should return early).
 */
async function isModelNotSupported(res: Response): Promise<boolean> {
  if (res.status === 400 || res.status === 404) {
    const cloned = res.clone()
    try {
      const body = (await cloned.json()) as ErrorBody
      const msg = body.error?.message ?? ""
      if (
        msg.includes("model_not_supported")
        || msg.includes("not supported")
        || body.error?.code === "model_not_supported"
      ) {
        console.log(`Skipping — upstream rejected model`)
        return true
      }
    } catch {
      // Not JSON — not a model_not_supported error
    }
  }
  return false
}

// Helper types for response validation
interface ChatCompletionChoice {
  message: { role: string; content: string | null }
  finish_reason: string | null
}

interface ChatCompletionBody {
  id: string
  model: string
  choices: Array<ChatCompletionChoice>
}

interface AnthropicBody {
  id: string
  type: string
  role: string
  content: Array<{ type: string; text?: string }>
  usage: { input_tokens: number; output_tokens: number }
}

interface ResponsesBody {
  id: string
  status: string
  output: Array<{ type: string }>
  output_text: string
}

interface EmbeddingBody {
  data: Array<{ embedding: Array<number>; index: number }>
  usage: { prompt_tokens: number }
}

// ── ChatCompletions models (non-streaming) ──
describe("Per-model: ChatCompletions (non-streaming)", () => {
  for (const modelId of CHAT_COMPLETIONS_MODELS) {
    test(
      modelId,
      async () => {
        if (!isModelAvailable(modelId)) {
          console.log(`Skipping ${modelId} — not in models list`)
          return
        }
        const res = await postJSON("/v1/chat/completions", {
          model: modelId,
          messages: [{ role: "user", content: "Say hello in one word." }],
          max_tokens: 10,
          stream: false,
        })
        if (await isModelNotSupported(res)) return
        expect(res.status).toBe(200)
        const body = (await res.json()) as ChatCompletionBody
        expect(body.choices.length).toBeGreaterThan(0)
        expect(body.choices[0].message.role).toBe("assistant")
      },
      TEST_TIMEOUT,
    )
  }
})

// ── ChatCompletions models (streaming) ──
describe("Per-model: ChatCompletions (streaming)", () => {
  for (const modelId of CHAT_COMPLETIONS_MODELS) {
    test(
      modelId,
      async () => {
        if (!isModelAvailable(modelId)) {
          console.log(`Skipping ${modelId} — not in models list`)
          return
        }
        const res = await postJSON("/v1/chat/completions", {
          model: modelId,
          messages: [{ role: "user", content: "Say hello in one word." }],
          max_tokens: 10,
          stream: true,
        })
        if (await isModelNotSupported(res)) return
        expect(res.status).toBe(200)
        const events = await collectSSEEvents(res)
        expect(events.length).toBeGreaterThan(0)
        const lastEvent = events.at(-1)
        expect(lastEvent).toBeDefined()
        expect(lastEvent?.data).toBe("[DONE]")
      },
      TEST_TIMEOUT,
    )
  }
})

// ── Messages API models (non-streaming) ──
describe("Per-model: Messages API (non-streaming)", () => {
  for (const modelId of MESSAGES_MODELS) {
    test(
      modelId,
      async () => {
        if (!isModelAvailable(modelId)) {
          console.log(`Skipping ${modelId} — not in models list`)
          return
        }
        const res = await postJSON("/v1/messages", {
          model: modelId,
          messages: [{ role: "user", content: "Say hello in one word." }],
          max_tokens: 10,
          stream: false,
        })
        if (await isModelNotSupported(res)) return
        expect(res.status).toBe(200)
        const body = (await res.json()) as AnthropicBody
        expect(body.type).toBe("message")
        expect(body.role).toBe("assistant")
        expect(body.content.length).toBeGreaterThan(0)
      },
      TEST_TIMEOUT,
    )
  }
})

// ── Messages API models (streaming) ──
describe("Per-model: Messages API (streaming)", () => {
  for (const modelId of MESSAGES_MODELS) {
    test(
      modelId,
      async () => {
        if (!isModelAvailable(modelId)) {
          console.log(`Skipping ${modelId} — not in models list`)
          return
        }
        const res = await postJSON("/v1/messages", {
          model: modelId,
          messages: [{ role: "user", content: "Say hello in one word." }],
          max_tokens: 10,
          stream: true,
        })
        if (await isModelNotSupported(res)) return
        expect(res.status).toBe(200)
        const events = await collectSSEEvents(res)
        expect(events.length).toBeGreaterThan(0)
        const eventTypes = events.map((e) => e.event)
        expect(eventTypes).toContain("message_start")
        expect(eventTypes).toContain("message_stop")
      },
      TEST_TIMEOUT,
    )
  }
})

// ── Responses API models (non-streaming) ──
describe("Per-model: Responses API (non-streaming)", () => {
  for (const modelId of RESPONSES_ONLY_MODELS) {
    test(
      modelId,
      async () => {
        if (!isModelAvailable(modelId)) {
          console.log(`Skipping ${modelId} — not in models list`)
          return
        }
        const res = await postJSON("/v1/responses", {
          model: modelId,
          input: "Say hello in one word.",
          stream: false,
        })
        if (await isModelNotSupported(res)) return
        expect(res.status).toBe(200)
        const body = (await res.json()) as ResponsesBody
        expect(body.status).toBe("completed")
        expect(body.output.length).toBeGreaterThan(0)
      },
      TEST_TIMEOUT,
    )
  }
})

// ── Responses API models (streaming) ──
describe("Per-model: Responses API (streaming)", () => {
  for (const modelId of RESPONSES_ONLY_MODELS) {
    test(
      modelId,
      async () => {
        if (!isModelAvailable(modelId)) {
          console.log(`Skipping ${modelId} — not in models list`)
          return
        }
        const res = await postJSON("/v1/responses", {
          model: modelId,
          input: "Say hello in one word.",
          stream: true,
        })
        if (await isModelNotSupported(res)) return
        expect(res.status).toBe(200)
        const events = await collectSSEEvents(res)
        expect(events.length).toBeGreaterThan(0)
        const eventTypes = new Set(events.map((e) => e.event))
        const hasCompletion =
          eventTypes.has("response.completed")
          || eventTypes.has("response.output_text.done")
        expect(hasCompletion).toBe(true)
      },
      TEST_TIMEOUT,
    )
  }
})

// ── Embedding models ──
describe("Per-model: Embeddings", () => {
  for (const modelId of EMBEDDING_MODELS) {
    test(
      modelId,
      async () => {
        if (!isModelAvailable(modelId)) {
          console.log(`Skipping ${modelId} — not in models list`)
          return
        }
        const res = await postJSON("/v1/embeddings", {
          model: modelId,
          input: ["Hello, world!"],
        })
        if (await isModelNotSupported(res)) return
        expect(res.status).toBe(200)
        const body = (await res.json()) as EmbeddingBody
        expect(body.data.length).toBeGreaterThan(0)
        expect(body.data[0].embedding.length).toBeGreaterThan(0)
      },
      TEST_TIMEOUT,
    )
  }
})
