import { AsyncLocalStorage } from "node:async_hooks"

import type { RuntimeSnapshot, SnapshotManager } from "~/lib/storage/types"

const requestSnapshots = new AsyncLocalStorage<RuntimeSnapshot>()

/** Admission passes one immutable manager snapshot for the whole HTTP request or WS turn. */
export function withRequestSnapshot<T>(
  snapshot: RuntimeSnapshot,
  work: () => T,
): T {
  return requestSnapshots.run(snapshot, work)
}

export function getRequestSnapshot(): RuntimeSnapshot | undefined {
  return requestSnapshots.getStore()
}

/** Domain reads use the captured request; live publication guards use manager.get(). */
export function getCurrentSnapshot(manager: SnapshotManager): RuntimeSnapshot {
  return getRequestSnapshot() ?? manager.get()
}
