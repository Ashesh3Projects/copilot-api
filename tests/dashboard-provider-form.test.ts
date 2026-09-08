import { expect, test } from "bun:test"

import { providerSecretPatch } from "../ui/src/lib/provider-form"

test("blank secrets retain stored values, explicit clearing never sends replacements", () => {
  expect(
    providerSecretPatch({
      apiKey: " ",
      clearApiKey: false,
      clearHeaders: false,
      headers: [{ key: "X-Secret", value: "" }],
    }),
  ).toEqual({ headers: { "X-Secret": "" } })
  expect(
    providerSecretPatch({
      apiKey: "stale",
      clearApiKey: true,
      clearHeaders: true,
      headers: [{ key: "X-Secret", value: "stale" }],
    }),
  ).toEqual({ clearApiKey: true, clearHeaders: true })
  expect(
    providerSecretPatch({
      apiKey: " new ",
      clearApiKey: false,
      clearHeaders: false,
      headers: [],
    }),
  ).toEqual({ apiKey: "new" })
})
