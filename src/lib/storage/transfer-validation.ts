import type { SqlSession } from "~/lib/storage/types"

import { validateAdminPasswordHash } from "~/lib/admin-auth"
import { validateStoredReplacements } from "~/lib/auto-replace"
import { validateAppConfigJson } from "~/lib/config"
import { normalizeGitHubDomain } from "~/lib/github-instance"
import { normalizeIpAddress } from "~/lib/ip-allowlist"
import { validateModelFallbackConfig } from "~/lib/model-fallback-config"
import { validateStoredModelRedirects } from "~/lib/model-redirect"
import { validateStoredModelRouting } from "~/lib/model-routing"
import { validateStoredModelSettings } from "~/lib/model-settings"
import { StorageSchemaError } from "~/lib/storage/errors"
import { loadCustomProviderSnapshotFromSession } from "~/lib/storage/providers-repository"
import { validateStoredFeatureFlags } from "~/routes/feature-flags/store"
import { validateStatsigOverrides } from "~/routes/statsig-overrides/store"

const validators: Record<string, (value: unknown) => unknown> = {
  app: validateAppConfigJson,
  replacements: validateStoredReplacements,
  model_redirects: validateStoredModelRedirects,
  model_settings: validateStoredModelSettings,
  model_routing: validateStoredModelRouting,
  model_fallbacks: validateModelFallbackConfig,
  feature_flags: validateStoredFeatureFlags,
  statsig_overrides: validateStatsigOverrides,
}
export const TRANSFER_OAUTH_SCOPES = new Set([
  "user:inference",
  "user:profile",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "org:create_api_key",
])
export function validateTransferScopes(value: unknown): void {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > TRANSFER_OAUTH_SCOPES.size
    || value.some(
      (scope: unknown) =>
        typeof scope !== "string" || !TRANSFER_OAUTH_SCOPES.has(scope),
    )
    || new Set(value).size !== value.length
  )
    throw new StorageSchemaError("Invalid transferred OAuth scopes")
}
export function validateTransferSetting(
  namespace: string,
  value: unknown,
): void {
  if (!Object.hasOwn(validators, namespace))
    throw new StorageSchemaError("Unknown transferred settings namespace")
  validators[namespace](value)
  if (
    namespace === "app"
    && value
    && typeof value === "object"
    && hasLegacyCredentialValues(value)
  )
    throw new StorageSchemaError(
      "Transferred credentials must use their dedicated tables",
    )
}

/** Early database defaults carried empty legacy fields; they confer no authority. */
function hasLegacyCredentialValues(value: object): boolean {
  if ("auth" in value) {
    const auth = value.auth
    if (
      !auth
      || typeof auth !== "object"
      || Array.isArray(auth)
      || Object.keys(auth).some((key) => key !== "apiKeys")
      || ("apiKeys" in auth
        && (!Array.isArray(auth.apiKeys) || auth.apiKeys.length > 0))
    )
      return true
  }
  return (
    ("customProviders" in value
      && (!Array.isArray(value.customProviders)
        || value.customProviders.length > 0))
    || ("groqApiKey" in value && value.groqApiKey !== "")
  )
}

export async function validateTransferDomains(
  session: SqlSession,
): Promise<void> {
  const settings = await session.query({
    sql: "SELECT namespace,value_json FROM capi_settings",
    args: [],
  })
  for (const row of settings)
    validateTransferSetting(
      String(row.namespace),
      JSON.parse(String(row.value_json)),
    )
  const admin = await session.query({
    sql: "SELECT password_hash FROM capi_admin",
    args: [],
  })
  for (const row of admin) validateAdminPasswordHash(String(row.password_hash))
  const accounts = await session.query({
    sql: "SELECT id,domain FROM capi_accounts",
    args: [],
  })
  for (const row of accounts)
    if (normalizeGitHubDomain(String(row.domain)) !== row.domain)
      throw new StorageSchemaError("Invalid imported account domain")
  const missing = await session.query({
    sql: "SELECT a.id FROM capi_accounts a LEFT JOIN capi_account_credentials c ON a.id=c.account_id WHERE a.deleted_at IS NULL AND a.enabled=1 AND c.account_id IS NULL LIMIT 1",
    args: [],
  })
  if (missing.length > 0)
    throw new StorageSchemaError("Imported account credential is missing")
  const ips = await session.query({
    sql: "SELECT ip FROM capi_ip_allowlist",
    args: [],
  })
  for (const row of ips)
    if (normalizeIpAddress(String(row.ip)) !== row.ip)
      throw new StorageSchemaError("Invalid imported IP allowlist")
  await loadCustomProviderSnapshotFromSession(session)
}
