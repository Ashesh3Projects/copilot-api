import { expect, test } from "bun:test"
import { Hono } from "hono"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HistoryPage } from "~/lib/storage/history-repository"

import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import { createHistoryRuntime } from "~/lib/telemetry-writer"
import { dashboardActivityRoutes } from "~/routes/dashboard/activity"

test("activity pages use deterministic cursors and clear rejects pending old generations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capi-activity-"))
  const storage = new LocalSqliteStorage(join(directory, "fixture.sqlite"))
  await migrateStorage(storage)
  const runtime = await createHistoryRuntime(storage, { autoFlush: false })
  const app = new Hono().route("/", dashboardActivityRoutes)
  try {
    const now = Date.now()
    for (const id of ["a", "b", "c"])
      runtime.writer.enqueue({
        id,
        kind: "activity",
        generation: 0,
        recordedAt: now,
        payload: { type: "info", message: "safe" },
      })
    const first = (await (
      await app.request("/activity?limit=2")
    ).json()) as HistoryPage
    expect(first.records.map((record: { id: string }) => record.id)).toEqual([
      "c",
      "b",
    ])
    const second = (await (
      await app.request(`/activity?limit=2&cursor=${first.cursor}`)
    ).json()) as HistoryPage
    expect(second.records.map((record: { id: string }) => record.id)).toEqual([
      "a",
    ])
    expect((await app.request("/activity?cursor=invalid")).status).toBe(400)
    expect((await app.request("/activity?limit=oops")).status).toBe(400)
    expect((await app.request("/activity", { method: "DELETE" })).status).toBe(
      200,
    )
    await runtime.writer.flush()
    expect(
      ((await (await app.request("/activity")).json()) as HistoryPage).records,
    ).toHaveLength(0)
  } finally {
    await runtime.close(500)
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  }
})
