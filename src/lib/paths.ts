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

// Legacy read-only path names remain for explicit migration/test compatibility.
