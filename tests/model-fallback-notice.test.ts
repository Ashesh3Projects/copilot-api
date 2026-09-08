import { expect, test } from "bun:test"

import {
  applyMessagesModelFallbackNotice,
  applyResponsesModelFallbackNotice,
} from "~/lib/model-fallback-notice"

const notice = {
  sourceModel: "source",
  targetModel: "target",
  cached: false,
  nativeClientNotice: true,
}
const request = {
  payload: { fallbacks: [{ model: "target" }] },
  headers: new Headers({ "anthropic-beta": "server-side-fallback-2026-06-01" }),
}
const fallback = {
  type: "fallback",
  from: { model: "source" },
  to: { model: "target" },
}

test("adds a native JSON fallback block only for opted-in capable clients", async () => {
  const response = await applyMessagesModelFallbackNotice(
    Response.json({
      type: "message",
      content: [{ type: "text", text: "answer" }],
    }),
    request,
    notice,
  )
  expect(await response.json()).toMatchObject({
    content: [fallback, { type: "text", text: "answer" }],
  })
  for (const candidate of [
    { ...request, payload: {} },
    { ...request, payload: { fallbacks: [] } },
    { ...request, payload: { fallbacks: [{ model: 1 }] } },
    { ...request, headers: new Headers() },
  ]) {
    const original = Response.json({ type: "message", content: [] })
    expect(
      await applyMessagesModelFallbackNotice(original, candidate, notice),
    ).toBe(original)
  }
  const disabled = Response.json({ type: "message", content: [] })
  expect(
    await applyMessagesModelFallbackNotice(disabled, request, {
      ...notice,
      nativeClientNotice: false,
    }),
  ).toBe(disabled)
})

test("does not duplicate native blocks or add notices to JSON failures", async () => {
  for (const body of [
    { type: "message", content: [fallback] },
    { type: "message", content: [], stop_reason: "refusal" },
    { type: "error", error: { message: "failed" } },
  ]) {
    const response = await applyMessagesModelFallbackNotice(
      Response.json(body),
      request,
      notice,
    )
    expect(await response.json()).toEqual(body)
  }
  const failed = Response.json({ type: "error" }, { status: 422 })
  expect(await applyMessagesModelFallbackNotice(failed, request, notice)).toBe(
    failed,
  )
})

test("inserts one streaming fallback block and shifts every original content index", async () => {
  const events = [
    { type: "message_start", message: { type: "message", content: [] } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "answer" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]
  const response = await applyMessagesModelFallbackNotice(
    sse(events),
    request,
    notice,
  )
  expect(await readEvents(response)).toEqual([
    events[0],
    { type: "content_block_start", index: 0, content_block: fallback },
    { type: "content_block_stop", index: 0 },
    { ...events[1], index: 1 },
    { ...events[2], index: 1 },
    { ...events[3], index: 1 },
    events[4],
    events[5],
  ])
})

test("leaves native duplicate blocks and streams failing before content untouched", async () => {
  for (const events of [
    [{ type: "error", error: { message: "failed" } }],
    [
      { type: "message_start", message: { content: [] } },
      { type: "error", error: { message: "failed" } },
    ],
    [
      { type: "message_start", message: { content: [] } },
      { type: "content_block_start", index: 0, content_block: fallback },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ],
  ]) {
    const response = await applyMessagesModelFallbackNotice(
      sse(events),
      request,
      notice,
    )
    expect(await readEvents(response)).toEqual(events)
  }
})

test("evaluates a delayed fallback notice only when streaming content arrives", async () => {
  let accepted = false
  const response = await applyMessagesModelFallbackNotice(
    sse([
      { type: "message_start", message: { content: [] } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]),
    request,
    () => (accepted ? notice : undefined),
  )
  accepted = true
  const events = await readEvents(response)
  expect(events[1]).toMatchObject({
    type: "content_block_start",
    content_block: fallback,
  })
})

test("adds lazy Codex response metadata after a preflushed HTTP response", async () => {
  let accepted = false
  const event = {
    type: "response.created",
    headers: {
      authorization: "must-not-pass",
      "x-github-request-id": "safe-id",
    },
    response: {
      id: "resp",
      model: "source",
      headers: { "x-openai-model": "stale-target" },
    },
  }
  const response = applyResponsesModelFallbackNotice(sse([event]), () =>
    accepted ? notice : undefined,
  )
  accepted = true
  expect(await readEvents(response)).toEqual([
    {
      ...event,
      headers: { "x-github-request-id": "safe-id", "openai-model": "target" },
      response: { ...event.response, headers: { "openai-model": "target" } },
    },
  ])
})

test("leaves Codex failure events and disabled notices unmodified", async () => {
  const events = [
    { type: "response.failed", response: { error: { message: "failed" } } },
  ]
  expect(
    await readEvents(
      applyResponsesModelFallbackNotice(sse(events), () => notice),
    ),
  ).toEqual(events)
  const original = sse([
    { type: "response.created", response: { model: "source" } },
  ])
  expect(
    applyResponsesModelFallbackNotice(original, {
      ...notice,
      nativeClientNotice: false,
    }),
  ).toBe(original)
})

function sse(events: Array<Record<string, unknown>>): Response {
  const bytes = new TextEncoder().encode(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
      )
      .join(""),
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 7)
          controller.enqueue(bytes.slice(index, index + 7))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function readEvents(response: Response): Promise<Array<unknown>> {
  return (await response.text())
    .split(/\r?\n\r?\n/u)
    .filter(Boolean)
    .map((frame) => {
      const data = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      return JSON.parse(data) as unknown
    })
}
