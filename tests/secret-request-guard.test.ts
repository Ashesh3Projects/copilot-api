import { expect, test } from "bun:test"

import { createSecretRequestGuard } from "../ui/src/lib/secret-request-guard"

test("hiding, closing, or unmounting invalidates an in-flight secret response", async () => {
  const guard = createSecretRequestGuard()
  const request = Promise.withResolvers<string>()
  const isCurrent = guard.begin()
  const pending = request.promise.then((value) =>
    isCurrent() ? value : undefined,
  )
  guard.invalidate()
  request.resolve("fixture-late-secret")
  expect(await pending).toBeUndefined()
})

test("only the latest reveal can publish a result and guards never store values", () => {
  const guard = createSecretRequestGuard()
  const previous = guard.begin()
  const current = guard.begin()
  expect(previous()).toBe(false)
  expect(current()).toBe(true)
  guard.invalidate()
  expect(current()).toBe(false)
})
