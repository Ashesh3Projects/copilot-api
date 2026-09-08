import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { LocalHTTPError } from "~/lib/error"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"
import {
  finalizeNativeResponsesRequest,
  prepareResponsesRequest,
} from "~/services/copilot/responses-contract"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
let lastRequestBody: Record<string, unknown> | undefined

const fetchMock = mock((_url: string, init?: RequestInit) => {
  lastRequestBody =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined
  return Response.json({
    id: "resp_normalization",
    object: "response",
    created_at: 1,
    model: lastRequestBody?.model,
    output: [],
    output_text: "",
    status: "completed",
    usage: null,
  })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  lastRequestBody = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  setModelSettingsForTest([])
})

test("sends a finalized tolerant native Responses body without preparing again", async () => {
  const caller = {
    model: "gpt-4o",
    input: [{ type: "future_item", content: { future: true } }],
    future_top_level: { retained: [1, 2] },
    background: { future: true },
    previous_response_id: "resp_previous",
    service_tier: { future: "priority" },
    context_management: { future: "shape" },
    tools: [
      { name: "malformed evidence" },
      { type: "mcp", server_label: "native", future: { retained: true } },
    ],
    store: true,
  }
  const prepared = prepareResponsesRequest(caller)
  const finalized = finalizeNativeResponsesRequest(prepared, {
    model: "gpt-4o",
    implicitDefault: false,
  })

  await seedProtocolDatabase().then(() =>
    createResponses(finalized.body, {
      vision: false,
      initiator: "user",
      prepared: true,
    }),
  )

  expect(lastRequestBody).toEqual(finalized.body)
  expect(lastRequestBody).toMatchObject({
    future_top_level: { retained: [1, 2] },
    background: { future: true },
    previous_response_id: "resp_previous",
    context_management: { future: "shape" },
    store: false,
    tools: [
      { type: "mcp", server_label: "native", future: { retained: true } },
    ],
  })
  expect(lastRequestBody).not.toHaveProperty("service_tier")
  expect(prepared.source as Record<string, unknown>).toEqual({
    ...caller,
    store: false,
  })
  expect(caller.store).toBe(true)
})

test("omits sampling parameters for GPT-5.6 reasoning requests", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-5.6-sol",
        input: "Hello",
        reasoning: { effort: "max" },
        temperature: 0.3,
        top_p: 0.8,
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(lastRequestBody).not.toHaveProperty("temperature")
  expect(lastRequestBody).not.toHaveProperty("top_p")
})

test("keeps sampling parameters for GPT-5.6 with reasoning disabled", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-5.6-sol",
        input: "Hello",
        reasoning: { effort: "none" },
        temperature: 0.3,
        top_p: 0.8,
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(lastRequestBody?.temperature).toBe(0.3)
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("keeps GPT-5.6 sampling for explicit none on implicit-default models", async () => {
  setModelSettingsForTest([
    {
      model: "gpt-5.6-implicit-medium",
      supportedReasoningEfforts: ["none", "medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-5.6-implicit-medium",
        input: "Hello",
        reasoning: { effort: "none" },
        temperature: 0.3,
        top_p: 0.8,
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(lastRequestBody?.reasoning).toEqual({ effort: "none" })
  expect(lastRequestBody?.temperature).toBe(0.3)
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("keeps GPT-5.6 sampling when the configured final default is none", async () => {
  setModelSettingsForTest([
    {
      model: "gpt-5.6-default-none",
      supportedReasoningEfforts: ["none", "medium"],
      defaultReasoningEffort: "none",
    },
  ])

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-5.6-default-none",
        input: "Hello",
        temperature: 0.3,
        top_p: 0.8,
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(lastRequestBody?.reasoning).toEqual({
    effort: "none",
  })
  expect(lastRequestBody?.temperature).toBe(0.3)
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("preserves integer effort for implicit-default Responses models", async () => {
  setModelSettingsForTest([
    {
      model: "gpt-5.6-implicit-medium",
      supportedReasoningEfforts: ["none", "medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-5.6-implicit-medium",
        input: "Hello",
        reasoning: { effort: 2048 },
        temperature: 0.3,
        top_p: 0.8,
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(lastRequestBody?.reasoning).toEqual({ effort: 2048, summary: "auto" })
  expect(lastRequestBody).not.toHaveProperty("temperature")
  expect(lastRequestBody).not.toHaveProperty("top_p")
})

test("omits Responses tool controls when no tools are available", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: "Hello",
        tools: null,
        tool_choice: "auto",
        parallel_tool_calls: true,
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(lastRequestBody).not.toHaveProperty("tools")
  expect(lastRequestBody).not.toHaveProperty("tool_choice")
  expect(lastRequestBody).not.toHaveProperty("parallel_tool_calls")
})

test("forwards Responses tool controls when a real tool is available", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: "Hello",
        tools: [
          {
            type: "function",
            name: "lookup",
            parameters: {},
            strict: false,
          },
        ],
        tool_choice: "required",
        parallel_tool_calls: true,
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(lastRequestBody?.tools).toEqual([
    {
      type: "function",
      name: "lookup",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ])
  expect(lastRequestBody?.tool_choice).toBe("required")
  expect(lastRequestBody?.parallel_tool_calls).toBe(true)
})

test.each(["changing", "throwing"])(
  "rejects a %s Responses tool type getter before the wire",
  async (behavior) => {
    let reads = 0
    const tool = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        reads += 1
        if (behavior === "throwing") throw new Error("unsafe getter detail")
        return reads === 1 ? "function" : "code_interpreter"
      },
    })

    let caught: unknown
    try {
      await seedProtocolDatabase().then(() =>
        createResponses(
          {
            model: "gpt-4o",
            input: "Hello",
            tools: [tool as Record<string, unknown>],
          },
          { vision: false, initiator: "user" },
        ),
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LocalHTTPError)
    expect((caught as LocalHTTPError).clientBody).toMatchObject({
      error: { code: "invalid_type", param: "tools" },
    })

    expect(reads).toBe(0)
    expect(lastRequestBody).toBeUndefined()
  },
)

test("forwards reviewed Responses fields from the prepared request", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: "Hello",
        context_management: [{ type: "truncate" }],
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
        prompt_cache_retention: "in_memory",
        truncation: "auto",
        user: "user-1",
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(lastRequestBody).toMatchObject({
    context_management: [{ type: "truncate" }],
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "in_memory",
    truncation: "auto",
    user: "user-1",
  })
})

test("preserves explicit Responses prompt caching controls exactly", async () => {
  const promptCacheOptions = {
    mode: "explicit",
    ttl: "30m",
    namespace: { tenant: "alpha", revision: 7 },
  }
  const promptCacheBreakpoint = {
    mode: "explicit",
    ttl: "5m",
    metadata: { prefix: "stable", version: 2 },
  }

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "stable prefix",
                prompt_cache_breakpoint: promptCacheBreakpoint,
              },
            ],
          },
        ],
        prompt_cache_options: promptCacheOptions,
        prompt_cache_retention: "in_memory",
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(JSON.stringify(lastRequestBody?.prompt_cache_options)).toBe(
    JSON.stringify(promptCacheOptions),
  )
  expect(lastRequestBody?.prompt_cache_retention).toBe("in_memory")
  const input = lastRequestBody?.input as Array<{
    content: Array<{ prompt_cache_breakpoint?: Record<string, unknown> }>
  }>
  expect(JSON.stringify(input[0]?.content[0]?.prompt_cache_breakpoint)).toBe(
    JSON.stringify(promptCacheBreakpoint),
  )
})

test("does not pass upstream Responses objects to ordinary logs", async () => {
  fetchMock.mockImplementationOnce(() =>
    Response.json(
      { error: { code: "invalid_request_body", message: "private-body" } },
      { status: 400, statusText: "private-status" },
    ),
  )
  const errorSpy = spyOn(consola, "error")

  try {
    let thrown: unknown
    try {
      await seedProtocolDatabase().then(() =>
        createResponses(
          { model: "gpt-4o", input: "Hello" },
          { vision: false, initiator: "user" },
        ),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toHaveProperty("response.status", 400)
    const output = JSON.stringify(errorSpy.mock.calls)
    expect(output).not.toContain("private-body")
    expect(output).not.toContain("private-status")
    expect(errorSpy.mock.calls).toEqual([["Failed to create responses"]])
  } finally {
    errorSpy.mockRestore()
  }
})
