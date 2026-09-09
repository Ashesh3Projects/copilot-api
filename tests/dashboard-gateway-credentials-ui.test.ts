import { expect, test } from "bun:test"

import { generateGatewayKey } from "../ui/src/lib/gateway-creation"

test("optional gateway generation produces editable independent 256-bit keys", () => {
  const first = generateGatewayKey()
  expect(first).toMatch(/^cop-[\da-f]{64}$/)
  expect(generateGatewayKey()).not.toBe(first)
})

test("gateway dashboard uses custom values, explicit reveal, and last-key-protected deletion", async () => {
  const source = await Bun.file(
    new URL("../ui/src/components/StoredCredentials.tsx", import.meta.url),
  ).text()
  expect(source).toContain("credential")
  expect(source).toContain("generateGatewayKey")
  expect(source).toContain('label="Generate"')
  expect(source).toContain('label="Add key"')
  expect(source).toContain("/reveal")
  expect(source).toContain("SecretValue")
  expect(source).toContain("expectedRevision")
  expect(source).not.toContain("displayed once")
  expect(source).not.toContain("lostKey")
  expect(source).not.toContain("cannot be recovered")
})

test("first setup shares optional key generation and describes persistent administrator reveal", async () => {
  const source = await Bun.file(
    new URL("../ui/src/AuthGate.tsx", import.meta.url),
  ).text()
  expect(source).toContain("Generate a random gateway key")
  expect(source).toContain("generateGatewayKey()")
  expect(source).toContain("not a memorable password")
  expect(source).toContain("reveal")
})

test("Groq uses current-value reveal controls and gateway deletion is a compact inline icon", async () => {
  const source = await Bun.file(
    new URL("../ui/src/components/StoredCredentials.tsx", import.meta.url),
  ).text()
  expect(source).toContain("groq/reveal")
  expect(source).toContain("maskedValue")
  expect(source).toContain("Trash2Icon")
  expect(source).toContain("isIconOnly")
  expect(source).toContain("actions={")
  expect(source).not.toContain('label="Delete"')
  expect(source).not.toContain(
    "A Groq key is stored. Leave blank to retain it.",
  )
})
