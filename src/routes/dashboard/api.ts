import type { Context } from "hono"

import { getAdminAuthStatus } from "~/lib/admin-auth"
import {
  addReplacement,
  getAllReplacements,
  removeReplacement,
  toggleReplacement,
  updateReplacement,
} from "~/lib/auto-replace"
import { revokeEnvironmentCapabilities } from "~/lib/bridge-capabilities"
import {
  getCodexCleanupModel,
  getSmallModel,
  setCodexCleanupModel,
} from "~/lib/config"
import {
  createNebiusQwen3EmbeddingProvider,
  getGroqApiKey,
  listCustomProvidersForDashboard,
  listCustomProviderPageForDashboard,
  removeCustomProvider,
  upsertCustomProvider,
} from "~/lib/custom-providers"
import {
  isValidIpAddress,
  listIpAllowlist,
  upsertIpAllowlistEntry,
} from "~/lib/ip-allowlist"
import {
  clearIpSecurityPolicy,
  extractClientIp,
  removeIpSecurityPolicy,
  setIpSecurityPolicyEnabled,
} from "~/lib/ip-blocker"
import {
  clearLlmDebugLogs,
  getLlmDebugLog,
  listLlmDebugLogs,
  LlmDebugQueryError,
} from "~/lib/llm-debug-log"
import {
  addModelRedirect,
  getAllModelRedirects,
  type ModelRedirectVerbosity,
  moveModelRedirect,
  removeModelRedirect,
  toggleModelRedirect,
  updateModelRedirect,
} from "~/lib/model-redirect"
import { setModelRoutingOverride } from "~/lib/model-routing"
import {
  getAllModelSettings,
  isReasoningEffort,
  type ModelRequestParameter,
  removeModelSettings,
  setModelSettings,
} from "~/lib/model-settings"
import { hasActiveGatewayCredentials } from "~/lib/request-auth"
import {
  getRoutingTelemetrySnapshot,
  isRoutingWindow,
} from "~/lib/routing-telemetry"
import { state } from "~/lib/state"
import { getSettingsActorId } from "~/lib/storage/domain-settings"
import { createProviderMutationContext } from "~/lib/storage/providers-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { peekHistoryRuntime } from "~/lib/telemetry-writer"
import { tokenPool } from "~/lib/token-pool"
import {
  trustedJwtDigestStore,
  TrustedJwtDigestConflictError,
  TrustedJwtDigestValidationError,
} from "~/lib/trusted-jwt-digests"
import { getUsageResponse } from "~/lib/usage-tracker"
import {
  archiveSession,
  createSession,
  getClientEvents,
  listSessions,
} from "~/routes/code-sessions/session-store"
import { providerSecretInputError } from "~/routes/dashboard/provider-secrets-input"
import {
  destroyDirectConnectSession,
  listDirectConnectSessions,
} from "~/routes/direct-connect/ws-handler"
import {
  deregisterEnvironment,
  enqueueWork,
  getEnvironment,
  listEnvironments,
} from "~/routes/environments/environment-store"
import {
  getFeatureFlags,
  removeFeatureFlag,
  setFeatureFlag,
} from "~/routes/feature-flags/store"
import {
  statsigOverrideStore,
  StatsigOverrideValidationError,
  type StatsigOverrideKind,
} from "~/routes/statsig-overrides/store"

import packageJson from "../../../package.json" with { type: "json" }

const serverStartTime = Date.now()

type RedirectSourceEffort =
  | "all"
  | "default"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

type RedirectTargetEffort = "low" | "medium" | "high" | "xhigh" | "max"

type ModelSettingsEffort = "low" | "medium" | "high" | "xhigh" | "max"

interface ModelSettingsRequestBody {
  model?: string
  sentryModelName?: string | null
  supportedReasoningEfforts?: Array<ModelSettingsEffort> | null
  defaultReasoningEffort?: ModelSettingsEffort | null
  implicitReasoningDefault?: boolean | null
  exposeVirtualReasoningModels?: boolean | null
  supportsAssistantPrefill?: boolean | null
  unsupportedRequestParameters?: Array<ModelRequestParameter> | null
}

interface CustomProviderRequestBody {
  id?: string
  name?: string
  type?: "openai-compatible"
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  clearApiKey?: boolean
  clearHeaders?: boolean
  replaceHeaders?: boolean
  enabled?: boolean
  headers?: Record<string, string>
  passReasoningEffort?: boolean | null
  models?: Array<{
    id?: string
    aliases?: Array<string>
    kind?: "chat" | "embedding"
    dimensions?: number | null
    supportsStreaming?: boolean | null
    passReasoningEffort?: boolean | null
  }>
}

function isStatsigOverrideKind(value: unknown): value is StatsigOverrideKind {
  return value === "featureGate" || value === "dynamicConfig"
}

interface ValidCustomProviderBody {
  id: string
  name: string
  baseUrl: string
  apiKey?: string
  apiKeyEnv?: string
  clearApiKey?: boolean
  clearHeaders?: boolean
  replaceHeaders?: boolean
  enabled?: boolean
  headers?: Record<string, string>
  passReasoningEffort?: boolean
  models: Array<{
    id: string
    kind: "chat" | "embedding"
    aliases?: Array<string>
    dimensions?: number
    supportsStreaming?: boolean
    passReasoningEffort?: boolean
  }>
}

interface IpAllowlistRequestBody {
  ip?: string
  enabled?: boolean
}

type CustomProviderParseResult =
  | { ok: true; body: ValidCustomProviderBody }
  | { ok: false; error: string }

function isExactRecord(
  value: unknown,
  expectedKeys: ReadonlyArray<string>,
): value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false
  }
  const keys = Object.keys(value)
  return (
    keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key))
  )
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  const parts: Array<string> = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)

  return parts.join(" ")
}

export function handleOverview(c: Context) {
  const codeSessions = listSessions().filter((s) => !s.archived)
  const directConnectSessions = listDirectConnectSessions()
  const environments = listEnvironments()
  const flags = getFeatureFlags()

  const uptimeMs = Date.now() - serverStartTime

  return c.json({
    activeSessions: codeSessions.length + directConnectSessions.length,
    codeSessionsCount: codeSessions.length,
    directConnectCount: directConnectSessions.length,
    environmentsCount: environments.length,
    flagsCount: Object.keys(flags).length + statsigOverrideStore.count(),
    uptime: formatUptime(uptimeMs),
    health: "ok",
  })
}

export function handleListSessions(c: Context) {
  const codeSessions = listSessions()
    .filter((s) => !s.archived)
    .map((s) => ({
      id: s.id,
      title: s.title,
      state: s.state,
      type: "code-session" as const,
      createdAt: s.createdAt,
      lastHeartbeat: s.lastHeartbeat,
      tags: s.tags,
    }))

  const directConnectSessions = listDirectConnectSessions().map((s) => ({
    id: s.id,
    title: s.id,
    state: "connected" as const,
    type: "direct-connect" as const,
    createdAt: s.createdAt,
    lastHeartbeat: null,
    tags: [],
  }))

  return c.json([...codeSessions, ...directConnectSessions])
}

export function handleArchiveSession(c: Context) {
  const id = c.req.param("id") ?? ""
  const success = archiveSession(id)
  if (!success) {
    return c.json({ error: "Session not found or already archived" }, 404)
  }
  return c.json({ success: true })
}

export function handleDestroySession(c: Context) {
  const id = c.req.param("id") ?? ""

  // Try direct-connect first
  if (destroyDirectConnectSession(id)) {
    return c.json({ success: true })
  }

  // Fall back to archiving code session
  if (archiveSession(id)) {
    return c.json({ success: true })
  }

  return c.json({ error: "Session not found" }, 404)
}

export function handleGetSessionEvents(c: Context) {
  const id = c.req.param("id") ?? ""
  return c.json(getClientEvents(id, 0))
}

export function handleListEnvironments(c: Context) {
  const envs = listEnvironments().map((env) => ({
    id: env.id,
    machineName: env.machineName,
    directory: env.directory,
    branch: env.branch,
    gitRepoUrl: env.gitRepoUrl,
    maxSessions: env.maxSessions,
    createdAt: env.createdAt,
    pendingWorkCount: env.workQueue.filter((w) => w.state === "pending").length,
  }))
  return c.json(envs)
}

export function handleDeregisterEnvironment(c: Context) {
  const id = c.req.param("id") ?? ""
  const success = deregisterEnvironment(id)
  if (!success) {
    return c.json({ error: "Environment not found" }, 404)
  }
  revokeEnvironmentCapabilities(id)
  return c.json({ success: true })
}

export function handleListFlags(c: Context) {
  return c.json(getFeatureFlags())
}

export async function handleSetFlag(c: Context) {
  const body = await c.req.json<{ name: string; value: unknown }>()
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }
  await setFeatureFlag(
    body.name,
    body.value as boolean | string | number | Record<string, unknown>,
  )
  return c.json({ success: true })
}

export async function handleDeleteFlag(c: Context) {
  const body = await c.req.json<{ name: string }>()
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }
  const removed = await removeFeatureFlag(body.name)
  if (!removed) {
    return c.json({ error: "Flag not found" }, 404)
  }
  return c.json({ success: true })
}

export function handleListStatsigOverrides(c: Context) {
  return c.json(statsigOverrideStore.get())
}

export async function handleSetStatsigOverride(c: Context) {
  const body = await c.req.json<{
    kind?: unknown
    name?: unknown
    value?: unknown
  }>()

  if (!isStatsigOverrideKind(body.kind)) {
    return c.json({ error: "kind must be featureGate or dynamicConfig" }, 400)
  }
  if (typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }

  try {
    await statsigOverrideStore.set(body.kind, body.name, body.value)
    return c.json({ success: true })
  } catch (error) {
    if (error instanceof StatsigOverrideValidationError) {
      return c.json({ error: error.message }, 400)
    }
    throw error
  }
}

export async function handleDeleteStatsigOverride(c: Context) {
  const body = await c.req.json<{
    kind?: unknown
    name?: unknown
  }>()

  if (!isStatsigOverrideKind(body.kind)) {
    return c.json({ error: "kind must be featureGate or dynamicConfig" }, 400)
  }
  if (typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }

  try {
    const removed = await statsigOverrideStore.remove(body.kind, body.name)
    if (!removed) {
      return c.json({ error: "Override not found" }, 404)
    }
    return c.json({ success: true })
  } catch (error) {
    if (error instanceof StatsigOverrideValidationError) {
      return c.json({ error: error.message }, 400)
    }
    throw error
  }
}

export async function handleListReplacements(c: Context) {
  const replacements = await getAllReplacements()
  return c.json(replacements)
}

export async function handleAddReplacement(c: Context) {
  const body = await c.req.json<{
    pattern: string
    replacement?: string
    isRegex?: boolean
    name?: string
  }>()
  if (!body.pattern || typeof body.pattern !== "string") {
    return c.json({ error: "pattern is required" }, 400)
  }
  const rule = await addReplacement(body.pattern, body.replacement ?? "", {
    isRegex: body.isRegex,
    name: body.name,
  })
  return c.json(rule)
}

export async function handleDeleteReplacement(c: Context) {
  const id = c.req.param("id") ?? ""
  const removed = await removeReplacement(id)
  if (!removed) {
    return c.json({ error: "Replacement not found" }, 404)
  }
  return c.json({ success: true })
}

export async function handleToggleReplacement(c: Context) {
  const id = c.req.param("id") ?? ""
  const rule = await toggleReplacement(id)
  if (!rule) {
    return c.json({ error: "Replacement not found or is a system rule" }, 404)
  }
  return c.json(rule)
}

export async function handleUpdateReplacement(c: Context) {
  const id = c.req.param("id") ?? ""
  const body = await c.req.json<{
    name?: string
    pattern?: string
    replacement?: string
    isRegex?: boolean
  }>()
  const rule = await updateReplacement(id, {
    name: body.name,
    pattern: body.pattern,
    replacement: body.replacement,
    isRegex: body.isRegex,
  })
  if (!rule) {
    return c.json({ error: "Replacement not found or is a system rule" }, 404)
  }
  return c.json(rule)
}

export async function handleListModelRedirects(c: Context) {
  return c.json(await getAllModelRedirects())
}

export async function handleAddModelRedirect(c: Context) {
  const body = await c.req.json<{
    sourceModel: string
    targetModel: string
    name?: string
    sourceEffort?: RedirectSourceEffort
    targetEffort?: RedirectTargetEffort
    targetVerbosity?: ModelRedirectVerbosity
  }>()
  if (!body.sourceModel || !body.targetModel) {
    return c.json({ error: "sourceModel and targetModel are required" }, 400)
  }
  const rule = await addModelRedirect(body.sourceModel, body.targetModel, {
    name: body.name,
    sourceEffort: body.sourceEffort,
    targetEffort: body.targetEffort,
    targetVerbosity: body.targetVerbosity,
  })
  return c.json(rule)
}

export async function handleDeleteModelRedirect(c: Context) {
  const id = c.req.param("id") ?? ""
  const removed = await removeModelRedirect(id)
  if (!removed) return c.json({ error: "Redirect not found" }, 404)
  return c.json({ success: true })
}

export async function handleToggleModelRedirect(c: Context) {
  const id = c.req.param("id") ?? ""
  const rule = await toggleModelRedirect(id)
  if (!rule) return c.json({ error: "Redirect not found" }, 404)
  return c.json(rule)
}

export async function handleUpdateModelRedirect(c: Context) {
  const id = c.req.param("id") ?? ""
  const body = await c.req.json<{
    name?: string
    sourceModel?: string
    sourceEffort?: RedirectSourceEffort
    targetModel?: string
    targetEffort?: RedirectTargetEffort | null
    targetVerbosity?: ModelRedirectVerbosity | null
    enabled?: boolean
  }>()
  const rule = await updateModelRedirect(id, body)
  if (!rule) return c.json({ error: "Redirect not found" }, 404)
  return c.json(rule)
}

export async function handleMoveModelRedirect(c: Context) {
  const id = c.req.param("id") ?? ""
  const body = await c.req.json<{ direction?: "up" | "down" }>()
  if (body.direction !== "up" && body.direction !== "down") {
    return c.json({ error: "direction must be up or down" }, 400)
  }
  const rule = await moveModelRedirect(id, body.direction)
  if (!rule) return c.json({ error: "Redirect not found" }, 404)
  return c.json(rule)
}

export async function handleListModelSettings(c: Context) {
  return c.json(await getAllModelSettings())
}

export async function handleSetModelSettings(c: Context) {
  const body = await c.req.json<ModelSettingsRequestBody>()

  if (!body.model || typeof body.model !== "string") {
    return c.json({ error: "model is required" }, 400)
  }

  const validationError = validateModelSettingsBody(body)
  if (validationError) return c.json({ error: validationError }, 400)

  const settings = await setModelSettings(body.model, modelSettingsUpdate(body))
  return c.json(settings)
}

function validateModelSettingsBody(
  body: ModelSettingsRequestBody,
): string | undefined {
  if (!isValidSentryModelName(body.sentryModelName)) {
    return "sentryModelName is invalid"
  }

  if (!isValidSupportedReasoningEfforts(body.supportedReasoningEfforts)) {
    return "supportedReasoningEfforts is invalid"
  }

  if (!isValidModelSettingsEffort(body.defaultReasoningEffort)) {
    return "defaultReasoningEffort is invalid"
  }

  if (!isValidUnsupportedRequestParameters(body.unsupportedRequestParameters)) {
    return "unsupportedRequestParameters is invalid"
  }

  if (!isValidOptionalBoolean(body.supportsAssistantPrefill)) {
    return "supportsAssistantPrefill is invalid"
  }

  return undefined
}

function isValidSentryModelName(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string"
}

function isValidSupportedReasoningEfforts(value: unknown): boolean {
  return (
    value === undefined
    || value === null
    || (Array.isArray(value)
      && value.every((effort) => isValidModelSettingsEffort(effort)))
  )
}

function isValidModelSettingsEffort(
  effort: unknown,
): effort is ModelSettingsEffort | null | undefined {
  return (
    effort === undefined
    || effort === null
    || effort === "max"
    || isReasoningEffort(effort)
  )
}

function isValidUnsupportedRequestParameters(value: unknown): boolean {
  return (
    value === undefined
    || value === null
    || (Array.isArray(value)
      && value.every(
        (parameter) => parameter === "temperature" || parameter === "top_p",
      ))
  )
}

function isValidOptionalBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "boolean"
}

function modelSettingsUpdate(body: ModelSettingsRequestBody) {
  return {
    ...(body.sentryModelName !== undefined ?
      { sentryModelName: body.sentryModelName }
    : {}),
    ...(body.supportedReasoningEfforts !== undefined ?
      { supportedReasoningEfforts: body.supportedReasoningEfforts }
    : {}),
    ...(body.defaultReasoningEffort !== undefined ?
      { defaultReasoningEffort: body.defaultReasoningEffort }
    : {}),
    ...(body.implicitReasoningDefault !== undefined ?
      { implicitReasoningDefault: body.implicitReasoningDefault }
    : {}),
    ...(body.exposeVirtualReasoningModels !== undefined ?
      { exposeVirtualReasoningModels: body.exposeVirtualReasoningModels }
    : {}),
    ...(body.supportsAssistantPrefill !== undefined ?
      { supportsAssistantPrefill: body.supportsAssistantPrefill }
    : {}),
    ...(body.unsupportedRequestParameters !== undefined ?
      { unsupportedRequestParameters: body.unsupportedRequestParameters }
    : {}),
  }
}

export async function handleDeleteModelSettings(c: Context) {
  const model = c.req.param("model") ?? ""
  const removed = await removeModelSettings(model)
  if (!removed) return c.json({ error: "Model settings not found" }, 404)
  return c.json({ success: true })
}

export function handleListModelRouting(c: Context) {
  const accounts = tokenPool.getAllAccounts().map((account) => ({
    id: account.id,
    accountType: account.accountType,
    githubUsername: account.githubUsername,
    healthy: account.healthy,
    enabled: account.enabled !== false,
    deleting: account.deleting === true,
    modelsCount: account.models.size,
  }))

  const models = tokenPool.getModelAccountAvailability().map((entry) => ({
    id: entry.model.id,
    name: entry.model.name,
    vendor: entry.model.vendor,
    preview: entry.model.preview,
    accounts: entry.accounts,
  }))

  return c.json({
    multiToken: state.isMultiToken,
    accounts,
    models,
  })
}

export async function handleListCustomProviders(c: Context) {
  if (c.req.query("withRevision") === "1")
    return c.json(await listCustomProviderPageForDashboard())
  return c.json(await listCustomProvidersForDashboard())
}

export async function handleUpsertCustomProvider(c: Context) {
  const parsed = parseCustomProviderBody(
    await c.req.json<CustomProviderRequestBody>(),
  )
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const { body } = parsed
  await upsertCustomProvider(
    {
      id: body.id,
      name: body.name,
      type: "openai-compatible",
      baseUrl: body.baseUrl,
      ...(body.apiKey ? { apiKey: body.apiKey } : {}),
      ...(body.headers ? { headers: body.headers } : {}),
      ...(body.clearApiKey !== undefined ?
        { clearApiKey: body.clearApiKey }
      : {}),
      ...(body.clearHeaders !== undefined ?
        { clearHeaders: body.clearHeaders }
      : {}),
      ...(body.replaceHeaders !== undefined ?
        { replaceHeaders: body.replaceHeaders }
      : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      models: body.models,
      ...(body.passReasoningEffort !== undefined ?
        { passReasoningEffort: body.passReasoningEffort }
      : {}),
    },
    await providerMutation(c, "provider.upsert", body),
  )

  return c.json(
    (await listCustomProvidersForDashboard()).find(
      (provider) => provider.id === body.id,
    ),
  )
}

function parseCustomProviderBody(
  body: CustomProviderRequestBody | null | undefined,
): CustomProviderParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, error: "Expected a JSON object" }
  const base = parseCustomProviderBase(body)
  if (!base.ok) return base
  const models = parseCustomProviderModels(body.models)
  if (!models.ok) return models

  return {
    ok: true,
    body: {
      ...base.body,
      models: models.models,
    },
  }
}

function parseCustomProviderBase(
  body: CustomProviderRequestBody,
):
  | { ok: true; body: Omit<ValidCustomProviderBody, "models"> }
  | { ok: false; error: string } {
  const id = getRequiredString(body.id, "id")
  if (!id.ok) return id
  const name = getRequiredString(body.name, "name")
  if (!name.ok) return name
  const baseUrl = getRequiredString(body.baseUrl, "baseUrl")
  if (!baseUrl.ok) return baseUrl
  const apiKey = getOptionalString(body.apiKey)
  const secretError = providerSecretInputError(body)
  if (secretError) return { ok: false, error: secretError }

  return {
    ok: true,
    body: {
      id: id.value,
      name: name.value,
      baseUrl: baseUrl.value,
      ...(apiKey ? { apiKey } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.clearApiKey !== undefined ?
        { clearApiKey: body.clearApiKey }
      : {}),
      ...(body.clearHeaders !== undefined ?
        { clearHeaders: body.clearHeaders }
      : {}),
      ...(body.replaceHeaders !== undefined ?
        { replaceHeaders: body.replaceHeaders }
      : {}),
      ...(body.headers ? { headers: body.headers } : {}),
      ...(typeof body.passReasoningEffort === "boolean" ?
        { passReasoningEffort: body.passReasoningEffort }
      : {}),
    },
  }
}

function parseCustomProviderModels(
  models: CustomProviderRequestBody["models"],
):
  | { ok: true; models: ValidCustomProviderBody["models"] }
  | { ok: false; error: string } {
  if (!Array.isArray(models) || models.length === 0) {
    return { ok: false, error: "models must contain at least one model" }
  }

  const parsedModels: ValidCustomProviderBody["models"] = []
  for (const model of models) {
    const parsed = parseCustomProviderModel(model)
    if (!parsed.ok) return parsed
    parsedModels.push(parsed.model)
  }

  return { ok: true, models: parsedModels }
}

function parseCustomProviderModel(
  model: NonNullable<CustomProviderRequestBody["models"]>[number],
):
  | { ok: true; model: ValidCustomProviderBody["models"][number] }
  | { ok: false; error: string } {
  const id = getRequiredString(model.id, "model id")
  if (!id.ok) return id
  if (model.kind !== "chat" && model.kind !== "embedding") {
    return { ok: false, error: "model kind must be chat or embedding" }
  }
  if (!isStringArray(model.aliases)) {
    return { ok: false, error: "model aliases must be strings" }
  }
  if (!isPositiveOptionalInteger(model.dimensions)) {
    return { ok: false, error: "model dimensions must be a positive integer" }
  }

  return {
    ok: true,
    model: {
      id: id.value,
      kind: model.kind,
      ...(model.aliases && model.aliases.length > 0 ?
        { aliases: model.aliases }
      : {}),
      ...(typeof model.dimensions === "number" ?
        { dimensions: model.dimensions }
      : {}),
      ...(typeof model.supportsStreaming === "boolean" ?
        { supportsStreaming: model.supportsStreaming }
      : {}),
      ...(typeof model.passReasoningEffort === "boolean" ?
        { passReasoningEffort: model.passReasoningEffort }
      : {}),
    },
  }
}

function getRequiredString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `${field} is required` }
  }
  return { ok: true, value: value.trim() }
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ?
      value.trim()
    : undefined
}

function isPositiveOptionalInteger(value: unknown): boolean {
  return (
    value === undefined
    || value === null
    || (typeof value === "number" && Number.isInteger(value) && value > 0)
  )
}

function isStringArray(value: unknown): boolean {
  return (
    value === undefined
    || (Array.isArray(value) && value.every((item) => typeof item === "string"))
  )
}

export async function handleAddNebiusCustomProvider(c: Context) {
  const body: { apiKey?: string } = await c.req
    .json<{ apiKey?: string }>()
    .catch(() => ({}))
  const apiKey = getRequiredString(body.apiKey, "apiKey")
  if (!apiKey.ok) return c.json({ error: apiKey.error }, 400)

  const provider = createNebiusQwen3EmbeddingProvider(apiKey.value)
  await upsertCustomProvider(
    provider,
    await providerMutation(c, "provider.upsert", provider),
  )
  return c.json(
    (await listCustomProvidersForDashboard()).find(
      (candidate) => candidate.id === provider.id,
    ),
  )
}

export async function handleDeleteCustomProvider(c: Context) {
  const id = c.req.param("id") ?? ""
  if (
    !(await removeCustomProvider(
      id,
      await providerMutation(c, "provider.remove", { id }),
    ))
  ) {
    return c.json({ error: "Custom provider not found" }, 404)
  }
  return c.json({ success: true })
}

async function providerMutation(c: Context, kind: string, input: unknown) {
  const actor = getSettingsActorId()
  if (!actor) throw new Error("Administrator authority is required")
  const mutation = await createProviderMutationContext(
    getStorageRuntime().storage,
    kind,
    input,
    actor,
  )
  const revision = c.req.header("If-Match")
  if (revision !== undefined) {
    const value = revision.replaceAll('"', "")
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error("Invalid configuration revision")
    mutation.expectedRevision = Number(value)
  }
  mutation.operationId = c.req.header("Idempotency-Key") ?? mutation.operationId
  return mutation
}

export async function handleSetModelRouting(c: Context) {
  const body = await c.req.json<{
    modelId?: string
    accountId?: number
    enabled?: boolean
  }>()

  if (!body.modelId || typeof body.modelId !== "string") {
    return c.json({ error: "modelId is required" }, 400)
  }
  if (typeof body.accountId !== "number" || !Number.isInteger(body.accountId)) {
    return c.json({ error: "accountId is required" }, 400)
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled is required" }, 400)
  }

  const account = tokenPool
    .getAllAccounts()
    .find((item) => item.id === body.accountId)
  if (!account) {
    return c.json({ error: "Account not found" }, 404)
  }
  if (!account.models.has(body.modelId)) {
    return c.json({ error: "Model is not available on this account" }, 400)
  }

  const override = await setModelRoutingOverride(
    body.modelId,
    body.accountId,
    body.enabled,
  )
  tokenPool.rebuildModelIndex()

  return c.json(override)
}

export async function handleGetUsage(c: Context) {
  return c.json(await getUsageResponse())
}

export async function handleGetUsageRouting(c: Context) {
  const windowValues = new URL(c.req.url).searchParams.getAll("window")
  const window = windowValues.length === 0 ? "1h" : windowValues[0]
  if (windowValues.length > 1 || !isRoutingWindow(window)) {
    return c.json({ error: "window must be one of 15m, 1h, 6h, or 24h" }, 400)
  }

  return c.json(
    await getRoutingTelemetrySnapshot({
      accounts: tokenPool.getAllAccounts().map((account) => ({
        id: account.id,
        accountType: account.accountType,
        ...(account.githubUsername ?
          { githubUsername: account.githubUsername }
        : {}),
        healthy: account.healthy,
      })),
      multiToken: state.isMultiToken,
      window,
    }),
  )
}

export async function handleListIpAllowlist(c: Context) {
  return c.json(await listIpAllowlist())
}

export function handleGetCurrentIpAllowlistClient(c: Context) {
  return c.json({ ip: extractClientIp(c) })
}

export async function handleSetIpAllowlistEntry(c: Context) {
  const body = await c.req.json<IpAllowlistRequestBody>().catch(() => null)
  if (body === null) return c.json({ error: "Invalid JSON body" }, 400)

  const ip = c.req.param("ip") || body.ip
  if (!ip || !isValidIpAddress(ip)) {
    return c.json({ error: "Valid IP address is required" }, 400)
  }

  const enabled = body.enabled
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return c.json({ error: "enabled must be boolean" }, 400)
  }

  const entry =
    enabled === undefined ?
      await upsertIpAllowlistEntry(ip, { source: "manual" })
    : await setIpSecurityPolicyEnabled(ip, enabled)

  if (entry === null)
    return c.json({ error: "Valid IP address is required" }, 400)
  return c.json(entry)
}

export async function handleDeleteIpAllowlistEntry(c: Context) {
  const ip = c.req.param("ip") ?? ""
  const removed = await removeIpSecurityPolicy(ip)
  if (!removed) return c.json({ error: "IP address not found" }, 404)
  return c.json({ success: true })
}

export async function handleClearIpAllowlist(c: Context) {
  const cleared = await clearIpSecurityPolicy()
  return c.json({ success: true, cleared })
}

export async function handleListTrustedJwtDigests(c: Context) {
  return c.json(await trustedJwtDigestStore.list())
}

export async function handleAddTrustedJwtDigest(c: Context) {
  const body = await c.req.json<unknown>().catch(() => null)
  if (!isExactRecord(body, ["label", "digest"])) {
    return c.json({ error: "label and digest are required" }, 400)
  }

  try {
    return c.json(
      await trustedJwtDigestStore.add({
        label: body.label as string,
        digest: body.digest as string,
      }),
    )
  } catch (error) {
    if (error instanceof TrustedJwtDigestConflictError) {
      return c.json({ error: error.message }, 409)
    }
    if (error instanceof TrustedJwtDigestValidationError) {
      return c.json({ error: error.message }, 400)
    }
    throw error
  }
}

export async function handleSetTrustedJwtDigestEnabled(c: Context) {
  const body = await c.req.json<unknown>().catch(() => null)
  if (!isExactRecord(body, ["enabled"]) || typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400)
  }

  try {
    const entry = await trustedJwtDigestStore.setEnabled(
      c.req.param("id") ?? "",
      body.enabled,
    )
    if (!entry) return c.json({ error: "Trusted JWT digest not found" }, 404)
    return c.json(entry)
  } catch (error) {
    if (error instanceof TrustedJwtDigestValidationError) {
      return c.json({ error: error.message }, 400)
    }
    throw error
  }
}

export async function handleDeleteTrustedJwtDigest(c: Context) {
  const removed = await trustedJwtDigestStore.remove(c.req.param("id") ?? "")
  if (!removed) return c.json({ error: "Trusted JWT digest not found" }, 404)
  return c.json({ success: true })
}

export async function handleListLlmDebugLogs(c: Context) {
  const limit = c.req.query("limit")
  try {
    return c.json(
      await listLlmDebugLogs({
        limit: limit === undefined ? undefined : Number(limit),
        cursor: c.req.query("cursor"),
      }),
    )
  } catch (error) {
    if (error instanceof LlmDebugQueryError)
      return c.json({ error: error.message }, 400)
    throw error
  }
}

export async function handleGetLlmDebugLog(c: Context) {
  const id = c.req.param("id") ?? ""
  const entry = await getLlmDebugLog(id)
  if (!entry) return c.json({ error: "Debug log not found" }, 404)
  return c.json(entry)
}

export async function handleClearLlmDebugLogs(c: Context) {
  await clearLlmDebugLogs()
  return c.json({ success: true })
}

export async function handleGetSettings(c: Context) {
  const availableModels =
    state.models?.data
      .map((model) => model.id)
      .filter((id) => typeof id === "string" && id.length > 0)
      .sort() ?? []

  const adminAuthStatus = await getAdminAuthStatus()

  return c.json({
    version: packageJson.version,
    port: process.env.PORT ?? "4141",
    host: process.env.HOST ?? "localhost",
    authEnabled: await hasActiveGatewayCredentials(),
    multiToken: tokenPool.getAllAccounts().length > 1,
    sentryEnabled: Boolean(process.env.SENTRY_DSN),
    groqEnabled: Boolean(getGroqApiKey()),
    dataDir:
      getStorageRuntime().config.kind === "sqlite" ?
        "Local SQLite"
      : "Remote Turso",
    storage: {
      kind: getStorageRuntime().config.kind,
      revision: getStorageRuntime().snapshot.get().revision,
      telemetry: peekHistoryRuntime()?.writer.status(),
    },
    debug: state.debug,
    verbose: state.verbose,
    passwordManagedExternally: adminAuthStatus.passwordManagedExternally,
    codexCleanupModel: getCodexCleanupModel(),
    codexCleanupModelDefault: getSmallModel(),
    availableModels,
  })
}

export async function handleSetCodexCleanupModel(c: Context) {
  const body = await c.req.json<{ model?: string | null }>().catch(() => null)
  if (body === null) {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  const raw = body.model
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    return c.json({ error: "model must be a string or null" }, 400)
  }

  const trimmed =
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null

  if (trimmed !== null) {
    const allowed = new Set(state.models?.data.map((m) => m.id) ?? [])
    if (allowed.size > 0 && !allowed.has(trimmed)) {
      return c.json({ error: `Unknown model: ${trimmed}` }, 400)
    }
  }

  await setCodexCleanupModel(trimmed)
  return c.json({
    codexCleanupModel: getCodexCleanupModel(),
    codexCleanupModelDefault: getSmallModel(),
  })
}

export function handleStartEnvironmentSession(c: Context) {
  const envId = c.req.param("id") ?? ""
  const env = getEnvironment(envId)
  if (!env) {
    return c.json({ error: "Environment not found" }, 404)
  }

  const session = createSession(`Session in ${env.machineName}`, [])

  const protocol =
    c.req.header("x-forwarded-proto")
    ?? (c.req.url.startsWith("https") ? "https" : "https")
  const host = c.req.header("host") ?? "localhost"
  const apiBaseUrl = `${protocol}://${host}`

  const workItem = enqueueWork({ envId, sessionId: session.id, apiBaseUrl })
  if (!workItem) {
    return c.json({ error: "Failed to enqueue work" }, 500)
  }

  return c.json({
    sessionId: session.id,
    workId: workItem.id,
    success: true,
  })
}
