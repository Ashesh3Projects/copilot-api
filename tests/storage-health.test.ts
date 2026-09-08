import { expect, test } from "bun:test"

import { healthRoutes } from "~/routes/health/route"
test("readiness is unavailable before storage starts while liveness stays minimal", async () => {
  const ready = await healthRoutes.request("/ready")
  expect(ready.status).toBe(503)
  expect(await ready.json()).toEqual({ status: "unavailable" })
  const live = await healthRoutes.request("/health")
  expect(live.status).toBe(200)
  expect(await live.json()).toEqual({ status: "ok" })
})
