import {
  DebugCaptureBuffer,
  DebugCaptureEncodingError,
} from "~/lib/debug-capture-buffer"

export { tapDebugResponse } from "~/lib/debug-response-tap"

/** In-memory working set; large bodies spill to an anonymous temporary file. */
export const DEBUG_CAPTURE_MEMORY_MAX_BYTES = 128 * 1024 * 1024
let retainedBytes = 0

export function debugCaptureMemoryUsage(): number {
  return retainedBytes
}

export function reserveDebugCaptureMemory(
  bytes: number,
  allowSingleOversized = false,
): boolean {
  if (
    bytes < 0
    || !Number.isFinite(bytes)
    || (retainedBytes + bytes > DEBUG_CAPTURE_MEMORY_MAX_BYTES
      && (!allowSingleOversized || retainedBytes !== 0))
  )
    return false
  retainedBytes += bytes
  return true
}

export function releaseDebugCaptureMemory(bytes: number): void {
  retainedBytes -= bytes
}

export interface CapturedBody {
  body: string | null
  bodyBytes: number
  /** False when reading stopped early: bodyBytes is an observed lower bound. */
  bodyBytesComplete?: boolean
  truncated?: boolean
  /** Legacy stored entries only. New captures never filter their contents. */
  redacted?: boolean
  omittedReason?:
    | "size-limit"
    | "unsupported"
    | "read-error"
    | "queue-pressure"
    | "storage-error"
    | "aborted"
}

/** Preserve the captured text and truthful capture metadata without parsing it. */
export function rawDebugCapture(
  input: Omit<CapturedBody, "bodyBytes"> & { bodyBytes?: number },
): CapturedBody {
  return {
    body: input.body,
    bodyBytes:
      input.bodyBytes
      ?? (input.body === null ? 0 : Buffer.byteLength(input.body)),
    bodyBytesComplete: input.bodyBytesComplete ?? !input.omittedReason,
    ...(input.truncated ? { truncated: true } : {}),
    ...(input.omittedReason ? { omittedReason: input.omittedReason } : {}),
  }
}

export function bodyToDebugCapture(body: RequestInit["body"]): CapturedBody {
  if (body === null || body === undefined)
    return rawDebugCapture({ body: null })
  if (typeof body === "string") return rawDebugCapture({ body })
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    try {
      return rawDebugCapture({
        body: new TextDecoder(undefined, {
          fatal: true,
          ignoreBOM: true,
        }).decode(body),
        bodyBytes: body.byteLength,
      })
    } catch {
      return {
        body: null,
        bodyBytes: body.byteLength,
        bodyBytesComplete: true,
        omittedReason: "unsupported",
      }
    }
  }
  return {
    body: null,
    bodyBytes: 0,
    bodyBytesComplete: false,
    omittedReason: "unsupported",
  }
}

export class DebugCaptureError extends Error {
  readonly capture: CapturedBody

  constructor(cause: unknown, capture: CapturedBody, aborted = false) {
    super("Debug body capture did not complete", { cause })
    this.capture = capture
    this.name = aborted ? "AbortError" : "DebugCaptureError"
  }
}

function failureReason(
  error: unknown,
  reason: CapturedBody["omittedReason"],
): CapturedBody["omittedReason"] {
  return error instanceof DebugCaptureEncodingError ? "unsupported" : reason
}

/** Consumes an owned response. Use tapDebugResponse when forwarding to a client. */
export async function captureDebugResponseBody(
  response: Response,
  signal?: AbortSignal,
): Promise<CapturedBody> {
  let bodyBytes = 0
  let bodyBytesComplete = false
  let captured = rawDebugCapture({ body: null })
  let failure: DebugCaptureError | undefined
  let reason: CapturedBody["omittedReason"] = "read-error"
  const buffer = new DebugCaptureBuffer()
  const state = { aborted: Boolean(signal?.aborted) }
  let reader: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined
  const cancel = () => {
    state.aborted = true
    // A tee's cancel promise waits for the client; never await that promise.
    void reader?.cancel().catch(() => undefined)
  }
  const checkAbort = () => {
    if (state.aborted) throw captureAbortReason(signal)
  }
  signal?.addEventListener("abort", cancel, { once: true })
  const timeout = setTimeout(cancel, 60 * 60_000)
  timeout.unref()
  try {
    checkAbort()
    const stream = response.body as ReadableStream<Uint8Array> | null
    reader = stream?.getReader()
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        checkAbort()
        if (done) break
        bodyBytes += value.byteLength
        reason = "storage-error"
        await buffer.append(value)
        reason = "read-error"
      }
      bodyBytesComplete = true
      reason = "storage-error"
      const body = await buffer.text()
      checkAbort()
      captured = { body, bodyBytes, bodyBytesComplete }
    }
  } catch (error) {
    void reader?.cancel().catch(() => undefined)
    let body: string | null = null
    try {
      body = await buffer.text()
    } catch {
      // Failed reads/decodes remain unavailable, never a reconstructed prefix.
    }
    failure = new DebugCaptureError(
      error,
      {
        body,
        bodyBytes,
        bodyBytesComplete,
        truncated: true,
        omittedReason: state.aborted ? "aborted" : failureReason(error, reason),
      },
      state.aborted,
    )
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", cancel)
    reader?.releaseLock()
  }
  try {
    await buffer.close()
  } catch (error) {
    // Preserve the first read/cancel failure and its observed bytes. A close
    // failure after successful reading still has the full captured body.
    failure ??= new DebugCaptureError(error, {
      ...captured,
      omittedReason: "storage-error",
    })
  }
  if (failure) throw failure
  return captured
}

function captureAbortReason(signal: AbortSignal | undefined): unknown {
  return (
    signal?.reason
    ?? new DOMException("Diagnostic capture aborted", "AbortError")
  )
}
