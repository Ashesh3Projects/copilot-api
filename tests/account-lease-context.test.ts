import { afterEach, expect, test } from "bun:test"

import { leaseAccount, withAccountLeases } from "~/lib/account-lease-context"
import { tokenPool } from "~/lib/token-pool"

afterEach(() => {
  tokenPool.removeAccountForTest(12001)
})

test("removal waits for selected response body completion", async () => {
  const account = tokenPool.addAccount("fixture-token", "individual", 12001)
  account.healthy = true
  account.credentialRevision = 1
  const source = new TransformStream<Uint8Array, Uint8Array>()
  const result = await withAccountLeases(undefined, async () => {
    await Promise.resolve()
    expect(leaseAccount(account).githubToken).toBe("fixture-token")
    return { response: new Response(source.readable) }
  })
  tokenPool.deleteAccount(account.id)
  let drained = false
  const drain = tokenPool.waitForDrain(account.id).then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  const reading = result.response.text()
  const writer = source.writable.getWriter()
  await writer.write(new TextEncoder().encode("ok"))
  await writer.close()
  expect(await reading).toBe("ok")
  await drain
  expect(drained).toBe(true)
})

test("an already aborted call cannot create an unreleased account lease", async () => {
  const account = tokenPool.addAccount("fixture-token", "individual", 12001)
  account.healthy = true
  const abort = new AbortController()
  abort.abort()
  let invoked = false
  try {
    await withAccountLeases(abort.signal, async () => {
      await Promise.resolve()
      invoked = true
      leaseAccount(account)
      return { response: new Response("never") }
    })
  } catch {
    // Expected abort: the callback must not acquire a lease.
  }
  expect(invoked).toBe(false)
})

test("abort during asynchronous admission cannot leak a late acquired lease", async () => {
  const account = tokenPool.addAccount("fixture-token", "individual", 12001)
  account.healthy = true
  const abort = new AbortController()
  let continueAdmission!: () => void
  const admission = new Promise<void>((resolve) => {
    continueAdmission = resolve
  })
  const result = withAccountLeases(abort.signal, async () => {
    await admission
    leaseAccount(account)
    return { response: new Response("late") }
  }).catch(() => undefined)
  abort.abort()
  continueAdmission()
  await result
  tokenPool.deleteAccount(account.id)
  let drained = false
  void tokenPool.waitForDrain(account.id).then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(true)
})
