import { expect, test } from "bun:test"

import { createStorage } from "~/lib/storage/client"
import { probeStorage } from "~/lib/storage/readiness"

import { createFakeTursoFetch, testConfig } from "./helpers/turso-transport"

test("readiness separates engine compatibility from missing schema", async () => {
  const remote = createFakeTursoFetch()
  const storage = createStorage(testConfig())
  try {
    expect(await probeStorage(storage, { requireSchema: false })).toMatchObject(
      { ready: true, engine: "turso", engineVersion: "test-turso" },
    )
    expect(await probeStorage(storage)).toMatchObject({
      ready: false,
      reason: "schema_missing",
    })
  } finally {
    await storage.close()
    remote.close()
  }
})

test.each([
  [401, "authentication"],
  [429, "quota"],
  [503, "unavailable"],
] as const)("readiness sanitizes %s failures", async (status, reason) => {
  const remote = createFakeTursoFetch({ status })
  const storage = createStorage(testConfig())
  try {
    expect(await probeStorage(storage)).toEqual({
      ready: false,
      engine: "turso",
      reason,
    })
  } finally {
    await storage.close()
    remote.close()
  }
})
