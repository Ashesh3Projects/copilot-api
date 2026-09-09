import * as Sentry from "@sentry/bun"

import { withStorageDeadline } from "~/lib/storage/operation-budget"
import { closeStorageRuntime } from "~/lib/storage/runtime"
import { peekHistoryRuntime } from "~/lib/telemetry-writer"

export interface ShutdownDependencies {
  stopAdmission(): void | Promise<void>
  forceCloseConnections?(): void | Promise<void>
  flush(deadlineMs: number): Promise<void>
  closeStorage(): Promise<void>
  closeMonitoring(): Promise<void>
  timeoutMs?: number
}
export function createShutdown(
  dependencies: ShutdownDependencies,
): () => Promise<void> {
  let stopping: Promise<void> | undefined
  return () => {
    stopping ??= (async () => {
      const timeout = dependencies.timeoutMs ?? 5_000
      const expires = Date.now() + timeout
      let timer: ReturnType<typeof setTimeout> | undefined
      const work = withStorageDeadline(expires, async () => {
        const drained = await settleBefore(
          Promise.resolve(dependencies.stopAdmission()),
          Date.now() + Math.min(1500, timeout * 0.4),
        )
        if (!drained && dependencies.forceCloseConnections) {
          await settleBefore(
            Promise.resolve(dependencies.forceCloseConnections()),
            Date.now() + Math.min(500, timeout * 0.1),
          )
        }
        try {
          await dependencies.flush(Math.max(0, expires - Date.now()))
        } catch {
          process.stderr.write(
            "History flush did not complete during shutdown.\n",
          )
        }
        await dependencies.closeStorage()
        await dependencies.closeMonitoring()
      }).catch(() => {
        process.stderr.write("Shutdown storage cleanup did not complete.\n")
      })
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeout)
        }),
      ])
      if (timer) clearTimeout(timer)
    })()
    return stopping
  }
}

/** Stop accepting immediately, but reserve time to commit history and close storage. */
async function settleBefore(
  work: Promise<void>,
  deadline: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          Math.max(0, deadline - Date.now()),
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function installShutdown(
  stopAdmission: () => void | Promise<void>,
  forceCloseConnections?: () => void | Promise<void>,
): void {
  const stop = createShutdown({
    stopAdmission,
    forceCloseConnections,
    flush: async (budget) => {
      await peekHistoryRuntime()?.close(budget)
    },
    closeStorage: closeStorageRuntime,
    closeMonitoring: async () => {
      await Sentry.close(500)
    },
  })
  let signaled = false
  const onSignal = () => {
    if (signaled) return
    signaled = true
    void stop().finally(() => process.exit(0))
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
}
