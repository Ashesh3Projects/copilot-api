import { defineCommand } from "citty"
import consola from "consola"

import {
  loadAccounts,
  addAccount as storeAddAccount,
  removeAccount as storeRemoveAccount,
} from "~/lib/accounts-store"
import {
  addReplacement,
  applyReplacements,
  clearUserReplacements,
  getAllReplacements,
  getUserReplacements,
  removeReplacement,
  toggleReplacement,
  updateReplacement,
  type ReplacementRule,
} from "~/lib/auto-replace"
import { mergeConfigWithDefaults } from "~/lib/config"
import {
  createNebiusQwen3EmbeddingProvider,
  listCustomProvidersForDashboard,
  removeCustomProvider,
  upsertCustomProvider,
} from "~/lib/custom-providers"
import {
  DEFAULT_GITHUB_DOMAIN,
  normalizeGitHubDomain,
} from "~/lib/github-instance"
import {
  initializeStorageRuntime,
  closeStorageRuntime,
  getStorageRuntime,
} from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { getDeviceCode } from "~/services/github/get-device-code"
import { pollAccessToken } from "~/services/github/poll-access-token"
import { resolveCopilotOAuth } from "~/services/github/resolve-copilot-oauth"

type MenuAction =
  | "list"
  | "add"
  | "edit"
  | "remove"
  | "toggle"
  | "test"
  | "clear"
  | "list-accounts"
  | "account-details"
  | "add-account"
  | "remove-account"
  | "list-custom-providers"
  | "add-nebius-provider"
  | "remove-custom-provider"
  | "exit"

function formatRule(rule: ReplacementRule, index: number): string {
  const status = rule.enabled ? "✓" : "✗"
  const type = rule.isRegex ? "regex" : "string"
  const system = rule.isSystem ? " [system]" : ""
  const name = rule.name ? ` "${rule.name}"` : ""
  const replacement = rule.replacement || "(empty)"
  return `${index + 1}. [${status}] (${type})${system}${name} "${rule.pattern}" → "${replacement}"`
}

function isValidPatternForMatchType(
  pattern: string,
  matchType: "string" | "regex",
): boolean {
  if (matchType !== "regex") return true
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

async function listReplacements(): Promise<void> {
  const all = await getAllReplacements()

  if (all.length === 0) {
    consola.info("No replacement rules configured.")
    return
  }

  consola.info("\n📋 Replacement Rules:\n")
  for (const [i, element] of all.entries()) {
    console.log(formatRule(element, i))
  }
  console.log()
}

async function addNewReplacement(): Promise<void> {
  const name = await consola.prompt("Name (optional, short description):", {
    type: "text",
    default: "",
  })

  if (typeof name === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const matchType = await consola.prompt("Match type:", {
    type: "select",
    options: [
      { label: "String (exact match)", value: "string" },
      { label: "Regex (regular expression)", value: "regex" },
    ],
  })

  if (typeof matchType === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const pattern = await consola.prompt("Pattern to match:", {
    type: "text",
  })

  if (typeof pattern === "symbol" || !pattern) {
    consola.info("Cancelled.")
    return
  }

  if (!isValidPatternForMatchType(pattern, matchType as "string" | "regex")) {
    consola.error(`Invalid regex pattern: ${pattern}`)
    return
  }

  const replacement = await consola.prompt(
    "Replacement text (leave empty to delete matches):",
    {
      type: "text",
      default: "",
    },
  )

  if (typeof replacement === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const rule = await addReplacement(pattern, replacement, {
    isRegex: matchType === "regex",
    name: name || undefined,
  })

  consola.success(`Added rule: ${rule.name || rule.id}`)
}

async function editExistingReplacement(): Promise<void> {
  const userRules = await getUserReplacements()

  if (userRules.length === 0) {
    consola.info("No user rules to edit.")
    return
  }

  const options = userRules.map((rule, i) => ({
    label: formatRule(rule, i),
    value: rule.id,
  }))

  const selected = await consola.prompt("Select rule to edit:", {
    type: "select",
    options,
  })

  if (typeof selected === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const rule = userRules.find((r) => r.id === selected)
  if (!rule) {
    consola.error("Rule not found.")
    return
  }

  consola.info(`\nEditing rule: ${rule.name || rule.id}`)
  consola.info("Press Enter to keep current value.\n")

  const name = await consola.prompt("Name:", {
    type: "text",
    default: rule.name || "",
  })

  if (typeof name === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const matchType = await consola.prompt("Match type:", {
    type: "select",
    options: [
      { label: "String (exact match)", value: "string" },
      { label: "Regex (regular expression)", value: "regex" },
    ],
    initial: rule.isRegex ? "regex" : "string",
  })

  if (typeof matchType === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const pattern = await consola.prompt("Pattern to match:", {
    type: "text",
    default: rule.pattern,
  })

  if (typeof pattern === "symbol" || !pattern) {
    consola.info("Cancelled.")
    return
  }

  if (!isValidPatternForMatchType(pattern, matchType as "string" | "regex")) {
    consola.error(`Invalid regex pattern: ${pattern}`)
    return
  }

  const replacement = await consola.prompt("Replacement text:", {
    type: "text",
    default: rule.replacement,
  })

  if (typeof replacement === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const updated = await updateReplacement(selected, {
    name: name || undefined,
    pattern,
    replacement,
    isRegex: matchType === "regex",
  })

  if (updated) {
    consola.success(`Updated rule: ${updated.name || updated.id}`)
  } else {
    consola.error("Failed to update rule.")
  }
}

async function removeExistingReplacement(): Promise<void> {
  const userRules = await getUserReplacements()

  if (userRules.length === 0) {
    consola.info("No user rules to remove.")
    return
  }

  const options = userRules.map((rule, i) => ({
    label: formatRule(rule, i),
    value: rule.id,
  }))

  const selected = await consola.prompt("Select rule to remove:", {
    type: "select",
    options,
  })

  if (typeof selected === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const success = await removeReplacement(selected)
  if (success) {
    consola.success("Rule removed.")
  } else {
    consola.error("Failed to remove rule.")
  }
}

async function toggleExistingReplacement(): Promise<void> {
  const userRules = await getUserReplacements()

  if (userRules.length === 0) {
    consola.info("No user rules to toggle.")
    return
  }

  const options = userRules.map((rule, i) => ({
    label: formatRule(rule, i),
    value: rule.id,
  }))

  const selected = await consola.prompt("Select rule to toggle:", {
    type: "select",
    options,
  })

  if (typeof selected === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const rule = await toggleReplacement(selected)
  if (rule) {
    consola.success(`Rule ${rule.enabled ? "enabled" : "disabled"}.`)
  } else {
    consola.error("Failed to toggle rule.")
  }
}

async function testReplacements(): Promise<void> {
  const testText = await consola.prompt("Enter text to test replacements:", {
    type: "text",
  })

  if (typeof testText === "symbol" || !testText) {
    consola.info("Cancelled.")
    return
  }

  const { text: result } = await applyReplacements(testText)

  consola.info("\n📝 Original:")
  console.log(testText)
  consola.info("\n✨ After replacements:")
  console.log(result)
  console.log()
}

async function clearAllReplacements(): Promise<void> {
  const confirm = await consola.prompt(
    "Are you sure you want to clear all user replacements?",
    {
      type: "confirm",
      initial: false,
    },
  )

  if (confirm) {
    await clearUserReplacements()
    consola.success("All user replacements cleared.")
  } else {
    consola.info("Cancelled.")
  }
}

// --- Account management ---

function maskToken(token: string): string {
  if (token.length <= 8) return "****"
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

async function listAccounts(): Promise<void> {
  // If the server is running, show live data from tokenPool
  if (tokenPool.size > 0) {
    const accounts = tokenPool.getAllAccounts()
    consola.info("\n👤 Accounts (live):\n")
    consola.info(
      `${"#".padEnd(4)} ${"Token".padEnd(16)} ${"Status".padEnd(10)} ${"Models".padEnd(8)} Type`,
    )
    consola.info("-".repeat(60))
    for (const account of accounts) {
      const status = account.healthy ? "✓ healthy" : "✗ unhealthy"
      const models = String(account.models.size)
      console.log(
        `${String(account.id).padEnd(4)} ${maskToken(account.githubToken).padEnd(16)} ${status.padEnd(10)} ${models.padEnd(8)} ${account.accountType}`,
      )
    }
    console.log()
    return
  }

  // Otherwise, show stored accounts from file
  const stored = await loadAccounts()
  if (stored.length === 0) {
    consola.info('No accounts configured. Use "Add account" to add one.')
    return
  }

  consola.info(`\n👤 Stored accounts (${stored.length}):\n`)
  for (const [i, account] of stored.entries()) {
    const label = account.label ? ` (${account.label})` : ""
    const instance =
      account.instanceDomain ? ` [${account.instanceDomain}]` : ""
    console.log(`  ${i + 1}. ${maskToken(account.token)}${instance}${label}`)
  }
  console.log()
}

async function showAccountDetails(): Promise<void> {
  // Live data from server
  if (tokenPool.size > 0) {
    const accounts = tokenPool.getAllAccounts()
    const options = accounts.map((account) => ({
      label: `#${account.id} ${maskToken(account.githubToken)} (${account.accountType})`,
      value: String(account.id),
    }))

    const selected = await consola.prompt("Select an account:", {
      type: "select",
      options,
    })

    if (typeof selected === "symbol") {
      consola.info("Cancelled.")
      return
    }

    const account = accounts.find((a) => String(a.id) === selected)
    if (!account) {
      consola.error("Account not found.")
      return
    }

    consola.info(`\n🔍 Account #${account.id}`)
    consola.info(`  Token: ${maskToken(account.githubToken)}`)
    consola.info(`  GitHub instance: ${account.githubInstanceDomain}`)
    consola.info(`  Type: ${account.accountType}`)
    consola.info(`  Status: ${account.healthy ? "✓ healthy" : "✗ unhealthy"}`)
    consola.info(`  Models (${account.models.size}):`)
    for (const model of account.models) {
      console.log(`    - ${model}`)
    }
    console.log()
    return
  }

  // Stored data (no live server)
  const stored = await loadAccounts()
  if (stored.length === 0) {
    consola.info('No accounts configured. Use "Add account" to add one.')
    return
  }

  const options = stored.map((account, i) => {
    const label = account.label ? ` (${account.label})` : ""
    return {
      label: `${i + 1}. ${maskToken(account.token)}${account.instanceDomain ? ` [${account.instanceDomain}]` : ""}${label}`,
      value: String(i),
    }
  })

  const selected = await consola.prompt("Select an account:", {
    type: "select",
    options,
  })

  const account = stored[Number(selected)]

  consola.info(`\n🔍 Account #${Number(selected) + 1}`)
  consola.info(`  Token: ${maskToken(account.token)}`)
  consola.info(`  GitHub instance: ${account.instanceDomain}`)
  if (account.label) consola.info(`  Label: ${account.label}`)
  consola.info("  (Start the server to see models and health status)")
  console.log()
}

async function addAccountMenu(): Promise<void> {
  const method = await consola.prompt("How would you like to add an account?", {
    type: "select",
    options: [
      {
        label: "🔑 Login via GitHub (device code flow)",
        value: "device-code",
      },
      { label: "📋 Paste an existing token", value: "paste-token" },
    ],
  })

  if (typeof method === "symbol") {
    consola.info("Cancelled.")
    return
  }

  let token: string
  const instanceDomain = await promptGitHubInstanceDomain()
  if (!instanceDomain) return

  if (method === "device-code") {
    const result = await loginViaDeviceCode(instanceDomain)
    if (!result) return
    token = result
  } else {
    const input = await consola.prompt("Enter a GitHub token:", {
      type: "text",
    })

    if (typeof input === "symbol" || !input) {
      consola.info("Cancelled.")
      return
    }
    token = input.trim()
  }

  // Validate the token against Copilot API
  consola.start("Validating token with Copilot API...")

  try {
    await resolveCopilotOAuth({
      accountType:
        instanceDomain === DEFAULT_GITHUB_DOMAIN ? "individual" : "enterprise",
      githubToken: token,
      instanceDomain,
    })

    consola.success("Token is valid and has Copilot access!")
  } catch (error) {
    consola.error("Failed to validate token:", error)
    return
  }

  // Ask for optional label
  const label = await consola.prompt(
    "Label for this account (optional, e.g. 'work', 'personal'):",
    { type: "text", default: "" },
  )

  const labelValue =
    typeof label === "symbol" || !label ? undefined : label.trim() || undefined

  // Save to store
  const accounts = await storeAddAccount(token, labelValue, instanceDomain)
  consola.success(`Account saved! (${accounts.length} total)`)
}

async function promptGitHubInstanceDomain(): Promise<string | undefined> {
  const target = await consola.prompt(
    "Which GitHub instance is this account on?",
    {
      type: "select",
      options: [
        { label: "GitHub.com", value: "github.com" },
        {
          label: "GitHub Enterprise Cloud (*.ghe.com)",
          value: "enterprise",
        },
      ],
    },
  )
  if (typeof target === "symbol") return undefined
  if (target === "github.com") return DEFAULT_GITHUB_DOMAIN

  const host = await consola.prompt("Enter the GitHub Enterprise domain:", {
    type: "text",
    placeholder: "msft.ghe.com",
  })
  if (typeof host === "symbol" || !host) return undefined
  try {
    return normalizeGitHubDomain(host)
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error))
    return undefined
  }
}

async function loginViaDeviceCode(
  instanceDomain: string,
): Promise<string | undefined> {
  try {
    consola.start("Requesting device code from GitHub...")
    const deviceCode = await getDeviceCode(instanceDomain)

    consola.box(
      `Open ${deviceCode.verification_uri}\nand enter code: ${deviceCode.user_code}`,
    )

    consola.start("Waiting for authorization...")
    const token = await pollAccessToken(deviceCode, instanceDomain)

    consola.success("Login successful!")
    return token
  } catch (error) {
    consola.error("Device code login failed:", error)
    return undefined
  }
}

async function removeAccountMenu(): Promise<void> {
  const stored = await loadAccounts()
  if (stored.length === 0) {
    consola.info('No accounts configured. Use "Add account" to add one.')
    return
  }

  const options = stored.map((account, i) => {
    const label = account.label ? ` (${account.label})` : ""
    return {
      label: `${i + 1}. ${maskToken(account.token)}${account.instanceDomain ? ` [${account.instanceDomain}]` : ""}${label}`,
      value: String(i),
    }
  })

  const selected = await consola.prompt("Select an account to remove:", {
    type: "select",
    options,
  })

  if (typeof selected === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const index = Number(selected)
  const account = stored[index]
  const label = account.label ? ` (${account.label})` : ""
  const instance = account.instanceDomain ? ` [${account.instanceDomain}]` : ""

  const confirm = await consola.prompt(
    `Remove account ${maskToken(account.token)}${instance}${label}?`,
    { type: "confirm", initial: false },
  )

  if (!confirm) {
    consola.info("Cancelled.")
    return
  }

  const remaining = await storeRemoveAccount(account.id)
  consola.success(`Account removed. (${remaining.length} remaining)`)
}

type DashboardCustomProvider = Awaited<
  ReturnType<typeof listCustomProvidersForDashboard>
>[number]

function formatCustomProvider(provider: DashboardCustomProvider): string {
  let keySource = "missing api key"
  if (provider.apiKeyConfigured) {
    keySource = "stored api key"
  }
  return `${provider.name} (${provider.id}) - ${provider.models.length} model${provider.models.length === 1 ? "" : "s"} - ${provider.baseUrl} - ${keySource}`
}

async function listCustomProvidersMenu(): Promise<void> {
  const providers = await listCustomProvidersForDashboard()
  if (providers.length === 0) {
    consola.info("No custom providers configured.")
    return
  }

  consola.info("\nCustom providers:\n")
  for (const [index, provider] of providers.entries()) {
    console.log(`${index + 1}. ${formatCustomProvider(provider)}`)
    for (const model of provider.models) {
      const aliases =
        model.aliases?.length ? ` aliases: ${model.aliases.join(", ")}` : ""
      const dimensions =
        model.dimensions ? ` dimensions: ${model.dimensions}` : ""
      console.log(`   - ${model.id} (${model.kind})${aliases}${dimensions}`)
    }
  }
  console.log()
}

async function addNebiusProviderMenu(): Promise<void> {
  const apiKey = await consola.prompt("Nebius API key:", {
    type: "text",
  })

  if (typeof apiKey === "symbol" || !apiKey.trim()) {
    consola.info("Cancelled.")
    return
  }

  const provider = createNebiusQwen3EmbeddingProvider(apiKey.trim())
  await upsertCustomProvider(provider)
  consola.success(
    `Saved ${provider.name}. Use ${provider.models[0]?.aliases?.[0] ?? provider.models[0]?.id} for embeddings.`,
  )
}

async function removeCustomProviderMenu(): Promise<void> {
  const providers = await listCustomProvidersForDashboard()
  if (providers.length === 0) {
    consola.info("No custom providers configured.")
    return
  }

  const selected = await consola.prompt("Select provider to remove:", {
    type: "select",
    options: providers.map((provider) => ({
      label: formatCustomProvider(provider),
      value: provider.id,
    })),
  })

  if (typeof selected === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const provider = providers.find((item) => item.id === selected)
  const confirm = await consola.prompt(
    `Remove custom provider ${provider?.name ?? selected}?`,
    { type: "confirm", initial: false },
  )

  if (!confirm) {
    consola.info("Cancelled.")
    return
  }

  if (await removeCustomProvider(selected)) {
    consola.success("Custom provider removed.")
  } else {
    consola.error("Custom provider not found.")
  }
}

const MENU_ACTION_HANDLERS: Partial<
  Record<MenuAction, () => Promise<void> | void>
> = {
  list: listReplacements,
  add: addNewReplacement,
  edit: editExistingReplacement,
  remove: removeExistingReplacement,
  toggle: toggleExistingReplacement,
  test: testReplacements,
  clear: clearAllReplacements,
  "list-accounts": listAccounts,
  "account-details": showAccountDetails,
  "add-account": addAccountMenu,
  "remove-account": removeAccountMenu,
  "list-custom-providers": listCustomProvidersMenu,
  "add-nebius-provider": addNebiusProviderMenu,
  "remove-custom-provider": removeCustomProviderMenu,
}

function getMenuOptions(): Array<{ label: string; value: MenuAction }> {
  return [
    { label: "📋 List all rules", value: "list" },
    { label: "➕ Add new rule", value: "add" },
    { label: "✏️  Edit rule", value: "edit" },
    { label: "➖ Remove rule", value: "remove" },
    { label: "🔄 Toggle rule on/off", value: "toggle" },
    { label: "🧪 Test replacements", value: "test" },
    { label: "🗑️  Clear all user rules", value: "clear" },
    { label: "👤 List accounts", value: "list-accounts" },
    { label: "🔍 Account details", value: "account-details" },
    { label: "➕ Add account", value: "add-account" },
    { label: "➖ Remove account", value: "remove-account" },
    { label: "🌐 List custom providers", value: "list-custom-providers" },
    { label: "➕ Add Nebius Qwen3 embeddings", value: "add-nebius-provider" },
    { label: "➖ Remove custom provider", value: "remove-custom-provider" },
    { label: "🚪 Exit", value: "exit" },
  ]
}

async function mainMenu(): Promise<void> {
  consola.info(`\n🔧 Copilot API - Replacement Configuration`)
  consola.info(`Database: ${getStorageRuntime().config.kind}\n`)

  let running = true

  while (running) {
    const action = await consola.prompt("What would you like to do?", {
      type: "select",
      options: getMenuOptions(),
    })

    if (typeof action === "symbol") {
      break
    }

    if (action === "exit") {
      running = false
      continue
    }

    await MENU_ACTION_HANDLERS[action]?.()
  }

  consola.info("Goodbye! 👋")
}

export const config = defineCommand({
  meta: {
    name: "config",
    description: "Configure replacement rules interactively",
  },
  run: async () => {
    await initializeStorageRuntime()
    await mergeConfigWithDefaults()
    try {
      await mainMenu()
    } finally {
      await closeStorageRuntime()
    }
  },
})
