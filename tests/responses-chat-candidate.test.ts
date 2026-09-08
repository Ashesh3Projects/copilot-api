import { afterEach, describe, expect, mock, test } from "bun:test"

import { adaptResponsesToChatCandidate } from "~/routes/responses/responses-chat-adapter"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "~/services/copilot/compaction-payload"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/* eslint-disable max-lines-per-function -- candidate matrix keeps source and exact target assertions together */

describe("Responses Chat fallback candidate", () => {
  test("adapts future items and collision-safe tool history without fatal rejection", async () => {
    const source = {
      model: "gpt-test",
      instructions: "system context",
      input: [
        { type: "future_item", payload: "private-future-value" },
        {
          type: "function_call",
          call_id: "responses_call_0_0",
          name: "one",
          arguments: "not-json",
        },
        { type: "message", role: "future-role", content: "keep me" },
        { type: "function_call", name: "two", arguments: { x: 1 } },
        {
          type: "function_call_output",
          call_id: "responses_call_0_0",
          output: "first",
        },
        {
          type: "function_call_output",
          call_id: "responses_call_0_0",
          output: "duplicate",
        },
      ],
      tools: [
        { type: "custom", name: "apply_patch", format: { type: "grammar" } },
        { type: "future_tool", name: "private-tool" },
      ],
      tool_choice: { type: "future_choice", name: "private-choice" },
      temperature: 0.2,
      top_p: 0.8,
      prompt_cache_key: "private-cache",
      stream: false,
    }

    const candidate = await adaptResponsesToChatCandidate({ source })

    expect(candidate.endpoint).toBe("/chat/completions")
    expect(candidate.check.supported).toBe(true)
    expect(
      candidate.payload.messages.some(
        (message) => message.content === "[Future Responses item]",
      ),
    ).toBe(true)
    expect(
      candidate.payload.messages.some(
        (message) => message.content === "keep me",
      ),
    ).toBe(true)
    expect(
      candidate.payload.messages.some(
        (message) =>
          typeof message.content === "string"
          && message.content.includes("duplicate"),
      ),
    ).toBe(true)
    const ids = candidate.payload.messages.flatMap(
      (message) => message.tool_calls?.map((call) => call.id) ?? [],
    )
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("responses_call_0_0")
    expect(
      candidate.payload.tools?.some(
        (tool) => tool.function.name === "apply_patch",
      ),
    ).toBe(true)
    expect(candidate.payload.tool_choice).toBe("auto")
    expect(candidate.payload.top_p).toBeUndefined()
    expect(JSON.stringify(candidate.check)).not.toContain("private-")
    expect(source.tools[0].type).toBe("custom")
  })

  test("marks only an empty completed Chat candidate fatal", async () => {
    const candidate = await adaptResponsesToChatCandidate({
      source: {
        model: "gpt-test",
        input: [],
        tools: [{ type: "future_tool" }],
      },
    })

    expect(candidate.check.supported).toBe(false)
    expect(candidate.check.findings[0]).toEqual({
      class: "message_shape",
      severity: "fatal",
    })
  })

  test("repairs a cloned recursive function schema and clears strict only on repair", async () => {
    const repairedSource = {
      model: "gpt-test",
      input: "hello",
      tools: [
        {
          type: "function",
          name: "lookup",
          strict: true,
          parameters: {
            type: "OBJECT",
            properties: {
              nested: {
                type: "OBJECT",
                properties: { value: { type: "STRING" } },
                required: ["missing"],
              },
              list: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: { id: { type: "STRING" } },
                },
              },
            },
            required: ["nested", "unknown"],
            anyOf: [
              {
                type: "OBJECT",
                properties: { flag: { type: "BOOLEAN" } },
              },
            ],
          },
        },
      ],
    }
    const validSource = {
      model: "gpt-test",
      input: "hello",
      tools: [
        {
          type: "function",
          name: "valid",
          strict: true,
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    }
    const repairedBefore = structuredClone(repairedSource)
    const validBefore = structuredClone(validSource)

    const repaired = await adaptResponsesToChatCandidate({
      source: repairedSource,
    })
    const valid = await adaptResponsesToChatCandidate({ source: validSource })

    expect(repairedSource).toEqual(repairedBefore)
    expect(validSource).toEqual(validBefore)
    expect(repaired.payload.tools?.[0]?.function).toMatchObject({
      strict: false,
      parameters: {
        type: "object",
        required: ["nested"],
        properties: {
          nested: {
            type: "object",
            properties: { value: { type: "string" } },
          },
          list: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        },
        anyOf: [
          {
            type: "object",
            properties: { flag: { type: "boolean" } },
          },
        ],
      },
    })
    expect(valid.payload.tools?.[0]?.function).toEqual({
      name: "valid",
      strict: true,
      parameters: validSource.tools[0].parameters,
    })
  })

  test("pairs generated and duplicate call IDs with one result across interleaving", async () => {
    const source = {
      model: "gpt-test",
      input: [
        { type: "function_call", name: "missing", arguments: "{}" },
        { type: "message", role: "user", content: "between" },
        { type: "function_call_output", output: "missing-result" },
        { type: "function_call", call_id: "dup", name: "one", arguments: "{}" },
        { type: "message", role: "assistant", content: "still pending" },
        { type: "function_call", call_id: "dup", name: "two", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "dup",
          output: "first-result",
        },
        {
          type: "function_call_output",
          call_id: "dup",
          output: "second-result",
        },
      ],
    }

    const [first, second] = await Promise.all([
      adaptResponsesToChatCandidate({ source }),
      adaptResponsesToChatCandidate({ source }),
    ])

    expect(first.payload).toEqual(second.payload)
    const calls = first.payload.messages.flatMap(
      (message) => message.tool_calls ?? [],
    )
    const toolResults = first.payload.messages.filter(
      (message) => message.role === "tool",
    )
    expect(calls.map((call) => call.id)).toEqual([
      "responses_call_0_0",
      "dup",
      "responses_call_5_0",
    ])
    expect(toolResults).toEqual([
      {
        role: "tool",
        tool_call_id: "responses_call_0_0",
        content: "missing-result",
      },
      { role: "tool", tool_call_id: "dup", content: "first-result" },
      {
        role: "tool",
        tool_call_id: "responses_call_5_0",
        content: "second-result",
      },
    ])
  })

  test("fits reducible compaction after preserving custom history without mutating source", async () => {
    const huge = "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 1024)
    const source = {
      model: "gpt-test",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_compact",
          name: "exec",
          input: "run",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_compact",
          output: "done",
        },
        {
          type: "function_call",
          call_id: "call_large",
          name: "lookup",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_large", output: huge },
      ],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }),
      },
    }

    const candidate = await adaptResponsesToChatCandidate({ source })

    expect(
      Buffer.byteLength(JSON.stringify(candidate.payload)),
    ).toBeLessThanOrEqual(COMPACTION_PAYLOAD_MAX_BYTES)
    expect(JSON.stringify(candidate.payload)).toContain("call_compact")
    expect(JSON.stringify(source)).toContain(huge)
  })

  test("fetches unrestricted URLs and keeps attachment failures URI-free", async () => {
    const requested: Array<string> = []
    const marker = "responses-chat-secret"
    globalThis.fetch = mock((input: string | URL | Request) => {
      const value = input instanceof Request ? input.url : input.toString()
      requested.push(value)
      return Promise.resolve(
        value.includes("ok.png") ?
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          })
        : new Response("", { status: 404 }),
      )
    }) as unknown as typeof fetch
    const candidate = await adaptResponsesToChatCandidate({
      source: {
        model: "gpt-test",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "before" },
              {
                type: "input_image",
                image_url: "HTTP://USER:PASS@127.1/ok.png",
              },
              {
                type: "input_file",
                file_url: `http://169.254.169.254/a.pdf?secret=${marker}`,
              },
              { type: "input_text", text: "after" },
            ],
          },
        ],
      },
    })

    expect(requested).toEqual([
      "http://USER:PASS@127.0.0.1/ok.png",
      `http://169.254.169.254/a.pdf?secret=${marker}`,
    ])
    expect(JSON.stringify(candidate.payload)).toContain("AQID")
    expect(JSON.stringify(candidate.payload)).toContain("before")
    expect(JSON.stringify(candidate.payload)).toContain("after")
    expect(JSON.stringify(candidate.payload)).not.toContain(marker)
  })
})
