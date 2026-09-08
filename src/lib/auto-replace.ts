import consola from "consola"
import { RE2JS } from "re2js"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import {
  getLoadedSetting,
  readSetting,
  updateSetting,
} from "~/lib/storage/domain-settings"
import { StorageSchemaError } from "~/lib/storage/errors"
import { normalizeSettingsJson } from "~/lib/storage/settings-repository"

export interface ReplacementRule {
  id: string
  name?: string // Human-readable name/description
  pattern: string
  replacement: string
  isRegex: boolean
  enabled: boolean
  isSystem?: boolean // System rules cannot be deleted by user
}

export class ReplacementValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReplacementValidationError"
  }
}

function validateRuleFields(
  pattern: string,
  options: { isRegex: boolean },
): void {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new ReplacementValidationError("Pattern is required")
  }
  if (options.isRegex) {
    try {
      RE2JS.compile(pattern)
    } catch {
      throw new ReplacementValidationError(
        "Pattern is not valid RE2-compatible syntax",
      )
    }
  }
}

function normalizeStoredRule(value: unknown): ReplacementRule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (
    typeof raw.id !== "string"
    || typeof raw.pattern !== "string"
    || typeof raw.replacement !== "string"
    || typeof raw.isRegex !== "boolean"
    || typeof raw.enabled !== "boolean"
  ) {
    return null
  }
  const name = typeof raw.name === "string" ? raw.name : undefined
  try {
    validateRuleFields(raw.pattern, { isRegex: raw.isRegex })
  } catch {
    return null
  }
  return {
    id: raw.id,
    pattern: raw.pattern,
    replacement: raw.replacement,
    isRegex: raw.isRegex,
    enabled: raw.enabled,
    ...(name ? { name } : {}),
    isSystem: false,
  }
}

// Built-in system replacement that cannot be removed
const SYSTEM_REPLACEMENTS: Array<ReplacementRule> = [
  {
    id: "system-anthropic-billing",
    name: "Remove Anthropic billing header",
    pattern: String.raw`x-anthropic-billing-header:[^\n]*\n?`,
    replacement: "",
    isRegex: true,
    enabled: true,
    isSystem: true,
  },
]

let testReplacements: Array<ReplacementRule> | undefined

export function validateStoredReplacements(
  value: unknown,
): Array<ReplacementRule> {
  if (value === undefined) return []
  if (!Array.isArray(value))
    throw new StorageSchemaError("Invalid replacement rules")
  return value.map((item) => {
    const rule = normalizeStoredRule(item)
    if (!rule) throw new StorageSchemaError("Invalid replacement rule")
    return rule
  })
}

function currentReplacements(): Array<ReplacementRule> {
  return structuredClone(
    testReplacements
      ?? validateStoredReplacements(getLoadedSetting("replacements")),
  )
}

async function mutateReplacements<T>(
  update: (rules: Array<ReplacementRule>) => T,
): Promise<T> {
  if (testReplacements) {
    const next = structuredClone(testReplacements)
    const result = update(next)
    testReplacements = next
    return structuredClone(result)
  }
  let result: T | undefined
  await updateSetting("replacements", (current) => {
    const next = validateStoredReplacements(current)
    result = update(next)
    return normalizeSettingsJson(next)
  })
  return structuredClone(result as T)
}

export async function loadReplacements(): Promise<void> {
  validateStoredReplacements(await readSetting("replacements"))
  testReplacements = undefined
}

export async function saveReplacements(): Promise<void> {
  if (testReplacements) return
  await updateSetting("replacements", (current) =>
    normalizeSettingsJson(validateStoredReplacements(current)),
  )
}

export async function ensureLoaded(): Promise<void> {
  await Promise.resolve(currentReplacements())
}

export async function getAllReplacements(): Promise<Array<ReplacementRule>> {
  return await Promise.resolve([
    ...structuredClone(SYSTEM_REPLACEMENTS),
    ...currentReplacements(),
  ])
}

export async function getUserReplacements(): Promise<Array<ReplacementRule>> {
  return await Promise.resolve(currentReplacements())
}

export async function addReplacement(
  pattern: string,
  replacement: string,
  options?: { isRegex?: boolean; name?: string },
): Promise<ReplacementRule> {
  const { isRegex = false, name } = options ?? {}
  validateRuleFields(pattern, { isRegex })
  const rule: ReplacementRule = {
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    ...(name !== undefined ? { name } : {}),
    pattern,
    replacement,
    isRegex,
    enabled: true,
    isSystem: false,
  }
  return mutateReplacements((rules) => {
    rules.push(rule)
    return rule
  })
}

export async function removeReplacement(id: string): Promise<boolean> {
  return mutateReplacements((rules) => {
    const index = rules.findIndex((rule) => rule.id === id && !rule.isSystem)
    if (index === -1) return false
    rules.splice(index, 1)
    return true
  })
}

export async function updateReplacement(
  id: string,
  updates: {
    name?: string
    pattern?: string
    replacement?: string
    isRegex?: boolean
    enabled?: boolean
  },
): Promise<ReplacementRule | null> {
  return mutateReplacements((rules) => {
    const rule = rules.find(
      (candidate) => candidate.id === id && !candidate.isSystem,
    )
    if (!rule) return null
    validateRuleFields(updates.pattern ?? rule.pattern, {
      isRegex: updates.isRegex ?? rule.isRegex,
    })
    if (updates.name !== undefined) rule.name = updates.name
    if (updates.pattern !== undefined) rule.pattern = updates.pattern
    if (updates.replacement !== undefined)
      rule.replacement = updates.replacement
    if (updates.isRegex !== undefined) rule.isRegex = updates.isRegex
    if (updates.enabled !== undefined) rule.enabled = updates.enabled
    return rule
  })
}

export async function toggleReplacement(
  id: string,
): Promise<ReplacementRule | null> {
  return mutateReplacements((rules) => {
    const rule = rules.find(
      (candidate) => candidate.id === id && !candidate.isSystem,
    )
    if (!rule) return null
    rule.enabled = !rule.enabled
    return rule
  })
}

export async function clearUserReplacements(): Promise<void> {
  await mutateReplacements((rules) => {
    rules.splice(0)
  })
}

/**
 * Apply a single replacement rule to text and return info about whether it matched
 */
function applyRule(
  text: string,
  rule: ReplacementRule,
): { result: string; matched: boolean } {
  if (!rule.enabled) return { result: text, matched: false }

  if (rule.isRegex) {
    try {
      const regex = RE2JS.compile(rule.pattern)
      const matcher = regex.matcher(text)
      const chunks: Array<string> = []
      let cursor = 0
      let matched = false

      while (matcher.find()) {
        matched = true
        const start = matcher.start()
        const end = matcher.end()
        const prefix = text.slice(cursor, start)
        const replacement = expandReplacement(rule.replacement, {
          matcher,
          input: text,
          span: { start, end },
        })
        chunks.push(prefix, replacement)
        cursor = end
      }

      if (!matched) return { result: text, matched: false }
      const suffix = text.slice(cursor)
      chunks.push(suffix)
      return { result: chunks.join(""), matched: true }
    } catch {
      consola.warn(`Invalid regex pattern in rule ${rule.id}: ${rule.pattern}`)
      return { result: text, matched: false }
    }
  }

  if (!text.includes(rule.pattern)) return { result: text, matched: false }
  return {
    result: text.replaceAll(rule.pattern, rule.replacement),
    matched: true,
  }
}

interface ReplacementMatcher {
  group(group?: string | number): string | null
  groupCount(): number
  getNamedGroups(): Record<string, string | null>
}

interface ReplacementExpansion {
  input: string
  matcher: ReplacementMatcher
  span: { start: number; end: number }
}

function expandReplacement(
  template: string,
  { matcher, input, span }: ReplacementExpansion,
): string {
  const namedGroups = matcher.getNamedGroups()
  return template.replaceAll(
    /\$([$&`']|<[^>]+>|\d{1,2})/g,
    (token, reference: string) => {
      if (reference === "$") return "$"
      if (reference === "&") return matcher.group() ?? ""
      if (reference === "`") return input.slice(0, span.start)
      if (reference === "'") return input.slice(span.end)
      if (reference.startsWith("<")) {
        return namedGroups[reference.slice(1, -1)] ?? token
      }
      const group = Number(reference)
      if (group < 1 || group > matcher.groupCount()) return token
      return matcher.group(group) ?? ""
    },
  )
}

export interface ReplacementResult {
  text: string
  appliedRules: Array<string>
}

/**
 * Apply all replacement rules to text
 */
export async function applyReplacements(
  text: string,
): Promise<ReplacementResult> {
  let result = text
  const allRules = await getAllReplacements()
  const appliedRules: Array<string> = []

  for (const rule of allRules) {
    const { result: newResult, matched } = applyRule(result, rule)
    if (matched) {
      result = newResult
      appliedRules.push(rule.name || rule.id)
    }
  }

  return { text: result, appliedRules }
}

export interface PayloadReplacementResult {
  payload: ChatCompletionsPayload
  appliedRules: Array<string>
}

/**
 * Apply replacements to a chat completions payload
 * This modifies message content in place
 */
export async function applyReplacementsToPayload(
  payload: ChatCompletionsPayload,
): Promise<PayloadReplacementResult> {
  const allAppliedRules: Array<string> = []

  const processedMessages = await Promise.all(
    payload.messages.map(async (message) => {
      if (typeof message.content === "string") {
        const { text, appliedRules } = await applyReplacements(message.content)
        allAppliedRules.push(...appliedRules)
        return { ...message, content: text }
      }

      // Handle array content (multimodal)
      if (Array.isArray(message.content)) {
        return {
          ...message,
          content: await Promise.all(
            message.content.map(async (part) => {
              if (
                typeof part === "object"
                && part.type === "text"
                && part.text
              ) {
                const { text, appliedRules } = await applyReplacements(
                  part.text,
                )
                allAppliedRules.push(...appliedRules)
                return { ...part, text }
              }
              return part
            }),
          ),
        }
      }

      return message
    }),
  )

  // Deduplicate rule names
  const uniqueRules = [...new Set(allAppliedRules)]

  return {
    payload: { ...payload, messages: processedMessages },
    appliedRules: uniqueRules,
  }
}

export function setReplacementsForTest(rules: Array<ReplacementRule>): void {
  testReplacements = structuredClone(rules)
}
