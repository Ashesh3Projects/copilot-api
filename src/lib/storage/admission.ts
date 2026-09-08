import type { MiddlewareHandler } from "hono"

import { getAccountsService } from "~/lib/accounts-service"
import { forwardError } from "~/lib/error"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { peekStorageRuntime } from "~/lib/storage/runtime"

/** Storage-backed production requests use one committed snapshot per admission. */
export const storageAdmission: MiddlewareHandler = async (context, next) => {
  const runtime = peekStorageRuntime()
  // The exported Hono app is also used with explicit injected domain test stores.
  // runServer always initializes storage before opening its listener.
  if (
    !runtime
    || ["/health", "/health/health", "/health/ready"].includes(context.req.path)
  ) {
    await next()
    return
  }
  try {
    await runtime.snapshot.refreshIfChanged()
    await getAccountsService().refreshRuntime()
    await withRequestSnapshot(runtime.snapshot.get(), next)
  } catch (error) {
    return await forwardError(context, error)
  }
}
