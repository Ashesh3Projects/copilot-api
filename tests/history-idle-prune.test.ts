import { expect, test } from "bun:test"
import { join } from "node:path"

import { LocalSqliteStorage } from "../src/lib/storage/local-sqlite"
import { migrateStorage } from "../src/lib/storage/migrations"
import { createHistoryRuntime } from "../src/lib/telemetry-writer"

async function waitForTimer() {
  await new Promise((resolve) => setTimeout(resolve, 1200))
}

test("idle timer physically prunes successful and failed captures at their retention deadlines", async () => {
  const storage = new LocalSqliteStorage(
    join(
      import.meta.dir,
      "../.superpowers/test-data/idle-prune",
      `${crypto.randomUUID()}.sqlite`,
    ),
  )
  await migrateStorage(storage)
  let now = Date.now()
  const history = await createHistoryRuntime(storage, { now: () => now })
  const rows = () =>
    storage.read((s) =>
      s.query({ sql: "SELECT id FROM capi_debug ORDER BY id", args: [] }),
    )
  try {
    for (const status of ["complete", "error"])
      history.writer.enqueue({
        id: status,
        kind: "debug",
        generation: history.generations.debug,
        recordedAt: now,
        payload: {
          startedAtMs: now,
          updatedAt: now,
          status,
          request: { body: "synthetic raw" },
        },
      })
    await history.writer.flush()
    expect(await rows()).toHaveLength(2)
    now += 600_001
    await waitForTimer()
    expect(await rows()).toEqual([{ id: "error" }])
    now += 3000_000
    await waitForTimer()
    expect(await rows()).toEqual([])
    expect(history.writer.status().degraded).toBe(false)
  } finally {
    await history.close(1000)
    await storage.close()
  }
})
