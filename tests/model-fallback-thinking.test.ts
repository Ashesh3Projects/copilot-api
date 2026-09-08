import { expect, test } from "bun:test"

import { stripModelTransitionThinking } from "~/lib/model-fallback"
import {
  captureForeignThinking,
  filterForeignThinking,
  mergeForeignThinking,
} from "~/lib/model-fallback-thinking"

test("tracks only hashes and selectively filters all supported history shapes", () => {
  const original = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "secret thought",
            signature: "old-signed",
          },
          { type: "redacted_thinking", data: "old-redacted" },
          { type: "text", text: "old answer" },
        ],
      },
      {
        role: "assistant",
        content: "answer",
        reasoning_text: "old thought",
        reasoning_opaque: "old-chat",
      },
    ],
    input: [
      {
        type: "reasoning",
        id: "rs_old",
        encrypted_content: "old-responses",
        summary: [],
      },
    ],
    contents: [
      {
        role: "model",
        parts: [
          {
            thought: true,
            text: "old Google thought",
            thoughtSignature: "old-google",
          },
          {
            functionCall: { name: "tool", args: {} },
            thoughtSignature: "old-tool",
          },
        ],
      },
    ],
  }
  const foreign = captureForeignThinking(original)
  expect(
    [...foreign.fingerprints].every((value) => /^[a-f\d]{64}$/.test(value)),
  ).toBe(true)
  expect(JSON.stringify([...foreign.fingerprints])).not.toContain(
    "secret thought",
  )
  const replay = structuredClone(original)
  replay.messages.push({
    role: "assistant",
    content: "new answer",
    reasoning_text: "new thought",
    reasoning_opaque: "new-chat",
  })
  replay.input.push({
    type: "reasoning",
    id: "rs_changed",
    encrypted_content: "new-responses",
    summary: [],
  })
  replay.contents[0].parts.push({
    thought: true,
    text: "new Google thought",
    thoughtSignature: "new-google",
  })
  filterForeignThinking(replay, foreign)
  const serialized = JSON.stringify(replay)
  for (const old of [
    "old-signed",
    "old-redacted",
    "old-chat",
    "old-responses",
    "old-google",
    "old-tool",
  ])
    expect(serialized).not.toContain(old)
  for (const retained of [
    "old answer",
    "new-chat",
    "new-responses",
    "new-google",
    "functionCall",
  ])
    expect(serialized).toContain(retained)
})

test("same opaque signature is filtered across bridges even if item ids or summaries change", () => {
  const foreign = captureForeignThinking({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old", signature: "opaque@rs_old" },
        ],
      },
    ],
  })
  const replay = {
    input: [
      {
        type: "reasoning",
        id: "rs_changed",
        encrypted_content: "opaque",
        summary: [{ type: "summary_text", text: "changed" }],
      },
      {
        type: "reasoning",
        id: "rs_new",
        encrypted_content: "new-opaque",
        summary: [],
      },
    ],
  }
  filterForeignThinking(replay, foreign)
  expect(replay.input).toHaveLength(1)
  expect(replay.input[0].encrypted_content).toBe("new-opaque")
})

test("foreign states merge without mutating existing entries and fail closed on overflow", () => {
  const first = captureForeignThinking({
    input: [{ type: "reasoning", encrypted_content: "first" }],
  })
  const second = captureForeignThinking({
    input: [{ type: "reasoning", encrypted_content: "second" }],
  })
  const merged = mergeForeignThinking(first, second)
  expect(first.fingerprints.size).toBe(1)
  expect(merged.fingerprints.size).toBe(2)
  const excessive = captureForeignThinking({
    input: Array.from({ length: 4097 }, (_, index) => ({
      type: "reasoning",
      encrypted_content: `signature-${index}`,
    })),
  })
  expect(excessive.fingerprints.size).toBe(4096)
  expect(excessive.complete).toBe(false)
})

test("removing reasoning-only assistants preserves tools and unrelated empty messages", () => {
  const payload: { messages: Array<Record<string, unknown>> } = {
    messages: [
      { role: "assistant", content: null, reasoning_opaque: "old" },
      {
        role: "assistant",
        content: null,
        reasoning_opaque: "old",
        tool_calls: [{ id: "tool", type: "function" }],
      },
      { role: "assistant", content: null },
    ],
  }
  const foreign = captureForeignThinking(payload)
  const cached = structuredClone(payload)
  filterForeignThinking(cached, foreign)
  stripModelTransitionThinking(payload)
  for (const filtered of [cached, payload]) {
    expect(filtered.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tool", type: "function" }],
      },
      { role: "assistant", content: null },
    ])
  }
})
