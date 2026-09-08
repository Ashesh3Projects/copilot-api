import { getLoadedSetting, updateSetting } from "~/lib/storage/domain-settings"
import { normalizeSettingsJson } from "~/lib/storage/settings-repository"

export type StatsigOverrideKind = "featureGate" | "dynamicConfig"
export type StatsigJsonValue =
  | null
  | boolean
  | number
  | string
  | StatsigJsonArray
  | StatsigDynamicConfig
export type StatsigJsonArray = Array<StatsigJsonValue>
export interface StatsigDynamicConfig {
  [key: string]: StatsigJsonValue
}

export interface StatsigOverrides {
  featureGates: Record<string, boolean>
  dynamicConfigs: Record<string, StatsigDynamicConfig>
}

export interface StatsigOverrideStore {
  get(): StatsigOverrides
  set(
    kind: StatsigOverrideKind,
    name: string,
    value: unknown,
  ): Promise<StatsigOverrides>
  remove(kind: StatsigOverrideKind, name: string): Promise<boolean>
  count(): number
  replaceForTest(overrides: StatsigOverrides): void
  resetAfterTest(): void
}

export class StatsigOverrideValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StatsigOverrideValidationError"
  }
}

const BLOCKED_NAMES = new Set(["__proto__", "prototype", "constructor"])
const DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE =
  "dynamic config value must be a JSON object"

function createStringMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function createEmptyOverrides(): StatsigOverrides {
  return {
    featureGates: createStringMap<boolean>(),
    dynamicConfigs: createStringMap<StatsigDynamicConfig>(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false
  }

  const prototype = Reflect.getPrototypeOf(value)
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

function setJsonObjectValue(
  target: StatsigDynamicConfig,
  key: string,
  value: StatsigJsonValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function cloneJsonArray(
  value: ReadonlyArray<unknown>,
  seen: Set<object>,
): Array<StatsigJsonValue> {
  if (seen.has(value)) {
    throw new StatsigOverrideValidationError(DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE)
  }

  seen.add(value)
  try {
    const clone: Array<StatsigJsonValue> = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new StatsigOverrideValidationError(
          DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE,
        )
      }
      clone.push(cloneJsonValue(value[index], seen))
    }
    return clone
  } finally {
    seen.delete(value)
  }
}

function cloneJsonObject(
  value: Record<string, unknown>,
  seen: Set<object> = new Set<object>(),
): StatsigDynamicConfig {
  if (!isPlainObject(value) || seen.has(value)) {
    throw new StatsigOverrideValidationError(DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE)
  }

  seen.add(value)
  try {
    const clone: StatsigDynamicConfig = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      setJsonObjectValue(clone, key, cloneJsonValue(nestedValue, seen))
    }
    return clone
  } finally {
    seen.delete(value)
  }
}

function cloneJsonValue(value: unknown, seen: Set<object>): StatsigJsonValue {
  if (value === null) {
    return value
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return cloneJsonArray(value, seen)
  }
  if (isPlainObject(value)) {
    return cloneJsonObject(value, seen)
  }

  throw new StatsigOverrideValidationError(DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE)
}

function cloneDynamicConfig(value: StatsigDynamicConfig): StatsigDynamicConfig {
  return cloneJsonObject(value)
}

function cloneOverrides(overrides: StatsigOverrides): StatsigOverrides {
  return {
    featureGates: { ...overrides.featureGates },
    dynamicConfigs: Object.fromEntries(
      Object.entries(overrides.dynamicConfigs).map(([name, value]) => [
        name,
        cloneDynamicConfig(value),
      ]),
    ),
  }
}

function normalizeName(name: string): string {
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new StatsigOverrideValidationError("name is required")
  }
  if (BLOCKED_NAMES.has(trimmedName)) {
    throw new StatsigOverrideValidationError("name is not allowed")
  }
  return trimmedName
}

function validateFeatureGateValue(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new StatsigOverrideValidationError(
      "feature gate value must be boolean",
    )
  }
  return value
}

function validateDynamicConfigValue(value: unknown): StatsigDynamicConfig {
  if (!isPlainObject(value)) {
    throw new StatsigOverrideValidationError(DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE)
  }
  return cloneJsonObject(value)
}

function validateFeatureGates(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) {
    throw new StatsigOverrideValidationError("featureGates must be an object")
  }

  const featureGates = createStringMap<boolean>()
  for (const [name, gateValue] of Object.entries(value)) {
    featureGates[normalizeName(name)] = validateFeatureGateValue(gateValue)
  }
  return featureGates
}

function validateDynamicConfigs(
  value: unknown,
): Record<string, StatsigDynamicConfig> {
  if (!isRecord(value)) {
    throw new StatsigOverrideValidationError("dynamicConfigs must be an object")
  }

  const dynamicConfigs = createStringMap<StatsigDynamicConfig>()
  for (const [name, configValue] of Object.entries(value)) {
    dynamicConfigs[normalizeName(name)] =
      validateDynamicConfigValue(configValue)
  }
  return dynamicConfigs
}

export function validateStatsigOverrides(value: unknown): StatsigOverrides {
  if (!isRecord(value)) {
    throw new StatsigOverrideValidationError(
      "statsig overrides must be an object",
    )
  }

  return {
    featureGates: validateFeatureGates(value.featureGates),
    dynamicConfigs: validateDynamicConfigs(value.dynamicConfigs),
  }
}

function overridesFromValue(value: unknown): StatsigOverrides {
  return value === undefined ?
      createEmptyOverrides()
    : validateStatsigOverrides(value)
}

export function createStatsigOverrideStore(): StatsigOverrideStore {
  let testOverrides: StatsigOverrides | undefined
  function getCurrent(): StatsigOverrides {
    return cloneOverrides(
      testOverrides
        ?? overridesFromValue(getLoadedSetting("statsig_overrides")),
    )
  }
  async function mutate(
    update: (overrides: StatsigOverrides) => StatsigOverrides,
  ): Promise<StatsigOverrides> {
    if (testOverrides) {
      testOverrides = update(cloneOverrides(testOverrides))
      return cloneOverrides(testOverrides)
    }
    return validateStatsigOverrides(
      await updateSetting("statsig_overrides", (current) =>
        normalizeSettingsJson(update(overridesFromValue(current))),
      ),
    )
  }
  return {
    get: getCurrent,
    async set(kind, name, value) {
      const normalizedName = normalizeName(name)
      const normalizedValue =
        kind === "featureGate" ?
          validateFeatureGateValue(value)
        : validateDynamicConfigValue(value)
      return cloneOverrides(
        await mutate((next) => {
          if (typeof normalizedValue === "boolean")
            next.featureGates[normalizedName] = normalizedValue
          else next.dynamicConfigs[normalizedName] = normalizedValue
          return next
        }),
      )
    },
    async remove(kind, name) {
      const normalizedName = normalizeName(name)
      let removed = false
      await mutate((next) => {
        const bucket =
          kind === "featureGate" ? next.featureGates : next.dynamicConfigs
        removed = Object.hasOwn(bucket, normalizedName)
        if (kind === "featureGate") {
          const { [normalizedName]: _removed, ...rest } = next.featureGates
          next.featureGates = rest
        } else {
          const { [normalizedName]: _removed, ...rest } = next.dynamicConfigs
          next.dynamicConfigs = rest
        }
        return next
      })
      return removed
    },
    count() {
      const value = getCurrent()
      return (
        Object.keys(value.featureGates).length
        + Object.keys(value.dynamicConfigs).length
      )
    },
    replaceForTest(overrides) {
      testOverrides = validateStatsigOverrides(overrides)
    },
    resetAfterTest() {
      testOverrides = undefined
    },
  }
}

export const statsigOverrideStore = createStatsigOverrideStore()
