import { z } from "zod"

import {
  getLoadedSetting,
  getLoadedSettingRevision,
  getLiveSettingRevision,
  readSetting,
  writeSetting,
} from "~/lib/storage/domain-settings"
import { getRequestSnapshot } from "~/lib/storage/request-snapshot"
import { peekStorageRuntime } from "~/lib/storage/runtime"

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^[\x21-\x7E]+$/,
    "Model IDs must contain printable ASCII without spaces",
  )
const fallbackRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    sourceModel: modelId,
    targetModel: modelId,
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((rule) => rule.sourceModel !== rule.targetModel, {
    message: "Fallback source and target models must differ",
  })

const fallbackConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    conversationAffinity: z.boolean().default(true),
    notifyClient: z.boolean().default(false),
    nativeClientNotice: z.boolean().default(false),
    affinityTtlSeconds: z.number().int().min(60).max(604800).default(86400),
    affinityMaxEntries: z.number().int().min(1).max(100000).default(10000),
    rules: z.array(fallbackRuleSchema).max(1000).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>()
    const sources = new Set<string>()
    for (const rule of config.rules) {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate fallback rule ID",
        })
      }
      if (rule.enabled && sources.has(rule.sourceModel)) {
        context.addIssue({
          code: "custom",
          message: "Only one enabled fallback is allowed per source model",
        })
      }
      ids.add(rule.id)
      if (rule.enabled) sources.add(rule.sourceModel)
    }
  })

export type ModelFallbackConfig = z.infer<typeof fallbackConfigSchema>
export type ModelFallbackRule = ModelFallbackConfig["rules"][number]

let testConfig: ModelFallbackConfig | undefined
let testRevision = 0

export function getModelFallbackConfigForRoutingSafety(): ModelFallbackConfig {
  return testConfig || peekStorageRuntime() ?
      getLoadedModelFallbackConfig()
    : validateModelFallbackConfig({})
}

export function validateModelFallbackConfig(
  value: unknown,
): ModelFallbackConfig {
  return fallbackConfigSchema.parse(value)
}

export function getLoadedModelFallbackConfig(): ModelFallbackConfig {
  const value = testConfig ?? getLoadedSetting("model_fallbacks")
  return structuredClone(
    validateModelFallbackConfig(value === undefined ? {} : value),
  )
}

export function getModelFallbackConfigRevision(): number {
  return testConfig ? testRevision : getLiveSettingRevision("model_fallbacks")
}

export function getCapturedModelFallbackConfigRevision(): number {
  return testConfig ? testRevision : getLoadedSettingRevision("model_fallbacks")
}

export async function getModelFallbackConfig(): Promise<ModelFallbackConfig> {
  if (testConfig || getRequestSnapshot()) return getLoadedModelFallbackConfig()
  const value = await readSetting("model_fallbacks")
  return validateModelFallbackConfig(value === undefined ? {} : value)
}

export async function setModelFallbackConfig(
  value: unknown,
): Promise<ModelFallbackConfig> {
  const next = validateModelFallbackConfig(value)
  if (testConfig) {
    testConfig = next
    testRevision++
  } else {
    await writeSetting("model_fallbacks", next)
  }
  return structuredClone(next)
}

export function setModelFallbackConfigForTest(
  value: ModelFallbackConfig | null,
): void {
  testConfig = value === null ? undefined : validateModelFallbackConfig(value)
  testRevision++
}
