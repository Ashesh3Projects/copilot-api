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
