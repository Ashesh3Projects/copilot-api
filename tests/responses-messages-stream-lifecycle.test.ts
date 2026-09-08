import * as Sentry from "@sentry/bun"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
  spyOn,
} from "bun:test"
import consola from "consola"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { STREAM_BEHAVIOR_CONTRACT } from "~/lib/compatibility-contract-values"
import { HTTPError } from "~/lib/error"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { setSsePreflushDeadlineForTest } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
let upstreamAborted = false
let rejectUpstream: ((error: unknown) => void) | undefined
let resolveUpstream: ((response: Response) => void) | undefined

const messagesOnlyModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "route-model",
      name: "Route Model",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/v1/messages"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 64_000 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

const fetchMock = mock(
  (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      resolveUpstream = resolve
      rejectUpstream = reject
      const rejectAsAborted = (): void => {
        upstreamAborted = true
        reject(new DOMException("The request was aborted", "AbortError"))
      }
      if (init?.signal?.aborted) {
        rejectAsAborted()
        return
      }
      init?.signal?.addEventListener("abort", rejectAsAborted, { once: true })
    }),
)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  upstreamAborted = false
  rejectUpstream = undefined
  resolveUpstream = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = messagesOnlyModels
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setSsePreflushDeadlineForTest(20)
})

afterEach(() => {
  setSsePreflushDeadlineForTest()
})

test("commits synthetic Responses SSE before buffered Messages headers", async () => {
  const responsePromise = Promise.resolve(
    seedProtocolDatabase().then(() =>
      server.request("/v1/responses", createRequest()),
    ),
  )
  const outcome = await Promise.race([
    responsePromise.then(() => "response" as const),
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 250),
    ),
  ])

  expect(outcome).toBe("response")
  const response = await responsePromise
  const reader = requireBody(response).getReader()
  const first = await reader.read()
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")
  await reader.cancel()
})

test("cancels buffered Messages and emits no Responses events after detach", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", createRequest()),
  )
  const reader = requireBody(response).getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")

  await reader.cancel()

  expect(await waitForUpstreamAbort()).toBe(true)
})

test("emits an in-band Responses failure for a late upstream rejection", async () => {
  const unhandled: Array<unknown> = []
  const onUnhandled = (event: Event): void => {
    unhandled.push((event as unknown as { reason?: unknown }).reason)
  }
  globalThis.addEventListener("unhandledrejection", onUnhandled)
  try {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses", createRequest()),
    )
    const reader = requireBody(response).getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")

    rejectUpstream?.(new Error("late private upstream failure"))
    const rest = await readRemaining(reader)

    const eventOrder = Array.from(
      rest.matchAll(/^event: (.+)$/gm),
      (match) => match[1],
    )
    const eventTypes = Array.from(
      rest.matchAll(/^data: (\{.*\})$/gm),
      (match) => (JSON.parse(match[1]) as { type?: unknown }).type,
    )
    expect(eventOrder).toEqual(["error", "response.failed"])
    expect(eventTypes).toEqual(["error", "response.failed"])
    const contractBehavior = STREAM_BEHAVIOR_CONTRACT.find(
      (row) => row.surface === "Synthetic Responses-from-Messages failure",
    )?.behavior
    if (contractBehavior === undefined) {
      throw new Error("Missing synthetic Responses stream contract row")
    }
    expect(eventOrder.join(" then ")).toBe(contractBehavior)
    expect(rest).not.toContain("late private upstream failure")
    expect((await reader.read()).done).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).toEqual([])
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled)
  }
})

test.each([
  {
    body: new TextEncoder().encode("  exact messages text\r\n  "),
    contentType: "text/plain; charset=utf-8",
    field: "message",
  },
  {
    body: Uint8Array.from([0x00, 0xff, 0x80, 0x41]),
    contentType: "application/octet-stream",
    field: "body_bytes",
  },
] as const)(
  "emits and reports an exact late Messages HTTPError $field once",
  async (fixture) => {
    const errorSpy = spyOn(consola, "error")
    const sentrySpy = spyOn(Sentry, "captureException").mockImplementation(
      () => "event-id",
    )
    try {
      const response = await seedProtocolDatabase().then(() =>
        server.request("/v1/responses", createRequest()),
      )
      const reader = requireBody(response).getReader()
      await reader.read()
      rejectUpstream?.(
        new HTTPError(
          "HTTPError private message",
          new Response(fixture.body.slice(), {
            headers: { "content-type": fixture.contentType },
            status: 429,
            statusText: "Private Status",
          }),
          { private_request: "private request" },
        ),
      )
      const rest = await readRemaining(reader)
      const frames = Array.from(
        rest.matchAll(/^data: (\{.*\})$/gm),
        (match) => JSON.parse(match[1]) as Record<string, unknown>,
      )
      const expected =
        fixture.field === "message" ?
          new TextDecoder(undefined, { ignoreBOM: true }).decode(fixture.body)
        : Array.from(fixture.body)
      for (const frame of frames.slice(-2)) {
        const error = frameError(frame)
        expect(error[fixture.field]).toEqual(expected)
        expect(error.status).toBe(429)
        expect(error.content_type).toBe(fixture.contentType)
      }
      expect(
        errorSpy.mock.calls.filter(
          (call) =>
            typeof call[0] === "object"
            && call[0] !== null
            && "upstreamResponseBodyBytes" in call[0],
        ),
      ).toHaveLength(1)
      expect(
        sentrySpy.mock.calls.filter((call) => hasUpstreamBodyExtra(call[1])),
      ).toHaveLength(1)
      const diagnostics = JSON.stringify([
        rest,
        errorSpy.mock.calls,
        sentrySpy.mock.calls,
      ])
      expect(diagnostics).not.toContain("HTTPError private message")
      expect(diagnostics).not.toContain("Private Status")
      expect(diagnostics).not.toContain("private request")
    } finally {
      errorSpy.mockRestore()
      sentrySpy.mockRestore()
    }
  },
)

test("does not emit failure or leak rejection when abort races late failure", async () => {
  const unhandled: Array<unknown> = []
  const onUnhandled = (event: Event): void => {
    unhandled.push((event as unknown as { reason?: unknown }).reason)
  }
  globalThis.addEventListener("unhandledrejection", onUnhandled)
  try {
    const response = await seedProtocolDatabase().then(() =>
      server.request("/v1/responses", createRequest()),
    )
    const reader = requireBody(response).getReader()
    await reader.read()
    await reader.cancel()
    rejectUpstream?.(new Error("late private abort race"))

    expect(await waitForUpstreamAbort()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).toEqual([])
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled)
  }
})

test("completes an in-band Responses stream for a late unknown Messages block", async () => {
  const response = await seedProtocolDatabase().then(() =>
    server.request("/v1/responses", createRequest()),
  )
  const reader = requireBody(response).getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n")

  resolveUpstream?.(
    Response.json({
      id: "msg_future",
      type: "message",
      role: "assistant",
      model: "route-model",
      content: [{ type: "future_block", value: "kept" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  )
  const rest = await readRemaining(reader)

  expect(rest).toContain("event: response.completed")
  expect(rest).toContain("future_block")
  expect(rest).not.toContain("event: error")
  expect(rest).not.toContain("event: response.failed")
})

function createRequest(): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "route-model",
      input: "hello",
      stream: true,
    }),
  }
}

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("Expected an SSE response body")
  return response.body
}

async function waitForUpstreamAbort(): Promise<boolean> {
  for (let index = 0; index < 100; index += 1) {
    if (upstreamAborted) return true
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return false
}

async function readRemaining(reader: {
  read: () => Promise<
    { done: false; value: Uint8Array } | { done: true; value?: Uint8Array }
  >
}): Promise<string> {
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const next = await reader.read()
    if (next.done) return output
    output += decoder.decode(next.value, { stream: true })
  }
}

function frameError(frame: Record<string, unknown>): Record<string, unknown> {
  const response = frame.response
  if (typeof response !== "object" || response === null) return frame
  const error = (response as Record<string, unknown>).error
  return typeof error === "object" && error !== null ?
      (error as Record<string, unknown>)
    : frame
}

function hasUpstreamBodyExtra(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const extra = (value as Record<string, unknown>).extra
  return (
    typeof extra === "object"
    && extra !== null
    && "upstreamResponseBodyBytes" in extra
  )
}
