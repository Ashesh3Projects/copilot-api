import { AsyncLocalStorage } from "node:async_hooks"

import type { Account } from "~/lib/token-pool"

import { LocalHTTPError } from "~/lib/error"
import { tokenPool } from "~/lib/token-pool"

const activeAccount = new AsyncLocalStorage<Account>()
type Lease = NonNullable<ReturnType<typeof tokenPool.acquireLease>>
interface LeaseScope {
  leases: Map<number, Lease>
  released: boolean
  signal?: AbortSignal | null
}
const calls = new AsyncLocalStorage<LeaseScope>()

export function getActiveAccount(): Account | undefined {
  return activeAccount.getStore()
}
export function withActiveAccount<T>(account: Account, work: () => T): T {
  return activeAccount.run(account, work)
}

export function leaseAccount(account: Account): Account {
  const scope = calls.getStore()
  if (!scope) return account
  scope.signal?.throwIfAborted()
  if (scope.released) throw unavailableAccount()
  let lease = scope.leases.get(account.id)
  if (!lease) {
    lease = tokenPool.acquireLease(account)
    if (!lease) throw unavailableAccount()
    scope.leases.set(account.id, lease)
  }
  return lease.account
}

export function unavailableAccount(): LocalHTTPError {
  const body = {
    error: {
      code: "account_unavailable",
      type: "account_unavailable",
      message: "No healthy configured account is available for this request.",
    },
  }
  return new LocalHTTPError(
    body.error.message,
    Response.json(body, { status: 503 }),
    body,
  )
}

/** Keep selected credential snapshots alive through the returned upstream body. */
export async function withAccountLeases<T extends { response: Response }>(
  signal: AbortSignal | null | undefined,
  work: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted()
  if (calls.getStore()) return work()
  const leases = new Map<number, Lease>()
  const scope: LeaseScope = { leases, released: false, signal }
  const release = () => {
    if (scope.released) return
    scope.released = true
    for (const lease of leases.values()) lease.release()
    signal?.removeEventListener("abort", release)
  }
  signal?.addEventListener("abort", release, { once: true })
  try {
    const result = await calls.run(scope, work)
    const source = result.response
    if (!source.body || signal?.aborted) {
      release()
      return result
    }
    const reader =
      source.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            release()
            controller.close()
          } else controller.enqueue(chunk.value)
        } catch (error) {
          release()
          controller.error(error)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          release()
        }
      },
    })
    return {
      ...result,
      response: new Response(body, {
        status: source.status,
        statusText: source.statusText,
        headers: source.headers,
      }),
    }
  } catch (error) {
    release()
    throw error
  }
}
