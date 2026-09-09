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
        kind: "debug",
        generation: 0,
        recordedAt: Date.now(),
        payload: { status: "complete", request: { body: "fixture" } },
      })
    const closing = closeStorageRuntime()
    await Promise.all([closing, closeStorageRuntime()])
    expect(peekHistoryRuntime()).toBeUndefined()
    const reopened = await initializeStorageRuntime({ config: fixture.config })
    const repository = createHistoryRepository(reopened.storage)
    expect((await repository.list("debug")).records).toHaveLength(2)
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
      id: "debug",
      kind: "debug",
      generation: 0,
      recordedAt: Date.now(),
      payload: { status: "streaming", request: { body: "fixture" } },
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
    expect((await history.repository.list("debug")).records).toHaveLength(1)
    await history.close(1000)
  } finally {
    await fixture.close()
  }
})
