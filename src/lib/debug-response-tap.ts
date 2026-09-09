import {
  DebugCaptureError,
  rawDebugCapture,
  type CapturedBody,
} from "~/lib/debug-capture"
import {
  DebugCaptureBuffer,
  DebugCaptureEncodingError,
} from "~/lib/debug-capture-buffer"

// A stalled diagnostic disk must not leave inference waiting indefinitely.
const CAPTURE_WRITE_TIMEOUT_MS = 1000

class ResponseCapture {
  readonly result = Promise.withResolvers<CapturedBody>()
  private readonly buffer = new DebugCaptureBuffer()
  private readonly stopped = Promise.withResolvers<undefined>()
  private bytes = 0
  private complete = false
  private failure:
    | { cause: unknown; reason: CapturedBody["omittedReason"] }
    | undefined
  private writing: Promise<void> = Promise.resolve()
  private writingPending = false
  private finishing: Promise<void> | undefined
  private readonly timeout: ReturnType<typeof setTimeout>
  private readonly signal: AbortSignal | undefined

  constructor(signal?: AbortSignal) {
    this.signal = signal
    this.timeout = setTimeout(() => this.abort(), 60 * 60_000)
    this.timeout.unref()
    signal?.addEventListener("abort", this.abort, { once: true })
    // The client can consume its body before the caller awaits diagnostics.
    void this.result.promise.catch(() => undefined)
    if (signal?.aborted) this.abort()
  }

  private readonly abort = () => {
    this.fail(
      this.signal?.reason
        ?? new DOMException("Diagnostic capture aborted", "AbortError"),
      "aborted",
    )
  }

  async append(chunk: Uint8Array): Promise<void> {
    if (this.finishing) return
    this.bytes += chunk.byteLength
    this.writingPending = true
    this.writing = this.buffer.append(chunk).finally(() => {
      this.writingPending = false
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.writing,
        this.stopped.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Diagnostic spool write timed out")),
            CAPTURE_WRITE_TIMEOUT_MS,
          )
        }),
      ])
    } catch (cause) {
      this.fail(cause, "storage-error")
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  finish(): void {
    if (this.finishing) return
    this.complete = true
    this.startFinalizing()
  }

  fail(cause: unknown, reason: CapturedBody["omittedReason"]): void {
    if (this.finishing) return
    this.failure = { cause, reason }
    this.stopped.resolve(undefined)
    this.startFinalizing()
  }

  private startFinalizing(): void {
    clearTimeout(this.timeout)
    this.signal?.removeEventListener("abort", this.abort)
    this.finishing = this.finalize()
    void this.finishing.catch((cause: unknown) => this.result.reject(cause))
  }

  private async finalize(): Promise<void> {
    const failure = this.failure
    // Never wait for a stuck file operation before releasing client flow or
    // publishing the failure. Its single owned buffer is closed afterwards.
    if (failure && this.writingPending) {
      this.result.reject(
        new DebugCaptureError(
          failure.cause,
          {
            body: null,
            bodyBytes: this.bytes,
            bodyBytesComplete: false,
            truncated: true,
            omittedReason: failure.reason,
          },
          failure.reason === "aborted",
        ),
      )
      await this.writing.catch(() => undefined)
      await this.buffer.close()
      return
    }
    let body: string | null = null
    let error = failure
    try {
      body = await this.buffer.text()
    } catch (cause) {
      error ??= {
        cause,
        reason:
          cause instanceof DebugCaptureEncodingError ? "unsupported" : (
            "storage-error"
          ),
      }
    }
    try {
      await this.buffer.close()
    } catch (cause) {
      error ??= { cause, reason: "storage-error" }
    }
    const captured: CapturedBody = {
      body,
      bodyBytes: this.bytes,
      bodyBytesComplete: this.complete,
    }
    if (error)
      this.result.reject(
        new DebugCaptureError(
          error.cause,
          {
            ...captured,
            ...(!this.complete ? { truncated: true } : {}),
            omittedReason: error.reason,
          },
          error.reason === "aborted",
        ),
      )
    else this.result.resolve(captured)
  }
}

/** Headers return immediately; capture advances only with client consumption. */
export function tapDebugResponse(
  response: Response,
  signal?: AbortSignal,
): {
  response: Response
  capture: Promise<CapturedBody>
} {
  if (!response.body)
    return {
      response,
      capture: Promise.resolve(rawDebugCapture({ body: null })),
    }
  const capture = new ResponseCapture(signal)
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const state = { ended: false }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const item = await reader.read()
          if (state.ended) return
          if (item.done) {
            state.ended = true
            controller.close()
            reader.releaseLock()
            capture.finish()
            return
          }
          await capture.append(item.value)
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancel() can run while the spool write is awaited.
          if (!state.ended) controller.enqueue(item.value)
        } catch (cause) {
          if (state.ended) return
          state.ended = true
          capture.fail(cause, "read-error")
          controller.error(cause)
          reader.releaseLock()
        }
      },
      cancel(reason) {
        state.ended = true
        capture.fail(
          reason ?? new DOMException("Client cancelled response", "AbortError"),
          "aborted",
        )
        // A transport's cancel can stall too; cleanup must not hold client cancel.
        void reader
          .cancel(reason)
          .catch(() => undefined)
          .finally(() => reader.releaseLock())
      },
    },
    { highWaterMark: 0 },
  )
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  })
  return { response: wrapped, capture: capture.result.promise }
}
