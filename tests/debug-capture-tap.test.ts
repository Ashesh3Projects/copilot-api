import { expect, spyOn, test } from "bun:test"

import { tapDebugResponse as tap } from "../src/lib/debug-capture"
import { DebugCaptureBuffer } from "../src/lib/debug-capture-buffer"

function source() {
  let produced = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === 128) {
          controller.close()
          return
        }
        produced++
        controller.enqueue(new Uint8Array(64 * 1024).fill(120))
      },
    }),
    { status: 201, statusText: "Created", headers: { "x-exact": "synthetic" } },
  )
  return { response, produced: () => produced }
}

test("unread response does not drain upstream into a diagnostic tee", async () => {
  const upstream = source()
  const controller = new AbortController()
  const tapped = tap(upstream.response, controller.signal)
  const capture = tapped.capture.catch((error: unknown) => error)
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(tapped.response.status).toBe(201)
    expect(tapped.response.headers.get("x-exact")).toBe("synthetic")
    expect(upstream.produced()).toBeLessThanOrEqual(1)
  } finally {
    controller.abort()
    void tapped.response.body?.cancel()
    await capture
  }
})

test("slow spool writes bound upstream read ahead while preserving every byte", async () => {
  const gate = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the intercepted instance.
  const append = DebugCaptureBuffer.prototype.append
  let first = true
  const slow = spyOn(DebugCaptureBuffer.prototype, "append").mockImplementation(
    async function (this: DebugCaptureBuffer, chunk) {
      if (first) {
        first = false
        entered.resolve(undefined)
        await gate.promise
      }
      await append.call(this, chunk)
    },
  )
  const upstream = source()
  const tapped = tap(upstream.response)
  const client = tapped.response.arrayBuffer()
  try {
    await entered.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(upstream.produced()).toBeLessThanOrEqual(2)
    gate.resolve(undefined)
    expect(new Uint8Array(await client).every((byte) => byte === 120)).toBe(
      true,
    )
    const captured = await tapped.capture
    expect(captured.body === "x".repeat(8 * 1024 * 1024)).toBe(true)
    expect(captured.bodyBytesComplete).toBe(true)
  } finally {
    gate.resolve(undefined)
    await Promise.allSettled([client, tapped.capture])
    slow.mockRestore()
  }
})

test("client cancellation cancels the source and records only the consumed prefix", async () => {
  let sourceCancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("prefix\r\n"))
      },
      cancel() {
        sourceCancelled = true
      },
    }),
  )
  const controller = new AbortController()
  const tapped = tap(response, controller.signal)
  const capture = tapped.capture.catch((error: unknown) => error)
  if (!tapped.response.body) throw new Error("Expected client response body")
  const reader = tapped.response.body.getReader()
  try {
    await reader.read()
    const cancellation = reader.cancel("client left")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sourceCancelled).toBe(true)
    await cancellation
    expect(await capture).toMatchObject({
      capture: {
        body: "prefix\r\n",
        bodyBytesComplete: false,
        omittedReason: "aborted",
      },
    })
  } finally {
    controller.abort()
    void reader.cancel()
    await capture
  }
})
