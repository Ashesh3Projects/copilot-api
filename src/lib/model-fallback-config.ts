import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { z } from "zod"

import { PATHS } from "~/lib/paths"

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

let config = fallbackConfigSchema.parse({})
let loaded = false
let loading: Promise<void> | undefined
let updateQueue: Promise<void> = Promise.resolve()
let revision = 0
let memoryOnly = false

export function validateModelFallbackConfig(
  value: unknown,
): ModelFallbackConfig {
  return fallbackConfigSchema.parse(value)
}

export function getLoadedModelFallbackConfig(): ModelFallbackConfig {
  return structuredClone(config)
}

export function getModelFallbackConfigRevision(): number {
  return revision
}

async function loadConfig(): Promise<void> {
  try {
    const data = await fs.readFile(PATHS.MODEL_FALLBACKS_CONFIG_PATH)
    config = validateModelFallbackConfig(JSON.parse(data.toString()) as unknown)
  } catch (error) {
    if (
      !(error instanceof Error)
      || !("code" in error)
      || error.code !== "ENOENT"
    ) {
      // Invalid rules must never silently activate a partial fallback policy.
      consola.error("Failed to load model fallback configuration:", error)
    }
    config = fallbackConfigSchema.parse({})
  }
  loaded = true
  revision++
}

export async function getModelFallbackConfig(): Promise<ModelFallbackConfig> {
  if (!loaded) {
    loading ??= loadConfig().finally(() => {
      loading = undefined
    })
    await loading
  }
  return getLoadedModelFallbackConfig()
}

async function persistConfig(next: ModelFallbackConfig): Promise<void> {
  const temporaryPath = `${PATHS.MODEL_FALLBACKS_CONFIG_PATH}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(PATHS.APP_DIR, { recursive: true, mode: 0o700 })
    await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await fs.rename(temporaryPath, PATHS.MODEL_FALLBACKS_CONFIG_PATH)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

export async function setModelFallbackConfig(
  value: unknown,
): Promise<ModelFallbackConfig> {
  const next = validateModelFallbackConfig(value)
  const update = updateQueue.then(async () => {
    await getModelFallbackConfig()
    if (!memoryOnly) await persistConfig(next)
    config = next
    revision++
  })
  updateQueue = update.catch(() => undefined)
  await update
  return structuredClone(next)
}

export function setModelFallbackConfigForTest(
  value: ModelFallbackConfig | null,
): void {
  config = validateModelFallbackConfig(value ?? {})
  loaded = value !== null
  memoryOnly = value !== null
  loading = undefined
  revision++
}
