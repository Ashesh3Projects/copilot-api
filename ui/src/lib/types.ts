// Types mirror the payload shapes produced by src/routes/dashboard/api.ts
// and src/routes/dashboard/llm-debug-replay.ts. Keep these in sync when the
// server-side handlers change shape.

export interface Overview {
  activeSessions: number
  codeSessionsCount: number
  directConnectCount: number
  environmentsCount: number
  flagsCount: number
  uptime: string
  health: string
}

export type SessionType = "code-session" | "direct-connect"
export type SessionState = "idle" | "running" | "requires_action" | "connected"

export interface Session {
  id: string
  title: string
  state: SessionState
  type: SessionType
  createdAt: number
  lastHeartbeat: number | null
  tags: Array<string>
}

export interface SessionEvent {
  event_id: string
  sequence_num: number
  event_type: string
  source: string
  payload: Record<string, unknown>
  created_at: string
  is_compaction?: boolean
  agent_id?: string
}

export interface Environment {
  id: string
  machineName: string
  directory: string
  branch: string
  gitRepoUrl: string | null
  maxSessions: number
  createdAt: number
  pendingWorkCount: number
}

export type FlagApplication = "claudeCode" | "chatgptCodex"
export type FlagValue = boolean | string | number | Record<string, unknown>
export type FlagsMap = Record<string, FlagValue>
export type StatsigOverrideKind = "featureGate" | "dynamicConfig"
export type StatsigDynamicConfig = Record<string, unknown>

export interface StatsigOverrides {
  featureGates: Record<string, boolean>
  dynamicConfigs: Record<string, StatsigDynamicConfig>
}

export interface Replacement {
  id: string
  name?: string
  pattern: string
  replacement: string
  isRegex: boolean
  enabled: boolean
  isSystem?: boolean
}

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export type RedirectSourceEffort = "all" | "default" | ReasoningEffort
export type RedirectTargetEffort = ReasoningEffort
export type RedirectTargetVerbosity = "low" | "medium" | "high"

export interface ModelFallbackRule {
  id: string
  sourceModel: string
  targetModel: string
  enabled: boolean
}

export interface ModelFallbackConfig {
  enabled: boolean
  conversationAffinity: boolean
  notifyClient: boolean
  nativeClientNotice: boolean
  affinityTtlSeconds: number
  affinityMaxEntries: number
  rules: Array<ModelFallbackRule>
}

export interface ModelFallbackSettings {
  config: ModelFallbackConfig
  cache: { entries: number }
}

export interface ModelRedirectConflict {
  id: string
  name?: string
}

export interface ModelRedirect {
  id: string
  name?: string
  sourceModel: string
  sourceEffort: RedirectSourceEffort
  targetModel: string
  targetEffort?: RedirectTargetEffort
  targetVerbosity?: RedirectTargetVerbosity
  enabled: boolean
  conflicts: Array<ModelRedirectConflict>
}

export type ModelRequestParameter = "temperature" | "top_p"

export interface ModelSetting {
  model: string
  sentryModelName?: string
  supportedReasoningEfforts?: Array<ReasoningEffort>
  defaultReasoningEffort?: ReasoningEffort
  implicitReasoningDefault?: boolean
  exposeVirtualReasoningModels?: boolean
  supportsAssistantPrefill?: boolean
  unsupportedRequestParameters?: Array<ModelRequestParameter>
}

export type CustomProviderModelKind = "chat" | "embedding"

export interface CustomProviderModel {
  id: string
  aliases?: Array<string>
  kind: CustomProviderModelKind
  dimensions?: number
  supportsStreaming?: boolean
  passReasoningEffort?: boolean
}

export interface CustomProvider {
  id: string
  name: string
  type: "openai-compatible"
  baseUrl: string
  apiKeyConfigured: boolean
  apiKeyEnv?: string
  headerNames: Array<string>
  models: Array<CustomProviderModel>
  passReasoningEffort?: boolean
}

export interface ModelRoutingAccount {
  id: number
  accountType: string
  githubUsername?: string
  healthy: boolean
  modelsCount: number
}

export interface ModelRoutingModelAccount {
  accountId: number
  enabled: boolean
}

export interface ModelRoutingModel {
  id: string
  name: string
  vendor: string
  preview: boolean
  accounts: Array<ModelRoutingModelAccount>
}

export interface ModelRouting {
  multiToken: boolean
  accounts: Array<ModelRoutingAccount>
  models: Array<ModelRoutingModel>
}

export interface UsageSection {
  utilization?: number
  tokens_used?: number
  request_count?: number
  resets_at?: number
  total_tokens?: number
  total_input_tokens?: number
  total_output_tokens?: number
  total_requests?: number
  first_request_at?: number | null
}

export type UsageData = Record<string, UsageSection>

export type RoutingWindow = "15m" | "1h" | "6h" | "24h"
export type RoutingBalanceStatus =
  | "not_applicable"
  | "insufficient_data"
  | "within_range"
  | "skewed"

export interface RoutingTotals {
  requests: number
  upstreamCalls: number
  retries: number
  failovers: number
}

export interface RoutingTimeSeriesPoint extends RoutingTotals {
  timestamp: number
  extraCalls: number
}

export interface RoutingOutcomeCounts {
  success: number
  clientError: number
  serverError: number
  transportError: number
  aborted: number
}

export interface RoutingModelAccountUsage {
  accountId: number
  share: number
  upstreamCalls: number
}

export interface RoutingModelUsage extends RoutingTotals {
  id: string
  model: string
  provider: string
  share: number
  amplification: number
  successRate: number
  outcomes: RoutingOutcomeCounts
  accounts: Array<RoutingModelAccountUsage>
}

export interface RoutingAccountUsage {
  accountId: number | null
  label: string
  accountType?: string
  githubUsername?: string
  healthy: boolean
  selected: number
  selectionShare: number
  expectedSelections: number
  expectedShare: number
  selectionDelta: number
  upstreamCalls: number
  callShare: number
  balanceStatus: RoutingBalanceStatus
}

export interface RoutingRouteUsage {
  route: string
  requests: number
  upstreamCalls: number
  share: number
}

export interface RoutingSelectionModes {
  sticky: number
  default: number
  single: number
}

export interface RoutingAffinitySources {
  claude_session: number
  copilot_session: number
  codex_session: number
  claude_metadata: number
  codex_metadata: number
  codex_thread: number
  unidentified: number
}

export interface RoutingTelemetrySnapshot {
  window: RoutingWindow
  windowMinutes: number
  retentionMinutes: number
  generatedAt: number
  telemetryStartedAt: number
  multiToken: boolean
  totals: RoutingTotals
  lifetime: RoutingTotals
  timeSeries: Array<RoutingTimeSeriesPoint>
  models: Array<RoutingModelUsage>
  accounts: Array<RoutingAccountUsage>
  routes: Array<RoutingRouteUsage>
  selectionModes: RoutingSelectionModes
  affinitySources: RoutingAffinitySources
}

export interface IpAllowlistEntry {
  ip: string
  enabled: boolean
  source: "authenticated" | "dashboard" | "manual"
  createdAt: string
  updatedAt: string
  lastSeenAt?: string
}

export interface TrustedJwtDigestEntry {
  id: string
  label: string
  digest: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export function ipAddressPlaceholder(currentIp: string | null): string {
  return currentIp ?? "203.0.113.10"
}

export function ipAddressForSubmission(
  input: string,
  currentIp: string | null,
): string | null {
  return input.trim() || currentIp
}

type GetRequest = <T>(path: string) => Promise<T>
type BodyRequest = <T>(path: string, body?: unknown) => Promise<T>

export class IpAddressRequiredError extends Error {
  constructor() {
    super("IP address is required")
    this.name = "IpAddressRequiredError"
  }
}

export class TrustedJwtDigestInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TrustedJwtDigestInputError"
  }
}

export interface LlmDebugEntry {
  id: string
  method: string
  path: string
  model?: string
  requestId?: string
  requestPreview: string
  requestBodyBytes: number
  responsePreview?: string
  responseBodyBytes?: number
  responseContentType?: string
  responseStatus?: number
  responseStatusText?: string
  errorMessage?: string
  startedAt: string
  durationMs?: number
  endedAt?: string
  status: "pending" | "complete" | "error" | "aborted"
  stream?: boolean
}

export interface LlmDebugLogError {
  code?: number | string
  errno?: number
  message: string
  name: string
  path?: string
  stack?: string
}

export interface LlmDebugLogRequest {
  body: string | null
  bodyBytes: number
  headers: Record<string, string>
  method: string
  path: string
  url: string
}

export interface LlmDebugLogResponse {
  body: string | null
  bodyBytes: number
  bodyReadError?: LlmDebugLogError
  headers: Record<string, string>
  status: number
  statusText: string
}

export interface LlmDebugDetail {
  id: string
  model?: string
  requestId?: string
  request: LlmDebugLogRequest
  response?: LlmDebugLogResponse
  error?: LlmDebugLogError
  startedAt: string
  startedAtMs: number
  durationMs?: number
  endedAt?: string
  status: "pending" | "complete" | "error" | "aborted"
  stream?: boolean
}

export interface ReplayStreamEvent {
  data: unknown
  rawData: string
  event?: string
  id?: string
  retry?: number
}

export interface ReplayResult {
  body: string
  durationMs: number
  finishReason: string | null
  headers: Record<string, string>
  parsed: unknown
  responseId: string | null
  status: number
  statusText: string
  streamEvents: Array<ReplayStreamEvent>
  usage: unknown
}

export interface SettingsData {
  version: string
  port: string
  host: string
  authEnabled: boolean
  multiToken: boolean
  sentryEnabled: boolean
  groqEnabled: boolean
  dataDir: string
  debug: boolean
  verbose: boolean
  passwordManagedExternally: boolean
  codexCleanupModel: string | null
  codexCleanupModelDefault: string | undefined
  availableModels: Array<string>
}

export interface SettingsBundle {
  settings: SettingsData
  allowlist: Array<IpAllowlistEntry>
  currentIp: string | null
  trustedJwtDigests: Array<TrustedJwtDigestEntry>
}

export async function loadSettingsBundle(
  requestGet: GetRequest,
): Promise<SettingsBundle> {
  const [settings, allowlist, currentIp, trustedJwtDigests] = await Promise.all(
    [
      requestGet<SettingsData>("/dashboard/api/settings"),
      requestGet<Array<IpAllowlistEntry>>("/dashboard/api/ip-allowlist"),
      requestGet<{ ip: string | null }>("/dashboard/api/ip-allowlist/current")
        .then((result) => result.ip)
        .catch(() => null),
      requestGet<Array<TrustedJwtDigestEntry>>(
        "/dashboard/api/trusted-jwt-digests",
      ),
    ],
  )

  return { settings, allowlist, currentIp, trustedJwtDigests }
}

export async function addIpAllowlistEntry(
  input: string,
  currentIp: string | null,
  requestPost: BodyRequest,
): Promise<void> {
  const ip = ipAddressForSubmission(input, currentIp)
  if (!ip) throw new IpAddressRequiredError()

  await requestPost("/dashboard/api/ip-allowlist", {
    ip,
    enabled: true,
  })
}

export function trustedJwtDigestForSubmission(
  labelInput: string,
  digestInput: string,
): { label: string; digest: string } {
  const label = labelInput.trim()
  const digest = digestInput.trim().toLowerCase()

  if (!label) {
    throw new TrustedJwtDigestInputError("Device label is required")
  }
  if (!/^[a-f\d]{64}$/.test(digest)) {
    throw new TrustedJwtDigestInputError(
      "SHA-256 digest must be exactly 64 hexadecimal characters",
    )
  }

  return { label, digest }
}

export async function addTrustedJwtDigest(
  label: string,
  digest: string,
  requestPost: BodyRequest,
): Promise<void> {
  await requestPost(
    "/dashboard/api/trusted-jwt-digests",
    trustedJwtDigestForSubmission(label, digest),
  )
}

export function clearIpAllowlist(
  requestDelete: BodyRequest,
): Promise<{ success: true; cleared: number }> {
  return requestDelete<{ success: true; cleared: number }>(
    "/dashboard/api/ip-allowlist",
  )
}
