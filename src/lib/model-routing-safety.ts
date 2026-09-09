import type {
  ModelFallbackConfig,
  ModelFallbackRule,
} from "~/lib/model-fallback-config"
import type {
  ModelRedirectRequest,
  ModelRedirectRule,
  ModelRedirectVerbosity,
} from "~/lib/model-redirect"
import type { ReasoningEffort } from "~/lib/model-suffix"

import { getCustomProviders } from "~/lib/custom-providers"
import { getModelFallbackConfigForRoutingSafety } from "~/lib/model-fallback-config"
import { getModelFallbackIdentity } from "~/lib/model-fallback-identity"
import { getLoadedModelRedirects } from "~/lib/model-redirect"
import {
  modelRouteStateKey,
  resolveModelRedirectRules,
} from "~/lib/model-redirect-resolver"
import {
  getModelReasoningConfig,
  normalizeReasoningEffortForModel,
} from "~/lib/model-suffix"
import { state } from "~/lib/state"
import { peekStorageRuntime } from "~/lib/storage/runtime"

export interface ModelRoutingSafety {
  safe: boolean
  loop?: {
    kind: "redirect" | "fallback" | "combined"
    models: Array<string>
    ruleIds: Array<string>
  }
}

export interface ModelRoutingAnalysisOptions {
  identity?: (model: string) => string
  normalizeEffort?: typeof normalizeReasoningEffortForModel
}

const efforts: Array<ReasoningEffort | undefined> = [
  undefined,
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]
const verbosities: Array<ModelRedirectVerbosity | undefined> = [
  undefined,
  "low",
  "medium",
  "high",
]

function requestCases(model: string): Array<ModelRedirectRequest> {
  return [
    ...efforts.flatMap((effort) =>
      verbosities.map((verbosity) => ({ model, effort, verbosity })),
    ),
    ...verbosities.map((verbosity) => ({ model, verbosity, modelOnly: true })),
  ]
}

function unsafe(
  kind: NonNullable<ModelRoutingSafety["loop"]>["kind"],
  models: Array<string>,
  ruleIds: Array<string>,
): ModelRoutingSafety {
  return { safe: false, loop: { kind, models, ruleIds } }
}

function fallbackLoop(
  rules: ReadonlyMap<string, ModelFallbackRule>,
  identity: (model: string) => string,
): ModelRoutingSafety | undefined {
  const completed = new Set<string>()
  for (const source of rules.keys()) {
    if (completed.has(source)) continue
    const seen = new Map<string, number>()
    const models: Array<string> = []
    const ids: Array<string> = []
    let model = source
    while (!completed.has(model)) {
      const key = identity(model)
      const at = seen.get(key)
      if (at !== undefined)
        return unsafe("fallback", [...models.slice(at), model], ids.slice(at))
      seen.set(key, models.length)
      models.push(model)
      const rule = rules.get(model)
      if (!rule) break
      ids.push(rule.id)
      model = rule.targetModel
    }
    for (const visited of models) completed.add(visited)
  }
  return undefined
}

function redirectLoop(
  redirects: ReadonlyArray<ModelRedirectRule>,
): ModelRoutingSafety | undefined {
  const redirectSources = new Set(
    redirects.filter((rule) => rule.enabled).map((rule) => rule.sourceModel),
  )
  for (const model of redirectSources) {
    for (const request of requestCases(model)) {
      const result = resolveModelRedirectRules(redirects, request)
      if (result.loop)
        return unsafe(
          "redirect",
          [
            result.loop[0].sourceModel,
            ...result.loop.map((step) => step.targetModel),
          ],
          result.loop.map((step) => step.ruleId),
        )
    }
  }
  return undefined
}

function routingModels(
  redirects: ReadonlyArray<ModelRedirectRule>,
  fallbacks: ReadonlyArray<ModelFallbackRule>,
): Array<string> {
  return [
    ...new Set(
      [...redirects, ...fallbacks]
        .filter((rule) => rule.enabled)
        .flatMap((rule) => [rule.sourceModel, rule.targetModel]),
    ),
  ]
}

/** Analyze actual ordered redirects and each possible effort/verbosity state. */
export function analyzeModelRoutingSafety(
  redirects: ReadonlyArray<ModelRedirectRule>,
  config: ModelFallbackConfig,
  options: ModelRoutingAnalysisOptions | ((model: string) => string) = {},
): ModelRoutingSafety {
  const analysis =
    typeof options === "function" ? { identity: options } : options
  const identity = analysis.identity ?? ((model: string) => model)
  const normalizeEffort =
    analysis.normalizeEffort ?? ((_model, effort) => effort)
  const rules = new Map(
    config.enabled ?
      config.rules
        .filter((rule) => rule.enabled)
        .map((rule) => [rule.sourceModel, rule])
    : [],
  )
  const pureFallback = fallbackLoop(rules, identity)
  if (pureFallback) return pureFallback
  const pureRedirect = redirectLoop(redirects)
  if (pureRedirect) return pureRedirect
  return combinedLoop(redirects, rules, { identity, normalizeEffort })
}

function combinedLoop(
  redirects: ReadonlyArray<ModelRedirectRule>,
  rules: ReadonlyMap<string, ModelFallbackRule>,
  { identity, normalizeEffort }: Required<ModelRoutingAnalysisOptions>,
): ModelRoutingSafety {
  const modelsWithRules = routingModels(redirects, [...rules.values()])
  const hasAliases =
    new Set(modelsWithRules.map((model) => identity(model))).size
    !== modelsWithRules.length
  const completed = new Set<string>()
  for (const model of rules.keys()) {
    for (const initial of requestCases(model)) {
      if (completed.has(modelRouteStateKey(initial))) continue
      let current = initial
      const seen = new Map<string, number>()
      const models: Array<string> = []
      const ruleIds: Array<string> = []
      const visited: Array<string> = []
      while (true) {
        const rawKey = modelRouteStateKey(current)
        const key = modelRouteStateKey({
          ...current,
          model: identity(current.model),
        })
        const at = seen.get(key)
        if (at !== undefined)
          return unsafe(
            "combined",
            [...models.slice(at), current.model],
            ruleIds,
          )
        // A safe suffix can still revisit an alias from this path's prefix.
        // Reuse completed suffixes only when every raw model has its own identity.
        if (!hasAliases && completed.has(rawKey)) break
        seen.set(key, models.length)
        visited.push(rawKey)
        models.push(current.model)
        const fallback = rules.get(current.model)
        if (!fallback) break
        ruleIds.push(fallback.id)
        const target = resolveModelRedirectRules(redirects, {
          ...current,
          model: fallback.targetModel,
        })
        if (target.loop)
          return unsafe(
            "redirect",
            [
              target.loop[0].sourceModel,
              ...target.loop.map((step) => step.targetModel),
            ],
            target.loop.map((step) => step.ruleId),
          )
        if (target.redirected) {
          models.push(fallback.targetModel)
          ruleIds.push(...(target.ruleIds ?? []))
        }
        current = {
          model: target.model,
          effort:
            current.modelOnly ? undefined : (
              normalizeEffort(target.model, target.effort)
            ),
          verbosity: target.verbosity,
          modelOnly: current.modelOnly,
        }
      }
      for (const key of visited) completed.add(key)
    }
  }
  return { safe: true }
}

let cached: { key: string; result: ModelRoutingSafety } | undefined

export function getModelRoutingSafety(
  config = getModelFallbackConfigForRoutingSafety(),
): ModelRoutingSafety {
  const redirects = getLoadedModelRedirects()
  const runtime = peekStorageRuntime()
  const providers = runtime ? getCustomProviders() : []
  // Effective reasoning settings include captured overrides and live catalog
  // capabilities. Credentials are never part of the safety cache key.
  const reasoning =
    runtime ?
      routingModels(redirects, config.enabled ? config.rules : []).map(
        (model) => [model, getModelReasoningConfig(model)],
      )
    : []
  const key = JSON.stringify([
    redirects,
    config.enabled,
    config.rules,
    providers.map((provider) => [provider.id, provider.models]),
    state.models?.data.map((model) => model.id),
    reasoning,
  ])
  if (key !== cached?.key) {
    cached = {
      key,
      result: analyzeModelRoutingSafety(redirects, config, {
        identity: runtime ? getModelFallbackIdentity : undefined,
        normalizeEffort: runtime ? normalizeReasoningEffortForModel : undefined,
      }),
    }
  }
  return structuredClone(cached.result)
}
