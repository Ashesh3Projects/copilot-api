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
  expect(source).toContain("secrets.revision !== revision")
  expect(source).toContain("SecretInput")
  expect(source).not.toContain("Leave blank to keep the stored key")
})

test("loaded provider secrets are omitted unless edited and header changes replace the whole map", () => {
  const original = {
    apiKey: "stored-key",
    headers: { "X-First": "one", "X-Second": "two" },
  }
  const form = {
    apiKey: original.apiKey,
    clearApiKey: false,
    clearHeaders: false,
    headers: Object.entries(original.headers).map(([key, value]) => ({
      key,
      value,
    })),
  }
  expect(providerSecretPatch(form, original)).toEqual({})
  expect(
    providerSecretPatch({ ...form, apiKey: " rotated " }, original),
  ).toEqual({ apiKey: "rotated" })
  expect(providerSecretPatch({ ...form, apiKey: "" }, original)).toEqual({
    clearApiKey: true,
  })
  expect(
    providerSecretPatch({ ...form, headers: [form.headers[0]] }, original),
  ).toEqual({ replaceHeaders: true, headers: { "X-First": "one" } })
  expect(providerSecretPatch({ ...form, headers: [] }, original)).toEqual({
    replaceHeaders: true,
    headers: {},
  })
})
