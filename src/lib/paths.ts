import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const APP_DIR =
  process.env.DATA_DIR
  || path.join(os.homedir(), ".local", "share", "copilot-api")

const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token")
const GITHUB_TOKENS_PATH = path.join(APP_DIR, "github_tokens.json")
const REPLACEMENTS_CONFIG_PATH = path.join(APP_DIR, "replacements.json")
const MODEL_REDIRECTS_CONFIG_PATH = path.join(APP_DIR, "model_redirects.json")
const MODEL_SETTINGS_CONFIG_PATH = path.join(APP_DIR, "model_settings.json")
const MODEL_ROUTING_CONFIG_PATH = path.join(APP_DIR, "model_routing.json")
const MODEL_FALLBACKS_CONFIG_PATH = path.join(APP_DIR, "model_fallbacks.json")
const FEATURE_FLAGS_PATH = path.join(APP_DIR, "feature_flags.json")
const STATSIG_OVERRIDES_PATH = path.join(APP_DIR, "statsig_overrides.json")
const IP_ALLOWLIST_PATH = path.join(APP_DIR, "ip_allowlist.json")
const TRUSTED_JWT_DIGESTS_PATH = path.join(APP_DIR, "trusted_jwt_digests.json")
const USAGE_PATH = path.join(APP_DIR, "usage.json")
const OAUTH_STORE_PATH = path.join(APP_DIR, "oauth_tokens.json")
const ADMIN_AUTH_PATH = path.join(APP_DIR, "admin_auth.json")
const ADMIN_SESSIONS_PATH = path.join(APP_DIR, "admin_sessions.json")

export const PATHS = {
  APP_DIR,
  CONFIG_PATH: path.join(APP_DIR, "config.json"),
  GITHUB_TOKEN_PATH,
  GITHUB_TOKENS_PATH,
  REPLACEMENTS_CONFIG_PATH,
  MODEL_REDIRECTS_CONFIG_PATH,
  MODEL_SETTINGS_CONFIG_PATH,
  MODEL_ROUTING_CONFIG_PATH,
  MODEL_FALLBACKS_CONFIG_PATH,
  FEATURE_FLAGS_PATH,
  STATSIG_OVERRIDES_PATH,
  IP_ALLOWLIST_PATH,
  TRUSTED_JWT_DIGESTS_PATH,
  USAGE_PATH,
  OAUTH_STORE_PATH,
  ADMIN_AUTH_PATH,
  ADMIN_SESSIONS_PATH,
}

/**
 * When true, GitHub tokens were sourced from environment variables.
 * In this mode we never read or write GitHub token files on disk.
 */
let envOnlyTokens = false

export function setEnvOnlyTokens(value: boolean): void {
  envOnlyTokens = value
}

export function isEnvOnlyTokens(): boolean {
  return envOnlyTokens
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(PATHS.APP_DIR, 0o700)
  if (!envOnlyTokens) {
    await ensureFile(PATHS.GITHUB_TOKEN_PATH)
  }
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
