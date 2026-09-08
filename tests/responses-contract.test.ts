/* eslint-disable max-lines -- current Responses contract matrix stays together */
import { expect, test } from "bun:test"

import type { CopilotContractNormalizationClass } from "~/lib/copilot-contract-observability"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { LocalHTTPError } from "~/lib/error"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { snapshotPlainDataRecord } from "~/lib/plain-data-snapshot"
import {
  applyResponsesReasoningDefaults,
  finalizeNativeResponsesRequest,
  finalizeResponsesRequest,
  prepareResponsesRequest,
} from "~/services/copilot/responses-contract"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

function prepareLegacyResponsesRequestForTest(payload: ResponsesPayload) {
  return finalizeResponsesRequest(payload, { implicitDefault: false })
}

function captureValidationError(payload: ResponsesPayload): LocalHTTPError {
  try {
    prepareLegacyResponsesRequestForTest(payload)
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    return error as LocalHTTPError
  }
  throw new Error("Expected Responses validation error")
}

const LEGACY_RESPONSES_TOOL_TYPES = [
  "code_interpreter",
  "computer_use",
  "computer_use_preview",
  "file_search",
  "local_shell",
  "mcp",
  "mcp_list_tools",
]

const FORWARDED_RESPONSES_TOOLS = [
  "function",
  "custom",
  "namespace",
  "shell",
  "apply_patch",
  "programmatic_tool_calling",
  "web_search",
  "computer",
  "image_generation",
  "client_future_tool",
]

function createDeepRecord(): Record<string, unknown> {
  let nested: Record<string, unknown> = { value: "leaf" }
  for (let index = 0; index < 24; index += 1) nested = { nested }
  return nested
}

test("preserves the reviewed current Responses field inventory", () => {
  const result = prepareLegacyResponsesRequestForTest({
    model: "gpt-5.6-sol",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "stable prefix",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
    ],
    context_management: [{ type: "truncate" }],
    truncation: "auto",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "in_memory",
    metadata: { trace: "value" },
    user: "user-1",
    snippy: { enabled: false },
  })
  expect(result.body).toMatchObject({
    context_management: [{ type: "truncate" }],
    truncation: "auto",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "in_memory",
    metadata: { trace: "value" },
    user: "user-1",
    snippy: { enabled: false },
  })
  expect(JSON.stringify(result.body)).toContain("prompt_cache_breakpoint")
})

test("accepts a deep, long Responses source while generic snapshots stay strict", () => {
  const payload = {
    model: "gpt-current",
    input: Array.from({ length: 2_049 }, () => ({
      role: "user",
      content: createDeepRecord(),
    })),
  }

  expect(prepareResponsesRequest(payload).source.input).toHaveLength(2_049)
  expect(snapshotPlainDataRecord(payload)).toBeUndefined()
})

test("preserves more than 2,048 safe Responses tools in the request snapshot", () => {
  const tools = Array.from({ length: 2_049 }, (_, index) => ({
    type: "function",
    name: `tool_${index}`,
  }))

  const prepared = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    tools,
  })

  expect(prepared.source.tools).toEqual(tools)
})

test("rejects Responses tool arrays above the request snapshot boundary", () => {
  const tools = Array.from({ length: 65_537 }, () => ({ type: "function" }))

  expect(() =>
    prepareResponsesRequest({
      model: "gpt-current",
      input: "hello",
      tools,
    }),
  ).toThrow(LocalHTTPError)
})

test("reports only fixed classes for wire-changing Responses normalization", () => {
  const result = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    max_output_tokens: 1,
    temperature: 0.3,
    top_p: 0.8,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content", "reasoning.encrypted_content"],
  })

  expect(result.normalizationClasses).toEqual([
    "empty_tool_controls",
    "encrypted_reasoning_include",
    "max_output_tokens",
  ])
})

test("reports final reasoning and sampling normalization classes", () => {
  const result = finalizeResponsesRequest(
    {
      model: "gpt-5.6-sol",
      input: "hello",
      temperature: 0.3,
      top_p: 0.8,
    },
    { defaultEffort: "medium", implicitDefault: false },
  )

  expect(result.normalizationClasses).toEqual([
    "reasoning_defaults",
    "gpt56_sampling",
  ])
})

test("reports every stateless control removed from the Responses wire", () => {
  const prepared = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    store: false,
    background: false,
    previous_response_id: null,
    service_tier: null,
    context_management: null,
  })

  expect(prepared.body).toEqual({
    model: "gpt-current",
    input: "hello",
    store: false,
  })
  expect(prepared.normalizationClasses).toEqual(["stateless_controls"])
})

test("preserves caller json_schema required fields exactly", () => {
  const prepared = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    text: {
      format: {
        type: "json_schema",
        name: "result",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            answer: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["answer", "answer", "unknown", 7],
        },
      },
    },
  })

  expect(prepared.body.text?.format).toMatchObject({
    schema: {
      required: ["answer", "answer", "unknown", 7],
    },
  })
  expect(prepared.normalizationClasses).toEqual([])
})

test.each([
  {
    name: "fully canonical schema",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
    expectedClasses: [],
  },
  {
    name: "duplicate required entry",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer", "answer"],
    },
    expectedClasses: [],
  },
])("classifies JSON-schema mutation exactly for $name", (entry) => {
  const prepared = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    text: {
      format: { type: "json_schema", name: "result", schema: entry.schema },
    },
  })

  expect([...prepared.normalizationClasses]).toEqual([...entry.expectedClasses])
})

test.each([
  {
    name: "absent tools and controls",
    extra: {},
    expectedClasses: [],
  },
  {
    name: "null tools without controls",
    extra: { tools: null },
    expectedClasses: [],
  },
  {
    name: "empty tools without controls",
    extra: { tools: [] },
    expectedClasses: ["empty_tool_controls"],
  },
  {
    name: "null tools with controls",
    extra: { tools: null, tool_choice: "auto", parallel_tool_calls: true },
    expectedClasses: ["empty_tool_controls"],
  },
] as Array<{
  name: string
  extra: Record<string, unknown>
  expectedClasses: Array<CopilotContractNormalizationClass>
}>)("classifies empty tool mutation exactly for $name", (entry) => {
  const prepared = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    ...entry.extra,
  })

  expect([...prepared.normalizationClasses]).toEqual([...entry.expectedClasses])
})

test.each([
  { name: "no stateless values", extra: {}, expectedClasses: [] },
  {
    name: "preserved store false only",
    extra: { store: false },
    expectedClasses: [],
  },
  {
    name: "omitted background false",
    extra: { background: false },
    expectedClasses: ["stateless_controls"],
  },
  {
    name: "omitted null continuation controls",
    extra: { previous_response_id: null, service_tier: null },
    expectedClasses: ["stateless_controls"],
  },
])("classifies stateless mutation exactly for $name", (entry) => {
  const prepared = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    ...entry.extra,
  })

  expect([...prepared.normalizationClasses]).toEqual([...entry.expectedClasses])
})

test("reports JSON-object instruction injection", () => {
  const prepared = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "plain response",
    text: { format: { type: "json_object" } },
  })

  expect(prepared.body.input).toEqual([
    {
      type: "message",
      role: "developer",
      content: "Respond with JSON.",
    },
    { type: "message", role: "user", content: "plain response" },
  ])
  expect(prepared.normalizationClasses).toEqual(["json_object_instruction"])
})

test("reports configured unsupported sampling removal", () => {
  setModelSettingsForTest([
    {
      model: "sampling-limited",
      unsupportedRequestParameters: ["temperature", "top_p"],
    },
  ])
  try {
    const prepared = finalizeResponsesRequest(
      {
        model: "sampling-limited",
        input: "hello",
        temperature: 0.2,
        top_p: 0.7,
      },
      { implicitDefault: false },
    )

    expect(prepared.body).not.toHaveProperty("temperature")
    expect(prepared.body).not.toHaveProperty("top_p")
    expect(prepared.normalizationClasses).toEqual(["unsupported_sampling"])
  } finally {
    setModelSettingsForTest([])
  }
})

test("keeps reasoning disabled without requesting summaries or encrypted state", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-5.6-sol",
    input: "hello",
    reasoning: { effort: "none" },
    include: ["code_interpreter_call.outputs"],
  }).body

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.reasoning).toEqual({ effort: "none" })
  expect(body.include).toEqual(["code_interpreter_call.outputs"])
})

test("removes encrypted reasoning inclusion when reasoning is disabled", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    reasoning: { effort: "none", summary: "detailed" },
    include: ["reasoning.encrypted_content", "code_interpreter_call.outputs"],
  }).body

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.reasoning).toEqual({ effort: "none" })
  expect(body.include).toEqual(["code_interpreter_call.outputs"])
})

test("preserves integer reasoning effort", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    reasoning: { effort: 2048 },
  }).body

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.reasoning).toEqual({ effort: 2048, summary: "auto" })
  expect(body.include).toContain("reasoning.encrypted_content")
})

test("adds encrypted reasoning inclusion once", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    include: ["reasoning.encrypted_content"],
  }).body
  const preparedInclude = body.include

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.include).toEqual(["reasoning.encrypted_content"])
  expect(body.include).not.toBe(preparedInclude)
})

test("canonicalizes duplicate encrypted reasoning includes", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    include: [
      "code_interpreter_call.outputs",
      "reasoning.encrypted_content",
      "file_search_call.results",
      "reasoning.encrypted_content",
    ],
  }).body

  expect(body.include).toEqual([
    "code_interpreter_call.outputs",
    "reasoning.encrypted_content",
    "file_search_call.results",
  ])
})

test("rejects null and array Responses bodies before preparation", () => {
  for (const payload of [null, []]) {
    const error = captureValidationError(payload as never)
    expect(error.response.status).toBe(400)
    expect(error.clientBody).toMatchObject({
      error: { type: "invalid_request_error" },
    })
  }
})

test("requires a non-empty Responses model before preparation", () => {
  for (const payload of [{}, { model: "   " }]) {
    const error = captureValidationError(payload as never)
    expect(error.response.status).toBe(400)
    expect(error.clientBody).toMatchObject({
      error: { param: "model", type: "invalid_request_error" },
    })
  }
})

test("treats null reasoning as absent", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    reasoning: null,
  }).body

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" })
})

test.each(["compaction", "truncate"])(
  "accepts %s context management",
  (type) => {
    const body = prepareLegacyResponsesRequestForTest({
      model: "gpt-current",
      input: "hello",
      context_management: [
        { type, threshold: 4096, future_nested: { enabled: true } },
      ],
    }).body

    expect(body.context_management).toEqual([
      { type, threshold: 4096, future_nested: { enabled: true } },
    ])
  },
)

test("accepts null context management without forwarding it", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    context_management: null,
  }).body

  expect(body).not.toHaveProperty("context_management")
})

test("rejects unsupported context management types locally", () => {
  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    context_management: [{ type: "future_unknown" }],
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "unsupported_value", param: "context_management" },
  })
})

test.each([1, null, undefined])(
  "rejects unsupported context management type %p locally",
  (type) => {
    const error = captureValidationError({
      model: "gpt-current",
      input: "hello",
      context_management: [{ type } as unknown as Record<string, unknown>],
    })

    expect(error.clientBody).toMatchObject({
      error: { code: "unsupported_value", param: "context_management" },
    })
  },
)

test.each([{ value: "truncate" }, { value: [null] }] as const)(
  "rejects invalid context management shape",
  ({ value }) => {
    const error = captureValidationError({
      model: "gpt-current",
      input: "hello",
      context_management:
        value as unknown as ResponsesPayload["context_management"],
    })

    expect(error.clientBody).toMatchObject({
      error: { code: "invalid_type", param: "context_management" },
    })
  },
)

test.each([
  ["store", { store: true }],
  ["background", { background: true }],
  ["previous_response_id", { previous_response_id: "resp_external" }],
] as const)("rejects unsupported stateful control %s", (param, extra) => {
  expect(() =>
    prepareLegacyResponsesRequestForTest({
      model: "gpt-5.6-sol",
      input: "hello",
      ...extra,
    }),
  ).toThrow(LocalHTTPError)
  try {
    prepareLegacyResponsesRequestForTest({
      model: "gpt-5.6-sol",
      input: "hello",
      ...extra,
    })
  } catch (error) {
    expect((error as LocalHTTPError).clientBody).toMatchObject({
      error: { code: "unsupported_value", param },
    })
  }
})

test.each(["priority", "standard", "future-tier"])(
  "removes service tier %s from the Responses wire",
  (serviceTier) => {
    const result = prepareLegacyResponsesRequestForTest({
      model: "gpt-5.6-sol",
      input: "hello",
      service_tier: serviceTier,
    })

    expect(result.body).not.toHaveProperty("service_tier")
    expect(result.normalizationClasses).toContain("stateless_controls")
  },
)

test("removes service tier from the tolerant native Responses finalization", () => {
  const prepared = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: "hello",
    service_tier: "priority",
  })
  const finalized = finalizeNativeResponsesRequest(prepared, {
    model: "gpt-5.6-sol-fast",
    implicitDefault: false,
  })

  expect(prepared.source.service_tier).toBe("priority")
  expect(finalized.body.model).toBe("gpt-5.6-sol-fast")
  expect(finalized.body).not.toHaveProperty("service_tier")
})

test("classifies service tier stripping when store is already false", () => {
  const prepared = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: "hello",
    service_tier: "priority",
    store: false,
  })

  expect(prepared.normalizationClasses).toEqual(["stateless_controls"])
})

test("accepts stateless false and null values without forwarding them", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-5.6-sol",
    input: "hello",
    store: false,
    background: false,
    previous_response_id: null,
  }).body
  expect(body.store).toBe(false)
  expect(body).not.toHaveProperty("background")
  expect(body).not.toHaveProperty("previous_response_id")
})

test("omits unknown top-level fields but preserves unknown nested fields", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi", future_nested: 1 }],
        future_item: 2,
      },
    ],
    future_top_level: 3,
  }).body
  expect(body).not.toHaveProperty("future_top_level")
  expect(JSON.stringify(body.input)).toContain("future_nested")
  expect(JSON.stringify(body.input)).toContain("future_item")
})

test.each([
  ["store", "yes"],
  ["background", 1],
] as const)("rejects invalid boolean stateful control %s", (param, value) => {
  const error = captureValidationError({
    model: "gpt-5.6-sol",
    input: "hello",
    [param]: value,
  })
  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param },
  })
})

test("rejects an invalid typed previous_response_id", () => {
  const error = captureValidationError({
    model: "gpt-5.6-sol",
    input: "hello",
    previous_response_id: 1 as never,
  })
  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "previous_response_id" },
  })
})

test("rejects an empty previous_response_id as unsupported", () => {
  const error = captureValidationError({
    model: "gpt-5.6-sol",
    input: "hello",
    previous_response_id: "",
  })
  expect(error.clientBody).toMatchObject({
    error: { code: "unsupported_value", param: "previous_response_id" },
  })
})

test("accepts null stateful controls without forwarding them", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-5.6-sol",
    input: "hello",
    store: null,
    background: null,
    previous_response_id: null,
    service_tier: null,
  }).body

  expect(body).not.toHaveProperty("store")
  expect(body).not.toHaveProperty("background")
  expect(body).not.toHaveProperty("previous_response_id")
  expect(body).not.toHaveProperty("service_tier")
})

test.each(LEGACY_RESPONSES_TOOL_TYPES)(
  "preserves formerly blocked native Responses tool %s",
  (type) => {
    const body = prepareLegacyResponsesRequestForTest({
      model: "gpt-current",
      input: "hello",
      tools: [{ type }],
    }).body

    expect(body.tools).toEqual([{ type }])
  },
)

test.each(FORWARDED_RESPONSES_TOOLS)(
  "preserves upstream-authorized Responses tool class %s",
  (type) => {
    const tool =
      type === "function" ?
        {
          type,
          name: "run",
          description: "Run a command",
          parameters: { type: "object", properties: {} },
          strict: false,
        }
      : { type, name: "run", future_option: { enabled: true } }
    const body = prepareLegacyResponsesRequestForTest({
      model: "gpt-current",
      input: "hello",
      tools: [tool],
    }).body

    expect((body.tools as Array<Record<string, unknown>>)[0]).toEqual(tool)
  },
)

test.each([
  { name: "non-array tools", tools: "function" },
  { name: "null tool item", tools: [null] },
  { name: "array tool item", tools: [[]] },
  { name: "primitive tool item", tools: ["function"] },
  { name: "missing tool type", tools: [{ name: "run" }] },
  { name: "non-string tool type", tools: [{ type: 1 }] },
  { name: "empty tool type", tools: [{ type: "" }] },
  { name: "blank tool type", tools: [{ type: "  \t" }] },
])("rejects malformed Responses $name", ({ tools }) => {
  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: tools as unknown as ResponsesPayload["tools"],
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "tools" },
  })
})

test("rejects inherited Responses tool types", () => {
  const tool = Object.create({ type: "function" }) as Record<string, unknown>
  tool.name = "run"

  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: [tool],
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "tools" },
  })
})

test("rejects non-plain Responses tool records", () => {
  class ToolRecord {
    type = "function"
  }

  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: [new ToolRecord() as unknown as Record<string, unknown>],
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "tools" },
  })
})

test("trims Responses tool types without mutating the caller", () => {
  const tool = { type: "  client_future_tool  ", name: "run" }
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    tools: [tool],
  }).body

  expect((body.tools as Array<Record<string, unknown>>)[0]?.type).toBe(
    "client_future_tool",
  )
  expect(tool.type).toBe("  client_future_tool  ")
})

test("preserves formerly blocked Responses tool types after trimming", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    tools: [{ type: "  code_interpreter  " }],
  }).body

  expect(body.tools).toEqual([{ type: "code_interpreter" }])
})

test("rejects a changing Responses tool type getter without invoking it", () => {
  let reads = 0
  const tool = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      reads += 1
      return reads === 1 ? "function" : "code_interpreter"
    },
  })

  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: [tool as Record<string, unknown>],
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "tools" },
  })
  expect(reads).toBe(0)
})

test("rejects a throwing Responses tool type getter with a safe error", () => {
  let reads = 0
  const tool = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      reads += 1
      throw new Error("unsafe getter detail")
    },
  })

  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: [tool as Record<string, unknown>],
  })

  expect(error.clientBody).toEqual({
    error: {
      code: "invalid_type",
      message: "Each tool must be a plain object with a non-empty string type.",
      param: "tools",
      type: "invalid_request_error",
    },
  })
  expect(reads).toBe(0)
})

test("rejects other Responses tool getters without invoking them", () => {
  let reads = 0
  const tool = Object.defineProperties(
    {},
    {
      type: { enumerable: true, value: "function" },
      name: {
        enumerable: true,
        get() {
          reads += 1
          throw new Error("unsafe getter detail")
        },
      },
    },
  )

  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: [tool as Record<string, unknown>],
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "tools" },
  })
  expect(reads).toBe(0)
})

test("rejects nested Responses tool getters without invoking them", () => {
  let reads = 0
  const nested = Object.defineProperty({}, "enabled", {
    enumerable: true,
    get() {
      reads += 1
      throw new Error("unsafe nested getter detail")
    },
  })

  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: [{ type: "client_future_tool", options: nested }],
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "tools" },
  })
  expect(reads).toBe(0)
})

test("rejects throwing Responses tool reflection traps with a safe error", () => {
  const tool = new Proxy(
    { type: "function" },
    {
      getPrototypeOf() {
        throw new Error("unsafe proxy detail")
      },
    },
  )

  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: [tool],
  })

  expect(error.clientBody).toEqual({
    error: {
      code: "invalid_type",
      message: "Each tool must be a plain object with a non-empty string type.",
      param: "tools",
      type: "invalid_request_error",
    },
  })
})

test("canonicalizes an injected LocalHTTPError from a tool reflection trap", () => {
  const injected = new LocalHTTPError(
    "injected tool error",
    Response.json({ injected: true }, { status: 418 }),
    { injected: true },
  )
  const tool = new Proxy(
    { type: "function" },
    {
      getPrototypeOf() {
        throw injected
      },
    },
  )

  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: [tool],
  })

  expect(error.message).toBe(
    "Each tool must be a plain object with a non-empty string type.",
  )
  expect(error.response.status).toBe(400)
  expect(error.clientBody).toEqual({
    error: {
      code: "invalid_type",
      message: "Each tool must be a plain object with a non-empty string type.",
      param: "tools",
      type: "invalid_request_error",
    },
  })
})

test("canonicalizes a hostile thrown proxy without inspecting it", () => {
  let prototypeReads = 0
  const hostileThrown = new Proxy(new Error("hostile thrown value"), {
    getPrototypeOf() {
      prototypeReads += 1
      throw new Error("unsafe thrown-value inspection")
    },
  })
  const tool = new Proxy(
    { type: "function" },
    {
      getPrototypeOf() {
        throw hostileThrown
      },
    },
  )

  let caught: unknown
  try {
    prepareLegacyResponsesRequestForTest({
      model: "gpt-current",
      input: "hello",
      tools: [tool],
    })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(LocalHTTPError)
  expect((caught as LocalHTTPError).clientBody).toEqual({
    error: {
      code: "invalid_type",
      message: "Each tool must be a plain object with a non-empty string type.",
      param: "tools",
      type: "invalid_request_error",
    },
  })
  expect(prototypeReads).toBe(0)
})

test.each([
  { name: "omitted", tools: undefined },
  { name: "null", tools: null },
  { name: "empty", tools: [] },
])("removes Responses tool controls when tools are $name", ({ tools }) => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    tools: tools as ResponsesPayload["tools"],
    tool_choice: "required",
    parallel_tool_calls: true,
  }).body

  expect(body).not.toHaveProperty("tools")
  expect(body).not.toHaveProperty("tool_choice")
  expect(body).not.toHaveProperty("parallel_tool_calls")
})

test("preserves Responses tool controls when a real tool is available", () => {
  const body = prepareLegacyResponsesRequestForTest({
    model: "gpt-current",
    input: "hello",
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object" },
        strict: false,
      },
    ],
    tool_choice: "required",
    parallel_tool_calls: true,
  }).body

  expect(body.tool_choice).toBe("required")
  expect(body.parallel_tool_calls).toBe(true)
})

test("prepares a new top-level body without mutating caller values", () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: {},
        strict: false,
      },
    ],
    store: false,
    background: false,
  }

  const result = prepareLegacyResponsesRequestForTest(payload)

  expect(result.body).not.toBe(payload)
  expect(result.body.input).not.toBe(payload.input)
  expect(payload.tools?.[0]).toMatchObject({ parameters: {} })
  expect(result.body.tools?.[0]).toMatchObject({
    parameters: { type: "object", properties: {} },
  })
})

test("preserves unknown native Responses source data with store as the sole override", () => {
  const payload = {
    model: "gpt-current",
    input: [
      {
        type: "future_input",
        future_item: { nested: [1, { enabled: true }] },
      },
    ],
    future_top_level: { mode: "native" },
    background: { future: true },
    previous_response_id: 17,
    service_tier: ["future"],
    context_management: { future: "shape" },
    store: { requested: true },
    tools: [{ name: "missing-type", future: true }],
  }

  const prepared = prepareResponsesRequest(payload)

  expect(prepared.source as Record<string, unknown>).toEqual({
    ...payload,
    store: false,
  })
  expect(prepared.normalizationClasses).toEqual(["stateless_controls"])
  expect(prepared.source).not.toBe(payload)
  expect(prepared.source.input).not.toBe(payload.input)
  expect(prepared.source.future_top_level).not.toBe(payload.future_top_level)
  expect(payload.store).toEqual({ requested: true })
})

test.each([
  { name: "absent", extra: {} },
  { name: "true", extra: { store: true } },
  { name: "false", extra: { store: false } },
  { name: "null", extra: { store: null } },
  { name: "string", extra: { store: "future" } },
  { name: "record", extra: { store: { future: true } } },
])("forces native Responses source store false when $name", ({ extra }) => {
  const prepared = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    ...extra,
  })

  expect(prepared.source.store).toBe(false)
  expect(prepared.normalizationClasses).toEqual(
    extra.store === false ? [] : ["stateless_controls"],
  )
})

test("finalizes native Responses tools without filtering source evidence", () => {
  const payload = {
    model: "gpt-current",
    input: "hello",
    tools: [
      null,
      { name: "missing-type", future: true },
      {
        type: "  mcp  ",
        server_label: "native",
        future: { retained: true },
      },
      {
        type: "function",
        name: "lookup",
        parameters: { properties: { query: { type: "string" } } },
      },
      { type: "future_tool", config: { mode: "native" } },
    ],
    tool_choice: { type: "future_choice" },
    parallel_tool_calls: "future",
  }

  const prepared = prepareResponsesRequest(payload)
  const finalized = finalizeNativeResponsesRequest(prepared, {
    model: "gpt-current",
    implicitDefault: false,
  })

  expect((prepared.source as Record<string, unknown>).tools).toEqual(
    payload.tools,
  )
  expect(finalized.body.tools).toEqual([
    {
      type: "mcp",
      server_label: "native",
      future: { retained: true },
    },
    {
      type: "function",
      name: "lookup",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
    { type: "future_tool", config: { mode: "native" } },
  ])
  expect(finalized.body.tool_choice).toEqual({ type: "future_choice" })
  expect((finalized.body as Record<string, unknown>).parallel_tool_calls).toBe(
    "future",
  )
  expect(prepared.source as Record<string, unknown>).toEqual({
    ...payload,
    store: false,
  })
})

test("normalizes a singleton native Responses tool only in the final wire", () => {
  const tool = { type: "  computer_use_preview  ", display_width: 1024 }
  const prepared = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    tools: tool,
  })
  const finalized = finalizeNativeResponsesRequest(prepared, {
    model: "gpt-current",
    implicitDefault: false,
  })

  expect((prepared.source as Record<string, unknown>).tools).toEqual(tool)
  expect(finalized.body.tools).toEqual([
    { type: "computer_use_preview", display_width: 1024 },
  ])
  expect(tool.type).toBe("  computer_use_preview  ")
})

test("skips a hostile native Responses tool sibling without invoking it", () => {
  let reads = 0
  const hostileTool = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      reads += 1
      throw new Error("unsafe tool getter")
    },
  })
  const prepared = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    tools: [hostileTool, { type: "future_tool", config: { enabled: true } }],
  })
  const finalized = finalizeNativeResponsesRequest(prepared, {
    model: "gpt-current",
    implicitDefault: false,
  })

  expect(reads).toBe(0)
  expect(prepared.source.tools).toEqual([
    { type: "future_tool", config: { enabled: true } },
  ])
  expect(finalized.body.tools).toEqual([
    { type: "future_tool", config: { enabled: true } },
  ])
})

test("removes native Responses tool controls when every tool is unusable", () => {
  const prepared = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    tools: [null, { name: "missing" }, { type: "  " }, 17],
    tool_choice: { type: "future_choice" },
    parallel_tool_calls: "future",
  })
  const finalized = finalizeNativeResponsesRequest(prepared, {
    model: "gpt-current",
    implicitDefault: false,
  })

  expect((prepared.source as Record<string, unknown>).tools).toEqual([
    null,
    { name: "missing" },
    { type: "  " },
    17,
  ])
  expect(finalized.body).not.toHaveProperty("tools")
  expect(finalized.body).not.toHaveProperty("tool_choice")
  expect(finalized.body).not.toHaveProperty("parallel_tool_calls")
  expect(finalized.normalizationClasses).toEqual([
    "stateless_controls",
    "empty_tool_controls",
  ])
})

test("keeps native source and repeated finalizations deeply independent", () => {
  const payload = {
    model: "requested-model",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    reasoning: { effort: null, future: { retained: true } },
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
    },
    max_output_tokens: 1,
    temperature: 0.4,
  }
  const prepared = prepareResponsesRequest(payload)
  const first = finalizeNativeResponsesRequest(prepared, {
    model: "resolved-model",
    defaultEffort: "medium",
    implicitDefault: false,
  })
  const second = finalizeNativeResponsesRequest(prepared, {
    model: "resolved-model",
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(first.body).toEqual(second.body)
  expect(first.body).not.toBe(second.body)
  expect(first.body.input).not.toBe(second.body.input)
  expect(prepared.source.model).toBe("requested-model")
  expect(prepared.source.max_output_tokens).toBe(1)
  expect(prepared.source.text).toEqual(payload.text)
  expect(payload.reasoning).toEqual({
    effort: null,
    future: { retained: true },
  })
  ;(first.body.input as Array<Record<string, unknown>>)[0].role = "mutated"
  expect(second.body.input).toEqual(payload.input)
  expect(prepared.source.input).toEqual(payload.input)
  expect(payload.input[0]?.role).toBe("user")
})

test("rejects hostile native Responses data outside tools without observing it", () => {
  let reads = 0
  const metadata = Object.defineProperty({}, "private", {
    enumerable: true,
    get() {
      reads += 1
      throw new Error("unsafe source getter")
    },
  })

  const error = captureNativeSourceValidationError({
    model: "gpt-current",
    input: "hello",
    metadata,
  })

  expect(error.response.status).toBe(400)
  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "body" },
  })
  expect(reads).toBe(0)
})

test.each([
  {
    name: "cycle",
    create: () => {
      const value: Record<string, unknown> = {}
      value.self = value
      return value
    },
  },
  { name: "BigInt", create: () => 1n },
  { name: "nonfinite number", create: () => Number.POSITIVE_INFINITY },
  { name: "undefined array entry", create: () => [undefined] },
  {
    name: "shared alias",
    create: () => {
      const shared = { value: true }
      return { first: shared, second: shared }
    },
  },
])("rejects native Responses $name source data", ({ create }) => {
  const error = captureNativeSourceValidationError({
    model: "gpt-current",
    input: "hello",
    future: create(),
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "body" },
  })
})

function captureNativeSourceValidationError(payload: unknown): LocalHTTPError {
  try {
    prepareResponsesRequest(payload)
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    return error as LocalHTTPError
  }
  throw new Error("Expected native Responses source validation error")
}
