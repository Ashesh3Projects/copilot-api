import { getLoadedSetting, updateSetting } from "~/lib/storage/domain-settings"
import { normalizeSettingsJson } from "~/lib/storage/settings-repository"

export type FeatureFlagValue =
  | boolean
  | string
  | number
  | Record<string, unknown>
export type FeatureFlags = Record<string, FeatureFlagValue>

const FORBIDDEN_FLAG_NAMES = new Set(["__proto__", "constructor", "prototype"])

export class FeatureFlagValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FeatureFlagValidationError"
  }
}

export function isValidFeatureFlagName(name: string): boolean {
  return (
    name.length > 0 && /^[\w.-]+$/.test(name) && !FORBIDDEN_FLAG_NAMES.has(name)
  )
}

function createFlagMap(): FeatureFlags {
  return Object.create(null) as FeatureFlags
}

function normalizeFlags(raw: unknown): FeatureFlags {
  const result = createFlagMap()
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return result
  }

  for (const [name, value] of Object.entries(raw)) {
    if (!isValidFeatureFlagName(name)) continue
    if (
      typeof value !== "boolean"
      && typeof value !== "string"
      && typeof value !== "number"
      && (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      continue
    }
    try {
      JSON.stringify(value)
    } catch {
      continue
    }
    result[name] = value as FeatureFlagValue
  }
  return result
}

const DEFAULT_FLAGS: FeatureFlags = {
  // Enable the env-less bridge (v2 protocol) for Remote Control
  tengu_bridge_repl_v2: true,
  // Enable bridge/Remote Control entitlement
  tengu_ccr_bridge: true,
  // Enable voice mode
  tengu_amber_quartz_disabled: false,
  // Enable remote TUI backend
  tengu_remote_backend: true,
  // A streamed API error is already the terminal outcome for that generation.
  // Retrying the same turn non-streaming can duplicate model/tool work.
  tengu_disable_streaming_to_non_streaming_fallback: true,
}

/** Detached defaults for snapshot-based export without consulting runtime state. */
export function getDefaultFeatureFlags(): FeatureFlags {
  return Object.assign(createFlagMap(), DEFAULT_FLAGS)
}

let testFlags: FeatureFlags | undefined

export function validateStoredFeatureFlags(raw: unknown): FeatureFlags {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FeatureFlagValidationError("Feature flags must be an object")
  }
  const normalized = normalizeFlags(raw)
  if (Object.keys(normalized).length !== Object.keys(raw).length) {
    throw new FeatureFlagValidationError("Invalid stored feature flag")
  }
  normalizeSettingsJson(normalized)
  return normalized
}

function flagsFromValue(value: unknown): FeatureFlags {
  return value === undefined ?
      Object.assign(createFlagMap(), DEFAULT_FLAGS)
    : validateStoredFeatureFlags(value)
}

function cloneFlags(flags: FeatureFlags): FeatureFlags {
  return Object.assign(createFlagMap(), structuredClone(flags))
}

export function getFeatureFlags(): FeatureFlags {
  return cloneFlags(
    testFlags ?? flagsFromValue(getLoadedSetting("feature_flags")),
  )
}

export async function setFeatureFlag(
  name: string,
  value: FeatureFlagValue,
): Promise<FeatureFlags> {
  if (!isValidFeatureFlagName(name))
    throw new FeatureFlagValidationError("Invalid feature flag name")
  let normalized: FeatureFlags
  try {
    normalized = validateStoredFeatureFlags({ [name]: value })
  } catch {
    throw new FeatureFlagValidationError(
      "Feature flag value is not serializable",
    )
  }
  const update = (flags: FeatureFlags) => {
    flags[name] = normalized[name]
    return flags
  }
  if (testFlags) {
    testFlags = update(cloneFlags(testFlags))
    return cloneFlags(testFlags)
  }
  return cloneFlags(
    validateStoredFeatureFlags(
      await updateSetting("feature_flags", (current) =>
        normalizeSettingsJson(update(flagsFromValue(current))),
      ),
    ),
  )
}

export async function removeFeatureFlag(name: string): Promise<boolean> {
  if (!isValidFeatureFlagName(name)) return false
  let removed = false
  const update = (flags: FeatureFlags) => {
    removed = Object.hasOwn(flags, name)
    const { [name]: _removed, ...rest } = flags
    return rest
  }
  if (testFlags) testFlags = update(cloneFlags(testFlags))
  else
    await updateSetting("feature_flags", (current) =>
      normalizeSettingsJson(update(flagsFromValue(current))),
    )
  return removed
}

export function setFeatureFlagsForTest(
  flags: FeatureFlags | null = createFlagMap(),
): void {
  testFlags =
    flags === null ? undefined : (
      Object.assign(createFlagMap(), DEFAULT_FLAGS, normalizeFlags(flags))
    )
}
