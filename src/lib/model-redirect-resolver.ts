import type {
  ModelRedirectRequest,
  ModelRedirectResult,
  ModelRedirectRule,
  ModelRedirectStep,
} from "~/lib/model-redirect"

export const MAX_REDIRECT_CHAIN_LENGTH = 10

export function modelRouteStateKey(request: ModelRedirectRequest): string {
  return JSON.stringify([
    request.model,
    request.effort ?? null,
    request.verbosity ?? null,
    request.modelOnly === true,
  ])
}

export interface ResolvedModelRedirect extends ModelRedirectResult {
  loop?: Array<ModelRedirectStep>
}

/** The dashboard order is significant: each hop only considers later rules. */
export function resolveModelRedirectRules(
  rules: ReadonlyArray<ModelRedirectRule>,
  request: ModelRedirectRequest,
): ResolvedModelRedirect {
  const current = { ...request }
  const chain: Array<ModelRedirectStep> = []
  const seen = new Set([modelRouteStateKey(current)])
  for (const rule of rules) {
    if (
      !rule.enabled
      || rule.sourceModel !== current.model
      || (rule.sourceEffort !== "all"
        && rule.sourceEffort !== (current.effort ?? "default"))
    )
      continue
    const next: ModelRedirectRequest = {
      model: rule.targetModel,
      effort:
        request.modelOnly ? undefined : (rule.targetEffort ?? current.effort),
      verbosity: rule.targetVerbosity ?? current.verbosity,
      modelOnly: request.modelOnly,
    }
    const key = modelRouteStateKey(next)
    if (key === modelRouteStateKey(current)) continue
    const step: ModelRedirectStep = {
      ruleId: rule.id,
      ruleName: rule.name,
      sourceModel: current.model,
      sourceEffort: request.modelOnly ? undefined : current.effort,
      sourceVerbosity: current.verbosity,
      targetModel: next.model,
      targetEffort: next.effort,
      targetVerbosity: next.verbosity,
    }
    if (seen.has(key)) {
      return { ...current, redirected: false, loop: [...chain, step] }
    }
    seen.add(key)
    chain.push(step)
    Object.assign(current, next)
    if (chain.length >= MAX_REDIRECT_CHAIN_LENGTH) break
  }
  const { model, effort, verbosity } = current
  if (chain.length === 0) return { model, effort, verbosity, redirected: false }
  return {
    model,
    effort,
    verbosity,
    redirected: true,
    originalModel: request.model,
    originalEffort: request.effort,
    originalVerbosity: request.verbosity,
    ruleId: chain[0].ruleId,
    ruleIds: chain.map((step) => step.ruleId),
    redirectChain: chain,
  }
}
