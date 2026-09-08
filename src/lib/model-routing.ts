import {
  getLoadedSetting,
  readSetting,
  updateSetting,
} from "~/lib/storage/domain-settings"
import { StorageSchemaError } from "~/lib/storage/errors"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { normalizeSettingsJson } from "~/lib/storage/settings-repository"

export interface ModelRoutingOverride {
  modelId: string
  accountId: number
  enabled: boolean
}

type ModelRoutingConfig = Partial<Record<string, Record<string, boolean>>>

let testConfig: ModelRoutingConfig | undefined

export function validateStoredModelRouting(value: unknown): ModelRoutingConfig {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageSchemaError("Invalid model routing configuration")
  }

  const normalized: ModelRoutingConfig = {}
  for (const [modelId, accountMap] of Object.entries(value)) {
    if (
      typeof accountMap !== "object"
      || accountMap === null
      || Array.isArray(accountMap)
    ) {
      throw new StorageSchemaError("Invalid model routing account map")
    }

    const typedAccountMap = accountMap as Record<string, unknown>
    for (const [accountId, enabled] of Object.entries(typedAccountMap)) {
      if (typeof enabled !== "boolean")
        throw new StorageSchemaError("Invalid model routing override")
      const normalizedAccountMap = normalized[modelId] ?? {}
      normalizedAccountMap[accountId] = enabled
      normalized[modelId] = normalizedAccountMap
    }
  }

  return normalized
}

function currentConfig(): ModelRoutingConfig {
  return structuredClone(
    testConfig ?? validateStoredModelRouting(getLoadedSetting("model_routing")),
  )
}

export async function loadModelRoutingOverrides(): Promise<void> {
  validateStoredModelRouting(await readSetting("model_routing"))
  testConfig = undefined
}

export async function saveModelRoutingOverrides(): Promise<void> {
  if (testConfig) return
  await updateSetting("model_routing", (current) =>
    normalizeSettingsJson(validateStoredModelRouting(current)),
  )
}

export async function ensureModelRoutingOverridesLoaded(): Promise<void> {
  await Promise.resolve(currentConfig())
}

export function isModelEnabledForAccount(
  modelId: string,
  accountId: number,
): boolean {
  return currentConfig()[modelId]?.[String(accountId)] ?? true
}

/** Shared eligibility must never be rebuilt from an admitted request's older policy. */
export function getLiveModelRoutingPolicy(): (
  modelId: string,
  accountId: number,
) => boolean {
  const config =
    testConfig
    ?? validateStoredModelRouting(
      getStorageRuntime().snapshot.get().documents.get("model_routing")?.value,
    )
  return (modelId, accountId) => config[modelId]?.[String(accountId)] ?? true
}

export function hasModelRoutingOverride(
  modelId: string,
  accountId: number,
): boolean {
  return currentConfig()[modelId]?.[String(accountId)] !== undefined
}

export async function setModelRoutingOverride(
  modelId: string,
  accountId: number,
  enabled: boolean,
): Promise<ModelRoutingOverride> {
  const update = (routingConfig: ModelRoutingConfig) => {
    const accountMap = routingConfig[modelId] ?? {}
    accountMap[String(accountId)] = enabled
    Object.defineProperty(routingConfig, modelId, {
      value: accountMap,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    return routingConfig
  }
  if (testConfig) testConfig = update(currentConfig())
  else
    await updateSetting("model_routing", (current) =>
      normalizeSettingsJson(update(validateStoredModelRouting(current))),
    )
  return { modelId, accountId, enabled }
}

export async function clearModelRoutingOverrides(): Promise<void> {
  if (testConfig) testConfig = {}
  else await updateSetting("model_routing", () => ({}))
}

export function setModelRoutingOverridesForTest(
  config: ModelRoutingConfig,
): void {
  testConfig = structuredClone(config)
}

export function resetModelRoutingOverridesForTest(): void {
  testConfig = undefined
}

export async function getAllModelRoutingOverrides(): Promise<
  Array<ModelRoutingOverride>
> {
  await ensureModelRoutingOverridesLoaded()
  const overrides: Array<ModelRoutingOverride> = []

  for (const [modelId, accountMap] of Object.entries(currentConfig())) {
    if (!accountMap) continue

    for (const [accountId, enabled] of Object.entries(accountMap)) {
      overrides.push({ modelId, accountId: Number(accountId), enabled })
    }
  }

  return overrides
}
