import { expect, test } from "bun:test"

import { mergeConfigWithDefaults } from "~/lib/config"
import { insertGatewayCredential } from "~/lib/storage/credentials-repository"
import { initializeStorageRuntime } from "~/lib/storage/runtime"
import { createHistoryRuntime } from "~/lib/telemetry-writer"

import { smokePublicProtocols } from "./helpers/public-protocol-smoke"
import { createRuntimeStorage } from "./helpers/runtime-storage"
test("real public protocols and WebSocket next-turn revocation use database state", async () => {
  const fixture = await createRuntimeStorage()
  let history: Awaited<ReturnType<typeof createHistoryRuntime>> | undefined
  try {
    await initializeStorageRuntime(fixture)
    await mergeConfigWithDefaults()
    history = await createHistoryRuntime(fixture.storage, { autoFlush: false })
    await fixture.storage.transaction((session) =>
      insertGatewayCredential(session, {
        id: "public-smoke",
        credential: "public-smoke-key",
        label: "fixture",
        createdAt: Date.now(),
      }),
    )
    const result = await smokePublicProtocols(
      fixture.storage,
      "public-smoke-key",
    )
    expect(result.requests).toBe(6)
    await history.writer.flush()
    expect(
      (await history.repository.readUsage(0)).lifetime.requestCount,
    ).toBeGreaterThan(0)
    expect(
      await fixture.storage.read((session) =>
        session.query({
          sql: "SELECT name FROM sqlite_master WHERE name = 'capi_activity'",
          args: [],
        }),
      ),
    ).toEqual([])
  } finally {
    await history?.close(5000)
    await fixture.close()
  }
}, 30000)
