import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  getRoutingTelemetrySnapshot,
  recordRoutingRequest,
  recordRoutingSelection,
  recordUpstreamCall,
  enableDatabaseRoutingTelemetryForTest,
} from "~/lib/routing-telemetry"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import { createHistoryRuntime } from "~/lib/telemetry-writer"
import {
  getUsageResponse,
  recordUsage,
  enableDatabaseUsageForTest,
} from "~/lib/usage-tracker"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function fixture() {
  enableDatabaseUsageForTest()
  const directory = await mkdtemp(join(tmpdir(), "capi-usage-"))
  const storage = new LocalSqliteStorage(join(directory, "fixture.sqlite"))
  await migrateStorage(storage)
  let runtime = await createHistoryRuntime(storage, { autoFlush: false })
  cleanup.push(async () => {
    await runtime.close(500)
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    storage,
    runtime,
    async restart() {
      await runtime.close(500)
      // eslint-disable-next-line require-atomic-updates -- Fixture restart is only called sequentially.
      runtime = await createHistoryRuntime(storage, { autoFlush: false })
      return runtime
    },
  }
}

test("usage reads include pending exactly once then survive a fresh runtime", async () => {
  const f = await fixture()
  recordUsage(7, 11, "a")
  recordUsage(13, 17, "b")
  expect((await getUsageResponse()).lifetime).toMatchObject({
    total_requests: 2,
    total_input_tokens: 20,
    total_output_tokens: 28,
  })
  await f.runtime.writer.flush()
  expect((await getUsageResponse()).lifetime).toMatchObject({
    total_requests: 2,
  })
  await f.restart()
  expect((await getUsageResponse()).lifetime).toMatchObject({
    total_requests: 2,
  })
  expect((await f.runtime.repository.readUsage(0)).buckets).toHaveLength(2)
})

test("routing persists dimensions, fractions, outcomes and lifetime across restart", async () => {
  const f = await fixture()
  enableDatabaseRoutingTelemetryForTest()
  const timestamp = Date.now()
  recordRoutingRequest({
    model: "a",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    status: 200,
    timestamp,
  })
  recordUpstreamCall({
    accountId: 0,
    model: "a",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    reason: "failover",
    outcome: "success",
    timestamp,
  })
  recordRoutingSelection({
    accountId: 0,
    eligibleAccountIds: [0, 1],
    mode: "sticky",
    affinitySource: "codex_thread",
    model: "a",
    timestamp,
  })
  const options = {
    accounts: [
      { id: 0, accountType: "individual", healthy: true },
      { id: 1, accountType: "individual", healthy: true },
    ],
    multiToken: true,
    now: timestamp,
    window: "1h" as const,
  }
  const before = await getRoutingTelemetrySnapshot(options)
  expect(before.totals).toEqual({
    requests: 1,
    upstreamCalls: 1,
    failovers: 1,
    retries: 0,
  })
  expect(before.accounts[0]).toMatchObject({
    expectedSelections: 0.5,
    selected: 1,
    upstreamCalls: 1,
  })
  await f.restart()
  const after = await getRoutingTelemetrySnapshot(options)
  expect(after.totals).toEqual(before.totals)
  expect(after.models).toEqual(before.models)
  expect(after.accounts).toEqual(before.accounts)
  expect(after.affinitySources.codex_thread).toBe(1)
  await f.runtime.repository.prune(timestamp + 2 * 86400_000)
  const old = await getRoutingTelemetrySnapshot({
    ...options,
    now: timestamp + 2 * 86400_000,
  })
  expect(old.totals.requests).toBe(0)
  expect(old.lifetime.requests).toBe(1)
})
