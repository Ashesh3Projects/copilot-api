import { Hono } from "hono"

import { getHistoryRuntime } from "~/lib/telemetry-writer"

function integer(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Invalid activity filter")
  return Number(value)
}

/** Mounted behind dashboard administrator authentication and CSRF middleware. */
export const dashboardActivityRoutes = new Hono()

dashboardActivityRoutes.get("/activity", async (c) => {
  let options
  try {
    options = {
      limit: integer(c.req.query("limit")),
      since: integer(c.req.query("since")),
      until: integer(c.req.query("until")),
      cursor: c.req.query("cursor"),
      type: c.req.query("type"),
    }
    if (options.type && !/^[a-z_-]{1,40}$/.test(options.type))
      throw new Error("Invalid activity filter")
  } catch {
    return c.json({ error: "Invalid activity filters" }, 400)
  }
  try {
    const runtime = getHistoryRuntime()
    const page = await runtime.writer.read((pending) =>
      runtime.repository.list("activity", options, pending),
    )
    return c.json({
      ...page,
      collection: {
        ...runtime.writer.status(),
        ...(await runtime.repository.collectionStatus()),
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid history cursor")
      return c.json({ error: "Invalid activity cursor" }, 400)
    return c.json({ error: "Activity history is temporarily unavailable" }, 503)
  }
})

dashboardActivityRoutes.delete("/activity", async (c) => {
  try {
    const runtime = getHistoryRuntime()
    const generation = await runtime.clear("activity")
    return c.json({ success: true, generation })
  } catch {
    return c.json({ error: "Activity history is temporarily unavailable" }, 503)
  }
})
