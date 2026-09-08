import type { Context, Next } from "hono"

import { Hono } from "hono"

import type { IssuedOAuthTokens } from "~/lib/oauth-store"

import {
  credentialHasScopes,
  isConfiguredInferenceCredential,
  resolveCredential,
  resolveGatewayCredential,
  resolveRequestCredential,
} from "~/lib/credential-resolver"
import {
  extractClientIp,
  isIpAllowedForWhitelistedRoute,
  isIpBanned,
  isIpBlocked,
  recordFailedAttempt,
  trustAuthenticatedIp,
} from "~/lib/ip-blocker"
import { getOAuthStore } from "~/lib/oauth-store"
import { resolveProtectedCredential } from "~/lib/protected-credential"
import { secureHtml } from "~/lib/secure-html"
import {
  isAllowedTransparentProxyRequest,
  transparentProxy,
} from "~/lib/transparent-proxy"
import { getUsageResponse } from "~/lib/usage-tracker"
import { getFeatureFlags } from "~/routes/feature-flags/store"

const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const MANUAL_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
const ALLOWED_SCOPES = new Set([
  "user:inference",
  "user:profile",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "org:create_api_key",
])

interface AuthorizationRequest {
  clientId: string
  redirectUri: string
  scopes: Array<string>
  state: string
  codeChallenge: string
}

function parseScopes(scope: string): Array<string> {
  return [...new Set(scope.split(/\s+/).filter(Boolean))]
}

function areAllowedScopes(scopes: ReadonlyArray<string>): boolean {
  return scopes.length > 0 && scopes.every((scope) => ALLOWED_SCOPES.has(scope))
}

function isAllowedRedirectUri(value: string): boolean {
  if (value === MANUAL_REDIRECT_URI) return true

  try {
    const redirect = new URL(value)
    const port = Number(redirect.port)
    return (
      redirect.protocol === "http:"
      && redirect.hostname === "localhost"
      && redirect.pathname === "/callback"
      && redirect.username === ""
      && redirect.password === ""
      && redirect.search === ""
      && redirect.hash === ""
      && Number.isInteger(port)
      && port > 0
      && port <= 65_535
    )
  } catch {
    return false
  }
}

// Validation deliberately checks the complete OAuth binding in one place.

function parseAuthorizationRequest(c: Context): AuthorizationRequest | null {
  const url = new URL(c.req.url)
  const requiredParameters = [
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
  ]
  if (
    requiredParameters.some(
      (name) => url.searchParams.getAll(name).length !== 1,
    )
  ) {
    return null
  }
  const clientId = url.searchParams.get("client_id") ?? ""
  const redirectUri = url.searchParams.get("redirect_uri") ?? ""
  const responseType = url.searchParams.get("response_type") ?? ""
  const scope = url.searchParams.get("scope") ?? ""
  const stateParam = url.searchParams.get("state") ?? ""
  const codeChallenge = url.searchParams.get("code_challenge") ?? ""
  const codeChallengeMethod =
    url.searchParams.get("code_challenge_method") ?? ""
  const scopes = parseScopes(scope)

  if (
    clientId !== CLAUDE_CODE_CLIENT_ID
    || responseType !== "code"
    || !isAllowedRedirectUri(redirectUri)
    || !areAllowedScopes(scopes)
    || stateParam.length < 16
    || codeChallengeMethod !== "S256"
    || !/^[\w-]{43}$/.test(codeChallenge)
  ) {
    return null
  }

  return {
    clientId,
    redirectUri,
    scopes,
    state: stateParam,
    codeChallenge,
  }
}

async function readOAuthBody(
  c: Context,
): Promise<Record<string, string> | null> {
  const rawBody = await c.req.text().catch(() => "")
  const contentType = c.req.header("content-type")?.toLowerCase() ?? ""
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const parameters = new URLSearchParams(rawBody)
    const names = [...parameters.keys()]
    if (new Set(names).size !== names.length) return null
    return filterOAuthFields(Object.fromEntries(parameters))
  }

  if (!contentType.includes("application/json")) return null
  const parsed: unknown = (() => {
    try {
      return JSON.parse(rawBody) as unknown
    } catch {
      return null
    }
  })()
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null
  }
  return filterOAuthFields(
    Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  )
}

function filterOAuthFields(
  fields: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(fields))
}

function oauthError(
  c: Context,
  error: string,
  status: 400 | 401 = 400,
): Response {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
  return c.json({ error }, status)
}

function oauthTextError(c: Context, message: string): Response {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
  return c.text(message, 400)
}

function oauthUnauthorized(c: Context): Response {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
}

function tokenResponse(c: Context, tokens: IssuedOAuthTokens): Response {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
  return c.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_in: tokens.expiresIn,
    refresh_token_expires_in: tokens.refreshTokenExpiresIn,
    scope: tokens.scopes.join(" "),
    token_type: "bearer",
  })
}

async function resolveScopedOAuthCredential(
  request: Request,
  scopes: ReadonlyArray<string>,
) {
  const credential = await resolveRequestCredential(request)
  return (
      credential?.kind === "oauth" && credentialHasScopes(credential, scopes)
    ) ?
      credential
    : null
}

function requireOAuthScopes(scopes: ReadonlyArray<string>) {
  return async (c: Context, next: Next): Promise<Response | undefined> => {
    const auth = await resolveProtectedCredential(
      c.req.raw,
      async () => await resolveScopedOAuthCredential(c.req.raw, scopes),
      { trustClientIp: scopes.includes("user:inference") },
    )
    if (auth.status !== "authorized") return oauthUnauthorized(c)
    await next()
    c.header("Cache-Control", "no-store")
  }
}

async function handleAuthorizationCodeGrant(
  c: Context,
  body: Record<string, string>,
): Promise<Response> {
  if (
    !body.code
    || !body.redirect_uri
    || !body.state
    || !body.code_verifier
    || !/^[\w.~-]{43,128}$/.test(body.code_verifier)
  ) {
    return oauthError(c, "invalid_grant")
  }
  if (await isConfiguredInferenceCredential(body.code)) {
    return oauthError(c, "invalid_grant")
  }

  const exchange = await getOAuthStore().exchangeAuthorizationCode({
    code: body.code,
    clientId: body.client_id,
    redirectUri: body.redirect_uri,
    state: body.state,
    codeVerifier: body.code_verifier,
  })
  if (exchange.status !== "ok") return oauthError(c, "invalid_grant")
  return tokenResponse(c, exchange.tokens)
}

async function handleRefreshTokenGrant(
  c: Context,
  body: Record<string, string>,
): Promise<Response> {
  if (!body.refresh_token) return oauthError(c, "invalid_grant")
  if (await isConfiguredInferenceCredential(body.refresh_token)) {
    return oauthError(c, "invalid_grant")
  }
  const requestedScopes = body.scope ? parseScopes(body.scope) : undefined
  if (requestedScopes !== undefined && !areAllowedScopes(requestedScopes)) {
    return oauthError(c, "invalid_scope")
  }

  const refresh = await getOAuthStore().refreshAccessToken({
    refreshToken: body.refresh_token,
    clientId: body.client_id,
    scopes: requestedScopes,
  })
  if (refresh.status === "invalid_scope") {
    return oauthError(c, "invalid_scope")
  }
  if (refresh.status !== "ok") return oauthError(c, "invalid_grant")
  return tokenResponse(c, refresh.tokens)
}

/**
 * Auth guard for OAuth API routes.
 * Requires a scoped OAuth token (or the operator gateway credential).
 * These routes are compatibility stubs, so denials never feed the IP ban
 * tracker — Claude Code polls them in the background and API-key clients
 * (third-party-provider mode) legitimately hold a non-OAuth credential.
 */
function oauthScopeGuard(...scopes: Array<string>) {
  return async (c: Context, next: Next): Promise<Response | undefined> => {
    const auth = await resolveProtectedCredential(
      c.req.raw,
      async () => await resolveScopedOAuthCredential(c.req.raw, scopes),
      {
        recordFailures: false,
        trustClientIp: scopes.includes("user:inference"),
      },
    )
    if (auth.status !== "authorized") return oauthUnauthorized(c)
    await next()
    c.header("Cache-Control", "no-store")
  }
}

const oauthProfileGuard = oauthScopeGuard("user:profile")
const oauthInferenceGuard = oauthScopeGuard("user:inference")
const oauthSessionGuard = oauthScopeGuard("user:sessions:claude_code")
const oauthMcpGuard = oauthScopeGuard("user:mcp_servers")
const oauthFileUploadGuard = oauthScopeGuard("user:file_upload")

// --- Browser routes: mounted at /oauth ---

export const oauthBrowserRoutes = new Hono()

// GET /oauth/authorize — show login form requiring API key
oauthBrowserRoutes.get("/authorize", (c) => {
  const authorizationRequest = parseAuthorizationRequest(c)
  const queryString = new URL(c.req.url).search

  if (!authorizationRequest) {
    return oauthTextError(c, "Invalid OAuth authorization request")
  }

  return secureHtml(
    c,
    getAuthorizePage(queryString),
    new URL(authorizationRequest.redirectUri),
  )
})

// POST /oauth/authorize — validate API key, then redirect
oauthBrowserRoutes.post("/authorize", async (c) => {
  const authorizationRequest = parseAuthorizationRequest(c)
  if (!authorizationRequest) {
    return oauthTextError(c, "Invalid OAuth authorization request")
  }

  const clientIp = extractClientIp(c)

  const body = await readOAuthBody(c)
  // Sparse form bodies are valid inputs even though the filtered record type is
  // string-valued for keys that are present.

  const apiKey = body?.api_key ?? ""

  const credential = apiKey ? await resolveCredential(apiKey) : null
  if (credential?.kind === "gateway") {
    if (
      clientIp !== null
      && authorizationRequest.scopes.includes("user:inference")
    ) {
      await trustAuthenticatedIp(clientIp)
    }
    const code = await getOAuthStore().issueAuthorizationCode({
      ...authorizationRequest,
    })
    const url = new URL(authorizationRequest.redirectUri)
    url.searchParams.set("code", code)
    url.searchParams.set("state", authorizationRequest.state)
    c.header("Cache-Control", "no-store")
    c.header("Pragma", "no-cache")
    return c.redirect(url.toString(), 302)
  }

  if (clientIp !== null && isIpBlocked(clientIp)) {
    return oauthUnauthorized(c)
  }

  if (clientIp !== null) {
    recordFailedAttempt(clientIp)
  }

  const queryString = new URL(c.req.url).search
  const response = secureHtml(
    c,
    getAuthorizePage(queryString, "Invalid API key"),
    new URL(authorizationRequest.redirectUri),
  )
  return new Response(response.body, {
    status: 401,
    headers: response.headers,
  })
})

// GET /oauth/code/success — success page
oauthBrowserRoutes.get("/code/success", (c) => {
  return secureHtml(
    c,
    "<html><body><h1>Login successful</h1><p>You can close this tab.</p></body></html>",
  )
})

// GET /oauth/code/callback — manual callback fallback
oauthBrowserRoutes.get("/code/callback", (c) => {
  const code = c.req.query("code") ?? ""
  const stateParam = c.req.query("state")
  const manualCode = stateParam ? `${code}#${stateParam}` : code

  return secureHtml(
    c,
    `<html><body><h1>Authorization Code</h1><p>Copy this code into Claude Code:</p><pre>${escapeHtml(manualCode)}</pre></body></html>`,
  )
})

// --- Token routes: mounted at /v1/oauth ---

export const oauthTokenRoutes = new Hono()

// GET /v1/oauth/hello — connectivity check
oauthTokenRoutes.get("/hello", (c) => c.json({ status: "ok" }))

// Auth guard — Claude Code sends the code + code_verifier, no API key.
// Validate the auth code matches what we issued.
oauthTokenRoutes.post("/token", async (c) => {
  const body = await readOAuthBody(c)
  if (!body) return oauthError(c, "invalid_request")
  const grantType = body.grant_type

  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(c, "unsupported_grant_type")
  }

  if (body.client_id !== CLAUDE_CODE_CLIENT_ID) {
    return oauthError(c, "invalid_client", 401)
  }

  if (grantType === "authorization_code") {
    return await handleAuthorizationCodeGrant(c, body)
  }
  return await handleRefreshTokenGrant(c, body)
})

oauthTokenRoutes.post("/revoke", async (c) => {
  const body = await readOAuthBody(c)
  if (body?.client_id === CLAUDE_CODE_CLIENT_ID && body.token) {
    await getOAuthStore().revokeToken(body.token)
  }
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
  return c.body(null, 200)
})

// --- API routes: mounted at /api ---

export const oauthApiRoutes = new Hono()

// GET /api/hello — connectivity check (no auth)
oauthApiRoutes.get("/hello", (c) => c.json({ status: "ok" }))

// /api/event_logging/* — block telemetry upstream while keeping clients happy.
oauthApiRoutes.all("/event_logging/*", (c) => c.body(null, 200))

// GET /api/web/domain_info — domain safety check, allow all (no auth)
oauthApiRoutes.get("/web/domain_info", (c) => {
  const domain = c.req.query("domain") ?? ""
  return c.json({ domain, can_fetch: true })
})

// Defined compatibility routes require valid Bearer token / x-api-key.
// Unknown /api/* routes fall through to the sink at the end of this router.

// GET /api/oauth/profile — fake profile
oauthApiRoutes.get("/oauth/profile", oauthProfileGuard, (c) => {
  return c.json({
    account: {
      uuid: "00000000-0000-4000-8000-000000000001",
      display_name: "Copilot API User",
      created_at: "2025-01-01T00:00:00Z",
    },
    organization: {
      uuid: "00000000-0000-4000-8000-000000000002",
      organization_type: "claude_max",
      rate_limit_tier: "max",
      billing_type: "self-serve",
      has_extra_usage_enabled: true,
      subscription_created_at: "2025-01-01T00:00:00Z",
    },
  })
})

// GET /api/oauth/claude_cli/roles
oauthApiRoutes.get("/oauth/claude_cli/roles", oauthProfileGuard, (c) =>
  c.json([]),
)

// GET /api/claude_code_penguin_mode — org fast-mode ("penguin mode") status.
// Claude Code fetches this directly (NOT via GrowthBook) to decide whether
// `/fast` is allowed. It reads `enabled`; a missing/false value is treated as
// disabled with reason "preference" → "Fast mode has been disabled by your
// organization". Controlled by the `claude_code_penguin_mode` feature flag,
// which defaults to enabled — flip it to false to turn fast mode off.
oauthApiRoutes.get("/claude_code_penguin_mode", oauthInferenceGuard, (c) => {
  const flag = getFeatureFlags().claude_code_penguin_mode
  const enabled = flag !== false && flag !== "false"
  return c.json(
    enabled ?
      { enabled: true }
    : { enabled: false, disabled_reason: "preference" },
  )
})

// GET /api/claude_cli_profile
oauthApiRoutes.get("/claude_cli_profile", oauthProfileGuard, (c) => c.json({}))

// GET /api/oauth/usage — usage data for settings panel
oauthApiRoutes.get("/oauth/usage", oauthProfileGuard, async (c) =>
  c.json(await getUsageResponse()),
)

// GET /api/oauth/claude_cli/client_data
oauthApiRoutes.get("/oauth/claude_cli/client_data", oauthProfileGuard, (c) =>
  c.json({}),
)

// POST /api/oauth/claude_cli/create_api_key
oauthApiRoutes.post(
  "/oauth/claude_cli/create_api_key",
  requireOAuthScopes(["org:create_api_key"]),
  async (c) => {
    const rawKey = await getOAuthStore().mintInferenceCredential()
    c.header("Cache-Control", "no-store")
    c.header("Pragma", "no-cache")
    return c.json({ raw_key: rawKey })
  },
)

// POST /api/claude_cli_feedback
oauthApiRoutes.post("/claude_cli_feedback", oauthInferenceGuard, (c) =>
  c.json({ success: true }),
)

// POST /api/claude_code/metrics
oauthApiRoutes.post("/claude_code/metrics", oauthInferenceGuard, (c) =>
  c.json({ success: true }),
)

// GET /api/claude_code/organizations/metrics_enabled
oauthApiRoutes.get(
  "/claude_code/organizations/metrics_enabled",
  oauthInferenceGuard,
  (c) => c.json({ enabled: false }),
)

// POST /api/claude_code/link_vcs_account
oauthApiRoutes.post("/claude_code/link_vcs_account", oauthProfileGuard, (c) =>
  c.json({ success: true }),
)

// GET /api/claude_code/user_settings
oauthApiRoutes.get("/claude_code/user_settings", oauthProfileGuard, (c) =>
  c.json({}),
)

// PUT /api/claude_code/user_settings
oauthApiRoutes.put("/claude_code/user_settings", oauthProfileGuard, (c) =>
  c.json({ success: true }),
)

// GET /api/organization
oauthApiRoutes.get("/organization/:id", oauthProfileGuard, (c) =>
  c.json({
    uuid: c.req.param("id"),
    name: "Copilot API",
    settings: {},
  }),
)

// GET /api/oauth/claude_cli/organizations — organization list
oauthApiRoutes.get("/oauth/claude_cli/organizations", oauthProfileGuard, (c) =>
  c.json([
    {
      uuid: "00000000-0000-4000-8000-000000000002",
      name: "Copilot API",
      organization_type: "claude_max",
      rate_limit_tier: "max",
      billing_type: "self-serve",
    },
  ]),
)

// GET /api/claude_code/organizations/:orgId/mcp_servers
oauthApiRoutes.get(
  "/claude_code/organizations/:orgId/mcp_servers",
  oauthMcpGuard,
  (c) => c.json({ mcp_servers: [] }),
)

// POST /api/claude_code/organizations/:orgId/mcp_servers
oauthApiRoutes.post(
  "/claude_code/organizations/:orgId/mcp_servers",
  oauthMcpGuard,
  (c) => c.json({ success: true }),
)

// GET /api/claude_code/organizations/:orgId/integrations
oauthApiRoutes.get(
  "/claude_code/organizations/:orgId/integrations",
  oauthMcpGuard,
  (c) => c.json({ integrations: [] }),
)

// GET /api/claude_code/task_runners
oauthApiRoutes.get("/claude_code/task_runners", oauthSessionGuard, (c) =>
  c.json({ task_runners: [] }),
)

// POST /api/claude_code/tasks
oauthApiRoutes.post("/claude_code/tasks", oauthSessionGuard, (c) =>
  c.json({ success: true }),
)

// GET /api/claude_code/environments
oauthApiRoutes.get("/claude_code/environments", oauthSessionGuard, (c) =>
  c.json({ environments: [] }),
)

// POST /api/claude_code/organizations/:orgId/file_upload
oauthApiRoutes.post(
  "/claude_code/organizations/:orgId/file_upload",
  oauthFileUploadGuard,
  (c) => c.json({ success: true }),
)

// GET /api/claude_code/organizations/:orgId/policy_limits
oauthApiRoutes.get(
  "/claude_code/organizations/:orgId/policy_limits",
  oauthSessionGuard,
  (c) => c.json({ limits: {}, policies: [] }),
)

// GET /api/claude_code/skill_search
oauthApiRoutes.get("/claude_code/skill_search", oauthSessionGuard, (c) =>
  c.json({ results: [] }),
)

// PATCH /api/claude_code/sessions/:id
oauthApiRoutes.patch("/claude_code/sessions/:id", oauthSessionGuard, (c) =>
  c.json({ success: true }),
)

// GET /api/claude_code/policy_limits (non-org path)
oauthApiRoutes.get("/claude_code/policy_limits", oauthSessionGuard, (c) =>
  c.json({ limits: {}, policies: [] }),
)

// GET /api/claude_code/settings — remote managed settings. Claude Code treats
// 204 (and 404) as an explicit "no policy configured" result. A successful
// JSON response must instead contain its uuid/checksum/settings envelope, so a
// bare object is a parse error in current clients.
oauthApiRoutes.get("/claude_code/settings", oauthSessionGuard, (c) =>
  c.body(null, 204),
)

// PUT /api/claude_code/settings
oauthApiRoutes.put("/claude_code/settings", oauthSessionGuard, (c) =>
  c.json({ success: true }),
)

// GET /api/claude_code/team_memory
oauthApiRoutes.get("/claude_code/team_memory", oauthSessionGuard, (c) =>
  c.json({ memories: [] }),
)

// GET /api/claude_code_grove
oauthApiRoutes.get("/claude_code_grove", oauthSessionGuard, (c) => c.json({}))

// GET /api/claude_cli/bootstrap
oauthApiRoutes.get("/claude_cli/bootstrap", oauthProfileGuard, (c) =>
  c.json({}),
)

// GET /api/oauth/account/settings
oauthApiRoutes.get("/oauth/account/settings", oauthProfileGuard, (c) =>
  c.json({}),
)

// POST /api/oauth/account/grove_notice_viewed
oauthApiRoutes.post(
  "/oauth/account/grove_notice_viewed",
  oauthProfileGuard,
  (c) => c.json({ success: true }),
)

// GET /api/oauth/organizations/:orgId/* (various sub-routes)
oauthApiRoutes.get(
  "/oauth/organizations/:orgId/overage_credit_grant",
  oauthProfileGuard,
  (c) => c.json({ grants: [] }),
)
oauthApiRoutes.get(
  "/oauth/organizations/:orgId/sync/github/auth",
  oauthProfileGuard,
  (c) => c.json({ authorized: false }),
)
oauthApiRoutes.get(
  "/oauth/organizations/:orgId/code/repos/:owner/:repo",
  oauthProfileGuard,
  (c) => c.json({}),
)
oauthApiRoutes.get(
  "/oauth/organizations/:orgId/admin_requests/eligibility",
  oauthProfileGuard,
  (c) => c.json({ eligible: false }),
)
oauthApiRoutes.get(
  "/oauth/organizations/:orgId/admin_requests",
  oauthProfileGuard,
  (c) => c.json({ requests: [] }),
)
oauthApiRoutes.post(
  "/oauth/organizations/:orgId/admin_requests",
  oauthProfileGuard,
  (c) => c.json({ success: true }),
)
oauthApiRoutes.get(
  "/oauth/organizations/:orgId/admin_requests/me",
  oauthProfileGuard,
  (c) => c.json({ requests: [] }),
)
oauthApiRoutes.get(
  "/oauth/organizations/:orgId/referral/eligibility",
  oauthProfileGuard,
  (c) => c.json({ eligible: false }),
)
oauthApiRoutes.get(
  "/oauth/organizations/:orgId/referral/redemptions",
  oauthProfileGuard,
  (c) => c.json({ redemptions: [] }),
)

// GET /api/organization/claude_code_first_token_date
oauthApiRoutes.get(
  "/organization/claude_code_first_token_date",
  oauthProfileGuard,
  (c) => c.json({ first_token_date: "2025-01-01T00:00:00Z" }),
)

// POST /api/organizations/:orgId/claude_code/buddy_react
oauthApiRoutes.post(
  "/organizations/:orgId/claude_code/buddy_react",
  oauthProfileGuard,
  (c) => c.json({ success: true }),
)

// Unknown /api/* calls from redirected Claude/Anthropic hosts require an
// inference credential or credential-free IP authorization.
oauthApiRoutes.all("*", async (c) => {
  if (!isAllowedTransparentProxyRequest(c)) {
    return c.notFound()
  }

  const clientIp = extractClientIp(c)
  const gatewayHeaderPresent = c.req.raw.headers.has("x-copilot-gateway-key")
  if (gatewayHeaderPresent) {
    const credential = await resolveGatewayCredential(
      c.req.raw.headers.get("x-copilot-gateway-key") ?? "",
      ["user:inference"],
    )
    if (!credential) {
      if (clientIp !== null && !isIpBanned(clientIp)) {
        recordFailedAttempt(clientIp)
      }
      return oauthUnauthorized(c)
    }
    if (clientIp !== null) await trustAuthenticatedIp(clientIp)
    return await transparentProxy(c)
  }

  if (clientIp !== null && (await isIpAllowedForWhitelistedRoute(clientIp))) {
    return await transparentProxy(c)
  }

  if (clientIp !== null && !isIpBanned(clientIp)) {
    recordFailedAttempt(clientIp)
  }
  return oauthUnauthorized(c)
})

// --- Authorize page HTML ---

function getAuthorizePage(queryString: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize — Copilot API</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2rem; width: 100%; max-width: 380px; }
  h1 { font-size: 1.2rem; color: #e6edf3; margin-bottom: 0.5rem; }
  p { font-size: 0.85rem; color: #8b949e; margin-bottom: 1.5rem; }
  input[type="password"] { width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 0.6rem 0.75rem; border-radius: 6px; font-size: 0.9rem; outline: none; margin-bottom: 1rem; }
  input[type="password"]:focus { border-color: #58a6ff; }
  button { width: 100%; padding: 0.6rem; border-radius: 6px; border: none; background: #238636; color: #fff; font-size: 0.9rem; cursor: pointer; }
  button:hover { background: #2ea043; }
  .error { color: #f85149; font-size: 0.85rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorize Claude Code</h1>
  <p>Enter your API key to continue.</p>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/oauth/authorize${escapeHtml(queryString)}">
    <input type="password" name="api_key" placeholder="API key" autofocus required>
    <button type="submit">Authorize</button>
  </form>
</div>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
