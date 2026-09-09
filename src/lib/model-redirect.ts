import consola from "consola"

import type { ReasoningEffort } from "~/lib/model-suffix"

import { resolveModelRedirectRules } from "~/lib/model-redirect-resolver"
import { getModelRoutingSafety } from "~/lib/model-routing-safety"
import {
  getLoadedSetting,
  getLoadedSettingRevision,
  getLiveSettingRevision,
  readSetting,
  updateSetting,
} from "~/lib/storage/domain-settings"
import { StorageSchemaError } from "~/lib/storage/errors"
import { peekStorageRuntime } from "~/lib/storage/runtime"
import { normalizeSettingsJson } from "~/lib/storage/settings-repository"

export type ModelRedirectEffortFilter = "all" | "default" | ReasoningEffort
export type ModelRedirectVerbosity = "low" | "medium" | "high"

export const MODEL_REDIRECT_EFFORT_FILTERS: Array<ModelRedirectEffortFilter> = [
  "all",
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

const REDIRECT_EFFORT_CASES = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

type RedirectEffortCase = (typeof REDIRECT_EFFORT_CASES)[number]

export interface ModelRedirectRule {
  id: string
  name?: string
  sourceModel: string
  sourceEffort: ModelRedirectEffortFilter
  targetModel: string
  targetEffort?: ReasoningEffort
  targetVerbosity?: ModelRedirectVerbosity
  enabled: boolean
}

export interface ModelRedirectConflict {
  id: string
  name?: string
}

export interface ModelRedirectRuleWithConflicts extends ModelRedirectRule {
  conflicts: Array<ModelRedirectConflict>
}

let testRedirects: Array<ModelRedirectRule> | undefined
let testRevision = 0

export function getModelRedirectRevision(live = false): number {
  if (testRedirects) return testRevision
  if (!peekStorageRuntime()) return 0
  return live ?
      getLiveSettingRevision("model_redirects")
    : getLoadedSettingRevision("model_redirects")
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
  )
}

function normalizeSourceEffort(value: unknown): ModelRedirectEffortFilter {
  if (value === "all" || value === "default") return value
  if (isReasoningEffort(value)) return value
  return "all"
}

function normalizeTargetEffort(value: unknown): ReasoningEffort | undefined {
  return isReasoningEffort(value) ? value : undefined
}

function normalizeTargetVerbosity(
  value: unknown,
): ModelRedirectVerbosity | undefined {
  return value === "low" || value === "medium" || value === "high" ?
      value
    : undefined
}

function normalizeRule(raw: unknown): ModelRedirectRule | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined
  }

  const value = raw as Record<string, unknown>
  if (
    typeof value.id !== "string"
    || typeof value.sourceModel !== "string"
    || typeof value.targetModel !== "string"
  ) {
    return undefined
  }

  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : undefined,
    sourceModel: value.sourceModel,
    sourceEffort: normalizeSourceEffort(value.sourceEffort),
    targetModel: value.targetModel,
    targetEffort: normalizeTargetEffort(value.targetEffort),
    targetVerbosity: normalizeTargetVerbosity(value.targetVerbosity),
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
  }
}

function normalizeRules(raw: unknown): Array<ModelRedirectRule> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const rule = normalizeRule(item)
    return rule ? [rule] : []
  })
}

function effortCases(
  filter: ModelRedirectEffortFilter,
): Array<RedirectEffortCase> {
  if (filter === "all") return [...REDIRECT_EFFORT_CASES]
  return [filter as RedirectEffortCase]
}

function getShadowingRules(
  rule: ModelRedirectRule,
  priorRules: Array<ModelRedirectRule>,
): Array<ModelRedirectRule> {
  if (!rule.enabled) return []

  const remaining = new Set(effortCases(rule.sourceEffort))
  const shadowingRules: Array<ModelRedirectRule> = []

  for (const candidate of priorRules) {
    if (!candidate.enabled || candidate.sourceModel !== rule.sourceModel) {
      continue
    }

    let coversAnyRemainingCase = false
    for (const effort of effortCases(candidate.sourceEffort)) {
      if (!remaining.has(effort)) continue
      remaining.delete(effort)
      coversAnyRemainingCase = true
    }

    if (coversAnyRemainingCase) shadowingRules.push(candidate)
    if (remaining.size === 0) return shadowingRules
  }

  return []
}

function withConflicts(
  rules: Array<ModelRedirectRule>,
): Array<ModelRedirectRuleWithConflicts> {
  return rules.map((rule, index) => {
    const shadowingRules = getShadowingRules(rule, rules.slice(0, index))
    return {
      ...rule,
      conflicts: shadowingRules.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
      })),
    }
  })
}

export function validateStoredModelRedirects(
  value: unknown,
): Array<ModelRedirectRule> {
  if (value === undefined) return []
  if (!Array.isArray(value))
    throw new StorageSchemaError("Invalid model redirect rules")
  return value.map((item) => {
    const rule = normalizeRule(item)
    if (!rule) throw new StorageSchemaError("Invalid model redirect rule")
    const raw = item as Record<string, unknown>
    const fields: Record<string, (field: unknown) => boolean> = {
      name: (field) => typeof field === "string",
      enabled: (field) => typeof field === "boolean",
      sourceEffort: (field) =>
        field === "all" || field === "default" || isReasoningEffort(field),
      targetEffort: isReasoningEffort,
      targetVerbosity: (field) => normalizeTargetVerbosity(field) !== undefined,
    }
    for (const [key, validate] of Object.entries(fields)) {
      if (Object.hasOwn(raw, key) && !validate(raw[key]))
        throw new StorageSchemaError("Invalid model redirect field")
    }
    return rule
  })
}

export function getLoadedModelRedirects(): Array<ModelRedirectRule> {
  return structuredClone(
    testRedirects
      ?? validateStoredModelRedirects(getLoadedSetting("model_redirects")),
  )
}

function redirectJson(rules: Array<ModelRedirectRule>) {
  return normalizeSettingsJson(
    rules.map((rule) =>
      Object.fromEntries(
        Object.entries(rule).filter(([, value]) => value !== undefined),
      ),
    ),
  )
}

async function mutateRedirects<T>(
  update: (rules: Array<ModelRedirectRule>) => T,
): Promise<T> {
  if (testRedirects) {
    const next = structuredClone(testRedirects)
    const result = update(next)
    testRedirects = next
    testRevision++
    return structuredClone(result)
  }
  let result: T | undefined
  await updateSetting("model_redirects", (current) => {
    const next = validateStoredModelRedirects(current)
    result = update(next)
    return redirectJson(next)
  })
  return structuredClone(result as T)
}

export async function loadModelRedirects(): Promise<void> {
  validateStoredModelRedirects(await readSetting("model_redirects"))
  testRedirects = undefined
}

export async function saveModelRedirects(): Promise<void> {
  if (testRedirects) return
  await updateSetting("model_redirects", (current) =>
    redirectJson(validateStoredModelRedirects(current)),
  )
}

export async function ensureLoaded(): Promise<void> {
  await Promise.resolve(getLoadedModelRedirects())
}

export async function getAllModelRedirects(): Promise<
  Array<ModelRedirectRuleWithConflicts>
> {
  return await Promise.resolve(withConflicts(getLoadedModelRedirects()))
}

export async function addModelRedirect(
  sourceModel: string,
  targetModel: string,
  options?: {
    name?: string
    sourceEffort?: ModelRedirectEffortFilter | "max"
    targetEffort?: ReasoningEffort | "max"
    targetVerbosity?: ModelRedirectVerbosity
  },
): Promise<ModelRedirectRule> {
  const rule: ModelRedirectRule = {
    id: `redirect-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: options?.name,
    sourceModel,
    sourceEffort: normalizeSourceEffort(options?.sourceEffort),
    targetModel,
    targetEffort: normalizeTargetEffort(options?.targetEffort),
    targetVerbosity: normalizeTargetVerbosity(options?.targetVerbosity),
    enabled: true,
  }
  await mutateRedirects((redirects) => {
    redirects.push(rule)
  })
  consola.info(`Added model redirect: "${sourceModel}" -> "${targetModel}"`)
  return { ...rule }
}

export async function removeModelRedirect(id: string): Promise<boolean> {
  return mutateRedirects((redirects) => {
    const before = redirects.length
    const next = redirects.filter((r) => r.id !== id)
    redirects.splice(0, redirects.length, ...next)
    if (redirects.length === before) return false
    consola.info(`Removed model redirect: ${id}`)
    return true
  })
}

export async function updateModelRedirect(
  id: string,
  updates: {
    name?: string
    sourceModel?: string
    sourceEffort?: ModelRedirectEffortFilter | "max"
    targetModel?: string
    targetEffort?: ReasoningEffort | "max" | null
    targetVerbosity?: ModelRedirectVerbosity | null
    enabled?: boolean
  },
): Promise<ModelRedirectRule | null> {
  return mutateRedirects((redirects) => {
    const rule = redirects.find((r) => r.id === id)
    if (!rule) return null

    if (updates.name !== undefined) rule.name = updates.name
    if (updates.sourceModel !== undefined)
      rule.sourceModel = updates.sourceModel
    if (updates.sourceEffort !== undefined) {
      rule.sourceEffort = normalizeSourceEffort(updates.sourceEffort)
    }
    if (updates.targetModel !== undefined)
      rule.targetModel = updates.targetModel
    if (updates.targetEffort !== undefined) {
      rule.targetEffort = normalizeTargetEffort(updates.targetEffort)
    }
    if (updates.targetVerbosity !== undefined) {
      rule.targetVerbosity = normalizeTargetVerbosity(updates.targetVerbosity)
    }
    if (updates.enabled !== undefined) rule.enabled = updates.enabled

    consola.info(`Updated model redirect: ${rule.name || rule.id}`)
    return { ...rule }
  })
}

export async function toggleModelRedirect(
  id: string,
): Promise<ModelRedirectRule | null> {
  return mutateRedirects((redirects) => {
    const rule = redirects.find((r) => r.id === id)
    if (!rule) return null
    rule.enabled = !rule.enabled
    return { ...rule }
  })
}

export async function moveModelRedirect(
  id: string,
  direction: "up" | "down",
): Promise<ModelRedirectRule | null> {
  return mutateRedirects((redirects) => {
    const index = redirects.findIndex((r) => r.id === id)
    if (index === -1) return null
    const current = redirects[index]

    const nextIndex = direction === "up" ? index - 1 : index + 1
    if (nextIndex < 0 || nextIndex >= redirects.length) {
      return { ...current }
    }

    const next = redirects[nextIndex]
    redirects[index] = next
    redirects[nextIndex] = current
    return { ...current }
  })
}

export async function clearModelRedirects(): Promise<void> {
  await mutateRedirects((redirects) => {
    redirects.splice(0)
  })
}

export interface ModelRedirectResult {
  model: string
  effort?: ReasoningEffort
  verbosity?: ModelRedirectVerbosity
  redirected: boolean
  originalModel?: string
  originalEffort?: ReasoningEffort
  originalVerbosity?: ModelRedirectVerbosity
  ruleId?: string
  ruleIds?: Array<string>
  redirectChain?: Array<ModelRedirectStep>
}

export interface ModelRedirectRequest {
  model: string
  effort?: ReasoningEffort
  verbosity?: ModelRedirectVerbosity
  modelOnly?: boolean
}

export interface ModelRedirectStep {
  ruleId: string
  ruleName?: string
  sourceModel: string
  sourceEffort?: ReasoningEffort
  targetModel: string
  targetEffort?: ReasoningEffort
  sourceVerbosity?: ModelRedirectVerbosity
  targetVerbosity?: ModelRedirectVerbosity
}

function formatModelWithEffort(
  model: string,
  effort: ReasoningEffort | undefined,
): string {
  return effort ? `${model}:${effort}` : model
}

function formatModelRedirectState(options: {
  effort?: ReasoningEffort
  model: string
  verbosity?: ModelRedirectVerbosity
}): string {
  const modelWithEffort = formatModelWithEffort(options.model, options.effort)
  return options.verbosity ?
      `${modelWithEffort} [verbosity=${options.verbosity}]`
    : modelWithEffort
}

export function formatModelRedirectResult(
  redirect: ModelRedirectResult,
): string {
  const chain = redirect.redirectChain
  if (!chain || chain.length === 0) {
    return formatModelRedirectState(redirect)
  }

  return [
    formatModelRedirectState({
      model: chain[0].sourceModel,
      effort: chain[0].sourceEffort,
      verbosity: chain[0].sourceVerbosity,
    }),
    ...chain.map((step) =>
      formatModelRedirectState({
        model: step.targetModel,
        effort: step.targetEffort,
        verbosity: step.targetVerbosity,
      }),
    ),
  ].join(" -> ")
}

/**
 * Apply exact-match model redirect rules. Returns the (possibly redirected)
 * model along with metadata describing whether a redirect occurred.
 *
 * Synchronous-by-design: callers in hot request paths should ensureLoaded()
 * up-front (we do that lazily on first call by triggering load if needed).
 */
export async function applyModelRedirect(
  input: string | ModelRedirectRequest,
): Promise<ModelRedirectResult> {
  await ensureLoaded()
  const request = typeof input === "string" ? { model: input } : input
  if (!getModelRoutingSafety().safe) {
    return {
      model: request.model,
      effort: request.effort,
      verbosity: request.verbosity,
      redirected: false,
    }
  }
  const result = resolveModelRedirectRules(getLoadedModelRedirects(), request)
  if (result.loop)
    return {
      model: request.model,
      effort: request.effort,
      verbosity: request.verbosity,
      redirected: false,
    }
  if (result.redirected)
    consola.debug(
      `Model redirect chain: ${formatModelRedirectResult(result)} (rules: ${result.ruleIds?.join(", ")})`,
    )
  return result
}

export function setModelRedirectsForTest(rules: Array<unknown>): void {
  testRedirects = normalizeRules(rules)
  testRevision++
}
