import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"

import { storageAdmission } from "~/lib/storage/admission"
import { getRequestSnapshot } from "~/lib/storage/request-snapshot"
import {
  closeStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"

import { createRuntimeStorage } from "./helpers/runtime-storage"

afterEach(async () => {
  await closeStorageRuntime()
})

test("HTTP admission captures initialized storage revision and reports outage as 503", async () => {
  const fixture = await createRuntimeStorage()
  try {
    const runtime = await initializeStorageRuntime({
      storage: fixture.storage,
      config: fixture.config,
    })
    const app = new Hono()
    app.use("*", storageAdmission)
    app.get("/", (c) => c.json({ revision: getRequestSnapshot()?.revision }))
    expect(await (await app.request("/")).json()).toEqual({
      revision: runtime.snapshot.get().revision,
    })
    await runtime.storage.close()
    expect((await app.request("/")).status).toBe(503)
  } finally {
    await fixture.close()
  }
})
