/**
 * SSE keep-alive lifecycle helpers.
 *
 * Cloudflare's origin read timeout is an *inactivity* timer (~120-125s, fixed
 * below Enterprise), not a duration cap — any byte from the origin resets it.
 * The gateway trips it by going silent while an upstream model prefills a large
 * context or reasons before its first token. These helpers emit SSE comment
 * frames during those stalls so the wire is never silent.
 *
 * Comment frames (a line beginning with `:`) are discarded by the SSE parser at
 * the transport layer, before any event reaches client logic, so they cannot
 * perturb a client's stream state machine.
 *
 * Both helpers race a single retained promise against a cancellable timer rather
 * than running a background `setInterval`. The reason is LIFECYCLE COUPLING, not
 * write safety: a per-request interval leaks unless it is cleared on every exit
 * path (normal completion, consumer break, upstream error, client abort), and
 * racing ties the timer's lifetime to the helper's own `finally`. Hono's
 * `StreamingApi.write()` already swallows post-close errors and its single
 * `WritableStreamDefaultWriter` serializes concurrent writes, so overlapping
 * writes are *not* the hazard here.
 *
 * `src/routes/code-sessions/event-bus.ts` uses a bare `setInterval` for the same
 * job, but it manages a long-lived per-session subscriber set with explicit
 * `ensureKeepalive`/`cleanupKeepalive` pairing — a different lifecycle than a
 * one-shot per-request stream.
 */

import { shouldAwaitModelFallbackBeforePreflush } from "~/lib/model-fallback"

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000
export const SSE_HEARTBEAT_COMMENT = ": keepalive\n\n"
export const SSE_PREFLUSH_DEADLINE_MS = 25_000

let ssePreflushDeadlineMs = SSE_PREFLUSH_DEADLINE_MS

export function setSsePreflushDeadlineForTest(
  deadlineMs = SSE_PREFLUSH_DEADLINE_MS,
): void {
  ssePreflushDeadlineMs = deadlineMs
}

/**
 * Structurally satisfied by Hono's `SSEStreamingApi`, which exposes `write`,
 * `aborted` and `closed` as public members — call sites pass the stream object
 * straight through, no adapter required.
 */
export interface SseHeartbeatSink {
  write: (input: string) => Promise<unknown>
  aborted: boolean
  closed: boolean
  onAbort?: (listener: () => void) => void
}

let heartbeatCount = 0

/** Total keep-alive frames written since process start. Observability only. */
export const getSseHeartbeatCount = (): number => heartbeatCount

/** Reset the counter so tests can assert exact per-case emission counts. */
export const resetSseHeartbeatCountForTest = (): void => {
  heartbeatCount = 0
}

/**
 * Kill switch. Set `COPILOT_API_DISABLE_SSE_HEARTBEAT` to disable emission
 * without a redeploy if a client is ever found to mishandle comment frames.
 * Read per-call rather than cached so it can be toggled in tests.
 */
const isHeartbeatDisabled = (): boolean =>
  Boolean(process.env.COPILOT_API_DISABLE_SSE_HEARTBEAT)

/** Sentinel distinguishing a timer win from a genuine upstream value. */
const HEARTBEAT_TIMER = Symbol("heartbeat-timer")
const HEARTBEAT_ABORT = Symbol("heartbeat-abort")

function createAbortError(): Error {
  const error = new Error("The downstream SSE connection was aborted")
  error.name = "AbortError"
  return error
}

function createSinkAbortPromise(
  sink: SseHeartbeatSink,
): Promise<typeof HEARTBEAT_ABORT> {
  if (sink.aborted || sink.closed) return Promise.resolve(HEARTBEAT_ABORT)

  return new Promise((resolve) => {
    sink.onAbort?.(() => resolve(HEARTBEAT_ABORT))
  })
}

const createHeartbeatTimer = (
  intervalMs: number,
): { cancel: () => void; promise: Promise<typeof HEARTBEAT_TIMER> } => {
  let resolveTimer: ((value: typeof HEARTBEAT_TIMER) => void) | undefined
  const promise = new Promise<typeof HEARTBEAT_TIMER>((resolve) => {
    resolveTimer = resolve
  })
  const timeout = setTimeout(() => {
    resolveTimer?.(HEARTBEAT_TIMER)
  }, intervalMs)

  return {
    cancel: () => {
      clearTimeout(timeout)
    },
    promise,
  }
}

/** Write one keep-alive frame, swallowing failures on a dead socket. */
export const writeSseHeartbeat = async (
  sink: SseHeartbeatSink,
): Promise<void> => {
  if (sink.aborted || sink.closed || isHeartbeatDisabled()) return

  try {
    await sink.write(SSE_HEARTBEAT_COMMENT)
    heartbeatCount += 1
  } catch {
    // A heartbeat is best-effort: a failed write on a socket the client has
    // already dropped must not become a stream error.
  }
}

/**
 * Wrap an upstream async iterable, emitting a keep-alive whenever the source
 * stalls longer than `intervalMs`. A no-op when chunks arrive continuously.
 */
export async function* withSseHeartbeat<T>(
  source: AsyncIterable<T>,
  sink: SseHeartbeatSink,
  intervalMs = SSE_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  const sinkAbort = createSinkAbortPromise(sink)
  let detached = sink.aborted || sink.closed
  // Retained across heartbeats: re-racing the *same* pending `next()` is what
  // makes a stall emit repeatedly without ever pulling twice from the source.
  let pendingNext = iterator.next()

  try {
    while (!sink.aborted && !sink.closed) {
      const timer = createHeartbeatTimer(intervalMs)

      try {
        const winner = await Promise.race([
          pendingNext,
          timer.promise,
          sinkAbort,
        ])

        if (winner === HEARTBEAT_ABORT) {
          detached = true
          return
        }

        if (winner === HEARTBEAT_TIMER) {
          await writeSseHeartbeat(sink)
          continue
        }

        if (winner.done === true) break
        yield winner.value
        pendingNext = iterator.next()
      } finally {
        timer.cancel()
      }
    }
  } finally {
    // `pendingNext` is dispatched before the loop is entered, and `Promise.race`
    // is the only place a handler is ever attached to it. A sink that already
    // reports aborted on the first pull skips the loop entirely, leaving that
    // in-flight promise unobserved — so a later rejection would surface as an
    // unhandled rejection rather than through this generator. Absorb it here.
    // Harmless when the promise was already raced and settled.
    pendingNext.catch(() => {
      // Already reported through the generator, or nobody is listening.
    })

    detached ||= sink.aborted || sink.closed
    const teardown = iterator.return?.()
    if (detached) {
      // Async-generator `return()` queues behind an already-pending `next()`.
      // Awaiting it here can hang forever on a stalled response body. The
      // request's AbortSignal owns cancellation of that body; detach this
      // best-effort iterator cleanup so downstream abort settles promptly.
      void teardown?.catch(() => {})
    } else {
      try {
        await teardown
      } catch {
        // Teardown is best-effort.
      }
    }
  }
}

/**
 * Await a promise inside an already-open stream, emitting a keep-alive whenever
 * it stays pending longer than `intervalMs`. For sites that block on a single
 * buffered upstream call rather than iterating.
 */
export const withHeartbeatWhilePending = async <T>(
  pending: Promise<T>,
  sink: SseHeartbeatSink,
  intervalMs = SSE_HEARTBEAT_INTERVAL_MS,
): Promise<T> => {
  const sinkAbort = createSinkAbortPromise(sink)
  while (!sink.aborted && !sink.closed) {
    const timer = createHeartbeatTimer(intervalMs)

    try {
      const winner = await Promise.race([pending, timer.promise, sinkAbort])
      if (winner === HEARTBEAT_ABORT) throw createAbortError()
      if (winner !== HEARTBEAT_TIMER) return winner
      await writeSseHeartbeat(sink)
    } finally {
      timer.cancel()
    }
  }

  throw createAbortError()
}

export type SsePreflushSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { reason: unknown; status: "rejected" }

const SSE_PREFLUSH_TIMER = Symbol("sse-preflush-timer")

export type SsePreflushResult<T> =
  | { kind: "pending"; pending: Promise<SsePreflushSettlement<T>> }
  | { kind: "settled"; value: T }

export function unwrapSsePreflushSettlement<T>(
  settlement: SsePreflushSettlement<T>,
): T {
  if (settlement.status === "fulfilled") return settlement.value
  throw settlement.reason
}

/**
 * Preserve ordinary HTTP errors for a short window, then let the caller open
 * an SSE response while the same already-observed operation continues.
 */
export async function raceSsePreflush<T>(
  pending: Promise<T>,
): Promise<SsePreflushResult<T>> {
  if (shouldAwaitModelFallbackBeforePreflush()) {
    return { kind: "settled", value: await pending }
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const observed = pending.then<
    SsePreflushSettlement<T>,
    SsePreflushSettlement<T>
  >(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ reason, status: "rejected" }),
  )
  const timer = new Promise<typeof SSE_PREFLUSH_TIMER>((resolve) => {
    timeout = setTimeout(
      () => resolve(SSE_PREFLUSH_TIMER),
      ssePreflushDeadlineMs,
    )
  })
  const settlement = await Promise.race([observed, timer])
  if (timeout !== undefined) clearTimeout(timeout)

  if (settlement === SSE_PREFLUSH_TIMER) {
    return { kind: "pending", pending: observed }
  }
  return {
    kind: "settled",
    value: unwrapSsePreflushSettlement(settlement),
  }
}
