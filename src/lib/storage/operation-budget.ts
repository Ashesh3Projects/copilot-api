import { AsyncLocalStorage } from "node:async_hooks"

import { StorageUnavailableError } from "~/lib/storage/errors"

const budget = new AsyncLocalStorage<number>()

export function getStorageDeadline(): number | undefined {
  return budget.getStore()
}

export function remainingStorageMs(): number {
  return Math.max(0, (getStorageDeadline() ?? Infinity) - Date.now())
}

export function withStorageDeadline<T>(
  deadlineAt: number,
  work: () => Promise<T>,
): Promise<T> {
  const deadline = Math.min(deadlineAt, getStorageDeadline() ?? Infinity)
  if (deadline <= Date.now())
    return Promise.reject(new StorageUnavailableError("timeout"))
  return budget.run(deadline, work)
}

// Only race work whose owner revokes its session before rolling back. Queue
// callers also recheck the absolute deadline after acquiring their turn.
export function deadlinePromise<T>(
  work: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new StorageUnavailableError("timeout")),
      Math.max(1, deadlineAt - Date.now()),
    )
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
