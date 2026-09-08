/* eslint-disable max-lines -- integration coverage shares one server fixture */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

import { HTTPError } from "../src/lib/error"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelRoutingOverridesForTest } from "../src/lib/model-routing"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { normalizeResponsesReasoning } from "../src/routes/responses/handler"
import {
  createStreamIdTracker,
  fixStreamIds,
} from "../src/routes/responses/stream-id-sync"
import { server } from "../src/server"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "../src/services/copilot/compaction-payload"
import {
  createResponses,
  sanitizeResponsesStreamEvent,
  type ResponsesPayload,
} from "../src/services/copilot/create-responses"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

test("fails closed when the terminal event name conflicts with its JSON type", () => {
  const privateMarker = "direct-terminal-private-marker"
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.failed",
    data: JSON.stringify({
      type: "response.output_text.delta",
      sequence_number: 9,
      response: {
        id: "resp_direct",
        object: "response",
        status: "failed",
        message: privateMarker,
        metadata: { private: privateMarker },
        error: { message: privateMarker, code: "custom_private_code" },
      },
      private: privateMarker,
    }),
  })

  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.failed",
    sequence_number: 9,
    response: {
      id: "resp_direct",
      object: "response",
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    },
  })
  expect(sanitized.data).not.toContain(privateMarker)
})

test("preserves a completed terminal event without a field allowlist", () => {
  const privateMarker = "completed-allowlist-private-marker"
  const data = JSON.stringify({
    type: "response.completed",
    sequence_number: 3,
    provider: privateMarker,
    response: {
      id: "resp_completed",
      object: "response",
      created_at: 1_700_000_000,
      model: "gpt-public",
      status: "completed",
      output: [
        {
          id: "msg_completed",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "done",
              annotations: [
                {
                  type: "url_citation",
                  start_index: 0,
                  end_index: 4,
                  title: "Public source",
                  url: "https://example.com/source",
                  private: privateMarker,
                },
              ],
              provider: privateMarker,
            },
          ],
          metadata: { private: privateMarker },
        },
        {
          id: "rs_completed",
          type: "reasoning",
          status: "completed",
          summary: [
            {
              type: "summary_text",
              text: "Checked the public state.",
              private: privateMarker,
            },
          ],
          encrypted_content: "encrypted-client-state",
          provider: privateMarker,
        },
        {
          id: "fc_completed",
          type: "function_call",
          call_id: "call_completed",
          name: "lookup",
          arguments: '{"id":7}',
          status: "completed",
          private: privateMarker,
        },
        {
          type: "private_future_item",
          value: privateMarker,
        },
      ],
      output_text: "done",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: {
          cached_tokens: 1,
          provider_cache_key: privateMarker,
        },
        output_tokens_details: {
          reasoning_tokens: 1,
          provider_reasoning: privateMarker,
        },
        provider_usage: privateMarker,
      },
      error: null,
      incomplete_details: null,
      metadata: { private: privateMarker },
      prompt_cache_key: privateMarker,
      safety_identifier: privateMarker,
      provider: privateMarker,
    },
  })
  const event = { event: "response.completed", data }

  const sanitized = sanitizeResponsesStreamEvent(event)

  expect(sanitized).not.toBe(event)
  expect(sanitized.event).toBe("response.completed")
  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual(
    JSON.parse(data) as unknown,
  )
  expect(sanitized.data).toBe(data)
  expect(sanitized.data).toContain(privateMarker)
})

test("preserves explicit empty completed output_text over derivable text", () => {
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 5,
      response: {
        id: "resp_explicit_empty_output_text",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg_explicit_empty_output_text",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "derived text",
                annotations: [],
              },
            ],
          },
        ],
        output_text: "",
        usage: null,
        error: null,
        incomplete_details: null,
      },
    }),
  })

  expect(sanitized.event).toBe("response.completed")
  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.completed",
    sequence_number: 5,
    response: {
      id: "resp_explicit_empty_output_text",
      object: "response",
      status: "completed",
      output: [
        {
          id: "msg_explicit_empty_output_text",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "derived text",
              annotations: [],
            },
          ],
        },
      ],
      output_text: "",
      usage: null,
      error: null,
      incomplete_details: null,
    },
  })
})

test("does not derive a missing completed output_text", () => {
  const privateMarker = "assistant-only-derived-output-text-private-marker"
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 6,
      response: {
        id: "resp_assistant_only_output_text",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg_user_output_text",
            type: "message",
            role: "user",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "user-text",
                annotations: [],
                private: privateMarker,
              },
            ],
            private: privateMarker,
          },
          {
            id: "msg_missing_role_output_text",
            type: "message",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "missing-role-text",
                annotations: [],
                private: privateMarker,
              },
            ],
            private: privateMarker,
          },
          {
            id: "msg_invalid_role_output_text",
            type: "message",
            role: "tool",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "invalid-role-text",
                annotations: [],
                private: privateMarker,
              },
            ],
            private: privateMarker,
          },
          {
            id: "msg_assistant_output_text",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "assistant-text",
                annotations: [],
                private: privateMarker,
              },
            ],
            private: privateMarker,
          },
        ],
        usage: null,
        error: null,
        incomplete_details: null,
        metadata: { private: privateMarker },
      },
      private: privateMarker,
    }),
  })

  expect(sanitized.event).toBe("response.completed")
  const completed = JSON.parse(sanitized.data ?? "{}") as {
    response?: Record<string, unknown>
  }
  expect(completed.response).not.toHaveProperty("output_text")
  expect(completed.response?.metadata).toEqual({ private: privateMarker })
  expect(sanitized.data).toContain(privateMarker)
})

test.each([
  {
    name: "assistant text",
    output: [
      {
        id: "msg_first",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "first",
            annotations: [],
            provider: "missing-output-text-private-marker",
          },
          {
            type: "refusal",
            refusal: "declined",
            provider: "missing-output-text-private-marker",
          },
        ],
        metadata: { private: "missing-output-text-private-marker" },
      },
      {
        id: "msg_second",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "second",
            annotations: [],
            provider: "missing-output-text-private-marker",
          },
        ],
        metadata: { private: "missing-output-text-private-marker" },
      },
    ],
  },
  {
    name: "tool-only output",
    output: [
      {
        id: "fc_tool_only",
        type: "function_call",
        call_id: "call_tool_only",
        name: "lookup",
        arguments: '{"id":7}',
        status: "completed",
        private: "missing-output-text-private-marker",
      },
    ],
  },
])(
  "preserves completed $name without synthesizing output_text",
  ({ output }) => {
    const event = {
      event: "response.completed",
      data: JSON.stringify({
        type: "response.completed",
        sequence_number: 5,
        provider: "missing-output-text-private-marker",
        response: {
          id: "resp_missing_output_text",
          object: "response",
          status: "completed",
          output,
          usage: null,
          error: null,
          incomplete_details: null,
          provider: "missing-output-text-private-marker",
        },
      }),
    }

    const sanitized = sanitizeResponsesStreamEvent(event)

    expect(sanitized.event).toBe("response.completed")
    const completed = JSON.parse(sanitized.data ?? "{}") as {
      response?: Record<string, unknown>
    }
    expect(completed.response?.output).toEqual(output)
    expect(completed.response).not.toHaveProperty("output_text")
    expect(sanitized.data).toContain("missing-output-text-private-marker")
  },
)

test("preserves completed tool output families with future fields", () => {
  const privateMarker = "completed-tool-private-marker"
  const terminal = {
    type: "response.completed",
    sequence_number: 4,
    response: {
      id: "resp_tools",
      object: "response",
      status: "completed",
      output: [
        {
          id: "computer_1",
          call_id: "call_computer",
          type: "computer_call",
          status: "completed",
          action: {
            type: "click",
            button: "left",
            x: 12,
            y: 34,
            private: privateMarker,
          },
          pending_safety_checks: [{ message: privateMarker }],
          private: privateMarker,
        },
        {
          id: "custom_1",
          call_id: "call_custom",
          type: "custom_tool_call",
          name: "shell",
          input: "pwd",
          status: "completed",
          private: privateMarker,
        },
        {
          id: "file_1",
          type: "file_search_call",
          status: "completed",
          queries: ["incident", 7, "timeline"],
          results: [
            {
              file_id: "file_a",
              filename: "incident.txt",
              score: 0.9,
              text: "reviewed excerpt",
              attributes: { private: privateMarker },
              private: privateMarker,
            },
          ],
          private: privateMarker,
        },
        {
          id: "mcp_1",
          call_id: "call_mcp",
          type: "mcp_call",
          name: "lookup",
          arguments: '{"id":1}',
          server_label: "inventory",
          output: "found",
          error: null,
          status: "completed",
          private: privateMarker,
        },
        {
          id: "web_1",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "current status",
            private: privateMarker,
          },
          private: privateMarker,
        },
      ],
      output_text: "",
      usage: null,
      error: null,
      incomplete_details: null,
    },
  }
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data: JSON.stringify(terminal),
  })

  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual(terminal)
  expect(sanitized.data).toContain(privateMarker)
})

test.each([
  {
    name: "missing id",
    response: {
      object: "response",
      status: "completed",
      output: [],
      output_text: "",
      usage: null,
      error: null,
      incomplete_details: null,
    },
  },
  {
    name: "wrong object",
    response: {
      id: "resp_invalid",
      object: "private_object",
      status: "completed",
      output: [],
      output_text: "",
      usage: null,
      error: null,
      incomplete_details: null,
    },
  },
  {
    name: "non-array output",
    response: {
      id: "resp_invalid",
      object: "response",
      status: "completed",
      output: "private-output",
      output_text: "",
      usage: null,
      error: null,
      incomplete_details: null,
    },
  },
  {
    name: "non-string output_text",
    response: {
      id: "resp_invalid",
      object: "response",
      status: "completed",
      output: [],
      output_text: null,
      usage: null,
      error: null,
      incomplete_details: null,
    },
  },
  {
    name: "non-null error",
    response: {
      id: "resp_invalid",
      object: "response",
      status: "completed",
      output: [],
      output_text: "",
      usage: null,
      error: { message: "private-error" },
      incomplete_details: null,
    },
  },
])("preserves parseable completed shape with $name", ({ response }) => {
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 3,
      response,
    }),
  })

  expect(sanitized.event).toBe("response.completed")
  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.completed",
    sequence_number: 3,
    response,
  })
})

test.each([
  { data: "null", name: "null" },
  { data: '"private-terminal-string"', name: "string" },
  { data: "17", name: "number" },
  { data: "true", name: "boolean" },
  { data: '["private-terminal-array"]', name: "array" },
])("reconstructs terminal $name JSON through the direct helper", ({ data }) => {
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.failed",
    data,
  })

  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.failed",
    sequence_number: 0,
    response: {
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    },
  })
  expect(sanitized.data).not.toContain("private-terminal")
})

test("reconstructs malformed terminal JSON through the direct helper", () => {
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.failed",
    data: '{"private":"malformed-terminal-private-marker"',
  })

  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.failed",
    sequence_number: 0,
    response: {
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    },
  })
  expect(sanitized.data).not.toContain("malformed-terminal-private-marker")
})

test.each([
  { data: "", name: "empty" },
  {
    data: '{"private":"completed-malformed-private-marker"',
    name: "malformed",
  },
])("fails closed for response.completed with $name data", ({ data }) => {
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data,
  })

  expect(sanitized.event).toBe("response.failed")
  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.failed",
    sequence_number: 0,
    response: {
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    },
  })
  expect(sanitized.data).not.toContain("completed-malformed-private-marker")
})

test.each([
  {
    data: "",
    event: "error",
    name: "empty error",
    expectedEvent: "error",
    expected: {
      type: "error",
      sequence_number: 0,
      code: "server_error",
      message: "Upstream Responses stream failed.",
      param: null,
      status: 502,
    },
  },
  {
    data: undefined,
    event: "error",
    name: "missing error",
    expectedEvent: "error",
    expected: {
      type: "error",
      sequence_number: 0,
      code: "server_error",
      message: "Upstream Responses stream failed.",
      param: null,
      status: 502,
    },
  },
  {
    data: "",
    event: "response.failed",
    name: "empty response.failed",
    expectedEvent: "response.failed",
    expected: {
      type: "response.failed",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    },
  },
  {
    data: undefined,
    event: "response.failed",
    name: "missing response.failed",
    expectedEvent: "response.failed",
    expected: {
      type: "response.failed",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    },
  },
  {
    data: "",
    event: "response.incomplete",
    name: "empty response.incomplete",
    expectedEvent: "response.incomplete",
    expected: {
      type: "response.incomplete",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    },
  },
  {
    data: undefined,
    event: "response.incomplete",
    name: "missing response.incomplete",
    expectedEvent: "response.incomplete",
    expected: {
      type: "response.incomplete",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    },
  },
  {
    data: "",
    event: "response.completed",
    name: "empty response.completed",
    expectedEvent: "response.failed",
    expected: {
      type: "response.failed",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    },
  },
  {
    data: undefined,
    event: "response.completed",
    name: "missing response.completed",
    expectedEvent: "response.failed",
    expected: {
      type: "response.failed",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    },
  },
])(
  "canonicalizes $name terminal data",
  ({ data, event, expected, expectedEvent }) => {
    const sanitized = sanitizeResponsesStreamEvent({ data, event })

    expect(sanitized.event).toBe(expectedEvent)
    expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual(expected)
  },
)

test("preserves response.completed without a sequence number", () => {
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_missing_sequence",
        object: "response",
        status: "completed",
        output: [],
        output_text: "",
        usage: null,
        error: null,
        incomplete_details: null,
      },
    }),
  })

  expect(sanitized.event).toBe("response.completed")
  expect(JSON.parse(sanitized.data ?? "{}") as { type?: string }).toMatchObject(
    {
      type: "response.completed",
    },
  )
})

test.each([
  { response: {}, name: "missing status" },
  { response: { status: "future_status" }, name: "unknown status" },
  { response: { status: "failed" }, name: "failed status" },
  { response: { status: "incomplete" }, name: "incomplete status" },
  { response: "private-response-string", name: "primitive response" },
])("preserves response.completed with $name", ({ response }) => {
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 4,
      response,
      private: "completed-private-marker",
    }),
  })

  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.completed",
    sequence_number: 4,
    response,
    private: "completed-private-marker",
  })
  expect(sanitized.data).toContain("completed-private-marker")
})

test("fails closed when the terminal event name and JSON type disagree", () => {
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.failed",
      sequence_number: 8,
      response: {
        id: "resp_mismatch",
        object: "response",
        status: "completed",
        output: [],
        output_text: "",
        usage: null,
        error: null,
        incomplete_details: null,
      },
      private: "mismatched-completed-private-marker",
    }),
  })

  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.failed",
    sequence_number: 8,
    response: {
      id: "resp_mismatch",
      object: "response",
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    },
  })
  expect(sanitized.data).not.toContain("mismatched-completed-private-marker")
})

test("stream ID synchronization delegates terminal primitives to sanitization", () => {
  expect(
    JSON.parse(
      fixStreamIds(
        '["stream-sync-private-marker"]',
        "response.completed",
        createStreamIdTracker(),
      ) ?? "",
    ) as unknown,
  ).toEqual({
    type: "response.failed",
    sequence_number: 0,
    response: {
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    },
  })
})

test.each([
  {
    event: "error",
    expected: {
      type: "error",
      sequence_number: 0,
      code: "server_error",
      message: "Upstream Responses stream failed.",
      param: null,
      status: 502,
    },
  },
  {
    event: "response.failed",
    expected: {
      type: "response.failed",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    },
  },
  {
    event: "response.incomplete",
    expected: {
      type: "response.incomplete",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    },
  },
  {
    event: "response.completed",
    expected: {
      type: "response.failed",
      sequence_number: 0,
      response: {
        output: [],
        output_text: "",
        usage: null,
        error: {
          code: "server_error",
          message: "Upstream Responses stream failed.",
          param: null,
          status: 502,
        },
        incomplete_details: null,
      },
    },
  },
])(
  "sanitizes empty $event data before stream ID synchronization",
  ({ event, expected }) => {
    expect(
      JSON.parse(
        fixStreamIds("", event, createStreamIdTracker()) ?? "",
      ) as unknown,
    ).toEqual(expected)
  },
)

test("leaves an empty nonterminal heartbeat unchanged during ID sync", () => {
  expect(
    fixStreamIds("", "response.output_text.delta", createStreamIdTracker()),
  ).toBe("")
})

test("skips malformed nonterminal JSON during stream ID synchronization", () => {
  expect(
    fixStreamIds(
      "{malformed-private-frame",
      "response.output_text.delta",
      createStreamIdTracker(),
    ),
  ).toBeUndefined()
})

test("throws on malformed terminal JSON during stream ID synchronization", () => {
  expect(() =>
    fixStreamIds(
      "{malformed-private-terminal",
      "response.completed",
      createStreamIdTracker(),
    ),
  ).toThrow(SyntaxError)
})

test("stream ID synchronization does not mutate a readonly terminal record", () => {
  const terminal = Object.freeze({
    type: "response.completed",
    sequence_number: 1,
    response: Object.freeze({
      id: "resp_readonly",
      object: "response",
      status: "completed",
      output: Object.freeze([]),
      output_text: "",
      usage: null,
      error: null,
      incomplete_details: null,
    }),
  })

  expect(() =>
    fixStreamIds(
      JSON.stringify(terminal),
      "response.completed",
      createStreamIdTracker(),
    ),
  ).not.toThrow()
  expect(terminal.type).toBe("response.completed")
})

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalIsMultiToken = state.isMultiToken
const addedAccountIds = [2201, 2202, 2211, 2212, 2221, 2222]
let lastRequestBody: Record<string, unknown> | undefined
let requestBodies: Array<Record<string, unknown>>
let queuedResponses: Array<Response>
let capturedAffinity: RoutingAffinity | undefined
let lastUpstreamHeaders: Headers | undefined
const capturedAuthorization: Array<string | undefined> = []

const responsesCapableModels = {
  object: "list" as const,
  data: [
    {
      id: "gpt-4o",
      name: "gpt-4o",
      object: "model" as const,
      version: "test",
      vendor: "openai",
      preview: false,
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt-4o",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

function createSuccessResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "gpt-4o",
      output: [],
      output_text: "",
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )
}

function parseRequestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    return {}
  }

  return JSON.parse(init.body) as Record<string, unknown>
}

const fetchMock = mock((_url: string, init?: RequestInit) => {
  capturedAffinity = getRoutingAffinity()
  lastUpstreamHeaders = new Headers(init?.headers)
  capturedAuthorization.push(
    new Headers(init?.headers).get("authorization") ?? undefined,
  )
  lastRequestBody = parseRequestBody(init)
  requestBodies.push(lastRequestBody)

  return queuedResponses.shift() ?? createSuccessResponse()
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.models = originalModels
  state.isMultiToken = originalIsMultiToken
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

afterEach(() => {
  for (const accountId of addedAccountIds)
    tokenPool.removeAccountForTest(accountId)
})

beforeEach(() => {
  fetchMock.mockClear()
  lastRequestBody = undefined
  requestBodies = []
  queuedResponses = []
  capturedAffinity = undefined
  lastUpstreamHeaders = undefined
  capturedAuthorization.length = 0
  state.models = originalModels
  state.isMultiToken = originalIsMultiToken
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  resetRoutingTelemetryForTest()
  setModelRedirectsForTest([])
  setModelRoutingOverridesForTest({})
  setModelSettingsForTest([])
})

test("removes service tier from already-prepared Responses transport payloads", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: "hello",
        service_tier: "priority",
      },
      {
        vision: false,
        initiator: "user",
        prepared: true,
      },
    ),
  )

  expect(requestBodies).toHaveLength(1)
  expect(requestBodies[0]).not.toHaveProperty("service_tier")
})

test("retries one exact unsupported Responses control after store enforcement", async () => {
  queuedResponses.push(
    Response.json(
      {
        error: {
          code: "invalid_request_body",
          message:
            "Unsupported parameter: 'top_p' is not supported with this model.",
        },
      },
      { status: 400 },
    ),
    createSuccessResponse(),
  )
  const payload = {
    model: "gpt-4o",
    input: "hello",
    top_p: 0.9,
    temperature: 0.2,
  } as ResponsesPayload
  const source = structuredClone(payload)

  await seedProtocolDatabase().then(() =>
    createResponses(payload, {
      vision: false,
      initiator: "user",
      copilotSessionToken: "responses-session-fixed",
    }),
  )

  expect(payload).toEqual(source)
  expect(requestBodies).toHaveLength(2)
  expect(requestBodies[0]).toMatchObject({ store: false, top_p: 0.9 })
  expect(requestBodies[1]).toEqual(
    Object.fromEntries(
      Object.entries(requestBodies[0]).filter(([key]) => key !== "top_p"),
    ),
  )
  expect(requestBodies[1]).not.toHaveProperty("top_p")
})

test("preserves native Responses failure status, headers, and exact route bytes", async () => {
  state.models = responsesCapableModels
  const body = new TextEncoder().encode('{"error":"responses"}\r\n  ')
  const createUpstream = () =>
    new Response(body.slice(), {
      status: 409,
      headers: { "content-type": "application/problem+json" },
    })
  const upstream = createUpstream()
  queuedResponses.push(upstream)

  const error = await seedProtocolDatabase()
    .then(() =>
      createResponses(
        { model: "gpt-4o", input: "hello" },
        { vision: false, initiator: "user" },
      ),
    )
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  const failedResponse = (error as HTTPError).response
  expect(failedResponse.status).toBe(upstream.status)
  expect(failedResponse.statusText).toBe(upstream.statusText)
  expect(Object.fromEntries(failedResponse.headers)).toEqual(
    Object.fromEntries(upstream.headers),
  )
  expect(failedResponse.bodyUsed).toBe(false)
  expect(
    Array.from(new Uint8Array(await failedResponse.arrayBuffer())),
  ).toEqual(Array.from(body))

  queuedResponses.push(createUpstream())
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", input: "hello" }),
    }),
  )
  expect(response.status).toBe(409)
  expect(response.headers.get("content-type")).toBe("application/problem+json")
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
    Array.from(body),
  )
})

const sessionToken = (payload: Record<string, unknown>): string =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`

const binarySessionToken = (payload: Record<string, unknown>): string => {
  const opaque = Buffer.from([0xff, 0, 0x80]).toString("base64url")
  return `${opaque}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${opaque}`
}

function invalidSessionTokens(model: string): Array<string> {
  const payload = Buffer.from(
    JSON.stringify({ selected_model: model }),
  ).toString("base64url")
  const noncanonicalPayload = Buffer.from(
    JSON.stringify({ selected_model: model, padding: "x" }),
  ).toString("base64url")
  if (noncanonicalPayload.length % 4 === 0) {
    throw new Error("Expected unused terminal base64url bits")
  }
  const decoded = Buffer.from(noncanonicalPayload, "base64url")
  const noncanonical = Array.from(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  )
    .map((character) => `${noncanonicalPayload.slice(0, -1)}${character}`)
    .find(
      (candidate) =>
        candidate !== noncanonicalPayload
        && Buffer.from(candidate, "base64url").equals(decoded),
    )
  if (!noncanonical) throw new Error("Expected a noncanonical token payload")
  return [
    `e%0.${payload}.c2ln`,
    `e30=.${payload}.c2ln`,
    `A.${payload}.c2ln`,
    `Zh.${payload}.c2ln`,
    `e30.${payload}.Zh`,
    `e30.${noncanonical}.c2ln`,
    `e30.${"A".repeat(16 * 1024)}.c2ln`,
    sessionToken({
      selected_model: { model },
      available_models: { 0: model },
    }),
  ]
}

test("forwards only matching model-scoped session tokens on Responses inference", async () => {
  state.models = responsesCapableModels
  const matchingToken = sessionToken({ selected_model: "gpt-4o" })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": matchingToken,
      },
      body: JSON.stringify({ model: "gpt-4o", input: "hello" }),
    }),
  )
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBe(matchingToken)

  const binaryToken = binarySessionToken({ selected_model: "gpt-4o" })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": binaryToken,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "binary opaque segments",
      }),
    }),
  )
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBe(binaryToken)

  for (const token of [
    sessionToken({ selected_model: "different-model" }),
    "malformed-token",
    ...invalidSessionTokens("gpt-4o"),
  ]) {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
          "copilot-session-token": token,
        },
        body: JSON.stringify({ model: "gpt-4o", input: "hello" }),
      }),
    )
    expect(response.status).toBe(200)
    expect(lastUpstreamHeaders?.get("copilot-session-token")).toBeNull()
    expect(lastUpstreamHeaders?.get("authorization")).toBe(
      "Bearer copilot-token",
    )
  }

  const redirectedModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-redirected",
    name: "GPT Redirected",
  }
  state.models = { object: "list", data: [redirectedModel] }
  setModelRedirectsForTest([
    {
      id: "responses-session-token-redirect",
      sourceModel: "gpt-4o",
      targetModel: "gpt-redirected",
      enabled: true,
    },
  ])
  const redirectedToken = sessionToken({
    selected_model: "gpt-redirected",
    available_models: ["gpt-4o", "gpt-redirected"],
  })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": redirectedToken,
      },
      body: JSON.stringify({ model: "gpt-4o", input: "hello" }),
    }),
  )
  expect(lastRequestBody?.model).toBe("gpt-redirected")
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBeNull()

  setModelRedirectsForTest([])
  const aliasModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-4.1",
    name: "GPT 4.1",
  }
  state.models = { object: "list", data: [aliasModel] }
  const aliasToken = sessionToken({ selected_model: "gpt-4.1" })
  await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": aliasToken,
      },
      body: JSON.stringify({ model: "gpt-4-1", input: "ordinary alias" }),
    }),
  )
  expect(lastRequestBody?.model).toBe("gpt-4.1")
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBe(aliasToken)

  setModelRedirectsForTest([
    {
      id: "responses-alias-chain-1",
      sourceModel: "gpt-4.1",
      targetModel: "gpt-alias-middle",
      enabled: true,
    },
    {
      id: "responses-alias-chain-2",
      sourceModel: "gpt-alias-middle",
      targetModel: "gpt-4-1",
      enabled: true,
    },
  ])
  await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": aliasToken,
      },
      body: JSON.stringify({
        model: "gpt-4-1",
        input: "configured alias redirect",
      }),
    }),
  )
  expect(lastRequestBody?.model).toBe("gpt-4.1")
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBeNull()
})

test("routes repeated Responses metadata sessions to stable accounts", async () => {
  const modelId = "responses-metadata-routing-model"
  const model = {
    ...responsesCapableModels.data[0],
    id: modelId,
    name: modelId,
  }
  state.models = { object: "list", data: [model] }
  for (const [id, token] of [
    [2201, "responses-token-one"],
    [2202, "responses-token-two"],
  ] as const) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = token
    account.healthy = true
    account.models = new Set([modelId])
    account.modelsData = [model]
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true
  const keys: Array<string> = []
  for (let index = 0; index < 100 && keys.length < 2; index++) {
    const key = `responses-session-${index}`
    const accountId = tokenPool.getAccountForModelBySession(modelId, key)?.id
    if (
      accountId !== undefined
      && !keys.some(
        (existing) =>
          tokenPool.getAccountForModelBySession(modelId, existing)?.id
          === accountId,
      )
    ) {
      keys.push(key)
    }
  }
  expect(keys).toHaveLength(2)
  const request = (key: string) =>
    seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          input: "hello",
          client_metadata: { session_id: key },
        }),
      }),
    )

  await request(keys[0] ?? "")
  await request(keys[0] ?? "")
  await request(keys[1] ?? "")
  await request(keys[1] ?? "")

  const expected = keys.map(
    (key) =>
      `Bearer ${tokenPool.getAccountForModelBySession(modelId, key)?.copilotToken}`,
  )
  expect(capturedAuthorization).toEqual([
    expected[0],
    expected[0],
    expected[1],
    expected[1],
  ])
  expect(expected[0]).not.toBe(expected[1])
  const usage = getRoutingTelemetrySnapshot({
    accounts: tokenPool.getAllAccounts().map((account) => ({
      accountType: account.accountType,
      healthy: account.healthy,
      id: account.id,
    })),
    multiToken: true,
    window: "1h",
  })
  expect(usage.selectionModes.sticky).toBe(4)
})

test("returns a structured conflict when a bound Responses account still rejects the session", async () => {
  const modelId = "responses-session-account-rejected"
  const model = {
    ...responsesCapableModels.data[0],
    id: modelId,
    name: modelId,
  }
  state.models = { data: [model], object: "list" }
  for (const [id, token] of [
    [2211, "responses-bound-token"],
    [2212, "responses-alternate-token"],
  ] as const) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = token
    account.healthy = true
    account.models = new Set([modelId])
    account.modelsData = [model]
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true
  const sessionId = Array.from(
    { length: 1000 },
    (_, index) => `responses-rejected-session-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountForModelBySession(modelId, candidate)?.id === 2211,
  )
  if (!sessionId) throw new TypeError("Expected affinity key for account 2211")
  queuedResponses.push(
    new Response("Unauthorized", { status: 401 }),
    Response.json({
      expires_at: 1_900_000_000,
      refresh_in: 1800,
      token: "responses-refreshed-bound-token",
    }),
    Response.json({ data: [model], object: "list" }),
    new Response("Unauthorized", { status: 401 }),
  )

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_metadata: { session_id: sessionId },
        input: "continue the conversation",
        model: modelId,
      }),
    }),
  )
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(409)
  expect(body).toMatchObject({
    error: {
      account_id: 2211,
      code: "session_account_rejected",
      type: "session_affinity_error",
    },
  })
  expect(JSON.stringify(body)).not.toContain(sessionId)
  expect(capturedAuthorization).not.toContain(
    "Bearer responses-alternate-token",
  )
})

test("installs Responses client metadata affinity before provider dispatch", async () => {
  state.models = responsesCapableModels
  for (const clientMetadata of [
    { session_id: "responses-object-session" },
    JSON.stringify({ session_id: "responses-string-session" }),
  ]) {
    const expectedKey =
      typeof clientMetadata === "string" ?
        "responses-string-session"
      : "responses-object-session"
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          input: "hello",
          client_metadata: clientMetadata,
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(capturedAffinity).toEqual({
      key: expectedKey,
      source: "codex_metadata",
    })
  }
})

test("routes Codex forks through the parent account and upstream session", async () => {
  const modelId = "responses-fork-affinity-model"
  const model = {
    ...responsesCapableModels.data[0],
    id: modelId,
    name: modelId,
  }
  state.models = { data: [model], object: "list" }
  for (const [id, token] of [
    [2201, "responses-fork-parent-token"],
    [2202, "responses-fork-child-token"],
  ] as const) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = token
    account.healthy = true
    account.models = new Set([modelId])
    account.modelsData = [model]
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "session-id": "fork-child-1",
      },
      body: JSON.stringify({
        model: modelId,
        input: "continue the fork",
        client_metadata: {
          session_id: "fork-child-1",
          thread_id: "fork-child-1",
          "x-codex-turn-metadata": JSON.stringify({
            forked_from_thread_id: "fork-parent-0",
          }),
        },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(capturedAffinity).toEqual({
    key: "fork-parent-0",
    source: "codex_thread",
  })
  expect(capturedAuthorization).toEqual(["Bearer responses-fork-parent-token"])
  expect(lastUpstreamHeaders?.get("x-client-session-id")).toBe(
    "81e3167a-de1a-5ffa-8c20-f832dc0e2909",
  )
  expect(lastUpstreamHeaders?.get("x-interaction-id")).toBe(
    "81e3167a-de1a-5ffa-8c20-f832dc0e2909",
  )
})

test("keeps Responses header affinity over metadata and ignores malformed metadata", async () => {
  state.models = responsesCapableModels
  await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "x-client-session-id": "header-session",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "hello",
        client_metadata: { session_id: "body-session" },
      }),
    }),
  )
  expect(capturedAffinity).toEqual({
    key: "header-session",
    source: "copilot_session",
  })

  await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "hello",
        client_metadata: "not json",
      }),
    }),
  )
  expect(capturedAffinity).toBeUndefined()
})

test("preserves native Responses state, context, future fields, and tools", async () => {
  state.models = responsesCapableModels
  const payload = {
    model: "gpt-4o",
    input: [{ type: "future_input", future: { nested: true } }],
    future_top_level: { retained: [1, 2] },
    background: { future: true },
    previous_response_id: "resp_previous",
    service_tier: { future: "priority" },
    context_management: { future: "shape" },
    tools: [
      { name: "safe malformed evidence" },
      { type: "mcp", server_label: "native", future: { retained: true } },
    ],
    store: true,
  }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies).toHaveLength(1)
  expect(requestBodies[0]).toEqual({
    model: "gpt-4o",
    input: payload.input,
    future_top_level: payload.future_top_level,
    background: payload.background,
    previous_response_id: payload.previous_response_id,
    context_management: payload.context_management,
    store: false,
    tools: [
      { type: "mcp", server_label: "native", future: { retained: true } },
    ],
  })
  expect(requestBodies[0]).not.toHaveProperty("service_tier")
})

test("routes priority Responses requests to an available fast model", async () => {
  const normalModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
  }
  const fastModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-5.6-sol-fast",
    name: "GPT-5.6 Sol Fast",
  }
  state.models = { object: "list", data: [normalModel, fastModel] }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: normalModel.id,
        input: "Hello",
        service_tier: "priority",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies).toHaveLength(1)
  expect(requestBodies[0]?.model).toBe(fastModel.id)
  expect(requestBodies[0]).not.toHaveProperty("service_tier")
})

test("removes non-priority service tiers without changing the model", async () => {
  const normalModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-service-tier-standard",
    name: "GPT Service Tier Standard",
  }
  state.models = { object: "list", data: [normalModel] }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: normalModel.id,
        input: "Hello",
        service_tier: "standard",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies[0]?.model).toBe(normalModel.id)
  expect(requestBodies[0]).not.toHaveProperty("service_tier")
})

test("keeps the normal model when no fast variant is available", async () => {
  const normalModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-no-fast",
    name: "GPT Priority No Fast",
  }
  state.models = { object: "list", data: [normalModel] }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: normalModel.id,
        input: "Hello",
        service_tier: "priority",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies[0]?.model).toBe(normalModel.id)
  expect(requestBodies[0]).not.toHaveProperty("service_tier")
})

test("applies priority fast routing after configured model redirects", async () => {
  const requestedModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-source",
    name: "GPT Priority Source",
  }
  const redirectedModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-target",
    name: "GPT Priority Target",
  }
  const fastModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-target-fast",
    name: "GPT Priority Target Fast",
  }
  state.models = {
    object: "list",
    data: [requestedModel, redirectedModel, fastModel],
  }
  setModelRedirectsForTest([
    {
      id: "priority-target-redirect",
      sourceModel: requestedModel.id,
      sourceEffort: "all",
      targetModel: redirectedModel.id,
      enabled: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: requestedModel.id,
        input: "Hello",
        service_tier: "priority",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies[0]?.model).toBe(fastModel.id)
  expect(requestBodies[0]).not.toHaveProperty("service_tier")
})

test("does not change reasoning effort when routing to the fast model", async () => {
  const normalModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-effort",
    name: "GPT Priority Effort",
    capabilities: {
      ...responsesCapableModels.data[0].capabilities,
      supports: { reasoning_effort: ["high"] },
    },
  }
  const fastModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-effort-fast",
    name: "GPT Priority Effort Fast",
    capabilities: {
      ...responsesCapableModels.data[0].capabilities,
      supports: { reasoning_effort: ["low"] },
    },
  }
  state.models = { object: "list", data: [normalModel, fastModel] }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: normalModel.id,
        input: "Hello",
        reasoning: { effort: "high" },
        service_tier: "priority",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies[0]?.model).toBe(fastModel.id)
  expect(requestBodies[0]?.reasoning).toMatchObject({ effort: "high" })
})

test("keeps the normal model when every fast-model account is disabled", async () => {
  const normalModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-disabled",
    name: "GPT Priority Disabled",
  }
  const fastModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-disabled-fast",
    name: "GPT Priority Disabled Fast",
  }
  state.models = { object: "list", data: [normalModel, fastModel] }
  const account = tokenPool.addAccount("github-2221", "individual", 2221)
  account.copilotToken = "responses-priority-disabled-token"
  account.healthy = true
  account.models = new Set([normalModel.id, fastModel.id])
  account.modelsData = [normalModel, fastModel]
  setModelRoutingOverridesForTest({ [fastModel.id]: { "2221": false } })
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: normalModel.id,
        input: "Hello",
        service_tier: "priority",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies[0]?.model).toBe(normalModel.id)
  expect(requestBodies[0]).not.toHaveProperty("service_tier")
})

test("keeps the normal model when a fast catalog entry has no enabled account", async () => {
  const normalModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-unroutable",
    name: "GPT Priority Unroutable",
  }
  const fastModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-unroutable-fast",
    name: "GPT Priority Unroutable Fast",
  }
  state.models = { object: "list", data: [normalModel, fastModel] }
  const account = tokenPool.addAccount("github-2222", "individual", 2222)
  account.copilotToken = "responses-priority-unroutable-token"
  account.healthy = true
  account.models = new Set([normalModel.id])
  account.modelsData = [normalModel]
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: normalModel.id,
        input: "Hello",
        service_tier: "priority",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies[0]?.model).toBe(normalModel.id)
  expect(requestBodies[0]).not.toHaveProperty("service_tier")
})

test("does not append a second fast suffix", async () => {
  const fastModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-already-fast",
    name: "GPT Already Fast",
  }
  state.models = { object: "list", data: [fastModel] }

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: fastModel.id,
        input: "Hello",
        service_tier: "priority",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies[0]?.model).toBe(fastModel.id)
  expect(requestBodies[0]).not.toHaveProperty("service_tier")
})

test("suppresses model-scoped session tokens after priority fast routing", async () => {
  const normalModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-session",
    name: "GPT Priority Session",
  }
  const fastModel = {
    ...responsesCapableModels.data[0],
    id: "gpt-priority-session-fast",
    name: "GPT Priority Session Fast",
  }
  state.models = { object: "list", data: [normalModel, fastModel] }
  const fastToken = sessionToken({ selected_model: fastModel.id })

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        "copilot-session-token": fastToken,
      },
      body: JSON.stringify({
        model: normalModel.id,
        input: "Hello",
        service_tier: "priority",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(requestBodies[0]?.model).toBe(fastModel.id)
  expect(lastUpstreamHeaders?.get("copilot-session-token")).toBeNull()
})

test("routes priority mode before selecting a chat fallback endpoint", async () => {
  const normalModel = {
    ...responsesCapableModels.data[0],
    id: "chat-priority-model",
    name: "Chat Priority Model",
    supported_endpoints: ["/chat/completions"],
  }
  const fastModel = {
    ...normalModel,
    id: "chat-priority-model-fast",
    name: "Chat Priority Model Fast",
  }
  state.models = { object: "list", data: [normalModel, fastModel] }
  queuedResponses.push(
    Response.json({
      id: "chatcmpl_priority",
      object: "chat.completion",
      created: 1,
      model: fastModel.id,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  )

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: normalModel.id,
        input: "Hello",
        service_tier: "priority",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastRequestBody?.model).toBe(fastModel.id)
  expect(lastRequestBody).not.toHaveProperty("service_tier")
})

test.each([
  ["store", { store: true }],
  ["background", { background: true }],
  ["previous_response_id", { previous_response_id: "resp_previous" }],
  ["service_tier", { service_tier: "priority" }],
] as const)(
  "omits stateful control %s before a chat-only Responses fallback",
  async (param, extra) => {
    state.models = {
      object: "list",
      data: [
        {
          ...responsesCapableModels.data[0],
          id: "chat-only-responses-model",
          name: "chat-only-responses-model",
          supported_endpoints: ["/chat/completions"],
        },
      ],
    }
    queuedResponses.push(
      Response.json({
        id: "chatcmpl_best_effort",
        object: "chat.completion",
        created: 1,
        model: "chat-only-responses-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    )

    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "chat-only-responses-model",
          input: "Hello",
          ...extra,
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastRequestBody).toMatchObject({
      model: "chat-only-responses-model",
      messages: [{ role: "user", content: "Hello" }],
    })
    expect(lastRequestBody).not.toHaveProperty(param)
  },
)

test("contextualizes omitted function output before chat fallback reaches upstream", async () => {
  const modelId = "chat-only-missing-function-output"
  state.models = {
    object: "list",
    data: [
      {
        ...responsesCapableModels.data[0],
        id: modelId,
        name: modelId,
        supported_endpoints: ["/chat/completions"],
      },
    ],
  }
  queuedResponses.push(
    Response.json({
      id: "chatcmpl_missing_output",
      object: "chat.completion",
      created: 1,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  )

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        input: [{ type: "function_call_output", call_id: "call_1" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(lastRequestBody)).toContain("Unpaired tool result")
})

test("preserves prompt and conversation_id when sending Responses API requests", async () => {
  const prompt = {
    id: "pmpt_123",
    variables: { task: "greeting" },
  }

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        prompt,
        conversation_id: "conv_abc",
      } as {
        model: string
        prompt: {
          id: string
          variables: { task: string }
        }
        conversation_id: string
      },
      {
        vision: false,
        initiator: "user",
      },
    ),
  )

  expect(lastRequestBody?.prompt).toEqual(prompt)
  expect(lastRequestBody?.conversation_id).toBe("conv_abc")
})

test("fits explicitly marked compaction payloads at the transport boundary", async () => {
  const oversizedOutput =
    "BEGIN-TRANSPORT\n"
    + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
    + "\nEND-TRANSPORT"

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_transport",
            name: "exec",
            input: "run transport diagnostic",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_transport",
            output: oversizedOutput,
          },
        ],
      },
      {
        compaction: true,
        vision: false,
        initiator: "user",
      },
    ),
  )

  const serialized = JSON.stringify(lastRequestBody)
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    COMPACTION_PAYLOAD_MAX_BYTES,
  )
  expect(serialized).toContain("run transport diagnostic")
  expect(serialized).toContain("BEGIN-TRANSPORT")
  expect(serialized).toContain("END-TRANSPORT")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
  expect(oversizedOutput).toEndWith("END-TRANSPORT")
})

test("injects runtime-style default reasoning settings for direct Responses requests", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: "Hello",
      } as {
        model: string
        input: string
      },
      {
        vision: false,
        initiator: "user",
      },
    ),
  )

  expect(lastRequestBody?.store).toBe(false)
  expect(lastRequestBody?.reasoning).toEqual({
    effort: "medium",
    summary: "auto",
  })
  expect(lastRequestBody?.include).toEqual(["reasoning.encrypted_content"])
})

test("clamps Responses max_output_tokens to Copilot's minimum", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-5.5",
        input: "Probe the selected model.",
        max_output_tokens: 1,
      },
      {
        vision: false,
        initiator: "user",
      },
    ),
  )

  expect(lastRequestBody?.max_output_tokens).toBe(16)
})

test("normalizes direct Responses max reasoning aliases", () => {
  const payload = {
    model: "claude-opus-4.8",
    input: "Hello",
    reasoning_effort: "max",
  } as ResponsesPayload

  const effort = normalizeResponsesReasoning(payload)

  expect(effort).toBe("max")
  expect(payload.reasoning?.effort).toBe("max")
  expect((payload as Record<string, unknown>).reasoning_effort).toBeUndefined()
})

test("preserves explicit string effort for implicit-default Responses models", async () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "claude-implicit-medium",
        input: "Hello",
        reasoning: { effort: "high" },
      } as {
        model: string
        input: string
        reasoning: { effort: "high" }
      },
      {
        vision: false,
        initiator: "user",
      },
    ),
  )

  expect(lastRequestBody?.reasoning).toEqual({
    effort: "high",
    summary: "auto",
  })
})

test("preserves explicit none for implicit-default Responses models", async () => {
  const model = {
    ...responsesCapableModels.data[0],
    id: "gpt-5.6-implicit-medium",
    name: "gpt-5.6-implicit-medium",
  }
  state.models = { object: "list", data: [model] }
  setModelSettingsForTest([
    {
      model: model.id,
      supportedReasoningEfforts: ["none", "medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        input: "Hello",
        reasoning: { effort: "none" },
        temperature: 0.3,
        top_p: 0.8,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastRequestBody?.reasoning).toEqual({ effort: "none" })
  expect(lastRequestBody?.include ?? []).not.toContain(
    "reasoning.encrypted_content",
  )
  expect(lastRequestBody?.temperature).toBe(0.3)
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("keeps numeric Responses redirects model-only across the HTTP route", async () => {
  const sourceModel = {
    ...responsesCapableModels.data[0],
    id: "numeric-route-source",
    name: "numeric-route-source",
  }
  const middleModel = {
    ...responsesCapableModels.data[0],
    id: "numeric-route-middle",
    name: "numeric-route-middle",
  }
  const finalModel = {
    ...responsesCapableModels.data[0],
    id: "numeric-route-final",
    name: "numeric-route-final",
  }
  state.models = {
    object: "list",
    data: [sourceModel, middleModel, finalModel],
  }
  setModelRedirectsForTest([
    {
      id: "numeric-route-source-to-middle",
      sourceModel: sourceModel.id,
      sourceEffort: "default",
      targetModel: middleModel.id,
      targetEffort: "high",
      enabled: true,
    },
    {
      id: "numeric-route-middle-high-to-wrong",
      sourceModel: middleModel.id,
      sourceEffort: "high",
      targetModel: "wrong-named-route-target",
      targetEffort: "max",
      enabled: true,
    },
    {
      id: "numeric-route-middle-default-to-final",
      sourceModel: middleModel.id,
      sourceEffort: "default",
      targetModel: finalModel.id,
      targetEffort: "xhigh",
      enabled: true,
    },
  ])
  const infoSpy = spyOn(console, "info")

  try {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: sourceModel.id,
          input: "Hello",
          reasoning: { effort: 2048 },
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(lastRequestBody?.model).toBe(finalModel.id)
    expect(lastRequestBody?.reasoning).toEqual({
      effort: 2048,
      summary: "auto",
    })
    const redirectTelemetry = infoSpy.mock.calls
      .flat()
      .filter(
        (value): value is string =>
          typeof value === "string" && value.includes("model_redirect"),
      )
      .join("\n")
    expect(redirectTelemetry).toContain(
      `${sourceModel.id} -> ${middleModel.id} -> ${finalModel.id}`,
    )
    expect(redirectTelemetry).not.toContain(":high")
    expect(redirectTelemetry).not.toContain(":max")
    expect(redirectTelemetry).not.toContain(":xhigh")
  } finally {
    infoSpy.mockRestore()
  }
})

test("overrides Responses verbosity without replacing other text controls", async () => {
  state.models = responsesCapableModels
  setModelRedirectsForTest([
    {
      id: "responses-verbosity-only",
      sourceModel: "gpt-4o",
      sourceEffort: "all",
      targetModel: "gpt-4o",
      targetVerbosity: "high",
      enabled: true,
    },
  ])

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "Explain the result.",
        text: {
          verbosity: "low",
          format: { type: "json_object" },
        },
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastRequestBody?.model).toBe("gpt-4o")
  expect(lastRequestBody?.text).toEqual({
    verbosity: "high",
    format: { type: "json_object" },
  })
})

test("dispatches zero from the top-level Responses reasoning alias", async () => {
  state.models = responsesCapableModels

  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "Hello",
        reasoning_effort: 0,
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(lastRequestBody?.reasoning).toEqual({ effort: 0, summary: "auto" })
})

for (const model of ["gpt-5.4-mini", "gpt-5.5"]) {
  test(`omits built-in unsupported request parameters for ${model} Responses models`, async () => {
    await seedProtocolDatabase().then(() =>
      createResponses(
        {
          model,
          input: "Hello",
          temperature: 0.3,
          top_p: 0.8,
        },
        {
          vision: false,
          initiator: "user",
        },
      ),
    )

    expect(lastRequestBody).not.toHaveProperty("temperature")
    expect(lastRequestBody).not.toHaveProperty("top_p")
  })
}

test("keeps supported request parameters for other Responses models", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: "Hello",
        temperature: 0.3,
        top_p: 0.8,
      },
      {
        vision: false,
        initiator: "user",
      },
    ),
  )

  expect(lastRequestBody?.temperature).toBe(0.3)
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("omits configured unsupported request parameters for Responses models", async () => {
  setModelSettingsForTest([
    {
      model: "no-temperature-model",
      unsupportedRequestParameters: ["temperature"],
    },
  ])

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "no-temperature-model",
        input: "Hello",
        temperature: 0.3,
        top_p: 0.8,
      },
      {
        vision: false,
        initiator: "user",
      },
    ),
  )

  expect(lastRequestBody).not.toHaveProperty("temperature")
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("normalizes Responses function tool parameter schemas before forwarding", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-4o",
    input: "Hello",
    tools: [
      {
        type: "function",
        name: "mcp__pencil__get_style_guide_tags",
        description: "Fetch style guide tags",
        parameters: {},
        strict: false,
      },
      {
        type: "function",
        name: "mcp__pencil__get_style_guide",
        parameters: { type: "object" },
        strict: false,
      },
    ],
  }

  await seedProtocolDatabase().then(() =>
    createResponses(payload, {
      vision: false,
      initiator: "user",
    }),
  )

  expect(lastRequestBody?.tools).toEqual([
    {
      type: "function",
      name: "mcp__pencil__get_style_guide_tags",
      description: "Fetch style guide tags",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
    {
      type: "function",
      name: "mcp__pencil__get_style_guide",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ])
})

test("preserves optional and open json_schema response format object schemas", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: "Extract entities.",
        text: {
          format: {
            type: "json_schema",
            name: "ExtractedEntities",
            schema: {
              type: "object",
              properties: {
                episode_indices: {
                  type: "array",
                  items: { type: "number" },
                },
                entities: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      type: { type: "string" },
                    },
                    required: ["name", "type"],
                  },
                },
              },
              required: ["entities"],
            },
          },
        },
      },
      {
        vision: false,
        initiator: "user",
      },
    ),
  )

  expect(lastRequestBody?.text).toEqual({
    format: {
      type: "json_schema",
      name: "ExtractedEntities",
      schema: {
        type: "object",
        properties: {
          episode_indices: {
            type: "array",
            items: { type: "number" },
          },
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
              },
              required: ["name", "type"],
            },
          },
        },
        required: ["entities"],
      },
    },
  })
})

test("adds JSON mode input instruction when input lacks json", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: "Extract entities.",
        instructions: "Return only JSON.",
        text: {
          format: { type: "json_object" },
        },
      },
      {
        vision: false,
        initiator: "user",
      },
    ),
  )

  expect(lastRequestBody?.input).toEqual([
    {
      type: "message",
      role: "developer",
      content: "Respond with JSON.",
    },
    {
      type: "message",
      role: "user",
      content: "Extract entities.",
    },
  ])
  expect(lastRequestBody?.instructions).toBe("Return only JSON.")
})

test("does not add JSON mode input instruction when input already mentions json", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: [
          {
            type: "message",
            role: "user",
            content: "Return JSON.",
          },
        ],
        text: {
          format: { type: "json_object" },
        },
      },
      {
        vision: false,
        initiator: "user",
      },
    ),
  )

  expect(lastRequestBody?.input).toEqual([
    {
      type: "message",
      role: "user",
      content: "Return JSON.",
    },
  ])
})

test("does not mutate and retry a changed-ceiling upstream 413", async () => {
  queuedResponses.push(
    new Response("payload too large", {
      status: 413,
      headers: { "content-type": "text/plain" },
    }),
    createSuccessResponse(),
  )

  const error = await seedProtocolDatabase()
    .then(() =>
      createResponses(
        {
          model: "gpt-4o",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Describe this image" },
                {
                  type: "input_image",
                  image_url: "data:image/png;base64,abc",
                  detail: "high",
                },
              ],
            },
          ],
        } as {
          model: string
          input: Array<{
            role: string
            content: Array<
              | { type: "input_text"; text: string }
              | { type: "input_image"; image_url: string; detail: string }
            >
          }>
        },
        {
          vision: true,
          initiator: "user",
        },
      ),
    )
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).response.status).toBe(413)
  expect(requestBodies).toHaveLength(1)
  expect(requestBodies[0]?.input).toEqual([
    {
      role: "user",
      content: [
        { type: "input_text", text: "Describe this image" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,abc",
          detail: "high",
        },
      ],
    },
  ])
  const usage = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(usage.totals).toMatchObject({
    retries: 0,
    upstreamCalls: 1,
  })
  expect(
    usage.selectionModes.sticky
      + usage.selectionModes.default
      + usage.selectionModes.single,
  ).toBe(1)
})

test("does not retry changed-ceiling 413 Responses requests with image-only input", async () => {
  queuedResponses.push(
    new Response("payload too large", {
      status: 413,
      headers: { "content-type": "text/plain" },
    }),
    createSuccessResponse(),
  )

  const error = await seedProtocolDatabase()
    .then(() =>
      createResponses(
        {
          model: "gpt-4o",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: "data:image/png;base64,abc",
                  detail: "high",
                },
              ],
            },
          ],
        } as {
          model: string
          input: Array<{
            role: string
            content: Array<{
              type: "input_image"
              image_url: string
              detail: string
            }>
          }>
        },
        {
          vision: true,
          initiator: "user",
        },
      ),
    )
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).response.status).toBe(413)
  expect(requestBodies).toHaveLength(1)
})
