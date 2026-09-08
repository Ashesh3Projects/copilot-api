import type { ReasoningEffort } from "~/lib/model-suffix"

import {
  getLoadedSetting,
  readSetting,
  updateSetting,
} from "~/lib/storage/domain-settings"
import { StorageSchemaError } from "~/lib/storage/errors"
import { normalizeSettingsJson } from "~/lib/storage/settings-repository"

export interface ModelSettings {
  model: string
  sentryModelName?: string
  supportedReasoningEfforts?: Array<ReasoningEffort>
  defaultReasoningEffort?: ReasoningEffort
  implicitReasoningDefault?: boolean
  exposeVirtualReasoningModels?: boolean
  supportsAssistantPrefill?: boolean
  unsupportedRequestParameters?: Array<ModelRequestParameter>
}

export interface ModelSettingsUpdate {
  sentryModelName?: string | null
  supportedReasoningEfforts?: Array<ReasoningEffort | "max"> | null
  defaultReasoningEffort?: ReasoningEffort | "max" | null
  implicitReasoningDefault?: boolean | null
  exposeVirtualReasoningModels?: boolean | null
  supportsAssistantPrefill?: boolean | null
  unsupportedRequestParameters?: Array<ModelRequestParameter> | null
}

export type ModelRequestParameter = "temperature" | "top_p"

type BooleanModelSetting =
  | "implicitReasoningDefault"
  | "exposeVirtualReasoningModels"
  | "supportsAssistantPrefill"

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
const REQUEST_PARAMETERS = new Set<ModelRequestParameter>([
  "temperature",
  "top_p",
])
const DEFAULT_UNSUPPORTED_REQUEST_PARAMETERS: Record<
  string,
  Array<ModelRequestParameter>
> = {
  "gpt-5.4-mini": ["temperature", "top_p"],
  "gpt-5.5": ["temperature", "top_p"],
}
const DEFAULT_UNSUPPORTED_ASSISTANT_PREFILL_MODELS = new Set([
  "claude-opus-4.8",
])
const DELETE_BOOLEAN_MODEL_SETTING: Record<
  BooleanModelSetting,
  (settings: ModelSettings) => void
> = {
  implicitReasoningDefault: (settings) => {
    delete settings.implicitReasoningDefault
  },
  exposeVirtualReasoningModels: (settings) => {
    delete settings.exposeVirtualReasoningModels
  },
  supportsAssistantPrefill: (settings) => {
    delete settings.supportsAssistantPrefill
  },
}

let testSettings: Record<string, ModelSettings> | undefined

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.has(value as ReasoningEffort)
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return isReasoningEffort(value) ? value : undefined
}

function normalizeSupportedReasoningEfforts(
  value: unknown,
): Array<ReasoningEffort> | undefined {
  if (!Array.isArray(value)) return undefined

  const efforts = value.flatMap((item) => {
    const effort = normalizeReasoningEffort(item)
    return effort ? [effort] : []
  })

  return [...new Set(efforts)]
}

function isModelRequestParameter(
  value: unknown,
): value is ModelRequestParameter {
  return REQUEST_PARAMETERS.has(value as ModelRequestParameter)
}

function normalizeUnsupportedRequestParameters(
  value: unknown,
): Array<ModelRequestParameter> | undefined {
  if (!Array.isArray(value)) return undefined

  const parameters = value.flatMap((item) =>
    isModelRequestParameter(item) ? [item] : [],
  )

  return [...new Set(parameters)]
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function applyNormalizedBoolean(
  settings: ModelSettings,
  key: BooleanModelSetting,
  value: boolean | undefined,
): void {
  if (value !== undefined) {
    settings[key] = value
  }
}

function normalizeModelSettings(raw: unknown): ModelSettings | undefined {
  if (!isSettingsRecord(raw)) return undefined

  const value = raw
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    return undefined
  }

  const supportedReasoningEfforts = normalizeSupportedReasoningEfforts(
    value.supportedReasoningEfforts,
  )
  const sentryModelName =
    typeof value.sentryModelName === "string" ?
      value.sentryModelName.trim()
    : undefined
  const defaultReasoningEffort = normalizeReasoningEffort(
    value.defaultReasoningEffort,
  )
  const implicitReasoningDefault = normalizeOptionalBoolean(
    value.implicitReasoningDefault,
  )
  const exposeVirtualReasoningModels = normalizeOptionalBoolean(
    value.exposeVirtualReasoningModels,
  )
  const supportsAssistantPrefill = normalizeOptionalBoolean(
    value.supportsAssistantPrefill,
  )
  const unsupportedRequestParameters = normalizeUnsupportedRequestParameters(
    value.unsupportedRequestParameters,
  )

  const normalized: ModelSettings = { model: value.model.trim() }

  if (sentryModelName) {
    normalized.sentryModelName = sentryModelName
  }
  if (supportedReasoningEfforts && supportedReasoningEfforts.length > 0) {
    normalized.supportedReasoningEfforts = supportedReasoningEfforts
  }
  if (defaultReasoningEffort) {
    normalized.defaultReasoningEffort = defaultReasoningEffort
  }
  applyNormalizedBoolean(
    normalized,
    "implicitReasoningDefault",
    implicitReasoningDefault,
  )
  applyNormalizedBoolean(
    normalized,
    "exposeVirtualReasoningModels",
    exposeVirtualReasoningModels,
  )
  applyNormalizedBoolean(
    normalized,
    "supportsAssistantPrefill",
    supportsAssistantPrefill,
  )
  if (unsupportedRequestParameters && unsupportedRequestParameters.length > 0) {
    normalized.unsupportedRequestParameters = unsupportedRequestParameters
  }

  return hasCustomModelSettings(normalized) ? normalized : undefined
}

function normalizeSettings(raw: unknown): Record<string, ModelSettings> {
  const items = getSettingsItems(raw)
  const normalized: Record<string, ModelSettings> = {}

  for (const item of items) {
    const settings = normalizeModelSettings(item)
    if (settings) normalized[settings.model] = settings
  }

  return normalized
}

function getSettingsItems(raw: unknown): Array<unknown> {
  if (Array.isArray(raw)) return raw
  if (!isSettingsRecord(raw)) return []

  return Object.entries(raw).map(([model, value]) => {
    if (!isSettingsRecord(value)) return value
    return { model, ...value }
  })
}

function hasCustomModelSettings(settings: ModelSettings): boolean {
  return (
    settings.sentryModelName !== undefined
    || settings.supportedReasoningEfforts !== undefined
    || settings.defaultReasoningEffort !== undefined
    || settings.implicitReasoningDefault !== undefined
    || settings.exposeVirtualReasoningModels !== undefined
    || settings.supportsAssistantPrefill !== undefined
    || settings.unsupportedRequestParameters !== undefined
  )
}

function validSettingArray(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every((entry) => predicate(entry))
}

function validateStoredModelSettingFields(item: Record<string, unknown>): void {
  const fields: Record<string, (value: unknown) => boolean> = {
    sentryModelName: (value) => typeof value === "string",
    defaultReasoningEffort: isReasoningEffort,
    supportedReasoningEfforts: (value) =>
      validSettingArray(value, isReasoningEffort),
    unsupportedRequestParameters: (value) =>
      validSettingArray(value, isModelRequestParameter),
    implicitReasoningDefault: (value) => typeof value === "boolean",
    exposeVirtualReasoningModels: (value) => typeof value === "boolean",
    supportsAssistantPrefill: (value) => typeof value === "boolean",
  }
  for (const [key, validate] of Object.entries(fields)) {
    if (Object.hasOwn(item, key) && !validate(item[key]))
      throw new StorageSchemaError("Invalid model setting field")
  }
}

export function validateStoredModelSettings(
  value: unknown,
): Record<string, ModelSettings> {
  if (value === undefined) return {}
  if (!Array.isArray(value) && !isSettingsRecord(value))
    throw new StorageSchemaError("Invalid model settings")
  for (const item of getSettingsItems(value)) {
    if (
      !isSettingsRecord(item)
      || typeof item.model !== "string"
      || !item.model.trim()
    )
      throw new StorageSchemaError("Invalid model setting entry")
    validateStoredModelSettingFields(item)
  }
  return normalizeSettings(value)
}

function currentSettings(): Record<string, ModelSettings> {
  return structuredClone(
    testSettings
      ?? validateStoredModelSettings(getLoadedSetting("model_settings")),
  )
}

async function mutateSettings<T>(
  update: (settings: Record<string, ModelSettings>) => T,
): Promise<T> {
  if (testSettings) {
    const next = structuredClone(testSettings)
    const result = update(next)
    testSettings = next
    return structuredClone(result)
  }
  let result: T | undefined
  await updateSetting("model_settings", (current) => {
    const next = validateStoredModelSettings(current)
    result = update(next)
    return normalizeSettingsJson(Object.values(next))
  })
  return structuredClone(result as T)
}

export async function loadModelSettings(): Promise<void> {
  validateStoredModelSettings(await readSetting("model_settings"))
  testSettings = undefined
}

export async function ensureModelSettingsLoaded(): Promise<void> {
  await Promise.resolve(currentSettings())
}

export function getModelSettings(model: string): ModelSettings | undefined {
  return currentSettings()[model]
}

export async function getAllModelSettings(): Promise<Array<ModelSettings>> {
  return await Promise.resolve(
    Object.values(currentSettings()).sort((a, b) =>
      a.model.localeCompare(b.model),
    ),
  )
}

export async function setModelSettings(
  model: string,
  updates: ModelSettingsUpdate,
): Promise<ModelSettings> {
  return mutateSettings((modelSettings) => {
    const trimmedModel = model.trim()
    const current: ModelSettings = modelSettings[trimmedModel] ?? {
      model: trimmedModel,
    }
    const next: ModelSettings = { ...current }

    if (updates.sentryModelName !== undefined) {
      const sentryModelName = updates.sentryModelName?.trim()
      if (sentryModelName) {
        next.sentryModelName = sentryModelName
      } else {
        delete next.sentryModelName
      }
    }

    if (updates.supportedReasoningEfforts !== undefined) {
      const supportedReasoningEfforts = normalizeSupportedReasoningEfforts(
        updates.supportedReasoningEfforts,
      )
      if (supportedReasoningEfforts && supportedReasoningEfforts.length > 0) {
        next.supportedReasoningEfforts = supportedReasoningEfforts
      } else {
        delete next.supportedReasoningEfforts
      }
    }

    if (updates.defaultReasoningEffort !== undefined) {
      const defaultReasoningEffort = normalizeReasoningEffort(
        updates.defaultReasoningEffort,
      )
      if (defaultReasoningEffort) {
        next.defaultReasoningEffort = defaultReasoningEffort
      } else {
        delete next.defaultReasoningEffort
      }
    }

    applyBooleanModelSettingUpdate(
      next,
      "implicitReasoningDefault",
      updates.implicitReasoningDefault,
    )
    applyBooleanModelSettingUpdate(
      next,
      "exposeVirtualReasoningModels",
      updates.exposeVirtualReasoningModels,
    )
    applyBooleanModelSettingUpdate(
      next,
      "supportsAssistantPrefill",
      updates.supportsAssistantPrefill,
    )

    applyUnsupportedRequestParametersUpdate(
      next,
      updates.unsupportedRequestParameters,
    )

    if (!hasCustomModelSettings(next)) {
      Reflect.deleteProperty(modelSettings, trimmedModel)
      return { model: trimmedModel }
    }

    modelSettings[trimmedModel] = next
    return { ...next }
  })
}

export async function removeModelSettings(model: string): Promise<boolean> {
  return mutateSettings((modelSettings) => {
    if (!Object.hasOwn(modelSettings, model)) return false
    Reflect.deleteProperty(modelSettings, model)
    return true
  })
}

export function setModelSettingsForTest(settings: Array<unknown>): void {
  testSettings = normalizeSettings(settings)
}

function applyUnsupportedRequestParametersUpdate(
  settings: ModelSettings,
  value: ModelSettingsUpdate["unsupportedRequestParameters"] | undefined,
): void {
  if (value === undefined) return

  const unsupportedRequestParameters =
    normalizeUnsupportedRequestParameters(value)
  if (unsupportedRequestParameters && unsupportedRequestParameters.length > 0) {
    settings.unsupportedRequestParameters = unsupportedRequestParameters
  } else {
    delete settings.unsupportedRequestParameters
  }
}

function applyBooleanModelSettingUpdate(
  settings: ModelSettings,
  key: BooleanModelSetting,
  value: boolean | null | undefined,
): void {
  if (value === undefined) return

  if (typeof value === "boolean") {
    settings[key] = value
  } else {
    DELETE_BOOLEAN_MODEL_SETTING[key](settings)
  }
}

export function getUnsupportedRequestParameters(
  model: string,
): Array<ModelRequestParameter> {
  return [
    ...new Set([
      ...(DEFAULT_UNSUPPORTED_REQUEST_PARAMETERS[model] ?? []),
      ...(getModelSettings(model)?.unsupportedRequestParameters ?? []),
    ]),
  ]
}

export function modelSupportsAssistantPrefill(model: string): boolean {
  const configured = getModelSettings(model)?.supportsAssistantPrefill
  if (configured !== undefined) return configured

  return !DEFAULT_UNSUPPORTED_ASSISTANT_PREFILL_MODELS.has(model)
}
