/* eslint-disable @typescript-eslint/require-await -- Shutdown callback mocks retain asynchronous lifecycle signatures. */
import { expect, test } from "bun:test"

import { createShutdown } from "~/lib/shutdown"

test("shutdown stops admission before history flush and runs only once", async () => {
  const order: Array<string> = []
  const shutdown = createShutdown({
    stopAdmission: () => {
      order.push("stop")
    },
    flush: async () => {
      order.push("flush")
    },
    closeStorage: async () => {
      order.push("close")
    },
    closeMonitoring: async () => {
      order.push("monitor")
    },
  })
  await Promise.all([shutdown(), shutdown()])
  expect(order).toEqual(["stop", "flush", "close", "monitor"])
})
test("shutdown has a bounded wait even when storage does not settle", async () => {
  const shutdown = createShutdown({
    stopAdmission: () => {},
    flush: () => new Promise(() => {}),
    closeStorage: async () => {},
    closeMonitoring: async () => {},
    timeoutMs: 20,
  })
  const started = Date.now()
  await shutdown()
  expect(Date.now() - started).toBeLessThan(250)
})
