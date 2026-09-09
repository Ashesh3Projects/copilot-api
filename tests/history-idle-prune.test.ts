import { afterEach, beforeEach, expect, jest, test } from "bun:test"

import { debugCaptureMemoryUsage } from "../src/lib/debug-capture"
import {
  clearLlmDebugLogs,
  failLlmDebugLog,
  finishLlmDebugLog,
  getLlmDebugCaptureSignal,
  getLlmDebugLog,
  LLM_DEBUG_HISTORY_WINDOW_MS,
  listLlmDebugLogs,
  startLlmDebugLog,
} from "../src/lib/llm-debug-log"

beforeEach(async () => {
  await clearLlmDebugLogs()
  jest.useFakeTimers()
})

afterEach(async () => {
  await clearLlmDebugLogs()
  jest.useRealTimers()
})

test("idle timer releases successful, failed and pending capture memory at their retention deadlines", async () => {
  const baseline = debugCaptureMemoryUsage()
  const startedAtMs = Date.now()
  const input = {
    method: "POST",
    path: "/responses",
    url: "https://example.test/responses",
    requestHeaders: {},
    requestBody: '{"input":"synthetic raw"}',
  }
  const complete = startLlmDebugLog(input)
  const failed = startLlmDebugLog(input)
  const pending = startLlmDebugLog(input)
  const pendingSignal = getLlmDebugCaptureSignal(pending)
  finishLlmDebugLog(complete, {
    body: '{"output":"synthetic raw"}',
    headers: {},
    status: 200,
    statusText: "OK",
  })
  failLlmDebugLog(failed, new Error("synthetic raw failure"))

  const retainedBytes = debugCaptureMemoryUsage()
  jest.advanceTimersByTime(LLM_DEBUG_HISTORY_WINDOW_MS - 1)
  expect(debugCaptureMemoryUsage()).toBe(retainedBytes)
  jest.advanceTimersByTime(1)
  expect(debugCaptureMemoryUsage()).toBeGreaterThan(baseline)
  expect(debugCaptureMemoryUsage()).toBeLessThan(retainedBytes)
  expect(pendingSignal.aborted).toBe(false)

  // No log reads have run: the timer must schedule the remaining one-hour TTL.
  const remainingBytes = debugCaptureMemoryUsage()
  jest.advanceTimersByTime(60 * 60_000 - LLM_DEBUG_HISTORY_WINDOW_MS - 1)
  expect(debugCaptureMemoryUsage()).toBe(remainingBytes)
  expect(pendingSignal.aborted).toBe(false)
  jest.advanceTimersByTime(1)
  expect(debugCaptureMemoryUsage()).toBe(baseline)
  expect(pendingSignal.aborted).toBe(true)

  // Rewinding proves idle cleanup released entries, not just hidden old dates.
  jest.setSystemTime(startedAtMs)
  expect(await getLlmDebugLog(complete)).toBeUndefined()
  expect(await getLlmDebugLog(failed)).toBeUndefined()
  expect(await getLlmDebugLog(pending)).toBeUndefined()
  expect((await listLlmDebugLogs()).count).toBe(0)
})
