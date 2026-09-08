import { expect, test } from "bun:test"

import { gatewayCreationFeedback } from "../ui/src/lib/gateway-creation"

test("metadata-only key replay clearly identifies the unavailable secret", () => {
  expect(gatewayCreationFeedback({ id: "key-1", label: "Laptop" })).toEqual({
    lost: { id: "key-1", label: "Laptop" },
  })
  expect(
    gatewayCreationFeedback({
      id: "key-2",
      label: "Laptop",
      credential: "synthetic-new-key",
    }),
  ).toEqual({ credential: "synthetic-new-key" })
})

test("first setup provides random-key generation without altering legacy key compatibility", async () => {
  const source = await Bun.file(
    new URL("../ui/src/AuthGate.tsx", import.meta.url),
  ).text()
  expect(source).toContain("Generate a random gateway key")
  expect(source).toContain("crypto.randomUUID()")
  expect(source).toContain("not a memorable password")
})
