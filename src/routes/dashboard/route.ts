import { Hono } from "hono"

import { authenticateAdminRequest } from "~/lib/admin-auth"
import { secureHtml } from "~/lib/secure-html"
import { withSettingsActor } from "~/lib/storage/domain-settings"
import { getSession } from "~/routes/code-sessions/session-store"
import { mintRemoteWebSocketTicket } from "~/routes/remote/ws-security"

import { dashboardAccountRoutes } from "./accounts"
import { dashboardActivityRoutes } from "./activity"
import {
  handleAddTrustedJwtDigest,
  handleAddModelRedirect,
  handleAddNebiusCustomProvider,
  handleAddReplacement,
  handleArchiveSession,
  handleClearIpAllowlist,
  handleClearLlmDebugLogs,
  handleDeleteCustomProvider,
  handleDeleteFlag,
  handleDeleteIpAllowlistEntry,
  handleDeleteModelRedirect,
  handleDeleteModelSettings,
  handleDeleteStatsigOverride,
  handleDeleteTrustedJwtDigest,
  handleDeleteReplacement,
  handleDeregisterEnvironment,
  handleDestroySession,
  handleGetLlmDebugLog,
  handleGetCurrentIpAllowlistClient,
  handleGetSessionEvents,
  handleGetSettings,
  handleGetUsage,
  handleGetUsageRouting,
  handleListCustomProviders,
  handleListEnvironments,
  handleListFlags,
  handleListIpAllowlist,
  handleListLlmDebugLogs,
  handleListModelRedirects,
  handleListModelRouting,
  handleListModelSettings,
  handleListReplacements,
  handleListStatsigOverrides,
  handleListTrustedJwtDigests,
  handleListSessions,
  handleMoveModelRedirect,
  handleOverview,
  handleSetFlag,
  handleSetIpAllowlistEntry,
  handleSetCodexCleanupModel,
  handleSetModelSettings,
  handleSetModelRouting,
  handleSetStatsigOverride,
  handleSetTrustedJwtDigestEnabled,
  handleStartEnvironmentSession,
  handleToggleModelRedirect,
  handleToggleReplacement,
  handleUpdateModelRedirect,
  handleUpdateReplacement,
  handleUpsertCustomProvider,
} from "./api"
import {
  dashboardAuthRoutes,
  getRefreshedSessionCookieHeaders,
} from "./auth-route"
import {
  createDashboardCredentialRoutes,
  createDashboardProviderSecretRoutes,
} from "./credentials"
import {
  handleClearFallbackCache,
  handleGetFallbacks,
  handleSetFallbacks,
} from "./fallbacks"
import { handleReplayLlmDebugLog } from "./llm-debug-replay"
import { DASHBOARD_HTML } from "./page-generated"
import { handleBackupSettings } from "./settings-backup"
import { handleExportSettings } from "./settings-export"

export const dashboardRoutes = new Hono()

// Serve the admin page (no auth on HTML; the page prompts for the API key
// which gates every /dashboard/api/* call. Brute-force is bounded by the
// shared 3-strikes IP ban in apiKeyGuard.)
dashboardRoutes.get("/", (c) => {
  return secureHtml(c, DASHBOARD_HTML)
})

dashboardRoutes.route("/auth", dashboardAuthRoutes)

dashboardRoutes.use("/api/*", async (c, next) => {
  if (/\/api\/llm-debug(?:\/|$)/.test(c.req.path))
    c.header("Cache-Control", "no-store")
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
  const session = await authenticateAdminRequest(c.req.raw, {
    requireCsrf: mutating,
  })
  if (!session) {
    c.header("Cache-Control", "no-store")
    return c.json(
      { error: { message: "Unauthorized", type: "authentication_error" } },
      401,
    )
  }
  await withSettingsActor(`admin:${session.tokenHash}`, next)
  for (const cookie of getRefreshedSessionCookieHeaders(c.req.raw)) {
    c.header("Set-Cookie", cookie, { append: true })
  }
})

// Overview
dashboardRoutes.route("/api/accounts", dashboardAccountRoutes)
dashboardRoutes.route("/api/credentials", createDashboardCredentialRoutes())
dashboardRoutes.route("/api", dashboardActivityRoutes)
dashboardRoutes.get("/api/overview", handleOverview)

// Sessions
dashboardRoutes.get("/api/sessions", handleListSessions)
dashboardRoutes.post("/api/sessions/:id/archive", handleArchiveSession)
dashboardRoutes.delete("/api/sessions/:id", handleDestroySession)
dashboardRoutes.get("/api/sessions/:id/events", handleGetSessionEvents)
dashboardRoutes.post("/api/sessions/:id/websocket-ticket", async (c) => {
  const sessionId = c.req.param("id")
  const codeSession = getSession(sessionId)
  if (!codeSession || codeSession.archived) {
    return c.json({ error: "Session not found" }, 404)
  }
  const adminSession = await authenticateAdminRequest(c.req.raw, {
    requireCsrf: true,
  })
  if (!adminSession) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  return c.json(mintRemoteWebSocketTicket(adminSession.tokenHash, sessionId))
})

// Environments
dashboardRoutes.get("/api/environments", handleListEnvironments)
dashboardRoutes.delete("/api/environments/:id", handleDeregisterEnvironment)
dashboardRoutes.post(
  "/api/environments/:id/start",
  handleStartEnvironmentSession,
)

// Feature Flags
dashboardRoutes.get("/api/flags", handleListFlags)
dashboardRoutes.post("/api/flags", handleSetFlag)
dashboardRoutes.delete("/api/flags", handleDeleteFlag)
dashboardRoutes.get("/api/statsig-overrides", handleListStatsigOverrides)
dashboardRoutes.post("/api/statsig-overrides", handleSetStatsigOverride)
dashboardRoutes.delete("/api/statsig-overrides", handleDeleteStatsigOverride)

// Replacements
dashboardRoutes.get("/api/replacements", handleListReplacements)
dashboardRoutes.post("/api/replacements", handleAddReplacement)
dashboardRoutes.delete("/api/replacements/:id", handleDeleteReplacement)
dashboardRoutes.patch("/api/replacements/:id", handleToggleReplacement)
dashboardRoutes.put("/api/replacements/:id", handleUpdateReplacement)

// Model Redirects
dashboardRoutes.get("/api/model-redirects", handleListModelRedirects)
dashboardRoutes.post("/api/model-redirects", handleAddModelRedirect)
dashboardRoutes.delete("/api/model-redirects/:id", handleDeleteModelRedirect)
dashboardRoutes.patch("/api/model-redirects/:id", handleUpdateModelRedirect)
dashboardRoutes.patch(
  "/api/model-redirects/:id/toggle",
  handleToggleModelRedirect,
)
dashboardRoutes.post("/api/model-redirects/:id/move", handleMoveModelRedirect)

// Model Fallbacks
dashboardRoutes.get("/api/fallbacks", handleGetFallbacks)
dashboardRoutes.put("/api/fallbacks", handleSetFallbacks)
dashboardRoutes.delete("/api/fallbacks/cache", handleClearFallbackCache)

// Model Settings
dashboardRoutes.get("/api/model-settings", handleListModelSettings)
dashboardRoutes.post("/api/model-settings", handleSetModelSettings)
dashboardRoutes.delete("/api/model-settings/:model", handleDeleteModelSettings)

// Custom Providers
dashboardRoutes.route(
  "/api/custom-providers",
  createDashboardProviderSecretRoutes(),
)
dashboardRoutes.get("/api/custom-providers", handleListCustomProviders)
dashboardRoutes.post("/api/custom-providers", handleUpsertCustomProvider)
dashboardRoutes.post(
  "/api/custom-providers/nebius-qwen3",
  handleAddNebiusCustomProvider,
)
dashboardRoutes.delete("/api/custom-providers/:id", handleDeleteCustomProvider)

// Model Routing
dashboardRoutes.get("/api/model-routing", handleListModelRouting)
dashboardRoutes.post("/api/model-routing", handleSetModelRouting)

// Usage
dashboardRoutes.get("/api/usage", handleGetUsage)
dashboardRoutes.get("/api/usage-routing", handleGetUsageRouting)

// IP Allowlist
dashboardRoutes.get("/api/ip-allowlist", handleListIpAllowlist)
dashboardRoutes.get(
  "/api/ip-allowlist/current",
  handleGetCurrentIpAllowlistClient,
)
dashboardRoutes.post("/api/ip-allowlist", handleSetIpAllowlistEntry)
dashboardRoutes.delete("/api/ip-allowlist", handleClearIpAllowlist)
dashboardRoutes.patch("/api/ip-allowlist/:ip", handleSetIpAllowlistEntry)
dashboardRoutes.delete("/api/ip-allowlist/:ip", handleDeleteIpAllowlistEntry)

// Trusted JWT Digests
dashboardRoutes.get("/api/trusted-jwt-digests", handleListTrustedJwtDigests)
dashboardRoutes.post("/api/trusted-jwt-digests", handleAddTrustedJwtDigest)
dashboardRoutes.patch(
  "/api/trusted-jwt-digests/:id",
  handleSetTrustedJwtDigestEnabled,
)
dashboardRoutes.delete(
  "/api/trusted-jwt-digests/:id",
  handleDeleteTrustedJwtDigest,
)

// LLM Debug Logs
dashboardRoutes.get("/api/llm-debug", handleListLlmDebugLogs)
dashboardRoutes.post("/api/llm-debug/:id/replay", handleReplayLlmDebugLog)
dashboardRoutes.get("/api/llm-debug/:id", handleGetLlmDebugLog)
dashboardRoutes.delete("/api/llm-debug", handleClearLlmDebugLogs)

// Settings
dashboardRoutes.get("/api/settings", handleGetSettings)
dashboardRoutes.get("/api/settings/export", handleExportSettings)
dashboardRoutes.post("/api/settings/backup", handleBackupSettings)
dashboardRoutes.post(
  "/api/settings/codex-cleanup-model",
  handleSetCodexCleanupModel,
)
