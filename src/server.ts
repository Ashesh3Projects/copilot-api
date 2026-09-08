import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import { runWithCopilotContractObservabilityScope } from "~/lib/copilot-contract-observability"
import {
  type CopilotRequestAttribution,
  resolveCopilotRequestAttribution,
  runWithCopilotRequestAttribution,
} from "~/lib/copilot-request-context"
import {
  type RoutingAffinity,
  resolveRoutingAffinityFromHeaders,
  runWithRoutingAffinity,
} from "~/lib/routing-affinity"

import { authenticateAdminRequest } from "./lib/admin-auth"
import {
  apiKeyGuard,
  isVerifiedTransparentProxyRequest,
} from "./lib/api-key-guard"
import { forwardError } from "./lib/error"
import { inferenceCors } from "./lib/inference-cors"
import { createAuthMiddleware } from "./lib/request-auth"
import { requestLogger } from "./lib/request-logger"
import {
  createRoutingTelemetryRequestState,
  copilotResponseHeadersStorage,
  getCopilotResponseHeaders,
  requestIdStorage,
  routedAccountStorage,
  routingTelemetryStorage,
  runWithRequestDiagnostics,
} from "./lib/request-session"
import { storageAdmission } from "./lib/storage/admission"
import { transparentProxy } from "./lib/transparent-proxy"
import { audioTranscriptionRoutes } from "./routes/audio-transcriptions/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { claudeCompatibilityRoutes } from "./routes/claude-compat/route"
import { codeSessionsRoutes } from "./routes/code-sessions/route"
import { codexAuthRoutes } from "./routes/codex-auth/route"
import { codexPluginServiceRoutes } from "./routes/codex-plugins/route"
import { codexResponsesRoutes } from "./routes/codex-responses/route"
import { codexSearchRoutes } from "./routes/codex-search/route"
import { computerUsePolicyRoutes } from "./routes/computer-use-policy/route"
import { copilotControlPlaneRoutes } from "./routes/copilot-control-plane/route"
import { dashboardRoutes } from "./routes/dashboard/route"
import { directConnectRoutes } from "./routes/direct-connect/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { environmentsRoutes } from "./routes/environments/route"
import { googleAIRoutes } from "./routes/google-ai/route"
import { growthbookRoutes } from "./routes/growthbook/route"
import { healthRoutes } from "./routes/health/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import {
  oauthApiRoutes,
  oauthBrowserRoutes,
  oauthTokenRoutes,
} from "./routes/oauth/route"
import { remoteRoutes } from "./routes/remote/route"
import { responsesRoutes } from "./routes/responses/route"
import { sessionsRoutes } from "./routes/sessions/route"
import { statsigProxyMiddleware } from "./routes/statsig-overrides/proxy"
import { transcribeRoutes } from "./routes/transcribe/route"
import { usageRoute } from "./routes/usage/route"
import { whamRoutes } from "./routes/wham/route"

export const server = new Hono()

export function getRoutingSourceProtocol(path: string): string {
  if (path.includes("/count_tokens")) return "Token Count"
  if (
    /^\/(?:v1\/|v1beta\/)?models\/[^/]+:(?:generateContent|streamGenerateContent|countTokens)$/.test(
      path,
    )
  ) {
    return "Google AI"
  }
  if (path.includes("/messages")) return "Messages"
  if (path.includes("/responses")) return "Responses"
  if (path.includes("/chat/completions")) return "Chat Completions"
  if (path.includes("/embeddings")) return "Embeddings"
  if (path.includes("/audio/transcriptions")) return "Audio Transcriptions"
  if (path.endsWith("/complete")) return "Legacy Complete"
  if (path.includes("/search")) return "Search"
  return "HTTP"
}

function applySecurityHeaders(c: {
  header(name: string, value: string): void
}): void {
  c.header("X-Content-Type-Options", "nosniff")
  c.header("X-Frame-Options", "DENY")
  c.header("Referrer-Policy", "no-referrer")
  c.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  )
  c.header("Cross-Origin-Opener-Policy", "same-origin")
  c.header("Cross-Origin-Resource-Policy", "same-origin")
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
}

async function runWithRequestRoutingScopes<T>(
  attribution: CopilotRequestAttribution,
  affinity: RoutingAffinity | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const runWithDiagnostics = async () =>
    await runWithRequestDiagnostics(
      async () => await runWithCopilotContractObservabilityScope(callback),
    )
  return await runWithCopilotRequestAttribution(
    attribution,
    async () =>
      await runWithRoutingAffinity(
        affinity,
        async () =>
          await copilotResponseHeadersStorage.run(
            {},
            async () => await routedAccountStorage.run({}, runWithDiagnostics),
          ),
      ),
  )
}

// Global middleware — applied to ALL routes including pre-auth ones
server.use("*", storageAdmission)
server.use("*", statsigProxyMiddleware)
server.use("*", async (c, next) => {
  const telemetryState = createRoutingTelemetryRequestState(
    getRoutingSourceProtocol(c.req.path),
  )
  await routingTelemetryStorage.run(telemetryState, next)
})
server.use(requestLogger)
server.use("*", inferenceCors)
server.use("*", async (c, next) => {
  await next()
  applySecurityHeaders(c)
})

// Capture the highest-priority safe conversation identity for account affinity.
server.use("*", async (c, next) => {
  const affinity = resolveRoutingAffinityFromHeaders(c.req.raw.headers)
  const attribution = resolveCopilotRequestAttribution(c.req.raw.headers)
  const requestId = c.req.header("x-request-id") ?? randomUUID()

  await requestIdStorage.run(requestId, async () => {
    await runWithRequestRoutingScopes(attribution, affinity, async () => {
      await next()

      for (const [key, value] of Object.entries(getCopilotResponseHeaders())) {
        if (key === "x-request-id") continue
        c.header(key, value)
      }
    })
  })

  c.header("x-request-id", requestId)
})

// Routes that bypass apiKeyGuard and auth middleware
// GrowthBook remote eval — Claude Code's SDK calls this for feature flags
server.route("/api/eval", growthbookRoutes)
server.get("/feature-flags", (c) => c.redirect("/dashboard#flags", 302))
server.all("/feature-flags/*", (c) => c.redirect("/dashboard#flags", 302))
// Dashboard admin page (HTML served unauthenticated; API sub-routes have their own auth)
server.route("/dashboard", dashboardRoutes)
// Remote Control page (HTML served unauthenticated; uses dashboard API for auth)
server.route("/remote", remoteRoutes)
// Legacy code-launcher URLs are administrator browser surfaces. Keep them
// before the data-plane guard and authorize with the admin cookie only.
server.get("/code/:sessionKey", async (c) => {
  const adminSession = await authenticateAdminRequest(c.req.raw)
  if (!adminSession) return c.redirect("/dashboard", 302)
  const sessionKey = c.req.param("sessionKey")
  const sessionId =
    sessionKey.startsWith("session_") ?
      `cse_${sessionKey.slice("session_".length)}`
    : sessionKey
  return c.redirect(`/remote?session=${encodeURIComponent(sessionId)}`)
})
server.get("/code", async (c) => {
  const adminSession = await authenticateAdminRequest(c.req.raw)
  if (!adminSession) return c.redirect("/dashboard", 302)
  return c.redirect("/dashboard#environments")
})
// OAuth fake layer — authorize, token exchange, profile
server.route("/oauth", oauthBrowserRoutes)
server.route("/v1/oauth", oauthTokenRoutes)
server.route("/api", oauthApiRoutes)
// Code Sessions — Claude Code authenticates via its own bearer tokens
server.route("/v1/code/sessions", codeSessionsRoutes)
// OAuth-only subscriber compatibility routes. These are intentionally mounted
// before the inference guard because some valid OAuth clients request only the
// session or MCP scope.
server.route("/v1", claudeCompatibilityRoutes)
// Sessions compat layer — used by v1 and v2 bridges
server.route("/v1/sessions", sessionsRoutes)
// Bridge Environments — v1 poll-based Remote Control protocol
server.route("/v1/environments", environmentsRoutes)
// Minimal liveness check. No session or configuration data is exposed here.
server.route("/health", healthRoutes)
// Codex Desktop dictation — auth via IP whitelist (see route file)
server.route("/transcribe", transcribeRoutes)
// Codex Desktop dictation transcript cleanup — auth via IP whitelist
server.route("/codex/responses", codexResponsesRoutes)
// Codex Desktop synthetic ChatGPT identities refresh without an Authorization
// header. The versioned refresh token is validated against the managed JWT
// digest registry inside this narrowly scoped route.
server.route("/v1/codex/auth", codexAuthRoutes)
// Codex Desktop plugin-service compatibility. The synthetic ChatGPT identity
// is valid only locally: the route authenticates it here, never forwards it,
// and lets Desktop continue into its configured local marketplace engine.
server.route("/ps", codexPluginServiceRoutes)
// Codex Desktop cloud-task endpoints. Returning a fast 404 lets Desktop fall
// back to local-only views instead of hanging behind proxy/auth silent drops.
server.route("/wham", whamRoutes)
// Computer Use URL policy compatibility. The helper may call this with the
// ChatGPT backend prefix or directly against the custom Codex API base.
server.route("/backend-api", computerUsePolicyRoutes)
server.route("", computerUsePolicyRoutes)

server.use(apiKeyGuard)
const inferenceAuth = createAuthMiddleware()
server.use("*", async (c, next) => {
  if (isVerifiedTransparentProxyRequest(c.req.raw)) {
    await next()
    return
  }
  // The middleware's Hono generic is broader than this server instance, but
  // the runtime Context/Next contract is identical.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  await inferenceAuth(c, next)
})

// Direct Connect is disabled by default and, when explicitly enabled for
// private development, remains behind both normal authentication layers.
server.route("/sessions", directConnectRoutes)

server.onError(async (err, c) => {
  return await forwardError(c, err)
})

server.get("/", (c) => c.text("Server running"))

server.route("", copilotControlPlaneRoutes)
server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
// Traffic-shaping config (replacements / model-redirects) is admin-only via
// /dashboard/api/* (admin session cookie + CSRF). Do not re-expose under
// inference credentials — that was CS-02 (cross-client integrity).
server.route("/responses", responsesRoutes)
server.route("/alpha/search", codexSearchRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1beta/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/audio/transcriptions", audioTranscriptionRoutes)
server.route("/v1/responses", responsesRoutes)
server.route("/v1/alpha/search", codexSearchRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
// Google Generative AI compatible endpoints
// Handles POST /v1/models/{model}:generateContent and :streamGenerateContent
server.route("/v1/models", googleAIRoutes)
server.route("/v1beta/models", googleAIRoutes)
server.route("/models", googleAIRoutes)

server.all("*", transparentProxy)
