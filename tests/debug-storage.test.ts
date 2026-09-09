import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import {
  captureDebugResponseBody,
  debugCaptureMemoryUsage,
} from "../src/lib/debug-capture"
import {
  clearLlmDebugLogs,
  failLlmDebugLog,
  finishLlmDebugLog,
  getLlmDebugLog,
  getLlmDebugCaptureSignal,
  listLlmDebugLogs,
  startLlmDebugLog,
} from "../src/lib/llm-debug-log"
import { LocalSqliteStorage } from "../src/lib/storage/local-sqlite"
import { migrateStorage } from "../src/lib/storage/migrations"
import { TursoStorage } from "../src/lib/storage/turso"
import {
  createHistoryRuntime,
  type HistoryRuntime,
} from "../src/lib/telemetry-writer"
import { createFakeTursoFetch, testConfig } from "./helpers/turso-transport"

let storage: LocalSqliteStorage
let history: HistoryRuntime
beforeEach(async () => {
  const directory = resolve(import.meta.dir, "../.superpowers/test-data/debug")
  await mkdir(directory, { recursive: true })
  storage = new LocalSqliteStorage(
    resolve(directory, `${crypto.randomUUID()}.sqlite`),
  )
  await migrateStorage(storage)
  history = await createHistoryRuntime(storage, { autoFlush: false })
})
afterEach(async () => {
  await history.close(500)
  await storage.close()
})
function start() {
  return startLlmDebugLog({
    method: "POST",
    path: "/responses",
    url: "https://example.test/responses",
    requestBody: '{"input":"ordinary conversation", "model":"gpt-test"}',
    requestHeaders: { authorization: "Bearer active-secret" },
    upstream: { kind: "copilot", accountId: 23 },
  })
}
test("pending overlays and durable rows retain raw credentials, conversation and pins", async () => {
  const id = start()
  expect((await getLlmDebugLog(id))?.request.body).toContain(
    "ordinary conversation",
  )
  failLlmDebugLog(id, new Error("failed using active-secret"))
  const pending = await history.writer.read((items) => Promise.resolve(items))
  expect(JSON.stringify(pending)).toContain("active-secret")
  await history.writer.flush()
  const rows = await storage.read((s) =>
    s.query({ sql: "SELECT payload_json FROM capi_debug", args: [] }),
  )
  expect(JSON.stringify(rows)).toContain("active-secret")
  expect((await getLlmDebugLog(id))?.upstream).toEqual({
    kind: "copilot",
    accountId: 23,
  })
})

test("custom credentials and error text remain present in the raw debug queue", async () => {
  const id = startLlmDebugLog({
    upstream: { kind: "custom", providerId: "custom-fixture" },
    requestHeaders: {
      "X-Vendor-Unusual": "synthetic-unusual-secret",
      "Ocp-Apim-Subscription-Key": "synthetic-subscription-secret",
      "content-type": "application/json",
    },
    requestBody: JSON.stringify({
      input: "synthetic-unusual-secret",
      id_token: "synthetic-id-secret",
    }),
    url: "https://custom.test/responses",
    path: "/responses",
    method: "POST",
  })
  failLlmDebugLog(
    id,
    new Error(
      'Upstream said {"api_key":"synthetic-fragment-secret"}; synthetic-subscription-secret',
    ),
  )
  const pending = await history.writer.read((items) => Promise.resolve(items))
  for (const secret of [
    "synthetic-unusual-secret",
    "synthetic-subscription-secret",
    "synthetic-id-secret",
    "synthetic-fragment-secret",
  ])
    expect(JSON.stringify(pending)).toContain(secret)
})
test("clear generations reject late completions, including pending writer batches", async () => {
  const id = start()
  const signal = getLlmDebugCaptureSignal(id)
  await clearLlmDebugLogs()
  expect(signal.aborted).toBe(true)
  finishLlmDebugLog(id, {
    body: "{}",
    headers: {},
    status: 200,
    statusText: "OK",
  })
  await history.writer.flush()
  expect(await getLlmDebugLog(id)).toBeUndefined()
  expect((await listLlmDebugLogs()).count).toBe(0)
})

test("clear releases live request and stalled response capture reservations together", async () => {
  await clearLlmDebugLogs()
  const baseline = debugCaptureMemoryUsage()
  const id = start()
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024))
      },
    }),
  )
  const capture = captureDebugResponseBody(
    response,
    getLlmDebugCaptureSignal(id),
  ).catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(debugCaptureMemoryUsage()).toBeGreaterThan(baseline + 1024)
  await clearLlmDebugLogs()
  await capture
  void response.body?.cancel()
  expect(debugCaptureMemoryUsage()).toBe(baseline)
})

test("active capture state evicts oldest requests and releases their readers", async () => {
  const first = start()
  const signal = getLlmDebugCaptureSignal(first)
  await history.writer.flush()
  for (let index = 0; index < 2000; index++) start()
  expect(signal.aborted).toBe(true)
  expect(await getLlmDebugLog(first)).toMatchObject({
    status: "interrupted",
    replayable: false,
    error: { name: "DebugCaptureInterrupted" },
  })
  expect(
    (await listLlmDebugLogs({ limit: 200 })).entries.length,
  ).toBeLessThanOrEqual(200)
})
test("new history runtime exposes unfinished rows as interrupted and completed rows intact", async () => {
  const unfinished = start()
  const completed = start()
  finishLlmDebugLog(completed, {
    body: '{"output":"answer"}',
    headers: {},
    status: 200,
    statusText: "OK",
  })
  await history.writer.flush()
  await history.close(500)
  // eslint-disable-next-line require-atomic-updates -- Isolated sequential test lifecycle.
  history = await createHistoryRuntime(storage, { autoFlush: false })
  expect(await getLlmDebugLog(unfinished)).toMatchObject({
    status: "interrupted",
    replayable: false,
  })
  expect(await getLlmDebugLog(completed)).toMatchObject({
    status: "complete",
    replayable: true,
  })
})

test("Turso transport persists raw debug captures and reopens them", async () => {
  await history.close(500)
  const transport = createFakeTursoFetch()
  const remote = new TursoStorage(testConfig())
  try {
    await migrateStorage(remote)
    const runtime = await createHistoryRuntime(remote, { autoFlush: false })
    const id = start()
    finishLlmDebugLog(id, {
      body: '{"output":"active-secret", "api_key":"response-secret"}',
      headers: { "set-cookie": "private=response-cookie" },
      status: 200,
      statusText: "OK",
    })
    await runtime.close(500)
    const reopened = await createHistoryRuntime(remote, { autoFlush: false })
    const entry = await getLlmDebugLog(id)
    expect(entry).toMatchObject({ status: "complete", replayable: true })
    expect(entry?.request.headers.authorization).toBe("Bearer active-secret")
    expect(entry?.response?.body).toBe(
      '{"output":"active-secret", "api_key":"response-secret"}',
    )
    expect(entry?.response?.headers["set-cookie"]).toBe(
      "private=response-cookie",
    )
    await reopened.close(500)
  } finally {
    await remote.close()
    transport.close()
  }
})

test("large request and SSE response survive pending overlays and SQLite reopening exactly", async () => {
  const requestBody =
    '{ "input": "'
    + "x".repeat(2 * 1024 * 1024)
    + '", "token": "synthetic-tail" }\r\n'
  const responseBody =
    ": synthetic-secret\r\nevent: delta\r\ndata: "
    + "x".repeat(2 * 1024 * 1024)
    + "\r\n\r\ndata:[DONE]\r\n\r\n"
  const headers = {
    Authorization: "Bearer synthetic-secret",
    "X-Custom": "exact",
  }
  const url =
    "https://user:synthetic-secret@example.test/responses?token=synthetic-secret&x=%2f&x=+"
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    url,
    requestBody,
    requestHeaders: headers,
  })
  finishLlmDebugLog(id, {
    body: responseBody,
    headers,
    status: 200,
    statusText: "OK",
  })
  const pending = await getLlmDebugLog(id)
  expect(pending?.request.body === requestBody).toBe(true)
  expect(pending?.response?.body === responseBody).toBe(true)
  await history.close(2000)
  // eslint-disable-next-line require-atomic-updates -- Isolated sequential test lifecycle.
  history = await createHistoryRuntime(storage, { autoFlush: false })
  const reopened = await getLlmDebugLog(id)
  expect(reopened?.request.body === requestBody).toBe(true)
  expect(reopened?.response?.body === responseBody).toBe(true)
  expect(reopened?.request.url).toBe(url)
  expect(reopened?.request.headers).toEqual(headers)
  expect(reopened?.response?.headers).toEqual(headers)
  expect(reopened?.response?.bodyBytesComplete).toBe(true)
  expect(reopened?.status).toBe("complete")
})
