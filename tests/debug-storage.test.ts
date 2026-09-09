import { afterEach, beforeEach, expect, test, spyOn } from "bun:test"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import {
  captureDebugResponseBody,
  DEBUG_CAPTURE_MEMORY_MAX_BYTES,
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
  await clearLlmDebugLogs()
})
afterEach(async () => {
  await clearLlmDebugLogs()
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
test("raw captures and dashboard reads never enter telemetry or SQL, preserving conversation and pins", async () => {
  const databaseRead = spyOn(storage, "read")
  const databaseWrite = spyOn(storage, "transaction")
  const enqueue = spyOn(history.writer, "enqueue")
  const id = start()
  expect((await getLlmDebugLog(id))?.request.body).toContain(
    "ordinary conversation",
  )
  failLlmDebugLog(id, new Error("failed using active-secret"))
  const entry = await getLlmDebugLog(id)
  expect(entry?.request.headers.authorization).toBe("Bearer active-secret")
  expect(entry?.error?.message).toBe("failed using active-secret")
  expect(entry?.upstream).toEqual({
    kind: "copilot",
    accountId: 23,
  })
  expect((await listLlmDebugLogs()).entries[0]?.id).toBe(id)
  await clearLlmDebugLogs()
  expect(await getLlmDebugLog(id)).toBeUndefined()
  expect(enqueue).not.toHaveBeenCalled()
  expect(databaseRead).not.toHaveBeenCalled()
  expect(databaseWrite).not.toHaveBeenCalled()
  enqueue.mockRestore()
  databaseRead.mockRestore()
  databaseWrite.mockRestore()
  expect(history.writer.status().pendingRecords).toBe(0)
  await history.writer.flush()
  const tables = await storage.read((s) =>
    s.query({
      sql: "SELECT name FROM sqlite_master WHERE name LIKE 'capi_debug%'",
      args: [],
    }),
  )
  expect(tables).toEqual([])
})

test("custom configured credentials remain in memory-only headers, bodies and errors", async () => {
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
  const entry = await getLlmDebugLog(id)
  expect(entry).toBeDefined()
  for (const secret of [
    "synthetic-unusual-secret",
    "synthetic-subscription-secret",
    "synthetic-id-secret",
    "synthetic-fragment-secret",
  ])
    expect(JSON.stringify(entry)).toContain(secret)
})
test("clearing memory cancels captures and ignores their late completions", async () => {
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
  for (let index = 0; index < 2000; index++) start()
  expect(signal.aborted).toBe(true)
  expect(await getLlmDebugLog(first)).toBeUndefined()
  expect(
    (await listLlmDebugLogs({ limit: 200 })).entries.length,
  ).toBeLessThanOrEqual(200)
})
test("database history lifecycle cannot reload, interrupt or delete process-local captures", async () => {
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
    status: "pending",
    replayable: true,
  })
  expect(await getLlmDebugLog(completed)).toMatchObject({
    status: "complete",
    replayable: true,
  })
  await clearLlmDebugLogs()
  await history.close(500)
  // eslint-disable-next-line require-atomic-updates -- Isolated sequential test lifecycle.
  history = await createHistoryRuntime(storage, { autoFlush: false })
  expect((await listLlmDebugLogs()).count).toBe(0)
})

test("debug operations send no Turso requests and keep raw results only in memory", async () => {
  await history.close(500)
  const transport = createFakeTursoFetch()
  const remote = new TursoStorage(testConfig())
  let runtime: HistoryRuntime | undefined
  try {
    await migrateStorage(remote)
    runtime = await createHistoryRuntime(remote, { autoFlush: false })
    const requestCount = transport.requests.length
    const id = start()
    finishLlmDebugLog(id, {
      body: '{"output":"active-secret", "api_key":"response-secret"}',
      headers: { "set-cookie": "private=response-cookie" },
      status: 200,
      statusText: "OK",
    })
    const entry = await getLlmDebugLog(id)
    expect(entry).toMatchObject({ status: "complete", replayable: true })
    expect(entry?.request.headers.authorization).toBe("Bearer active-secret")
    expect(entry?.response?.body).toBe(
      '{"output":"active-secret", "api_key":"response-secret"}',
    )
    expect(entry?.response?.headers["set-cookie"]).toBe(
      "private=response-cookie",
    )
    expect((await listLlmDebugLogs()).count).toBe(1)
    await clearLlmDebugLogs()
    expect(transport.requests.length).toBe(requestCount)
    expect(runtime.writer.status().pendingRecords).toBe(0)
  } finally {
    await clearLlmDebugLogs()
    await runtime?.close(500)
    await remote.close()
    transport.close()
  }
})

test("debug remains available while the selected database is unavailable", async () => {
  const databaseRead = spyOn(storage, "read").mockImplementation(() => {
    throw new Error("Fixture database unavailable")
  })
  try {
    const id = start()
    finishLlmDebugLog(id, {
      body: "{}",
      headers: {},
      status: 200,
      statusText: "OK",
    })
    expect((await getLlmDebugLog(id))?.status).toBe("complete")
    expect((await listLlmDebugLogs()).count).toBe(1)
    await clearLlmDebugLogs()
    expect((await listLlmDebugLogs()).count).toBe(0)
    expect(databaseRead).not.toHaveBeenCalled()
  } finally {
    databaseRead.mockRestore()
  }
})

test("completed request and response bodies share the bounded memory budget", async () => {
  const baseline = debugCaptureMemoryUsage()
  let first: string | undefined
  const requestBody = '{ "input": "' + "x".repeat(2 * 1024 * 1024) + '" }\r\n'
  const responseBody =
    "event: delta\r\ndata: "
    + "y".repeat(2 * 1024 * 1024)
    + "\r\n\r\ndata:[DONE]\r\n\r\n"
  for (let index = 0; index < 18; index++) {
    const id = startLlmDebugLog({
      method: "POST",
      path: "/responses",
      url: "https://example.test/responses",
      requestHeaders: {},
      requestBody,
    })
    first ??= id
    finishLlmDebugLog(id, {
      body: responseBody,
      headers: {},
      status: 200,
      statusText: "OK",
    })
    const entry = await getLlmDebugLog(id)
    expect(entry?.request.body === requestBody).toBe(true)
    expect(entry?.response?.body === responseBody).toBe(true)
    expect(entry?.status).toBe("complete")
    if (index === 0) {
      expect(debugCaptureMemoryUsage() - baseline).toBeGreaterThanOrEqual(
        (requestBody.length + responseBody.length) * 2,
      )
    }
    expect(debugCaptureMemoryUsage()).toBeLessThanOrEqual(
      DEBUG_CAPTURE_MEMORY_MAX_BYTES,
    )
  }
  expect(debugCaptureMemoryUsage()).toBeGreaterThan(baseline)
  if (!first) throw new Error("Expected a debug capture")
  expect(await getLlmDebugLog(first)).toBeUndefined()
  expect((await listLlmDebugLogs()).count).toBeGreaterThan(0)
  await clearLlmDebugLogs()
  expect(debugCaptureMemoryUsage()).toBe(baseline)
})

test.each(["request", "response"] as const)(
  "retains one oversized %s capture and evicts it whole for the next entry",
  async (side) => {
    const baseline = debugCaptureMemoryUsage()
    const first = start()
    const signal = getLlmDebugCaptureSignal(first)
    const oversizedBody = "x".repeat(DEBUG_CAPTURE_MEMORY_MAX_BYTES / 2 + 1)
    const requestBody = side === "request" ? oversizedBody : "{}"
    const responseBody = side === "response" ? oversizedBody : "{}"
    const id = startLlmDebugLog({
      method: "POST",
      path: "/responses",
      url: "https://example.test/responses",
      requestHeaders: {},
      requestBody,
    })
    if (side === "request") {
      expect(debugCaptureMemoryUsage()).toBeGreaterThan(
        DEBUG_CAPTURE_MEMORY_MAX_BYTES,
      )
      expect((await getLlmDebugLog(id))?.request.body === requestBody).toBe(
        true,
      )
    }
    finishLlmDebugLog(id, {
      body: responseBody,
      headers: {},
      status: 200,
      statusText: "OK",
    })
    const entry = await getLlmDebugLog(id)
    expect(entry?.request.body === requestBody).toBe(true)
    expect(entry?.response?.body === responseBody).toBe(true)
    expect(entry?.status).toBe("complete")
    expect(entry?.replayable).toBe(true)
    expect(debugCaptureMemoryUsage()).toBeGreaterThan(
      DEBUG_CAPTURE_MEMORY_MAX_BYTES,
    )
    expect(signal.aborted).toBe(true)
    expect(await getLlmDebugLog(first)).toBeUndefined()
    const replacement = start()
    expect(await getLlmDebugLog(id)).toBeUndefined()
    expect((await getLlmDebugLog(replacement))?.status).toBe("pending")
    expect(debugCaptureMemoryUsage()).toBeLessThanOrEqual(
      DEBUG_CAPTURE_MEMORY_MAX_BYTES,
    )
    await clearLlmDebugLogs()
    expect(debugCaptureMemoryUsage()).toBe(baseline)
  },
)

test("fresh processes cannot recover completed debug bodies or pending captures", async () => {
  const script = `
    import { LocalSqliteStorage } from './src/lib/storage/local-sqlite';
    import { migrateStorage } from './src/lib/storage/migrations';
    import { createHistoryRuntime } from './src/lib/telemetry-writer';
    import { startLlmDebugLog, finishLlmDebugLog, listLlmDebugLogs } from './src/lib/llm-debug-log';
    const storage = new LocalSqliteStorage(process.env.DEBUG_TEST_DATABASE);
    await migrateStorage(storage);
    const history = await createHistoryRuntime(storage, { autoFlush: false });
    if (process.env.DEBUG_TEST_CAPTURE === '1') {
      const input = { method: 'POST', path: '/responses', url: 'https://example.test/responses', requestHeaders: {}, requestBody: '{"input":"volatile-restart-marker"}' };
      startLlmDebugLog(input);
      const id = startLlmDebugLog(input);
      finishLlmDebugLog(id, { body: '{"output":"volatile-restart-answer"}', headers: {}, status: 200, statusText: 'OK' });
    }
    console.log(JSON.stringify({ count: (await listLlmDebugLogs()).count }));
    await history.close(500);
    await storage.close();
  `
  const path = resolve(
    import.meta.dir,
    "../.superpowers/test-data/debug",
    `${crypto.randomUUID()}.sqlite`,
  )
  for (const capture of ["1", "0"]) {
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        DEBUG_TEST_DATABASE: path,
        DEBUG_TEST_CAPTURE: capture,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(errors).toBe("")
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({ count: capture === "1" ? 2 : 0 })
  }
})
