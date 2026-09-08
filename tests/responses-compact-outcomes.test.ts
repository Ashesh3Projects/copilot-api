import { afterEach, beforeEach, expect, test } from "bun:test"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
let upstreamBody: Record<string, unknown>
let upstreamPath: string | undefined
let upstreamAuthorization: string | null
let result: Record<string, unknown>

beforeEach(() => {
  state.copilotToken = "synthetic-compact-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: "compact-model",
        name: "compact-model",
        object: "model",
        version: "test",
        vendor: "openai",
        preview: false,
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt",
          limits: { max_output_tokens: 8192 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  result = responsesResult([message("Task state preserved.")])
  upstreamPath = undefined
  globalThis.fetch = ((url, init) => {
    upstreamPath = new URL(url instanceof Request ? url.url : url).pathname
    upstreamAuthorization = new Headers(init?.headers).get("authorization")
    if (typeof init?.body !== "string")
      throw new TypeError("Expected JSON body")
    upstreamBody = JSON.parse(init.body) as Record<string, unknown>
    return Promise.resolve(Response.json(result))
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  tokenPool.removeAccountForTest(25_401)
  tokenPool.removeAccountForTest(25_402)
})

function message(...texts: Array<string>): Record<string, unknown> {
  return {
    id: "msg_summary",
    type: "message",
    role: "assistant",
    status: "completed",
    content: texts.map((text) => ({
      type: "output_text",
      text,
      annotations: [],
    })),
  }
}

function setEndpoints(endpoints: Array<string>): void {
  const model = state.models?.data[0]
  if (!model) throw new TypeError("Expected test model")
  model.supported_endpoints = endpoints
}

function responsesResult(
  output: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    id: "resp_summary",
    object: "response",
    created_at: 1,
    model: "compact-model",
    status: "completed",
    output,
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }
}

function compactRequest(headers: Record<string, string> = {}) {
  return seedProtocolDatabase().then(() =>
    server.request("/v1/responses/compact", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model: "compact-model",
        input: [{ role: "user", content: "Keep the current task state." }],
      }),
    }),
  )
}

async function readSummary(response: Response): Promise<string> {
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    output: Array<{ encrypted_content: string }>
  }
  return Buffer.from(body.output[0].encrypted_content, "base64").toString(
    "utf8",
  )
}

test("compaction prefers all final-answer text after commentary", async () => {
  result = responsesResult([
    {
      ...message("I will summarize the conversation now."),
      phase: "commentary",
    },
    {
      ...message("Current task: preserve state.", "Pending: finish build."),
      phase: "final_answer",
    },
    {
      ...message("Constraint: keep the API compatible."),
      phase: "final_answer",
    },
  ])
  const summary = await readSummary(await compactRequest())
  expect(summary).toBe(
    "Current task: preserve state.\nPending: finish build.\nConstraint: keep the API compatible.",
  )
})

test("compaction uses the selected account's endpoint and output limit", async () => {
  const model = state.models?.data[0]
  if (!model) throw new TypeError("Expected test model")
  for (const id of [25_401, 25_402]) {
    const account = tokenPool.addAccount(
      `synthetic-github-${id}`,
      "individual",
      id,
    )
    account.copilotToken = `synthetic-copilot-${id}`
    account.healthy = true
    account.models = new Set([model.id])
    const accountModel = structuredClone(model)
    accountModel.supported_endpoints =
      id === 25_401 ? ["/responses"] : ["/v1/messages"]
    accountModel.capabilities.limits = { max_output_tokens: 1024 }
    account.modelsData = [accountModel]
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true
  const affinity = Array.from(
    { length: 100 },
    (_, index) => `compact-affinity-${index}`,
  ).find(
    (key) =>
      tokenPool.getAccountForModelBySession(model.id, key)?.id === 25_402,
  )
  if (!affinity) throw new TypeError("Expected affinity for Messages account")
  result = {
    id: "msg_summary",
    type: "message",
    role: "assistant",
    model: model.id,
    content: [{ type: "text", text: "Selected account summary." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  const response = await compactRequest({ "x-client-session-id": affinity })
  expect(await readSummary(response)).toBe("Selected account summary.")
  expect(upstreamPath).toBe("/v1/messages")
  expect(upstreamAuthorization).toBe("Bearer synthetic-copilot-25402")
  expect(upstreamBody.max_tokens).toBe(1024)
})

test("compaction combines unphased text blocks and messages without output_text", async () => {
  result = responsesResult([
    message("Current task.", "Pending work."),
    message("Constraints."),
  ])
  expect(await readSummary(await compactRequest())).toBe(
    "Current task.\nPending work.\nConstraints.",
  )
})

test("compaction retains a legacy successful summary without status metadata", async () => {
  delete result.status
  expect(await readSummary(await compactRequest())).toBe(
    "Task state preserved.",
  )
})

test("compaction accepts the output_text convenience field when blocks are absent", async () => {
  result = { ...responsesResult([]), output_text: "Complete summary." }
  expect(await readSummary(await compactRequest())).toBe("Complete summary.")
})

test.each([
  {
    name: "failed",
    patch: {
      status: "failed",
      error: { code: "server_error", message: "Synthetic summary failure" },
      output_text: "",
    },
    reason: "Synthetic summary failure",
  },
  {
    name: "incomplete",
    patch: {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    },
    reason: "max_output_tokens",
  },
  { name: "empty", patch: { output: [], output_text: "" }, reason: "empty" },
  {
    name: "whitespace",
    patch: { output: [message("  \n ")] },
    reason: "empty",
  },
  {
    name: "empty final answer",
    patch: {
      output: [
        { ...message("Preparing summary."), phase: "commentary" },
        { ...message(""), phase: "final_answer" },
      ],
    },
    reason: "empty",
  },
])(
  "compaction rejects $name without publishing replacement history",
  async ({ patch, reason }) => {
    result = { ...result, ...patch }
    const response = await compactRequest()
    expect(response.status).toBe(502)
    const body = (await response.json()) as {
      error: { code: string; message: string }
      output?: unknown
    }
    expect(body.error.code).toBe("compaction_summary_failed")
    expect(body.error.message).toContain(reason)
    expect(body.output).toBeUndefined()
  },
)

test.each([
  ["string", "BUILD SUCCEEDED"],
  ["text blocks", [{ type: "input_text", text: "BUILD SUCCEEDED" }]],
  ["structured object", { result: "BUILD SUCCEEDED" }],
] as const)(
  "Messages-only compaction retains %s custom tool output",
  async (_kind, output) => {
    setEndpoints(["/v1/messages"])
    result = {
      id: "msg_summary",
      type: "message",
      role: "assistant",
      model: "compact-model",
      content: [{ type: "text", text: "The tool result is retained." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "compact-model",
          input: [
            {
              type: "custom_tool_call",
              call_id: "call_summary",
              name: "exec",
              input: "run build",
            },
            {
              type: "custom_tool_call_output",
              call_id: "call_summary",
              output,
            },
            { role: "user", content: "Keep the build result." },
          ],
        }),
      }),
    )
    expect(await readSummary(response)).toBe("The tool result is retained.")
    expect(upstreamPath).toBe("/v1/messages")
    expect(JSON.stringify(upstreamBody)).toContain("BUILD SUCCEEDED")
    expect(JSON.stringify(upstreamBody)).toContain("run build")
    expect(JSON.stringify(upstreamBody)).not.toContain("[object Object]")
  },
)

test("ordinary Responses still forwards an incomplete generation", async () => {
  result = {
    ...result,
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  }
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "compact-model",
        input: "hello",
        stream: false,
      }),
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  })
})

test.each(["length", "content_filter", "tool_calls"])(
  "Chat compaction rejects finish_reason %s",
  async (finishReason) => {
    setEndpoints(["/chat/completions"])
    result = {
      id: "chat_summary",
      object: "chat.completion",
      model: "compact-model",
      created: 1,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Partial summary" },
          finish_reason: finishReason,
        },
      ],
    }
    const response = await compactRequest()
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: { code: "compaction_summary_failed" },
    })
  },
)

test.each([
  { name: "complete", content: "Complete Chat summary.", status: 200 },
  { name: "empty", content: "", status: 502 },
])(
  "Chat compaction handles $name stopped summaries",
  async ({ content, status }) => {
    setEndpoints(["/chat/completions"])
    result = {
      id: "chat_summary",
      object: "chat.completion",
      model: "compact-model",
      created: 1,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    }
    const response = await compactRequest()
    expect(response.status).toBe(status)
    if (status === 200) {
      expect(await readSummary(response)).toBe(content)
    } else {
      expect(await response.json()).toMatchObject({
        error: { code: "compaction_summary_failed" },
      })
    }
  },
)

test.each([
  { reason: "end_turn", status: 200 },
  { reason: "max_tokens", status: 502 },
  { reason: "pause_turn", status: 502 },
])(
  "Messages-only compaction uses the advertised endpoint and handles $reason",
  async ({ reason, status }) => {
    setEndpoints(["/v1/messages"])
    result = {
      id: "msg_summary",
      type: "message",
      role: "assistant",
      model: "compact-model",
      content: [{ type: "text", text: "Task state preserved." }],
      stop_reason: reason,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
      },
    }
    const response = await compactRequest()
    expect(upstreamPath).toBe("/v1/messages")
    expect(upstreamBody.stream).toBe(false)
    expect(upstreamBody.max_tokens).toBeGreaterThan(0)
    expect(response.status).toBe(status)
    if (status === 200) {
      const body = (await response.json()) as {
        usage: unknown
        output: Array<{ encrypted_content: string }>
      }
      expect(
        Buffer.from(body.output[0].encrypted_content, "base64").toString(
          "utf8",
        ),
      ).toBe("Task state preserved.")
      expect(body.usage).toMatchObject({
        input_tokens: 15,
        output_tokens: 5,
        total_tokens: 20,
      })
    } else {
      expect(await response.json()).toMatchObject({
        error: { code: "compaction_summary_failed" },
      })
    }
  },
)
