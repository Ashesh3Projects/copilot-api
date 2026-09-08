import { expect, spyOn, test } from "bun:test"

import { createSession } from "~/routes/code-sessions/session-store"

test("code session identifiers keep their shape without depending on Math.random", () => {
  const weak = spyOn(Math, "random").mockReturnValue(0)
  try {
    const first = createSession("fixture first", [])
    const second = createSession("fixture second", [])
    expect(first.id).toMatch(/^cse_[a-z0-9]{24}$/)
    expect(second.id).toMatch(/^cse_[a-z0-9]{24}$/)
    expect(first.id).not.toBe(second.id)
    expect(weak).not.toHaveBeenCalled()
  } finally {
    weak.mockRestore()
  }
})
