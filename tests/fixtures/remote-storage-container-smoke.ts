import { existsSync } from "node:fs"

import type { HistoryRecord } from "~/lib/telemetry-writer"

import { getAccountsService } from "~/lib/accounts-service"
import { initializeAdminAuth, issueAdminSetupCode } from "~/lib/admin-auth"
import { mergeConfigWithDefaults } from "~/lib/config"
import { createShutdown } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { createStorage } from "~/lib/storage/client"
import { resolveStorageConfig } from "~/lib/storage/config"
import { probeStorage } from "~/lib/storage/readiness"
import {
  closeStorageRuntime,
  initializeStorageRuntime,
  peekStorageRuntime,
} from "~/lib/storage/runtime"
import {
  createHistoryRuntime,
  peekHistoryRuntime,
} from "~/lib/telemetry-writer"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"

import { isolatedNamespace } from "../helpers/isolated-transfer-storage"
import { smokePublicProtocols } from "../helpers/public-protocol-smoke"

function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Smoke assertion failed: ${label}`)
}

// eslint-disable-next-line max-lines-per-function, complexity -- Standalone fixture keeps its startup, route assertions and cleanup in one owned lifecycle.
async function main() {
  check(
    process.env.CAP_STORAGE_REMOTE_SMOKE === "1",
    "explicit remote smoke gate",
  )
  const config = resolveStorageConfig()
  check(config.kind === "turso", "remote-only backend")
  const dataDir = process.env.DATA_DIR
  check(
    dataDir && !existsSync(dataDir),
    "absent local persistence directory before startup",
  )
  process.env.COPILOT_ADMIN_ORIGIN = "http://127.0.0.1"
  const backend = createStorage(config)
  const namespace = isolatedNamespace(backend)
  let http: ReturnType<typeof Bun.serve> | undefined
  let phase = "initialize"
  try {
    await namespace.initialize()
    const runtime = await initializeStorageRuntime({
      storage: namespace.storage,
      config,
    })
    await mergeConfigWithDefaults()
    await createHistoryRuntime(runtime.storage)
    await initializeAdminAuth()
    await getAccountsService().refreshRuntime()
    state.models = tokenPool.getAllModels()
    check(
      (await probeStorage(namespace.storage, { kind: "turso" })).ready,
      "mapped schema readiness",
    )
    http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: (request) => server.fetch(request),
    })
    const base = `http://127.0.0.1:${http.port}`
    const request = (path: string, init?: RequestInit) =>
      fetch(base + path, init)
    phase = "ready"
    const ready = await request("/health/ready")
    check(
      ready.status === 200
        && ((await ready.json()) as { status: string }).status === "ready",
      "ready route",
    )
    phase = "setup-status"
    const status = await request("/dashboard/auth/status")
    check(
      status.status === 200
        && !((await status.json()) as { configured: boolean }).configured,
      "unconfigured administrator",
    )
    phase = "setup"
    const { code } = await issueAdminSetupCode()
    const gatewayKey = "synthetic-container-smoke-gateway"
    const password = "synthetic-container-smoke-password"
    const json = (body: unknown): RequestInit => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1",
      },
      body: JSON.stringify(body),
    })
    const setup = await request(
      "/dashboard/auth/setup",
      json({ setupCode: code, gatewayKey, password }),
    )
    check(
      setup.status === 201
        && ((await setup.json()) as { authenticated: boolean }).authenticated,
      "public setup flow",
    )
    phase = "login"
    const login = await request(
      "/dashboard/auth/login",
      json({ gatewayKey, password }),
    )
    check(
      login.status === 200
        && ((await login.json()) as { authenticated: boolean }).authenticated,
      "public login flow",
    )
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
    check(
      cookie.includes("=") && login.headers.getSetCookie().length === 2,
      "session cookie issuance",
    )
    const session = await request("/dashboard/auth/session", {
      headers: { cookie },
    })
    check(
      session.status === 200
        && ((await session.json()) as { authenticated: boolean }).authenticated,
      "persisted administrator session",
    )
    phase = "protected-models"
    const rejected = await request("/v1/models", {
      headers: { authorization: "Bearer deliberately-invalid-smoke-key" },
    })
    check(rejected.status === 401, "invalid inference credential rejected")
    await rejected.arrayBuffer()
    const models = await request("/v1/models", {
      headers: { authorization: `Bearer ${gatewayKey}` },
    })
    check(
      models.status === 200
        && Array.isArray(((await models.json()) as { data: unknown }).data),
      "protected model catalog",
    )
    const dashboard = await request("/dashboard/api/accounts", {
      headers: { cookie },
    })
    check(dashboard.status === 200, "protected administrator account listing")
    await dashboard.arrayBuffer()
    phase = "diagnostic-batches"
    const history = peekHistoryRuntime()
    check(history, "history initialized")
    await history.writer.flush()
    const now = Date.now()
    const diagnostics: Array<HistoryRecord> = Array.from(
      { length: 100 },
      (_, index): Array<HistoryRecord> => [
        {
          id: `smoke-debug-${index}`,
          kind: "debug" as const,
          generation: history.generations.debug,
          recordedAt: now,
          payload: {
            status: "complete",
            replayable: false,
            startedAtMs: now,
            updatedAt: now,
            message: "synthetic smoke debug",
          },
        },
      ],
    ).flat()
    await history.repository.applyBatch("smoke-diagnostic-batch", diagnostics)
    await history.repository.applyBatch("smoke-diagnostic-batch", diagnostics)
    for (const table of ["capi_debug"]) {
      const rows = await namespace.storage.read((sql) =>
        sql.query({
          sql: `SELECT count(*) AS count FROM ${table} WHERE id LIKE 'smoke-%'`,
          args: [],
        }),
      )
      check(
        rows[0]?.count === 100,
        "batched diagnostic count and receipt replay",
      )
    }
    await history.clear("debug")
    await history.repository.applyBatch(
      "smoke-delayed-debug",
      diagnostics.filter((record) => record.kind === "debug"),
    )
    const cleared = await namespace.storage.read((sql) =>
      sql.query({ sql: "SELECT count(*) AS count FROM capi_debug", args: [] }),
    )
    check(
      cleared[0]?.count === 0,
      "cleared generation rejects stale debug batch",
    )
    phase = "counter-batches"
    const counterBatch: Array<HistoryRecord> = Array.from(
      { length: 100 },
      (_, index): HistoryRecord =>
        index % 2 ?
          {
            id: `smoke-usage-${index}`,
            kind: "usage" as const,
            generation: 0,
            recordedAt: now - index * 60_000,
            payload: {
              timestamp: now - index * 60_000,
              model: `smoke-model-${index}`,
              inputTokens: 7,
              outputTokens: 11,
              requestCount: 1,
              firstRequestAt: now - index * 60_000,
            },
          }
        : {
            id: `smoke-routing-${index}`,
            kind: "routing" as const,
            generation: 0,
            recordedAt: now - index * 60_000,
            payload: {
              timestamp: now - index * 60_000,
              totals: { requests: 1, upstreamCalls: 2 },
            },
          },
    )
    await history.repository.applyBatch("smoke-counter-batch", counterBatch)
    await history.repository.applyBatch("smoke-counter-batch", counterBatch)
    const usage = await history.repository.readUsage(0)
    check(
      usage.lifetime.inputTokens === 350
        && usage.lifetime.outputTokens === 550
        && usage.lifetime.requestCount === 50,
      "mixed usage batch counters",
    )
    check(
      usage.buckets.filter((bucket) => bucket.model?.startsWith("smoke-model-"))
        .length === 50,
      "unique usage model buckets",
    )
    phase = "public-protocols"
    await smokePublicProtocols(namespace.storage, gatewayKey)
    phase = "shutdown"
    const stop = createShutdown({
      stopAdmission: () => {
        void http?.stop(false)
      },
      flush: async (budget) => {
        const result = await peekHistoryRuntime()?.close(budget)
        check(
          result && !result.pendingRecords && !result.degraded,
          "clean history flush",
        )
      },
      closeStorage: closeStorageRuntime,
      closeMonitoring: () => Promise.resolve(),
    })
    await stop()
    await http.stop(true)
    // eslint-disable-next-line require-atomic-updates -- The fixture owns this server and closes it sequentially.
    http = undefined
    check(!peekStorageRuntime(), "runtime closed")
    check(
      !existsSync(dataDir),
      "no local persistence directory after functional remote run",
    )
    const runs = await namespace.storage.read((sql) =>
      sql.query({ sql: "SELECT clean FROM capi_process_runs", args: [] }),
    )
    check(runs.length === 1 && runs[0]?.clean === 1, "clean shutdown marker")
    phase = "cleanup"
    await namespace.cleanup()
    check(!existsSync(dataDir), "no local fallback after cleanup")
    process.stdout.write(
      JSON.stringify({
        status: "passed",
        backend: "turso",
        checks: [
          "ready",
          "setup",
          "login",
          "session",
          "protected-models",
          "invalid-credential",
          "admin-accounts",
          "batched-history",
          "mixed-counter-batches",
          "public-chat-messages-responses",
          "responses-websocket-continuation",
          "websocket-revocation-next-turn",
          "history-receipt-replay",
          "history-clear-generation",
          "clean-shutdown",
          "exact-prefix-cleanup",
          "no-local-persistence",
        ],
      }) + "\n",
    )
  } catch {
    // Never print backend error payloads or any of the request-local secrets.
    process.stderr.write(JSON.stringify({ status: "failed", phase }) + "\n")
    process.exitCode = 1
  } finally {
    try {
      await http?.stop(true)
      await peekHistoryRuntime()?.close(5000)
      await closeStorageRuntime()
      await namespace.cleanup()
    } catch {
      process.stderr.write(
        JSON.stringify({ status: "failed", phase: "cleanup" }) + "\n",
      )
      process.exitCode = 1
    } finally {
      await backend.close()
    }
  }
}

await main().catch(() => {
  process.stderr.write('{"status":"failed","phase":"configuration"}\n')
  process.exitCode = 1
})
