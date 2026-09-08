import { expect, test } from "bun:test"

import {
  captureDebugResponseBody,
  DEBUG_CAPTURE_MAX_BYTES,
  DEBUG_CAPTURE_MEMORY_MAX_BYTES,
  debugCaptureMemoryUsage,
  sanitizeDebugCapture,
  sanitizeDebugHeaders,
  sanitizeDebugUrl,
  sanitizeDebugText,
} from "../src/lib/debug-capture"

test("scrubs structured credentials, literal echoes, headers and URL secrets", () => {
  const capture = sanitizeDebugCapture({
    body: JSON.stringify({
      input: "hello live-secret",
      api_key: "body-secret",
      nested: { refreshToken: "other-secret" },
    }),
    knownCredentials: ["live-secret"],
  })
  expect(capture.body).toContain("hello [REDACTED]")
  expect(capture.body).not.toContain("body-secret")
  expect(capture.body).not.toContain("other-secret")
  expect(capture.redacted).toBe(true)
  expect(
    sanitizeDebugHeaders({
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "X-Client-Session-Id": "private",
      "content-type": "application/json",
    }),
  ).toEqual({
    Authorization: "[REDACTED]",
    Cookie: "[REDACTED]",
    "X-Client-Session-Id": "[REDACTED]",
    "content-type": "application/json",
  })
  expect(
    sanitizeDebugUrl(
      "https://user:password@example.test/responses?token=secret&model=safe",
    ),
  ).toBe("https://example.test/responses?token=%5BREDACTED%5D&model=safe")
})

test("omits all malformed and oversized body content instead of a secret prefix", () => {
  expect(
    sanitizeDebugCapture({ body: '{"api_key":"unfinished-secret' }),
  ).toMatchObject({ body: null, omittedReason: "unsupported", redacted: false })
  const body = JSON.stringify({
    input: "x".repeat(DEBUG_CAPTURE_MAX_BYTES),
    api_key: "secret-tail",
  })
  expect(sanitizeDebugCapture({ body })).toMatchObject({
    body: null,
    bodyBytes: Buffer.byteLength(body),
    truncated: true,
    omittedReason: "size-limit",
  })
})

test("diagnostic capture preserves complete large client bytes and cancels its branch", async () => {
  const body = "x".repeat(2 * DEBUG_CAPTURE_MAX_BYTES)
  const response = new Response(body)
  const capture = captureDebugResponseBody(response)
  expect(await response.text()).toBe(body)
  expect(await capture).toMatchObject({
    body: null,
    truncated: true,
    bodyBytes: Buffer.byteLength(body),
  })
})

test("capture abort releases a stalled diagnostic reader", async () => {
  const abort = new AbortController()
  const response = new Response(new ReadableStream<Uint8Array>({ start() {} }))
  const capture = captureDebugResponseBody(response, abort.signal)
  abort.abort(new DOMException("client disconnected", "AbortError"))
  let error: unknown
  try {
    await capture
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({ name: "AbortError" })
  void response.body?.cancel()
})

test("SSE capture scrubs JSON data and rejects incomplete structured events", () => {
  const captured = sanitizeDebugCapture({
    body: 'event: delta\ndata: {"text":"normal", "token":"secret"}\n\ndata: [DONE]\n\n',
    contentType: "text/event-stream",
  })
  expect(captured.body).toContain("normal")
  expect(captured.body).not.toContain("secret")
  expect(
    sanitizeDebugCapture({
      body: 'data: {"token":"prefix',
      contentType: "text/event-stream",
    }).body,
  ).toBeNull()
})

test("ordinary bracketed conversation text and embedded JSON formatting remain intact", () => {
  const body = JSON.stringify({
    input: "[example] explain this",
    metadata: '{ "ordinary": true }',
  })
  expect(sanitizeDebugCapture({ body })).toMatchObject({
    body,
    redacted: false,
  })
})

test.each([
  'Upstream said {"api_key":"synthetic-secret"}',
  '{"token":"synthetic-secret',
  'prefix {"id_token":"synthetic-secret"} suffix',
  String.raw`prefix {"api\u005fkey":"synthetic-secret"} suffix`,
])(
  "credential fragments are safe in conversation strings and errors: %s",
  (input) => {
    const capture = sanitizeDebugCapture({ body: JSON.stringify({ input }) })
    expect(JSON.stringify(capture)).not.toContain("synthetic-secret")
    expect(sanitizeDebugText(input)).not.toContain("synthetic-secret")
  },
)

test("id tokens and subscription credentials are scrubbed", () => {
  expect(
    sanitizeDebugCapture({ body: '{"id_token":"synthetic-secret"}' }).body,
  ).not.toContain("synthetic-secret")
  expect(
    sanitizeDebugHeaders({ "Ocp-Apim-Subscription-Key": "synthetic-secret" }),
  ).toEqual({ "Ocp-Apim-Subscription-Key": "[REDACTED]" })
})

test("concurrent stalled capture buffers obey one shared memory budget and release on abort", async () => {
  const captures: Array<Promise<unknown>> = []
  const aborts: Array<AbortController> = []
  const clients: Array<{ cancel(): Promise<void> }> = []
  let omitted = 0
  const chunk = new Uint8Array(256 * 1024)
  const baseline = debugCaptureMemoryUsage()
  try {
    for (let index = 0; index < 24; index++) {
      const abort = new AbortController()
      aborts.push(abort)
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk)
          },
        }),
      )
      captures.push(
        captureDebugResponseBody(response, abort.signal).then(
          (capture) => {
            if (capture.omittedReason === "queue-pressure") omitted++
          },
          () => undefined,
        ),
      )
      const clientStream = response.body as ReadableStream<Uint8Array> | null
      const reader = clientStream?.getReader()
      if (!reader) throw new Error("Expected client stream")
      clients.push(reader)
      expect((await reader.read()).value?.byteLength).toBe(chunk.byteLength)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(debugCaptureMemoryUsage()).toBeLessThanOrEqual(
        DEBUG_CAPTURE_MEMORY_MAX_BYTES,
      )
    }
    expect(omitted).toBeGreaterThan(0)
    expect(debugCaptureMemoryUsage()).toBeGreaterThan(baseline)
  } finally {
    for (const abort of aborts) abort.abort()
    for (const client of clients) void client.cancel()
    await Promise.all(captures)
  }
  expect(debugCaptureMemoryUsage()).toBe(baseline)
})

test("response capture releases shared reservations on read failure and successful completion", async () => {
  const baseline = debugCaptureMemoryUsage()
  const chunk = new TextEncoder().encode('{"ok":true}')
  const controller = {
    value: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
  }
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller.value = value
        value.enqueue(chunk)
      },
    }),
  )
  const capture = captureDebugResponseBody(response).catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(debugCaptureMemoryUsage()).toBeGreaterThan(baseline)
  controller.value?.error(new Error("synthetic read failure"))
  await capture
  expect(debugCaptureMemoryUsage()).toBe(baseline)
  const completed = await captureDebugResponseBody(new Response(chunk))
  expect(completed.body).toBe('{"ok":true}')
  expect(debugCaptureMemoryUsage()).toBe(baseline)
})
