// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- UI has a separate JSX TS project.
// @ts-nocheck -- Runtime coverage imports the separately configured UI project.
import { expect, mock, test } from "bun:test"

// UI dependencies and their declarations live outside the root TS project.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { renderToStaticMarkup } from "../ui/node_modules/react-dom/server.bun.js"
import { createElement } from "../ui/node_modules/react/index.js"

const settingsBundle = {
  credentials: [],
  groq: false,
  settings: {
    version: "2.0.10",
    port: "4141",
    host: "127.0.0.1",
    authEnabled: true,
    multiToken: false,
    sentryEnabled: false,
    groqEnabled: false,
    dataDir: "F:/copilot-api-data",
    debug: false,
    verbose: false,
    passwordManagedExternally: true,
    codexCleanupModel: null,
    codexCleanupModelDefault: undefined,
    availableModels: [],
  },
  allowlist: [
    {
      ip: "192.0.2.10",
      enabled: true,
      source: "dashboard",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
  ],
  currentIp: "198.51.100.24",
  trustedJwtDigests: [
    {
      id: "6f9619ff-8b86-4be5-9c13-11c0c978a11",
      label: "Gaming PC",
      digest: "a".repeat(64),
      enabled: true,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
  ],
}

await mock.module("../ui/src/lib/usePolling", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix
  useAsyncData: () => ({
    data: settingsBundle,
    error: undefined,
    loading: false,
    reload: () => {},
    reloadSilently: () => {},
  }),
}))

await mock.module("../ui/src/lib/toast", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix
  useToast: () => ({
    success: () => {},
    error: () => {},
  }),
}))

const { default: SettingsScreen } = await import("../ui/src/screens/Settings")

function renderSettings(): string {
  return renderToStaticMarkup(createElement(SettingsScreen))
}

function findClosingDiv(markup: string, openingIndex: number): number {
  let depth = 0

  for (const match of markup.slice(openingIndex).matchAll(/<\/?div\b[^>]*>/g)) {
    depth += match[0].startsWith("</") ? -1 : 1
    if (depth === 0) return openingIndex + match.index + match[0].length
  }

  throw new Error("Responsive pair closing tag not found")
}

test("settings cards render server and IP first with trusted JWT full width", () => {
  const markup = renderSettings()
  const serverIndex = markup.indexOf("Server Configuration")
  const ipIndex = markup.indexOf("IP Allowlist")
  const jwtIndex = markup.indexOf("Trusted JWT Digests")
  const responsivePairCount = (markup.match(/class="responsive-pair"/g) ?? [])
    .length
  const responsivePairStart = markup.indexOf('<div class="responsive-pair"')
  const pairMinWidth = /--responsive-pair-min:(\d+)px/.exec(markup)
  const responsivePairEnd = findClosingDiv(markup, responsivePairStart)
  const jwtCardStart = markup.lastIndexOf('<div class="astryx-card', jwtIndex)

  expect(serverIndex).toBeGreaterThan(-1)
  expect(ipIndex).toBeGreaterThan(serverIndex)
  expect(jwtIndex).toBeGreaterThan(ipIndex)
  expect(responsivePairCount).toBe(1)
  expect(Number(pairMinWidth?.[1])).toBeLessThanOrEqual(470)
  expect(markup.slice(responsivePairStart, jwtCardStart)).toContain(
    "IP Allowlist",
  )
  expect(responsivePairEnd).toBeLessThanOrEqual(jwtCardStart)
})

test("settings keeps export in server configuration without admin security copy", () => {
  const markup = renderSettings()
  const serverEnd = markup.indexOf("IP Allowlist")
  const serverMarkup = markup.slice(
    markup.indexOf("Server Configuration"),
    serverEnd,
  )

  expect(serverMarkup).toContain("Export sanitized config")
  expect(markup).not.toContain("Administrator Security")
  expect(markup).not.toContain("Password managed by the environment")
  expect(markup).not.toContain("COPILOT_ADMIN_PASSWORD_HASH")
})

test("individual IP removal has no confirmation dialog", () => {
  const markup = renderSettings()

  expect(markup).toContain('aria-label="Remove 192.0.2.10"')
  expect(markup).toContain("Clear IP allowlist")
  expect(markup).toContain("Delete trusted JWT digest")
  expect(markup.match(/role="alertdialog"/g)).toHaveLength(2)
})
