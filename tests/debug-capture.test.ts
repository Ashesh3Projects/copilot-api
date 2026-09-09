import { expect, spyOn, test } from "bun:test"

import {
  captureDebugResponseBody,
  tapDebugResponse,
  DEBUG_CAPTURE_MEMORY_MAX_BYTES,
  debugCaptureMemoryUsage,
  reserveDebugCaptureMemory,
  releaseDebugCaptureMemory,
  rawDebugCapture,
} from "../src/lib/debug-capture"
import { DebugCaptureBuffer } from "../src/lib/debug-capture-buffer"

test("retains exact structured credentials, literal echoes, headers and URL", () => {
  const body =
    '{ "input": "hello synthetic-secret", "api_key":"body-secret", "nested": {"refreshToken":"other-secret"} }\r\n'
  const capture = rawDebugCapture({
    body,
  })
  expect(capture.body).toBe(body)
  expect(capture.redacted).not.toBe(true)
})

test.each([
  '{"api_key":"unfinished-secret',
  "password=synthetic-secret & keep = exact spacing\r\n",
  "<html>token=synthetic-secret</html>\n",
  "",
])("retains malformed and non-JSON capture exactly: %s", (body) => {
  expect(rawDebugCapture({ body })).toMatchObject({ body })
  expect(rawDebugCapture({ body }).omittedReason).toBeUndefined()
})

test("retains bodies larger than the former one MiB limit", () => {
  const body = JSON.stringify({
    input: "x".repeat(2 * 1024 * 1024),
    api_key: "secret-tail",
  })
  const capture = rawDebugCapture({ body })
  expect(capture.body === body).toBe(true)
  expect(capture.bodyBytes).toBe(Buffer.byteLength(body))
  expect(capture.truncated).not.toBe(true)
  expect(capture.omittedReason).toBeUndefined()
})

test("captures the complete large response without changing client bytes", async () => {
  const body = "x".repeat(2 * 1024 * 1024) + "\r\nsynthetic-tail"
  const { response, capture } = tapDebugResponse(new Response(body))
  expect((await response.text()) === body).toBe(true)
  const captured = await capture
  expect(captured.body === body).toBe(true)
  expect(captured.bodyBytes).toBe(Buffer.byteLength(body))
  expect(captured.bodyBytesComplete).toBe(true)
  expect(captured.truncated).not.toBe(true)
  expect(captured.omittedReason).toBeUndefined()
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
  expect(error).toMatchObject({
    cause: { name: "AbortError", message: "client disconnected" },
  })
  void response.body?.cancel()
})

test.each([
  ': keepalive\r\nevent: delta\r\nid: 007\r\ndata: {"text":"normal",\r\ndata: "token":"synthetic-secret"}\r\n\r\ndata:[DONE]\r\n\r\n',
  'data: {"token":"prefix',
  "data: plain text with a synthetic-secret\r\n\r\n",
])("retains exact SSE framing and partial events: %s", (body) => {
  const captured = rawDebugCapture({ body })
  expect(captured.body).toBe(body)
  expect(captured.omittedReason).toBeUndefined()
})

test("ordinary bracketed conversation text and embedded JSON formatting remain intact", () => {
  const body = JSON.stringify({
    input: "[example] explain this",
    metadata: '{ "ordinary": true }',
  })
  expect(rawDebugCapture({ body })).toMatchObject({
    body,
  })
})

test.each([
  'Upstream said {"api_key":"synthetic-secret"}',
  '{"token":"synthetic-secret',
  'prefix {"id_token":"synthetic-secret"} suffix',
  String.raw`prefix {"api\u005fkey":"synthetic-secret"} suffix`,
])(
  "credential fragments remain exact in conversation strings and errors: %s",
  (input) => {
    const capture = rawDebugCapture({ body: JSON.stringify({ input }) })
    expect(capture.body).toBe(JSON.stringify({ input }))
  },
)

test("id tokens remain captured", () => {
  expect(
    rawDebugCapture({ body: '{"id_token":"synthetic-secret"}' }).body,
  ).toBe('{"id_token":"synthetic-secret"}')
})

test("response capture preserves a BOM and split multibyte text", async () => {
  const body = '\uFEFF{ "input": "世界 🌍", "token": "synthetic-secret" }\r\n'
  const bytes = new TextEncoder().encode(body)
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 2)
          controller.enqueue(bytes.slice(at, at + 2))
        controller.close()
      },
    }),
  )
  const tapped = tapDebugResponse(response)
  const clientBytes = await tapped.response.arrayBuffer()
  const captured = await tapped.capture
  expect(captured.body).toBe(body)
  expect(captured.bodyBytes).toBe(bytes.length)
  expect(Array.from(new Uint8Array(clientBytes))).toEqual(Array.from(bytes))
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
      const tapped = tapDebugResponse(response, abort.signal)
      captures.push(
        tapped.capture.then(
          (capture) => {
            if (capture.omittedReason === "queue-pressure") omitted++
          },
          () => undefined,
        ),
      )
      const clientStream = tapped.response
        .body as ReadableStream<Uint8Array> | null
      const reader = clientStream?.getReader()
      if (!reader) throw new Error("Expected client stream")
      clients.push(reader)
      expect((await reader.read()).value?.byteLength).toBe(chunk.byteLength)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(debugCaptureMemoryUsage()).toBeLessThanOrEqual(
        DEBUG_CAPTURE_MEMORY_MAX_BYTES,
      )
    }
    expect(omitted).toBe(0)
    expect(debugCaptureMemoryUsage()).toBeGreaterThan(baseline)
  } finally {
    for (const abort of aborts) abort.abort()
    for (const client of clients) void client.cancel()
    await Promise.all(captures)
  }
  expect(debugCaptureMemoryUsage()).toBe(baseline)
})

test("spills large responses when memory is occupied without dropping raw bytes", async () => {
  const baseline = debugCaptureMemoryUsage()
  const reservation = DEBUG_CAPTURE_MEMORY_MAX_BYTES - baseline
  expect(reserveDebugCaptureMemory(reservation)).toBe(true)
  const body = "data: " + "x".repeat(20 * 1024 * 1024) + "\r\n\r\n"
  try {
    const { response, capture } = tapDebugResponse(new Response(body))
    expect((await response.text()) === body).toBe(true)
    const result = await capture
    expect(result.body === body).toBe(true)
    expect(result.bodyBytes).toBe(Buffer.byteLength(body))
    expect(result.bodyBytesComplete).toBe(true)
    expect(result.omittedReason).toBeUndefined()
  } finally {
    releaseDebugCaptureMemory(reservation)
  }
  expect(debugCaptureMemoryUsage()).toBe(baseline)
})

test("read failures retain the observed prefix and lower-bound byte count", async () => {
  const prefix = 'data: { "token": "synthetic-partial" }\r\n'
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(new TextEncoder().encode(prefix))
      },
    }),
  )
  const capture = captureDebugResponseBody(response).catch(
    (error: unknown) => error,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  streamController?.error(new Error("synthetic read failure"))
  expect(await capture).toMatchObject({
    cause: { message: "synthetic read failure" },
    capture: {
      body: prefix,
      bodyBytes: Buffer.byteLength(prefix),
      bodyBytesComplete: false,
      truncated: true,
      omittedReason: "read-error",
    },
  })
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

test("stalled capture storage stops diagnostics and resumes client bytes", async () => {
  const { promise: gate, resolve: resume } = Promise.withResolvers<undefined>()
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the intercepted buffer as receiver.
  const append = DebugCaptureBuffer.prototype.append
  const slowAppend = spyOn(
    DebugCaptureBuffer.prototype,
    "append",
  ).mockImplementation(async function (this: DebugCaptureBuffer, chunk) {
    await gate
    return append.call(this, chunk)
  })
  const body = "synthetic-content\r\n".repeat(80_000)
  const { response, capture } = tapDebugResponse(new Response(body))
  const pending = capture.catch((error: unknown) => error)
  try {
    expect((await response.text()) === body).toBe(true)
    expect(await pending).toMatchObject({
      capture: {
        body: null,
        bodyBytesComplete: false,
        omittedReason: "storage-error",
      },
    })
  } finally {
    resume(undefined)
    await pending.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    slowAppend.mockRestore()
  }
})

test("capture buffer failures retain observed bytes and never fail the client", async () => {
  const body = "synthetic-response"
  const append = spyOn(
    DebugCaptureBuffer.prototype,
    "append",
  ).mockRejectedValueOnce(new Error("synthetic spool failure"))
  try {
    const { response, capture } = tapDebugResponse(new Response(body))
    const pending = capture.catch((error: unknown) => error)
    expect(await response.text()).toBe(body)
    expect(await pending).toMatchObject({
      cause: { message: "synthetic spool failure" },
      capture: {
        bodyBytes: Buffer.byteLength(body),
        bodyBytesComplete: false,
        omittedReason: "storage-error",
      },
    })
  } finally {
    append.mockRestore()
  }
})

test("capture cleanup failures retain the full body and accurate byte metadata", async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the intercepted buffer as receiver.
  const close = DebugCaptureBuffer.prototype.close
  const failedClose = spyOn(
    DebugCaptureBuffer.prototype,
    "close",
  ).mockImplementationOnce(async function (this: DebugCaptureBuffer) {
    await close.call(this)
    throw new Error("synthetic close failure")
  })
  const body = "synthetic-response"
  try {
    expect(
      await captureDebugResponseBody(new Response(body)).catch(
        (error: unknown) => error,
      ),
    ).toMatchObject({
      cause: { message: "synthetic close failure" },
      capture: {
        body,
        bodyBytes: Buffer.byteLength(body),
        bodyBytesComplete: true,
        omittedReason: "storage-error",
      },
    })
  } finally {
    failedClose.mockRestore()
  }
})

test("invalid UTF-8 is reported as unsupported with exact observed bytes", async () => {
  const { response, capture } = tapDebugResponse(
    new Response(Uint8Array.from([65, 255, 66])),
  )
  const pending = capture.catch((error: unknown) => error)
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
    65, 255, 66,
  ])
  expect(await pending).toMatchObject({
    capture: {
      body: null,
      bodyBytes: 3,
      bodyBytesComplete: true,
      omittedReason: "unsupported",
    },
  })
})
