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

test("settings groups credentials, access controls and administration after a compact server summary", () => {
  const markup = renderSettings()
  const serverIndex = markup.indexOf("Server Configuration")
  const credentialsIndex = markup.indexOf(
    'aria-labelledby="settings-credentials-heading"',
  )
  const accessIndex = markup.indexOf(
    'aria-labelledby="settings-access-heading"',
  )
  const administrationIndex = markup.indexOf(
    'aria-labelledby="settings-administration-heading"',
  )

  expect(serverIndex).toBeGreaterThan(-1)
  expect(credentialsIndex).toBeGreaterThan(serverIndex)
  expect(accessIndex).toBeGreaterThan(credentialsIndex)
  expect(administrationIndex).toBeGreaterThan(accessIndex)
  const credentials = markup.slice(credentialsIndex, accessIndex)
  expect(credentials).toContain("Gateway credentials")
  expect(credentials).toContain("Speech transcription")
  expect(credentials).toContain("Codex Dictation Cleanup")
  const access = markup.slice(accessIndex, administrationIndex)
  expect(access).toContain("IP Allowlist")
  expect(access).toContain("Trusted JWT Digests")
  expect(access).toContain(
    'role="region" aria-labelledby="settings-ip-list-label" tabindex="0"',
  )
  expect(access).toContain(
    'role="region" aria-labelledby="settings-jwt-list-label" tabindex="0"',
  )
  expect(access).toContain("1 IP address · 1 enabled")
  expect(access).toContain("1 trusted digest · 1 enabled")
  expect(access).toContain('aria-label="IP allowlist"')
  expect(access).toContain('aria-label="Trusted JWT digests"')
  const administration = markup.slice(administrationIndex)
  expect(administration).toContain("Administrator password")
  expect(administration).toContain("Encrypted database backup")
  expect(markup).not.toContain('role="tablist"')
})

test("settings keeps sanitized export beside backup without admin security copy", () => {
  const markup = renderSettings()
  const backupMarkup = markup.slice(markup.indexOf("Encrypted database backup"))

  expect(backupMarkup).toContain("Export sanitized config")
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
