import * as Sentry from "@sentry/bun"

import { withStorageDeadline } from "~/lib/storage/operation-budget"
import { closeStorageRuntime } from "~/lib/storage/runtime"
import { peekHistoryRuntime } from "~/lib/telemetry-writer"

export interface ShutdownDependencies {
  stopAdmission(): void
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
      dependencies.stopAdmission()
      const timeout = dependencies.timeoutMs ?? 5_000
      let timer: ReturnType<typeof setTimeout> | undefined
      const work = withStorageDeadline(Date.now() + timeout, async () => {
        try {
          await dependencies.flush(timeout)
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
export function installShutdown(stopAdmission: () => void): void {
  const stop = createShutdown({
    stopAdmission,
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
