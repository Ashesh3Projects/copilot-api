/* eslint-disable max-lines, max-lines-per-function */
import { describe, expect, test } from "bun:test"

import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import {
  classifyEmittedWebSocketTerminal,
  mergeEffectiveNativeMessagesOptions,
  parseResponsesWebSocketFrame,
  resolveResponsesContinuation,
} from "~/routes/responses/websocket-protocol"

describe("classifyEmittedWebSocketTerminal", () => {
  test("trusts the emitted JSON type over a mismatched raw event name", () => {
    expect(
      classifyEmittedWebSocketTerminal(
        { type: "response.failed" },
        "response.completed",
      ),
    ).toBe("response.failed")
  })
})

describe("parseResponsesWebSocketFrame", () => {
  test("merges payload fields while keeping the protocol envelope out", () => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-top",
        input: "hello",
        headers: {
          "X-Interaction-Type": "conversation-subagent",
          "X-Client-Machine-Id": "machine-1",
          "X-Initiator": "user",
          Authorization: "Bearer must-not-pass",
          "Copilot-Session-Token": "must-not-pass",
        },
        initiator: "agent",
        agent_task_id: "task-top",
        parent_agent_id: "parent-top",
        response: {
          model: "gpt-nested",
          stream: true,
          max_output_tokens: 128,
          headers: { must: "not-pass" },
          initiator: "user",
          agent_task_id: "task-nested",
          parent_agent_id: "parent-nested",
          type: "nested-envelope",
        },
      }),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        attribution: {
          agentTaskId: "task-top",
          clientMachineId: "machine-1",
          interactionType: "conversation-subagent",
          parentAgentId: "parent-top",
        },
        initiator: "agent",
        payload: {
          input: "hello",
          max_output_tokens: 128,
          model: "gpt-nested",
          stream: true,
        },
        nativeMessagesOptions: {},
        requestedModel: "gpt-nested",
      },
    })
  })

  test("uses typed header attribution unless a top-level task field overrides it", () => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-current",
        headers: {
          "X-Agent-Task-Id": "task-header",
          "X-Parent-Agent-Id": "parent-header",
          "X-Unreviewed-Header": "must-not-pass",
        },
        agent_task_id: "task-top",
      }),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        attribution: {
          agentTaskId: "task-top",
          parentAgentId: "parent-header",
        },
        payload: { model: "gpt-current", stream: true },
        nativeMessagesOptions: {},
        requestedModel: "gpt-current",
      },
    })
  })

  test("uses a valid header initiator when the top-level override is absent", () => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-current",
        headers: { "X-Initiator": "user" },
      }),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        attribution: {},
        initiator: "user",
        payload: { model: "gpt-current", stream: true },
        nativeMessagesOptions: {},
        requestedModel: "gpt-current",
      },
    })
  })

  test("ignores malformed and secret frame headers", () => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-current",
        headers: {
          "Bad\nName": "value",
          "X-Agent-Task-Id": "bad\nvalue",
          Authorization: "Bearer must-not-pass",
          "Copilot-Session-Token": "must-not-pass",
        },
      }),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        attribution: {},
        payload: { model: "gpt-current", stream: true },
        nativeMessagesOptions: {},
        requestedModel: "gpt-current",
      },
    })
  })

  test.each([
    [Buffer.from("binary"), "Binary frames not supported"],
    [new Uint8Array([1, 2, 3]), "Binary frames not supported"],
    ["not-json", "Invalid JSON"],
    ["null", "JSON message must be an object"],
    [JSON.stringify([]), "JSON message must be an object"],
    [
      JSON.stringify({ type: "response.processed" }),
      "Unsupported message type",
    ],
    [JSON.stringify({ type: "other" }), "Unsupported message type"],
  ] as const)(
    "returns a recoverable parse error for %p",
    (message, expected) => {
      const result = parseResponsesWebSocketFrame(message)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatchObject({
          status: 400,
          type: "invalid_request_error",
        })
        expect(result.error.message).toContain(expected)
      }
    },
  )

  test.each([
    {
      frame: { stream: false },
      name: "top-level",
    },
    {
      frame: { stream: true, response: { stream: false } },
      name: "nested",
    },
    {
      frame: { stream: false, response: { stream: true } },
      name: "overridden top-level",
    },
  ])("coerces explicit $name stream false", ({ frame }) => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "gpt-current",
        input: "hello",
        ...frame,
      }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.payload.stream).toBe(true)
  })

  test.each([null, false, "assistant", 1])(
    "omits invalid top-level initiator %p",
    (initiator) => {
      const result = parseResponsesWebSocketFrame(
        JSON.stringify({
          type: "response.create",
          model: "gpt-current",
          initiator,
        }),
      )

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.initiator).toBeUndefined()
    },
  )

  test("extracts only sanitized native Messages options case-insensitively", () => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({
        type: "response.create",
        model: "claude-sonnet-4.5",
        headers: {
          "AnThRoPiC-BeTa": "tools-2024-04-04, tools-2024-04-04",
          "ANTHROPIC-VERSION": "2023-06-01",
          "X-Model-Provider-Preference": "anthropic",
          authorization: "Bearer must-not-persist",
          "copilot-session-token": "must-not-persist",
          "x-agent-task-id": "task-one",
        },
      }),
    )

    expect(result).toEqual({
      ok: true,
      value: {
        attribution: { agentTaskId: "task-one" },
        payload: { model: "claude-sonnet-4.5", stream: true },
        nativeMessagesOptions: {
          anthropicBeta: "tools-2024-04-04",
          anthropicVersion: "2023-06-01",
          modelProviderPreference: "anthropic",
        },
        requestedModel: "claude-sonnet-4.5",
      },
    })
  })
})

describe("mergeEffectiveNativeMessagesOptions", () => {
  test("merges supplied sanitized fields into a fresh object", () => {
    const current = {
      anthropicBeta: "interleaved-thinking-2025-05-14",
      anthropicVersion: "2023-06-01",
      modelProviderPreference: "anthropic",
    }
    const merged = mergeEffectiveNativeMessagesOptions(current, {
      anthropicVersion: "2024-01-01",
    })

    expect(merged).toEqual({
      anthropicBeta: "interleaved-thinking-2025-05-14",
      anthropicVersion: "2024-01-01",
      modelProviderPreference: "anthropic",
    })
    expect(merged).not.toBe(current)
  })
})

function userInput(text: string): ResponseInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }
}

describe("resolveResponsesContinuation core", () => {
  test("starts a new thread when previous_response_id is omitted", () => {
    const payload: ResponsesPayload = {
      model: "gpt-current",
      input: "hello",
    }

    expect(resolveResponsesContinuation(new Map(), payload)).toEqual({
      ok: true,
      payload: { model: "gpt-current", input: "hello" },
    })
    expect(payload).toEqual({ model: "gpt-current", input: "hello" })
  })

  test("immutably rehydrates a known connection-local response id", () => {
    const snapshot: ResponsesPayload = {
      model: "gpt-current",
      instructions: "stable",
      input: [{ role: "user", content: "first" }],
      tools: [{ type: "function", name: "run" }],
    }
    const payload: ResponsesPayload = {
      model: "gpt-current",
      previous_response_id: "resp_1",
      input: [{ role: "user", content: "second" }],
    }

    const result = resolveResponsesContinuation(
      new Map([["resp_1", snapshot]]),
      payload,
    )

    expect(result).toEqual({
      ok: true,
      payload: {
        model: "gpt-current",
        instructions: "stable",
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
        tools: [{ type: "function", name: "run" }],
      },
    })
    expect(snapshot).toEqual({
      model: "gpt-current",
      instructions: "stable",
      input: [{ role: "user", content: "first" }],
      tools: [{ type: "function", name: "run" }],
    })
    expect(payload).toEqual({
      model: "gpt-current",
      previous_response_id: "resp_1",
      input: [{ role: "user", content: "second" }],
    })
  })
})

describe("resolveResponsesContinuation input merging", () => {
  test.each([
    {
      currentInput: "second",
      expected: [userInput("first"), userInput("second")],
      name: "string then string",
      snapshotInput: "first",
    },
    {
      currentInput: [userInput("second")],
      expected: [userInput("first"), userInput("second")],
      name: "string then array",
      snapshotInput: "first",
    },
    {
      currentInput: "second",
      expected: [userInput("first"), userInput("second")],
      name: "array then string",
      snapshotInput: [userInput("first")],
    },
    {
      currentInput: [userInput("second")],
      expected: [userInput("first"), userInput("second")],
      name: "array then array",
      snapshotInput: [userInput("first")],
    },
    {
      currentInput: "",
      expected: [userInput(""), userInput("")],
      name: "empty string then empty string",
      snapshotInput: "",
    },
    {
      currentInput: [],
      expected: [userInput("first")],
      name: "string then empty array",
      snapshotInput: "first",
    },
    {
      currentInput: "second",
      expected: [userInput("second")],
      name: "empty array then string",
      snapshotInput: [],
    },
    {
      currentInput: [],
      expected: [],
      name: "empty array then empty array",
      snapshotInput: [],
    },
  ] as Array<{
    currentInput: ResponsesPayload["input"]
    expected: Array<ResponseInputItem>
    name: string
    snapshotInput: ResponsesPayload["input"]
  }>)(
    "preserves ordered $name continuation input",
    ({ currentInput, expected, snapshotInput }) => {
      const result = resolveResponsesContinuation(
        new Map([
          ["resp_mixed", { input: snapshotInput, model: "gpt-current" }],
        ]),
        {
          input: currentInput,
          model: "gpt-current",
          previous_response_id: "resp_mixed",
        },
      )

      expect(result).toMatchObject({ ok: true, payload: { input: expected } })
    },
  )

  test.each([
    {
      currentInput: "current",
      name: "null snapshot input",
      snapshotInput: null,
    },
    {
      currentInput: null,
      name: "null current input",
      snapshotInput: "snapshot",
    },
    {
      currentInput: "current",
      name: "malformed snapshot input",
      snapshotInput: { role: "user" },
    },
    {
      currentInput: { role: "user" },
      name: "malformed current input",
      snapshotInput: "snapshot",
    },
  ])("rejects $name", ({ currentInput, snapshotInput }) => {
    expect(
      resolveResponsesContinuation(
        new Map([
          [
            "resp_invalid_input",
            { input: snapshotInput, model: "gpt-current" } as ResponsesPayload,
          ],
        ]),
        {
          input: currentInput,
          model: "gpt-current",
          previous_response_id: "resp_invalid_input",
        } as ResponsesPayload,
      ),
    ).toEqual({
      ok: false,
      code: "invalid_request_error",
      message: "input must be a string or array",
      status: 400,
    })
  })
})

describe("resolveResponsesContinuation cloning", () => {
  test("deep-clones snapshot and current continuation values", () => {
    const snapshot: ResponsesPayload = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first" }],
        },
      ],
      metadata: {
        owner: { name: "snapshot-owner" },
      } as unknown as ResponsesPayload["metadata"],
      model: "gpt-current",
      tools: [
        {
          type: "function",
          name: "run",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
      ],
    }
    const current: ResponsesPayload = {
      client_metadata: { turn: { id: "turn-current" } },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "second" }],
        },
      ],
      model: "gpt-current",
      previous_response_id: "resp_clone",
    }
    const result = resolveResponsesContinuation(
      new Map([["resp_clone", snapshot]]),
      current,
    )
    if (!result.ok) throw new Error("Expected continuation resolution")

    const output = result.payload as unknown as {
      client_metadata: { turn: { id: string } }
      input: Array<{ content: Array<{ text: string }> }>
      metadata: { owner: { name: string } }
      tools: Array<{
        parameters: { properties: { command: { type: string } } }
      }>
    }
    output.input[0].content[0].text = "mutated-snapshot-input"
    output.input[1].content[0].text = "mutated-current-input"
    output.tools[0].parameters.properties.command.type = "number"
    output.metadata.owner.name = "mutated-snapshot-metadata"
    output.client_metadata.turn.id = "mutated-current-metadata"

    expect(snapshot).toMatchObject({
      input: [{ content: [{ text: "first" }] }],
      metadata: { owner: { name: "snapshot-owner" } },
      tools: [{ parameters: { properties: { command: { type: "string" } } } }],
    })
    expect(current).toMatchObject({
      client_metadata: { turn: { id: "turn-current" } },
      input: [{ content: [{ text: "second" }] }],
    })
  })

  test("deep-clones a new-thread payload when previous_response_id is omitted", () => {
    const payload: ResponsesPayload = {
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      metadata: {
        owner: { name: "caller" },
      } as unknown as ResponsesPayload["metadata"],
      model: "gpt-current",
      tools: [{ type: "function", name: "run", parameters: {} }],
    }
    const result = resolveResponsesContinuation(new Map(), payload)
    if (!result.ok) throw new Error("Expected new-thread resolution")

    const output = result.payload as unknown as {
      input: Array<{ content: Array<{ text: string }> }>
      metadata: { owner: { name: string } }
      tools: Array<{ parameters: Record<string, unknown> }>
    }
    output.input[0].content[0].text = "mutated"
    output.metadata.owner.name = "mutated"
    output.tools[0].parameters.changed = true

    expect(payload).toMatchObject({
      input: [{ content: [{ text: "hi" }] }],
      metadata: { owner: { name: "caller" } },
      tools: [{ parameters: {} }],
    })
  })

  test("deep-clones current tools and metadata overrides", () => {
    const snapshot: ResponsesPayload = {
      metadata: { source: "snapshot" },
      model: "gpt-current",
      tools: [{ type: "function", name: "snapshot_tool", parameters: {} }],
    }
    const current: ResponsesPayload = {
      metadata: {
        owner: { name: "current-owner" },
      } as unknown as ResponsesPayload["metadata"],
      model: "gpt-current",
      previous_response_id: "resp_current_clone",
      tools: [
        {
          type: "function",
          name: "current_tool",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
    }
    const result = resolveResponsesContinuation(
      new Map([["resp_current_clone", snapshot]]),
      current,
    )
    if (!result.ok) throw new Error("Expected continuation resolution")

    const output = result.payload as unknown as {
      metadata: { owner: { name: string } }
      tools: Array<{
        parameters: { properties: { query: { type: string } } }
      }>
    }
    output.metadata.owner.name = "mutated-current-owner"
    output.tools[0].parameters.properties.query.type = "number"

    expect(current).toMatchObject({
      metadata: { owner: { name: "current-owner" } },
      tools: [{ parameters: { properties: { query: { type: "string" } } } }],
    })
    expect(snapshot).toMatchObject({
      metadata: { source: "snapshot" },
      tools: [{ name: "snapshot_tool" }],
    })
  })
})

describe("resolveResponsesContinuation errors", () => {
  test("rejects an explicit model that differs from the snapshot model", () => {
    expect(
      resolveResponsesContinuation(
        new Map([
          [
            "resp_model",
            {
              model: "model-a",
              client_metadata: { session_id: "session-a" },
              input: "prior history",
            },
          ],
        ]),
        {
          model: "model-b",
          client_metadata: { session_id: "session-b" },
          previous_response_id: "resp_model",
          input: "delta",
        },
      ),
    ).toEqual({
      ok: false,
      code: "invalid_request_error",
      message: "Continuation model must match the previous response model.",
      status: 400,
    })
  })

  test("inherits the snapshot model and affinity metadata when omitted or replaced", () => {
    const snapshot: ResponsesPayload = {
      model: "model-a",
      client_metadata: {
        session_id: "session-a",
        thread_id: "thread-a",
        typed: { source: "snapshot" },
      },
      input: "prior history",
    }

    const result = resolveResponsesContinuation(
      new Map([["resp_affinity", snapshot]]),
      {
        client_metadata: {
          session_id: "session-b",
          thread_id: "thread-b",
          typed: { source: "caller" },
        },
        previous_response_id: "resp_affinity",
        input: "delta",
      } as unknown as ResponsesPayload,
    )

    expect(result).toEqual({
      ok: true,
      payload: {
        model: "model-a",
        client_metadata: {
          session_id: "session-a",
          thread_id: "thread-a",
          typed: { source: "caller" },
        },
        input: [userInput("prior history"), userInput("delta")],
      },
    })
    expect(snapshot.client_metadata).toEqual({
      session_id: "session-a",
      thread_id: "thread-a",
      typed: { source: "snapshot" },
    })
  })

  test("accepts an already-normalized explicit model equal to the prepared snapshot", () => {
    const result = resolveResponsesContinuation(
      new Map([
        [
          "resp_normalized",
          { model: "claude-opus-4.6", input: "prior history" },
        ],
      ]),
      {
        model: "claude-opus-4.6",
        previous_response_id: "resp_normalized",
        input: "delta",
      },
    )

    expect(result).toMatchObject({
      ok: true,
      payload: { model: "claude-opus-4.6" },
    })
  })

  test("returns previous_response_not_found for a stale local id", () => {
    expect(
      resolveResponsesContinuation(new Map(), {
        model: "gpt-current",
        input: "delta",
        previous_response_id: "resp_stale",
      }),
    ).toEqual({
      ok: false,
      code: "previous_response_not_found",
      message:
        "The previous response is not available on this WebSocket connection.",
      status: 400,
    })
  })

  test.each([
    [null, "previous_response_id must be a string"],
    ["", "previous_response_id must not be empty"],
    [17, "previous_response_id must be a string"],
  ] as const)("rejects malformed previous_response_id %p", (value, message) => {
    expect(
      resolveResponsesContinuation(new Map(), {
        model: "gpt-current",
        input: "delta",
        previous_response_id: value,
      } as ResponsesPayload),
    ).toEqual({
      ok: false,
      code: "invalid_request_error",
      message,
      status: 400,
    })
  })
})

describe("parseResponsesWebSocketFrame hostile input", () => {
  test.each([
    { name: "null", type: null as unknown },
    { name: "number", type: 7 as unknown },
    { name: "array", type: [] as unknown },
    { name: "object", type: {} as unknown },
    { name: "shadowed toString", type: { toString: null } as unknown },
    {
      name: "shadowed valueOf and toString",
      type: { toString: {}, valueOf: {} } as unknown,
    },
  ])("rejects hostile $name message types without coercion", ({ type }) => {
    const result = parseResponsesWebSocketFrame(
      JSON.stringify({ type, model: "gpt-current" }),
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: "bad_request",
        message: "Unsupported message type",
        status: 400,
        type: "invalid_request_error",
      },
    })
  })
})

describe("parseResponsesWebSocketFrame attribution precedence", () => {
  test.each(["agent", "user"] as const)(
    "uses top-level initiator %s over the header envelope",
    (initiator) => {
      const result = parseResponsesWebSocketFrame(
        JSON.stringify({
          type: "response.create",
          model: "gpt-current",
          headers: { "X-Initiator": initiator === "agent" ? "user" : "agent" },
          initiator,
        }),
      )

      expect(result).toMatchObject({ ok: true, value: { initiator } })
    },
  )

  test.each([null, false, "assistant", 1])(
    "treats invalid present top-level initiator %p as absent",
    (initiator) => {
      const result = parseResponsesWebSocketFrame(
        JSON.stringify({
          type: "response.create",
          model: "gpt-current",
          headers: { "X-Initiator": "agent" },
          initiator,
        }),
      )

      expect(result).toMatchObject({
        ok: true,
        value: { initiator: "agent" },
      })
    },
  )

  test.each([
    {
      agent_task_id: "",
      expected: { parentAgentId: "parent-header" },
      name: "blank task id",
    },
    {
      agent_task_id: 7,
      expected: { parentAgentId: "parent-header" },
      name: "non-string task id",
    },
    {
      agent_task_id: "x".repeat(1025),
      expected: { parentAgentId: "parent-header" },
      name: "oversized task id",
    },
    {
      agent_task_id: "bad\nvalue",
      expected: { parentAgentId: "parent-header" },
      name: "control-character task id",
    },
    {
      expected: {
        agentTaskId: "task-header",
        parentAgentId: "parent-header",
      },
      name: "absent task id",
    },
    {
      expected: { agentTaskId: "task-header" },
      name: "blank parent id",
      parent_agent_id: " ",
    },
    {
      expected: { agentTaskId: "task-header" },
      name: "non-string parent id",
      parent_agent_id: false,
    },
    {
      expected: { agentTaskId: "task-header" },
      name: "oversized parent id",
      parent_agent_id: "x".repeat(1025),
    },
    {
      expected: { agentTaskId: "task-header" },
      name: "control-character parent id",
      parent_agent_id: "bad\rvalue",
    },
  ])(
    "applies explicit top-level precedence for $name",
    ({ expected, ...topLevel }) => {
      const { name: _name, ...frameFields } = topLevel
      const result = parseResponsesWebSocketFrame(
        JSON.stringify({
          type: "response.create",
          model: "gpt-current",
          headers: {
            "X-Agent-Task-Id": "task-header",
            "X-Parent-Agent-Id": "parent-header",
          },
          ...frameFields,
        }),
      )

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.attribution).toEqual(expected)
    },
  )
})
