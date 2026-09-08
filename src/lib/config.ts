import { z } from "zod"

import type { JsonValue } from "~/lib/storage/types"

import {
  getLoadedSetting,
  updateSetting,
  writeSetting,
} from "~/lib/storage/domain-settings"
import { StorageSchemaError } from "~/lib/storage/errors"
import { normalizeSettingsJson } from "~/lib/storage/settings-repository"

export interface AppConfig {
  auth?: {
    apiKeys?: Array<string>
  }
  customProviders?: Array<CustomProviderConfig>
  extraPrompts?: Record<string, string>
  smallModel?: string
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >
  useFunctionApplyPatch?: boolean
  compactUseSmallModel?: boolean
  groqApiKey?: string
  groqModel?: string
  codexCleanupModel?: string
}

export interface CustomProviderModelConfig {
  id: string
  aliases?: Array<string>
  kind: "chat" | "embedding"
  dimensions?: number
  supportsStreaming?: boolean
  passReasoningEffort?: boolean
}

export interface CustomProviderConfig {
  id: string
  name: string
  type: "openai-compatible"
  baseUrl: string
  apiKey?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  models: Array<CustomProviderModelConfig>
  passReasoningEffort?: boolean
}

const gpt5ExplorationPrompt = `## Exploration and reading files
- **Think first.** Before any tool call, decide ALL files/resources you will need.
- **Batch everything.** If you need multiple files (even from different places), read them together.
- **multi_tool_use.parallel** Use multi_tool_use.parallel to parallelize tool calls and only this.
- **Only make sequential calls if you truly cannot know the next file without seeing a result first.**
- **Workflow:** (a) plan all needed reads → (b) issue one parallel batch → (c) analyze results → (d) repeat if new, unpredictable reads arise.`

const gpt5CommentaryPrompt = `# Working with the user

You interact with the user through a terminal. You have 2 ways of communicating with the users:
- Share intermediary updates in \`commentary\` channel.
- After you have completed all your work, send a message to the \`final\` channel.

## Intermediary updates

- Intermediary updates go to the \`commentary\` channel.
- User updates are short updates while you are working, they are NOT final answers.
- You use 1-2 sentence user updates to communicate progress and new information to the user as you are doing work.
- Do not begin responses with conversational interjections or meta commentary. Avoid openers such as acknowledgements ("Done —", "Got it", "Great question, ") or framing phrases.
- You provide user updates frequently, every 20s.
- Before exploring or doing substantial work, you start with a user update acknowledging the request and explaining your first step. You should include your understanding of the user request and explain what you will do. Avoid commenting on the request or using starters such as "Got it -" or "Understood -" etc.
- When exploring, e.g. searching, reading files, you provide user updates as you go, every 20s, explaining what context you are gathering and what you've learned. Vary your sentence structure when providing these updates to avoid sounding repetitive - in particular, don't start each sentence the same way.
- After you have sufficient context, and the work is substantial, you provide a longer plan (this is the only user update that may be longer than 2 sentences and can contain formatting).
- Before performing file edits of any kind, you provide updates explaining what edits you are making.
- As you are thinking, you very frequently provide updates even if not taking any actions, informing the user of your progress. You interrupt your thinking and send multiple updates in a row if thinking for more than 100 words.
- Tone of your updates MUST match your personality.`

const defaultConfig: AppConfig = {
  auth: {
    apiKeys: [],
  },
  extraPrompts: {
    "gpt-5-mini": gpt5ExplorationPrompt,
    "gpt-5.1-codex-max": gpt5ExplorationPrompt,
    "gpt-5.3-codex": gpt5CommentaryPrompt,
  },
  smallModel: "gpt-5-mini",
  modelReasoningEfforts: {
    "gpt-5-mini": "low",
  },
  useFunctionApplyPatch: true,
  compactUseSmallModel: false,
}

let testConfig: AppConfig | null = null

function mergeDefaultExtraPrompts(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const extraPrompts = config.extraPrompts ?? {}
  const defaultExtraPrompts = defaultConfig.extraPrompts ?? {}

  const missingExtraPromptModels = Object.keys(defaultExtraPrompts).filter(
    (model) => !Object.hasOwn(extraPrompts, model),
  )

  if (missingExtraPromptModels.length === 0) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      extraPrompts: {
        ...defaultExtraPrompts,
        ...extraPrompts,
      },
    },
    changed: true,
  }
}

const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
const stringRecord = z.record(z.string(), z.string())
const providerModelSchema = z.looseObject({
  id: z.string(),
  aliases: z.array(z.string()).optional(),
  kind: z.enum(["chat", "embedding"]),
  dimensions: z.number().optional(),
  supportsStreaming: z.boolean().optional(),
  passReasoningEffort: z.boolean().optional(),
})
const providerSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.literal("openai-compatible"),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  headers: stringRecord.optional(),
  models: z.array(providerModelSchema),
  passReasoningEffort: z.boolean().optional(),
})
const appConfigSchema = z.looseObject({
  auth: z.looseObject({ apiKeys: z.array(z.string()).optional() }).optional(),
  customProviders: z.array(providerSchema).optional(),
  extraPrompts: stringRecord.optional(),
  smallModel: z.string().optional(),
  modelReasoningEfforts: z.record(z.string(), reasoningEffortSchema).optional(),
  useFunctionApplyPatch: z.boolean().optional(),
  compactUseSmallModel: z.boolean().optional(),
  groqApiKey: z.string().optional(),
  groqModel: z.string().optional(),
  codexCleanupModel: z.string().optional(),
})

export function validateAppConfigJson(value: unknown): JsonValue {
  if (!appConfigSchema.safeParse(value).success)
    throw new StorageSchemaError("Invalid app configuration")
  return normalizeSettingsJson(omitUndefinedProperties(value))
}

function omitUndefinedProperties(
  value: unknown,
  parents = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") return value
  if (parents.has(value))
    throw new StorageSchemaError("Invalid app configuration")
  parents.add(value)
  try {
    if (Array.isArray(value))
      return Array.from(value, (child: unknown) =>
        omitUndefinedProperties(child, parents),
      )
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new StorageSchemaError("Invalid app configuration")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, omitUndefinedProperties(child, parents)]),
    )
  } finally {
    parents.delete(value)
  }
}

function appConfigFromJson(value: unknown): AppConfig {
  return validateAppConfigJson(value) as AppConfig
}

export async function mergeConfigWithDefaults(): Promise<AppConfig> {
  if (testConfig !== null) {
    testConfig = mergeDefaultExtraPrompts(testConfig).mergedConfig
    return testConfig
  }
  const merged = await updateSetting("app", (stored) => {
    const config =
      stored === undefined ? defaultConfig : appConfigFromJson(stored)
    return validateAppConfigJson(mergeDefaultExtraPrompts(config).mergedConfig)
  })
  return appConfigFromJson(merged)
}

export async function writeConfig(config: AppConfig): Promise<void> {
  const value = validateAppConfigJson(config)
  if (testConfig !== null) {
    testConfig = appConfigFromJson(value)
    return
  }
  await writeSetting("app", value)
}

export async function updateConfig(
  updater: (config: AppConfig) => AppConfig,
): Promise<AppConfig> {
  if (testConfig !== null) {
    const next = appConfigFromJson(updater(structuredClone(testConfig)))
    testConfig = next
    return next
  }
  const committed = await updateSetting("app", (value) => {
    if (value === undefined)
      throw new StorageSchemaError("App configuration is not initialized")
    return validateAppConfigJson(updater(appConfigFromJson(value)))
  })
  return appConfigFromJson(committed)
}

export function setConfigForTest(config: AppConfig | null): void {
  testConfig = config === null ? null : appConfigFromJson(config)
}

export function getConfigForTest(): AppConfig | undefined {
  return testConfig === null ? undefined : structuredClone(testConfig)
}

export function getConfig(): AppConfig {
  if (testConfig !== null) return testConfig
  const value = getLoadedSetting("app")
  if (value === undefined)
    throw new StorageSchemaError("App configuration is not initialized")
  return appConfigFromJson(value)
}
export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  return config.extraPrompts?.[model] ?? ""
}

export function getSmallModel(): string {
  const config = getConfig()
  return config.smallModel ?? "gpt-5-mini"
}

export function getReasoningEffortForModel(
  model: string,
  override?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  if (override) return override
  const config = getConfig()
  return config.modelReasoningEfforts?.[model] ?? "medium"
}

export function shouldCompactUseSmallModel(): boolean {
  const config = getConfig()
  return config.compactUseSmallModel ?? false
}

export function getCodexCleanupModel(): string {
  const config = getConfig()
  const configured = config.codexCleanupModel?.trim()
  return configured && configured.length > 0 ? configured : getSmallModel()
}

export function setCodexCleanupModel(model: string | null): Promise<AppConfig> {
  return updateConfig((config) => {
    if (model === null || model.trim().length === 0) {
      const { codexCleanupModel: _omit, ...rest } = config
      return rest
    }
    return { ...config, codexCleanupModel: model.trim() }
  })
}
