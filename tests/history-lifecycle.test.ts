import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import { createHistoryRepository } from "~/lib/storage/history-repository"
import {
  closeStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"
import {
  createHistoryRuntime,
  peekHistoryRuntime,
} from "~/lib/telemetry-writer"

import { createRuntimeStorage } from "./helpers/runtime-storage"

test("closing the owning storage runtime drains history and marks the run clean exactly once", async () => {
  const fixture = await createRuntimeStorage()
  try {
    await initializeStorageRuntime(fixture)
    const history = await createHistoryRuntime(fixture.storage, {
      autoFlush: false,
    })
    for (const id of ["one", "two"])
      history.writer.enqueue({
        id,
        kind: "usage",
        generation: 0,
        recordedAt: Date.now(),
        payload: { inputTokens: 7, outputTokens: 11, requestCount: 1 },
      })
    const closing = closeStorageRuntime()
    await Promise.all([closing, closeStorageRuntime()])
    expect(peekHistoryRuntime()).toBeUndefined()
    const reopened = await initializeStorageRuntime({ config: fixture.config })
    const repository = createHistoryRepository(reopened.storage)
    expect((await repository.readUsage(0)).lifetime).toMatchObject({
      inputTokens: 14,
      outputTokens: 22,
      requestCount: 2,
    })
    const runs = await reopened.storage.read((session) =>
      session.query({
        sql: "SELECT clean, ended_at FROM capi_process_runs",
        args: [],
      }),
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]?.clean).toBe(1)
    expect(runs[0]?.ended_at).toBeNumber()
    const next = await createHistoryRuntime(reopened.storage, {
      autoFlush: false,
    })
    expect((await next.repository.collectionStatus()).unknownGaps).toBe(0)
    expect(await history.close(1000)).toMatchObject({
      pendingRecords: 0,
      degraded: false,
    })
  } finally {
    await fixture.close()
  }
})

test("a real read-only CLI command creates no history run and leaves a live gateway's history intact", async () => {
  const fixture = await createRuntimeStorage()
  try {
    await initializeStorageRuntime(fixture)
    const history = await createHistoryRuntime(fixture.storage, {
      autoFlush: false,
    })
    history.writer.enqueue({
      id: "routing",
      kind: "routing",
      generation: 0,
      recordedAt: Date.now(),
      payload: { totals: { requests: 1, upstreamCalls: 2 } },
    })
    await history.writer.flush()
    const child = Bun.spawn(
      [process.execPath, "src/main.ts", "debug", "--json"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          DATA_DIR: fixture.directory,
          TURSO_DATABASE_URL: "",
          TURSO_AUTH_TOKEN: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ storage: { kind: "sqlite" } })
    expect((await history.repository.collectionStatus()).unknownGaps).toBe(0)
    expect(
      await fixture.storage.read((session) =>
        session.query({
          sql: "SELECT COUNT(*) AS count FROM capi_process_runs",
          args: [],
        }),
      ),
    ).toEqual([{ count: 1 }])
    expect((await history.repository.readRouting(0)).lifetime).toEqual({
      requests: 1,
      upstreamCalls: 2,
    })
    await history.close(1000)
  } finally {
    await fixture.close()
  }
})

test("idle maintenance renews the run and prunes routing minutes and receipts while retaining usage and lifetime counters", async () => {
  const fixture = await createRuntimeStorage()
  try {
    await initializeStorageRuntime(fixture)
    let now = Date.now()
    const history = await createHistoryRuntime(fixture.storage, {
      now: () => now,
    })
    history.writer.enqueue({
      id: "usage",
      kind: "usage",
      generation: 0,
      recordedAt: now,
      payload: { inputTokens: 7, outputTokens: 11, requestCount: 1 },
    })
    history.writer.enqueue({
      id: "routing",
      kind: "routing",
      generation: 0,
      recordedAt: now,
      payload: { totals: { requests: 1, upstreamCalls: 2 } },
    })
    await history.writer.flush()
    now += 86400_000 + 60_000
    await Bun.sleep(1100)
    expect((await history.repository.readUsage(0)).buckets).toHaveLength(1)
    expect((await history.repository.readRouting(0)).buckets).toHaveLength(0)
    expect((await history.repository.readRouting(0)).lifetime).toEqual({
      requests: 1,
      upstreamCalls: 2,
    })
    expect(
      await fixture.storage.read((session) =>
        session.query({
          sql: "SELECT id FROM capi_applied_operations WHERE kind = 'history_batch'",
          args: [],
        }),
      ),
    ).toEqual([])
    expect(
      await fixture.storage.read((session) =>
        session.query({
          sql: "SELECT clean, ended_at, json_extract(payload_json, '$.heartbeatAt') AS heartbeat FROM capi_process_runs",
          args: [],
        }),
      ),
    ).toEqual([{ clean: 0, ended_at: null, heartbeat: now }])
    expect((await history.repository.collectionStatus()).unknownGaps).toBe(0)
  } finally {
    await fixture.close()
  }
})

test("close returns within its deadline when the final clean-run transaction stalls", async () => {
  const fixture = await createRuntimeStorage()
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let stalled = false
  let history: Awaited<ReturnType<typeof createHistoryRuntime>> | undefined
  try {
    await initializeStorageRuntime(fixture)
    history = await createHistoryRuntime(
      {
        ...fixture.storage,
        async transaction(work) {
          if (stalled) {
            entered.resolve(undefined)
            await released.promise
          }
          return fixture.storage.transaction(work)
        },
      },
      { autoFlush: false },
    )
    stalled = true
    const started = performance.now()
    const closing = history.close(30)
    await entered.promise
    expect(await closing).toMatchObject({ pendingRecords: 0, degraded: true })
    expect(performance.now() - started).toBeLessThan(500)
    expect(peekHistoryRuntime()).toBeUndefined()
    released.resolve(undefined)
    expect(
      await fixture.storage.read((session) =>
        session.query({
          sql: "SELECT clean, ended_at FROM capi_process_runs",
          args: [],
        }),
      ),
    ).toEqual([{ clean: 0, ended_at: null }])
  } finally {
    released.resolve(undefined)
    await history?.close(1000)
    await fixture.close()
  }
})
