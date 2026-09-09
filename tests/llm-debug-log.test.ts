import { afterEach, beforeEach, expect, jest, test } from "bun:test"

import { debugCaptureMemoryUsage } from "../src/lib/debug-capture"
import {
  abortLlmDebugLog,
  clearLlmDebugLogs,
  failLlmDebugLog,
  finishLlmDebugLog,
  getLlmDebugLog,
  LLM_DEBUG_HISTORY_WINDOW_MS,
  listLlmDebugLogs,
  startLlmDebugLog,
} from "../src/lib/llm-debug-log"
beforeEach(async () => {
  await clearLlmDebugLogs()
})

afterEach(async () => {
  await clearLlmDebugLogs()
  jest.useRealTimers()
})

test("captures request and response in memory without initializing storage", async () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: '{"input":"memory only"}',
    requestHeaders: {},
    url: "https://example.test/responses",
  })
  expect((await getLlmDebugLog(id))?.status).toBe("pending")
  finishLlmDebugLog(id, {
    body: '{"output":"volatile answer"}',
    headers: {},
    status: 200,
    statusText: "OK",
  })
  expect((await getLlmDebugLog(id))?.response?.body).toContain(
    "volatile answer",
  )
  expect((await listLlmDebugLogs()).count).toBe(1)
  await clearLlmDebugLogs()
  expect(await getLlmDebugLog(id)).toBeUndefined()
})

test("preserves exact request and response credentials, formatting, headers and URL", async () => {
  const startedAtMs = Date.now()
  const requestBody = `{"messages": [ {"role": "user", "content": "Find this request"} ], "api_key": "body-secret", "model": "gpt-test", "stream": false}`
  const responseBody = `{ "access_token": "response-secret", "ok": true }`
  const requestHeaders = {
    authorization: "Bearer raw-token",
    cookie: "session=secret",
    "x-api-key": "header-secret",
  }
  const responseHeaders = {
    "content-type": "application/json",
    "set-cookie": "upstream=secret",
  }
  const url =
    "https://url-user:url-password@example.test/chat/completions?api_key=query-secret"
  const id = startLlmDebugLog({
    method: "POST",
    path: "/chat/completions",
    requestBody,
    requestHeaders,
    requestId: "req-debug-1",
    startedAtMs,
    url,
  })

  finishLlmDebugLog(
    id,
    {
      body: responseBody,
      headers: responseHeaders,
      status: 200,
      statusText: "OK",
    },
    startedAtMs + 123,
  )

  const list = await listLlmDebugLogs()
  expect(list.count).toBe(1)
  expect(list.entries[0]?.model).toBe("gpt-test")
  expect(list.entries[0]?.requestPreview).toContain("Find this request")
  expect(list.entries[0]?.responsePreview).toContain("ok")
  expect(list.entries[0]?.durationMs).toBe(123)

  const detail = await getLlmDebugLog(id)
  expect(detail?.request).toMatchObject({
    body: requestBody,
    bodyBytes: new TextEncoder().encode(requestBody).byteLength,
    headers: requestHeaders,
    url,
  })
  expect(detail?.response).toMatchObject({
    body: responseBody,
    bodyBytes: new TextEncoder().encode(responseBody).byteLength,
    headers: responseHeaders,
  })
  expect(detail?.replayable).toBe(true)
})

test("classifies non-success upstream responses as errors", async () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "gpt-test" }),
    requestHeaders: {},
    url: "https://example.test/responses",
  })

  finishLlmDebugLog(id, {
    body: JSON.stringify({
      error: { code: "invalid_request_body", message: "Invalid request" },
    }),
    headers: { "content-type": "application/json" },
    status: 400,
    statusText: "Bad Request",
  })

  expect((await getLlmDebugLog(id))?.status).toBe("error")
  expect((await listLlmDebugLogs()).entries[0]?.status).toBe("error")
})

test("preserves session headers and nested structured request bodies", async () => {
  const rawIds = [
    "root-session-private",
    "root-thread-private",
    "conversation-private",
    "prompt-cache-private",
    "safety-private",
    "client-session-private",
    "client-thread-private",
    "claude-session-private",
  ]
  const requestBody = JSON.stringify({
    session_id: rawIds[0],
    thread_id: rawIds[1],
    conversation_id: rawIds[2],
    prompt_cache_key: rawIds[3],
    safety_identifier: rawIds[4],
    client_metadata: JSON.stringify({
      session_id: rawIds[5],
      thread_id: rawIds[6],
    }),
    metadata: {
      user_id: JSON.stringify({ session_id: rawIds[7] }),
    },
    model: "gpt-test",
  })
  const requestHeaders = {
    "X-Agent-Task-Id": "derived-agent-task-id",
    "X-Client-Session-Id": "derived-client-session-id",
    "X-Interaction-Id": "derived-interaction-id",
  }
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody,
    requestHeaders,
    url: "https://example.test/responses",
  })

  const detail = await getLlmDebugLog(id)
  expect(detail?.request.body).toBe(requestBody)
  expect(detail?.request.headers).toEqual(requestHeaders)
  expect(detail?.replayable).toBe(true)
})

test("preserves non-JSON request bodies", async () => {
  const requestBody = "api_key=body-secret & keep = exact spacing"
  const id = startLlmDebugLog({
    method: "POST",
    path: "/embeddings",
    requestBody,
    requestHeaders: {},
    url: "https://example.test/embeddings",
  })

  expect((await getLlmDebugLog(id))?.request).toMatchObject({
    body: requestBody,
    bodyBytes: Buffer.byteLength(requestBody),
  })
})

test("preserves aborted response details and runtime error URL", async () => {
  const startedAtMs = Date.now()
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: "{}",
    requestHeaders: {},
    startedAtMs,
    url: "https://example.test/responses",
  })
  const errorPath =
    "https://error-user:error-password@example.test/responses?token=error-secret"
  const error = Object.assign(new Error("client disconnected"), {
    code: "ECONNABORTED",
    path: errorPath,
  })
  const responseBody = `{ "refresh_token": "response-secret" }`
  const responseHeaders = {
    "content-type": "application/json",
    "set-cookie": "upstream=secret",
  }

  abortLlmDebugLog(id, {
    endedAtMs: startedAtMs + 25,
    error,
    response: {
      body: responseBody,
      headers: responseHeaders,
      status: 499,
      statusText: "Client Closed Request",
    },
  })

  const detail = await getLlmDebugLog(id)
  expect(detail?.error?.path).toBe(errorPath)
  expect(detail?.response).toMatchObject({
    body: responseBody,
    bodyBytes: new TextEncoder().encode(responseBody).byteLength,
    headers: responseHeaders,
  })
})

test("returns independent raw entries", async () => {
  const requestBody = `{ "api_key": "request-secret" }`
  const responseBody = `{ "access_token": "response-secret" }`
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody,
    requestHeaders: { authorization: "Bearer raw-token" },
    url: "https://example.test/responses?token=query-secret",
  })
  finishLlmDebugLog(id, {
    body: responseBody,
    headers: { "set-cookie": "upstream=secret" },
    status: 200,
    statusText: "OK",
  })

  const firstRead = await getLlmDebugLog(id)
  if (!firstRead?.response) throw new Error("Expected a completed debug entry")
  firstRead.request.body = "mutated"
  firstRead.request.headers.authorization = "mutated"
  firstRead.response.body = "mutated"
  firstRead.response.headers["set-cookie"] = "mutated"

  const secondRead = await getLlmDebugLog(id)
  expect(secondRead?.request.body).toBe(requestBody)
  expect(secondRead?.request.headers.authorization).toBe("Bearer raw-token")
  expect(secondRead?.response?.body).toBe(responseBody)
  expect(secondRead?.response?.headers["set-cookie"]).toBe("upstream=secret")
})

test("incomplete HTTP 200 captures stay unsuccessful with honest byte counts", async () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: "{}",
    requestHeaders: {},
    url: "https://example.test/responses",
  })
  finishLlmDebugLog(id, {
    body: "data: partial\r\n",
    bodyBytes: 15,
    bodyBytesComplete: false,
    truncated: true,
    omittedReason: "queue-pressure",
    headers: { "content-type": "text/event-stream" },
    status: 200,
    statusText: "OK",
  })
  const detail = await getLlmDebugLog(id)
  expect(detail?.status).toBe("error")
  expect(detail?.response).toMatchObject({
    body: "data: partial\r\n",
    bodyBytes: 15,
    bodyBytesComplete: false,
    truncated: true,
    omittedReason: "queue-pressure",
  })
})

test("an unavailable request capture is not marked complete after HTTP 200", async () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: null,
    requestCapture: {
      body: null,
      bodyBytes: 123,
      bodyBytesComplete: false,
      omittedReason: "read-error",
    },
    requestHeaders: {},
    url: "https://example.test/responses",
  })
  finishLlmDebugLog(id, {
    body: "{}",
    headers: {},
    status: 200,
    statusText: "OK",
  })
  expect((await getLlmDebugLog(id))?.status).toBe("error")
})

test("prunes entries older than the retention window", async () => {
  const now = Date.now()
  const oldId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "old-model" }),
    requestHeaders: {},
    startedAtMs: now - LLM_DEBUG_HISTORY_WINDOW_MS - 1,
    url: "https://example.test/responses",
  })
  finishLlmDebugLog(
    oldId,
    { body: "{}", headers: {}, status: 200, statusText: "OK" },
    now - LLM_DEBUG_HISTORY_WINDOW_MS,
  )
  const freshId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "fresh-model" }),
    requestHeaders: {},
    startedAtMs: now,
    url: "https://example.test/responses",
  })

  const list = await listLlmDebugLogs()
  expect(list.count).toBe(1)
  expect(list.entries[0]?.id).toBe(freshId)
  expect(list.entries[0]?.model).toBe("fresh-model")
})

test("retains unsuccessful entries for one hour while successful entries expire after ten minutes", async () => {
  jest.useFakeTimers()
  const startedAtMs = Date.UTC(2026, 7, 24)
  jest.setSystemTime(startedAtMs)

  const completeId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "complete-model" }),
    requestHeaders: {},
    url: "https://example.test/responses",
  })
  finishLlmDebugLog(completeId, {
    body: "{}",
    headers: {},
    status: 200,
    statusText: "OK",
  })

  const nonSuccessId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "non-success-model" }),
    requestHeaders: {},
    url: "https://example.test/responses",
  })
  finishLlmDebugLog(nonSuccessId, {
    body: '{"error":"upstream failure"}',
    headers: { "content-type": "application/json" },
    status: 503,
    statusText: "Service Unavailable",
  })

  const erroredId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "errored-model" }),
    requestHeaders: {},
    url: "https://example.test/responses",
  })
  failLlmDebugLog(erroredId, new Error("transport failure"))

  const abortedId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "aborted-model" }),
    requestHeaders: {},
    url: "https://example.test/responses",
  })
  abortLlmDebugLog(abortedId, { error: new Error("client disconnected") })

  jest.setSystemTime(startedAtMs + LLM_DEBUG_HISTORY_WINDOW_MS + 1)
  expect(
    (await listLlmDebugLogs()).entries.map((entry) => entry.id).sort(),
  ).toEqual([abortedId, erroredId, nonSuccessId].sort())
  expect(await getLlmDebugLog(completeId)).toBeUndefined()

  jest.setSystemTime(startedAtMs + 60 * 60 * 1000 + 1)
  expect((await listLlmDebugLogs()).count).toBe(0)
})

test("retains requests that become unsuccessful after ten minutes", async () => {
  jest.useFakeTimers()
  const startedAtMs = Date.UTC(2026, 7, 24)
  jest.setSystemTime(startedAtMs)
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "slow-failure-model" }),
    requestHeaders: {},
    url: "https://example.test/responses",
  })

  jest.setSystemTime(startedAtMs + LLM_DEBUG_HISTORY_WINDOW_MS + 1)
  failLlmDebugLog(
    id,
    new Error("late transport failure"),
    startedAtMs + LLM_DEBUG_HISTORY_WINDOW_MS + 1,
  )

  expect((await getLlmDebugLog(id))?.status).toBe("error")
  jest.setSystemTime(startedAtMs + 60 * 60 * 1000 + 1)
  expect(await getLlmDebugLog(id)).toBeUndefined()
})

test("keeps timestamp ordering after a newer successful entry expires", async () => {
  jest.useFakeTimers()
  const startedAtMs = Date.UTC(2026, 7, 24)
  jest.setSystemTime(startedAtMs)

  const retainedErrorId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "retained-error" }),
    requestHeaders: {},
    startedAtMs,
    url: "https://example.test/responses",
  })
  failLlmDebugLog(retainedErrorId, new Error("upstream failure"), startedAtMs)

  const expiredSuccessId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "expired-success" }),
    requestHeaders: {},
    startedAtMs: startedAtMs + 1,
    url: "https://example.test/responses",
  })
  finishLlmDebugLog(
    expiredSuccessId,
    { body: "{}", headers: {}, status: 200, statusText: "OK" },
    startedAtMs + 1,
  )

  jest.setSystemTime(startedAtMs + LLM_DEBUG_HISTORY_WINDOW_MS + 2)
  expect(await getLlmDebugLog(expiredSuccessId)).toBeUndefined()

  const backdatedId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "backdated-pending" }),
    requestHeaders: {},
    startedAtMs: startedAtMs - 1,
    url: "https://example.test/responses",
  })

  expect((await listLlmDebugLogs()).entries.map((entry) => entry.id)).toEqual([
    retainedErrorId,
    backdatedId,
  ])
})

test("retains complete previews inside the retention window", async () => {
  const longPrompt = "x".repeat(400)
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "fresh-model", input: longPrompt }),
    requestHeaders: {},
    url: "https://example.test/responses",
  })

  const entry = (await listLlmDebugLogs()).entries.find(
    (item) => item.id === id,
  )
  expect(entry?.requestPreview).toContain(longPrompt)
})

test("timer releases expired captures from memory without dashboard reads", async () => {
  jest.useFakeTimers()
  const startedAtMs = Date.now()
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "idle-model", input: "retained" }),
    requestHeaders: {},
    startedAtMs,
    url: "https://example.test/responses",
  })
  finishLlmDebugLog(id, {
    body: "{}",
    headers: {},
    status: 200,
    statusText: "OK",
  })

  expect(debugCaptureMemoryUsage()).toBeGreaterThan(0)
  jest.advanceTimersByTime(LLM_DEBUG_HISTORY_WINDOW_MS)
  expect(debugCaptureMemoryUsage()).toBe(0)
  jest.setSystemTime(startedAtMs)

  // Moving the clock back proves the timer removed the capture itself.
  expect((await listLlmDebugLogs()).count).toBe(0)
})

test("paginates memory by timestamp and id without duplicates", async () => {
  const startedAtMs = Date.now()
  const ids = Array.from({ length: 5 }, () =>
    startLlmDebugLog({
      method: "POST",
      path: "/responses",
      requestBody: "{}",
      requestHeaders: {},
      url: "https://example.test/responses",
      startedAtMs,
    }),
  )
    .sort()
    .reverse()
  const first = await listLlmDebugLogs({ limit: 2 })
  expect(first.entries.map((entry) => entry.id)).toEqual(ids.slice(0, 2))
  expect(first.cursor).not.toBeNull()
  if (!first.cursor) throw new Error("Expected a second debug page")
  const second = await listLlmDebugLogs({ limit: 2, cursor: first.cursor })
  expect(second.entries.map((entry) => entry.id)).toEqual(ids.slice(2, 4))
  if (!second.cursor) throw new Error("Expected a third debug page")
  const third = await listLlmDebugLogs({ limit: 2, cursor: second.cursor })
  expect(third.entries.map((entry) => entry.id)).toEqual(ids.slice(4))
  expect(third.cursor).toBeNull()
})

test("successful captures expire exactly at ten minutes and pending captures at one hour", async () => {
  jest.useFakeTimers()
  const startedAtMs = Date.now()
  const input = {
    method: "POST",
    path: "/responses",
    requestBody: "{}",
    requestHeaders: {},
    url: "https://example.test/responses",
  }
  const complete = startLlmDebugLog(input)
  const pending = startLlmDebugLog(input)
  finishLlmDebugLog(complete, {
    body: "{}",
    headers: {},
    status: 200,
    statusText: "OK",
  })
  jest.setSystemTime(startedAtMs + LLM_DEBUG_HISTORY_WINDOW_MS - 1)
  expect(await getLlmDebugLog(complete)).toBeDefined()
  jest.setSystemTime(startedAtMs + LLM_DEBUG_HISTORY_WINDOW_MS)
  expect(await getLlmDebugLog(complete)).toBeUndefined()
  expect(await getLlmDebugLog(pending)).toBeDefined()
  jest.setSystemTime(startedAtMs + 60 * 60_000)
  expect(await getLlmDebugLog(pending)).toBeUndefined()
  expect(debugCaptureMemoryUsage()).toBe(0)
})

test("keeps aborted requests terminal when late response work finishes", async () => {
  const startedAtMs = Date.now()
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "gpt-abort" }),
    requestHeaders: {},
    startedAtMs,
    url: "https://example.test/responses",
  })
  const abortError = new Error("client disconnected")
  abortError.name = "AbortError"

  abortLlmDebugLog(id, { error: abortError, endedAtMs: startedAtMs + 25 })
  finishLlmDebugLog(
    id,
    {
      body: '{"late":true}',
      headers: { "content-type": "application/json" },
      status: 200,
      statusText: "OK",
    },
    startedAtMs + 50,
  )
  failLlmDebugLog(id, new Error("late failure"), startedAtMs + 75)

  const detail = await getLlmDebugLog(id)
  expect(detail?.status).toBe("aborted")
  expect(detail?.durationMs).toBe(25)
  expect(detail?.error?.name).toBe("AbortError")
  expect(detail?.response).toBeUndefined()
})

test("does not let an abort overwrite a completed request", async () => {
  const startedAtMs = Date.now()
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "gpt-complete" }),
    requestHeaders: {},
    startedAtMs,
    url: "https://example.test/responses",
  })
  finishLlmDebugLog(
    id,
    {
      body: "{}",
      headers: {},
      status: 200,
      statusText: "OK",
    },
    startedAtMs + 10,
  )
  abortLlmDebugLog(id, {
    error: new Error("late abort"),
    endedAtMs: startedAtMs + 20,
  })

  expect((await getLlmDebugLog(id))?.status).toBe("complete")
  expect((await getLlmDebugLog(id))?.durationMs).toBe(10)
})
