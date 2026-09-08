import { Hono, type Handler } from "hono"

import { peekStorageRuntime } from "~/lib/storage/runtime"
import { hasIncompleteTransfer } from "~/lib/storage/runtime-status"

export const healthRoutes = new Hono()

healthRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json({ error: "Not found" }, 404)
  }
  await next()
})

// Keep this response free of configuration, session, dependency, and version
// information while retaining the nested compatibility alias.
const healthHandler: Handler = (c) => c.json({ status: "ok" })

healthRoutes.get("/", healthHandler)
healthRoutes.get("/health", healthHandler)
healthRoutes.on("HEAD", ["/", "/health"], (c) => c.body(null, 200))
healthRoutes.on(["GET", "HEAD"], "/ready", async (c) => {
  let ready = false
  try {
    const runtime = peekStorageRuntime()
    if (runtime) {
      await runtime.snapshot.refreshIfChanged()
      ready = !(await hasIncompleteTransfer(runtime.storage))
    }
  } catch {
    ready = false
  }
  c.header("Cache-Control", "no-store")
  const status = ready ? 200 : 503
  return c.req.method === "HEAD" ?
      c.body(null, status)
    : c.json({ status: ready ? "ready" : "unavailable" }, status)
})
healthRoutes.all("*", (c) => c.json({ error: "Not found" }, 404))
