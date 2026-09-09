import { expect, test } from "bun:test"

import {
  isStoredGatewayCredential,
  maskSecret,
  normalizeGatewayCredential,
} from "~/lib/credential-value"

test("credential masks retain five characters at each end without exposing short secrets", () => {
  expect(maskSecret("abcde-middle-fghij")).toBe("abcde...fghij")
  expect(maskSecret("short")).toBe("**********")
  expect(maskSecret("0123456789")).toBe("**********")
  expect(maskSecret("")).toBe("**********")
})

test("custom gateway keys normalize only surrounding whitespace", () => {
  expect(normalizeGatewayCredential("  custom-fixture_key  ")).toBe(
    "custom-fixture_key",
  )
  expect(isStoredGatewayCredential("custom-fixture_key")).toBe(true)
  expect(isStoredGatewayCredential(" custom-fixture_key ")).toBe(false)
})

test.each([
  "",
  "   ",
  "key value",
  "key\nvalue",
  "nonascii-\u00e9",
  "x".repeat(4097),
])(
  "invalid custom gateway values fail without echoing submitted data",
  (value) => {
    expect(() => normalizeGatewayCredential(value)).toThrow(
      "Gateway key must contain 1 to 4096 visible ASCII characters without whitespace",
    )
  },
)
