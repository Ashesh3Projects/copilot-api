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

test("shutdown waits for admitted requests to finish before closing history", async () => {
  const drained = Promise.withResolvers<undefined>()
  const order: Array<string> = []
  const shutdown = createShutdown({
    stopAdmission: async () => {
      order.push("stop")
      await drained.promise
      order.push("last request recorded")
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
  const stopping = shutdown()
  await Promise.resolve()
  expect(order).toEqual(["stop"])
  drained.resolve(undefined)
  await stopping
  expect(order).toEqual([
    "stop",
    "last request recorded",
    "flush",
    "close",
    "monitor",
  ])
})

test("idle connections cannot consume the history finalization budget", async () => {
  const order: Array<string> = []
  let flushBudget = 0
  const shutdown = createShutdown({
    stopAdmission: () => {
      order.push("stop")
      return new Promise(() => {})
    },
    flush: async (budget) => {
      flushBudget = budget
      order.push("flush")
    },
    closeStorage: async () => {
      order.push("close")
    },
    closeMonitoring: async () => {
      order.push("monitor")
    },
    timeoutMs: 100,
  })
  await shutdown()
  expect(order).toEqual(["stop", "flush", "close", "monitor"])
  expect(flushBudget).toBeGreaterThan(20)
})

test("an idle WebSocket is force-closed before final history cleanup", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response(null, { status: 400 })
    },
    websocket: { message() {} },
  })
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/`)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener(
        "error",
        () => reject(new Error("Fixture websocket failed")),
        { once: true },
      )
    })
    const order: Array<string> = []
    const shutdown = createShutdown({
      stopAdmission: () => server.stop(false),
      forceCloseConnections: () => {
        order.push("force")
        socket.close()
        return server.stop(true)
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
      timeoutMs: 200,
    })
    await shutdown()
    expect(order).toEqual(["force", "flush", "close", "monitor"])
  } finally {
    socket.close()
    await server.stop(true)
  }
})
