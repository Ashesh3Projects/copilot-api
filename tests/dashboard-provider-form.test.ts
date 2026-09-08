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

test("provider editing keeps the originally loaded revision through background list refreshes", async () => {
  const source = await Bun.file(
    new URL("../ui/src/screens/CustomProviders.tsx", import.meta.url),
  ).text()
  expect(source).toContain("setFormRevision(page?.revision)")
  expect(source).toMatch(
    /api\("POST", "\/dashboard\/api\/custom-providers", payload, \{\s*expectedRevision: formRevision/,
  )
  expect(source).toContain(
    "if (caught instanceof ApiError && caught.status === 409) closeForm()",
  )
})
