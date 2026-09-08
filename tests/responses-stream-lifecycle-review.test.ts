import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
  PROTOCOL_GATEWAY_KEY,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const encoder = new TextEncoder()
let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined

const fetchMock = mock(
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller
        },
      }),
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    ),
)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.models = originalModels
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  upstreamController = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test("buffered emulated web_search stops at the first completed terminal", async () => {
  installModel("route-model")
  const response = await postResponses({
    input: "search",
    stream: true,
    tools: [emulatedWebSearchTool()],
  })
  const reader = requireBody(response).getReader()
  enqueueTerminal({
    event: "response.completed",
    status: "completed",
    id: "resp_first_buffered",
    sequenceNumber: 1,
  })
  enqueueRaw(
    "response.failed",
    JSON.stringify({
      type: "response.failed",
      sequence_number: 2,
      response: {
        id: "resp_late_failure",
        status: "failed",
        output: [],
        output_text: "",
        error: { message: "late failure must not win" },
      },
    }),
  )
  upstreamController?.close()

  const body = await readRemaining(reader)
  expect(events(body).filter((event) => isTerminalEvent(event))).toEqual([
    "response.completed",
  ])
  expect(body).not.toContain("resp_late_failure")
})

test("buffered emulated web_search stops at the first failed terminal", async () => {
  installModel("route-model")
  const firstFailure = {
    type: "response.failed",
    sequence_number: 1,
    response: {
      id: "resp_first_failure",
      status: "failed",
      output: [{ type: "future_partial", retained: true }],
      output_text: "partial",
      error: { code: "first_failure", message: "first failure wins" },
    },
  }
  const response = await postResponses({
    input: "search",
    stream: true,
    tools: [emulatedWebSearchTool()],
  })
  const reader = requireBody(response).getReader()
  enqueueRaw("response.failed", JSON.stringify(firstFailure))
  enqueueTerminal({
    event: "response.completed",
    status: "completed",
    id: "resp_late_completed",
    sequenceNumber: 2,
  })
  upstreamController?.close()

  const body = await readRemaining(reader)
  expect(events(body)).toEqual(["response.failed"])
  expect(dataFrames(body)).toEqual([firstFailure])
})

test("retains mixed reasoning, function, and indexed text output on failure", async () => {
  installModel("route-model")
  const response = await postResponses({ input: "hello", stream: true })
  const reader = requireBody(response).getReader()
  enqueueOutputItem(0, {
    id: "reasoning_client",
    type: "reasoning",
    status: "in_progress",
    summary: [{ type: "summary_text", text: "kept reasoning" }],
  })
  enqueueOutputItem(1, {
    id: "function_client",
    type: "function_call",
    call_id: "call_mixed",
    name: "lookup",
    arguments: "{}",
    status: "in_progress",
  })
  enqueueOutputItem(2, {
    id: "message_client",
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [],
  })
  enqueueNative("response.output_text.delta", {
    type: "response.output_text.delta",
    sequence_number: 3,
    item_id: "message_client",
    output_index: 2,
    content_index: 0,
    delta: "mixed partial",
  })
  const partial = await readUntilContains(reader, "mixed partial")
  upstreamController?.close()

  const terminal = dataFrames(partial + (await readRemaining(reader))).at(
    -1,
  ) as {
    response?: { output?: Array<Record<string, unknown>> }
  }
  expect(terminal.response?.output?.map((item) => item.type)).toEqual([
    "reasoning",
    "function_call",
    "message",
  ])
  expect(terminal.response?.output?.[2]).toMatchObject({
    id: "message_client",
    content: [{ type: "output_text", text: "mixed partial" }],
  })
})

test.each(["ends cleanly", "throws"] as const)(
  "late native failure retains outbound requested model and repaired IDs when source $name",
  async (ending) => {
    installModel("redirect-target")
    setModelRedirectsForTest([
      {
        id: "responses-stream-redirect",
        sourceModel: "route-model",
        sourceEffort: "all",
        targetModel: "redirect-target",
        enabled: true,
      },
    ])
    const response = await postResponses({ input: "hello", stream: true })
    const reader = requireBody(response).getReader()
    enqueueNative("response.created", {
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_redirected",
        object: "response",
        created_at: 5,
        model: "redirect-target",
        status: "in_progress",
        output: [],
        output_text: "",
        usage: null,
        error: null,
        incomplete_details: null,
      },
    })
    enqueueOutputItem(1, {
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    })
    const added = await readUntilContains(reader, "response.output_item.added")
    const generatedId = (dataFrames(added).at(-1) as { item?: { id?: string } })
      .item?.id
    if (!generatedId) throw new Error("Expected generated client item ID")
    enqueueNative("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "upstream_changed_id",
      output_index: 1,
      content_index: 0,
      delta: "redirected partial",
    })
    const delta = await readUntilContains(reader, "redirected partial")
    if (ending === "throws") {
      upstreamController?.error(new Error("late redirected failure"))
    } else {
      upstreamController?.close()
    }

    const body = added + delta + (await readRemaining(reader))
    const terminal = dataFrames(body).at(-1) as {
      response?: {
        model?: string
        output?: Array<{ id?: string; content?: Array<{ text?: string }> }>
      }
    }
    expect(body).toContain(`"item_id":"${generatedId}"`)
    expect(terminal.response?.model).toBe("route-model")
    expect(terminal.response?.output?.[1]).toMatchObject({
      id: generatedId,
      content: [{ type: "output_text", text: "redirected partial" }],
    })
  },
)

function installModel(id: string): void {
  state.models = {
    object: "list",
    data: [
      {
        id,
        name: id,
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  } satisfies ModelsResponse
}

function postResponses(extra: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(
    seedProtocolDatabase().then(() =>
      server.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "route-model", ...extra }),
      }),
    ),
  )
}

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("Expected an SSE response body")
  return response.body
}

function enqueueRaw(event: string, data: string): void {
  upstreamController?.enqueue(
    encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
  )
}

function enqueueNative(event: string, data: Record<string, unknown>): void {
  enqueueRaw(event, JSON.stringify(data))
}

function enqueueOutputItem(
  outputIndex: number,
  item: Record<string, unknown>,
): void {
  enqueueNative("response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: outputIndex,
    output_index: outputIndex,
    item,
  })
}

function enqueueTerminal(options: {
  event: "response.completed" | "response.incomplete"
  status: "completed" | "incomplete"
  id: string
  sequenceNumber: number
}): void {
  enqueueNative(options.event, {
    type: options.event,
    sequence_number: options.sequenceNumber,
    response: {
      id: options.id,
      object: "response",
      created_at: 1,
      model: "route-model",
      status: options.status,
      output: [],
      output_text: "",
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
    },
  })
}

function emulatedWebSearchTool(): Record<string, unknown> {
  return {
    type: "function",
    name: "web_search",
    description: "Search",
    parameters: { type: "object", properties: {} },
    strict: false,
  }
}

function events(body: string): Array<string> {
  return Array.from(body.matchAll(/^event: (.+)$/gm), (match) => match[1])
}

function isTerminalEvent(event: string): boolean {
  return (
    event === "response.completed"
    || event === "response.incomplete"
    || event === "response.failed"
    || event === "error"
  )
}

function dataFrames(body: string): Array<unknown> {
  return Array.from(
    body.matchAll(/^data: (\{.*\})$/gm),
    (match) => JSON.parse(match[1]) as unknown,
  )
}

type StreamReader = {
  read: () => Promise<
    { done: false; value: Uint8Array } | { done: true; value?: Uint8Array }
  >
}

async function readRemaining(reader: StreamReader): Promise<string> {
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const next = await reader.read()
    if (next.done) return output
    output += decoder.decode(next.value, { stream: true })
  }
}

async function readUntilContains(
  reader: StreamReader,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let output = ""
  while (!output.includes(marker)) {
    const next = await reader.read()
    if (next.done) throw new Error(`Stream ended before ${marker}`)
    output += decoder.decode(next.value, { stream: true })
  }
  return output
}
