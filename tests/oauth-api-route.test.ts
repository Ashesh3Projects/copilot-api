import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import consola from "consola"
import { createHash } from "node:crypto"

import { mergeConfigWithDefaults } from "../src/lib/config"
import { resolveCredential } from "../src/lib/credential-resolver"
import { listIpAllowlist, setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import {
  isIpBlocked,
  recordFailedAttempt,
  resetIpSecurityForTest,
} from "../src/lib/ip-blocker"
import {
  createPkceChallenge,
  OAuthStore,
  setOAuthStoreForTest,
} from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import {
  removeFeatureFlag,
  setFeatureFlag,
} from "../src/routes/feature-flags/store"
import { server } from "../src/server"
import { createAuthStorageFixture } from "./helpers/auth-storage"

const originalApiKeyAuth = state.apiKeyAuth
const originalInferenceCredentialDigests =
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
const originalWarn = consola.warn
const oauthClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const oauthRedirectUri = "https://platform.claude.com/oauth/code/callback"
const oauthScopes =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
const oauthVerifier = "v".repeat(64)
const oauthState = "state-with-enough-entropy-123456789"
let authFixture: Awaited<ReturnType<typeof createAuthStorageFixture>>

async function setInferenceCredentialDigests(
  value: string | undefined,
): Promise<void> {
  await authFixture.storage.transaction(async (session) => {
    await session.execute({
      sql: "DELETE FROM capi_inference_credentials WHERE kind = 'managed'",
      args: [],
    })
    if (value)
      await session.execute({
        sql: "INSERT INTO capi_inference_credentials(digest,id,kind,principal_id,label,enabled,scopes_json,created_at,updated_at) VALUES(?,?,'managed',?,NULL,1,?,0,0)",
        args: [
          value,
          "fixture-managed",
          "inference-managed:fixture-managed",
          '["user:inference"]',
        ],
      })
  })
}
function authorizationQuery(
  redirectUri: string = oauthRedirectUri,
): URLSearchParams {
  return new URLSearchParams({
    client_id: oauthClientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: oauthScopes,
    code_challenge: createPkceChallenge(oauthVerifier),
    code_challenge_method: "S256",
    state: oauthState,
  })
}

beforeEach(async () => {
  authFixture = await createAuthStorageFixture()
  await mergeConfigWithDefaults()
  setIpAllowlistForTest([])
  state.apiKeyAuth = "test-secret-key"
  resetIpSecurityForTest()
  consola.warn = mock(() => {}) as unknown as typeof consola.warn
  await authFixture.storage.transaction((session) =>
    session.execute({
      sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES(?,?,?,0)",
      args: ["fixture-gateway", sha256Hex("test-secret-key"), "test"],
    }),
  )
  setOAuthStoreForTest(new OAuthStore({ storage: authFixture.storage }))
})

afterEach(async () => {
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
  setOAuthStoreForTest(null)
  await authFixture.close()
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  consola.warn = originalWarn
  if (originalInferenceCredentialDigests === undefined)
    delete process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  else
    process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S =
      originalInferenceCredentialDigests
})
test("accepts versioned telemetry calls without auth", async () => {
  const response = await server.request("/api/event_logging/v2/batch", {
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toBe("")
})

test("denies unknown /api calls instead of acknowledging them pre-auth", async () => {
  const response = await server.request("/api/unknown/noop", {
    method: "POST",
  })

  expect(response.status).toBe(404)
})

test("still requires auth for defined OAuth API routes", async () => {
  const unauthorizedResponse = await server.request("/api/oauth/profile")

  expect(unauthorizedResponse.status).toBe(401)

  const gatewayResponse = await server.request("/api/oauth/profile", {
    headers: { authorization: "Bearer test-secret-key" },
  })

  expect(gatewayResponse.status).toBe(401)
})

test("penguin mode reports fast mode enabled by default", async () => {
  await removeFeatureFlag("claude_code_penguin_mode")

  const tokens = await authorizeAndExchange()
  const response = await server.request("/api/claude_code_penguin_mode", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ enabled: true })
})

test("penguin mode honors the claude_code_penguin_mode flag when disabled", async () => {
  await setFeatureFlag("claude_code_penguin_mode", false)

  try {
    const tokens = await authorizeAndExchange()
    const response = await server.request("/api/claude_code_penguin_mode", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      enabled: false,
      disabled_reason: "preference",
    })
  } finally {
    await removeFeatureFlag("claude_code_penguin_mode")
  }
})

test("manual OAuth callback displays code with state for Claude Code paste", async () => {
  const response = await server.request(
    "/oauth/code/callback?code=copilot-api-auth-code&state=test-state",
  )

  expect(response.status).toBe(200)
  expect(await response.text()).toContain(
    "<pre>copilot-api-auth-code#test-state</pre>",
  )
})

test("manual OAuth callback escapes displayed code", async () => {
  const response = await server.request(
    "/oauth/code/callback?code=%3Ccode%3E&state=a%26b",
  )

  expect(response.status).toBe(200)
  expect(await response.text()).toContain("<pre>&lt;code&gt;#a&amp;b</pre>")
})

test("OAuth authorize page allows the exact local callback origin", async () => {
  const response = await server.request(
    `/oauth/authorize?${authorizationQuery("http://localhost:43123/callback").toString()}`,
  )

  expect(response.status).toBe(200)
  const csp = response.headers.get("content-security-policy")
  expect(csp).toContain("form-action 'self' http://localhost:43123;")
  expect(csp).not.toContain("localhost:*")
  expect(csp).not.toContain("http://localhost;")
})

test("OAuth authorize page allows the exact manual callback origin", async () => {
  const response = await server.request(
    `/oauth/authorize?${authorizationQuery().toString()}`,
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-security-policy")).toContain(
    "form-action 'self' https://platform.claude.com;",
  )
})

test("OAuth authorize rejects a missing api_key without throwing", async () => {
  const response = await server.request(
    `/oauth/authorize?${authorizationQuery().toString()}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    },
  )

  expect(response.status).toBe(401)
  expect(await response.text()).toContain("Invalid API key")
})

test("invalid OAuth API key response retains the callback origin", async () => {
  const response = await server.request(
    `/oauth/authorize?${authorizationQuery("http://localhost:43124/callback").toString()}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: "invalid-key" }).toString(),
    },
  )

  expect(response.status).toBe(401)
  expect(response.headers.get("content-security-policy")).toContain(
    "form-action 'self' http://localhost:43124;",
  )
})

test("a valid OAuth login recovers a client from an active IP ban", async () => {
  const clientIp = "198.51.100.91"
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "x-copilot-peer-ip": clientIp,
  }
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  expect(isIpBlocked(clientIp)).toBe(true)

  const response = await server.request(
    `/oauth/authorize?${authorizationQuery().toString()}`,
    {
      method: "POST",
      headers,
      body: new URLSearchParams({ api_key: "test-secret-key" }).toString(),
    },
  )

  expect(response.status).toBe(302)
  expect(isIpBlocked(clientIp)).toBe(false)
})

test("a profile-only OAuth login does not recover or allowlist a banned IP", async () => {
  const clientIp = "198.51.100.92"
  const query = authorizationQuery()
  query.set("scope", "user:profile")
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "x-copilot-peer-ip": clientIp,
  }
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  expect(isIpBlocked(clientIp)).toBe(true)

  const response = await server.request(
    `/oauth/authorize?${query.toString()}`,
    {
      method: "POST",
      headers,
      body: new URLSearchParams({ api_key: "test-secret-key" }).toString(),
    },
  )

  expect(response.status).toBe(302)
  expect(isIpBlocked(clientIp)).toBe(true)
  expect(await listIpAllowlist()).toEqual([])
})

test("unknown credentials across surfaces share the IP tracker", async () => {
  const clientIp = "198.51.100.90"
  const peer = { "x-copilot-peer-ip": clientIp }
  const query = authorizationQuery()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await server.request(
      `/oauth/authorize?${query.toString()}`,
      {
        method: "POST",
        headers: {
          ...peer,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ api_key: "invalid-key" }).toString(),
      },
    )
    expect(response.status).toBe(401)
  }

  const unknownToken = await server.request(
    "/api/oauth/claude_cli/create_api_key",
    {
      method: "POST",
      headers: {
        ...peer,
        "x-api-key": "cc_at_not-a-real-token",
      },
    },
  )
  expect(unknownToken.status).toBe(401)
  expect(isIpBlocked(clientIp)).toBe(true)

  const tokens = await authorizeAndExchange()
  const banned = await server.request("/api/oauth/profile", {
    headers: {
      ...peer,
      "x-api-key": tokens.access_token,
    },
  })
  expect(banned.status).toBe(401)
})

test("compatibility stub routes never feed the IP ban tracker", async () => {
  const clientIp = "198.51.100.77"
  const peer = { "x-copilot-peer-ip": clientIp }
  const stubPaths = [
    "/api/claude_code/organizations/metrics_enabled",
    "/api/claude_cli/bootstrap?entrypoint=claude-desktop-3p",
    "/api/oauth/profile",
    "/v1/mcp_servers",
  ]

  for (const stubPath of stubPaths) {
    const response = await server.request(stubPath, {
      headers: { ...peer, authorization: "Bearer cc_at_not-a-real-token" },
    })
    expect(response.status, stubPath).toBe(401)
  }

  expect(isIpBlocked(clientIp)).toBe(false)
})

test("remote managed settings reports that no organization policy is configured", async () => {
  const tokens = await authorizeAndExchange()
  const response = await server.request("/api/claude_code/settings", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })

  expect(response.status).toBe(204)
  expect(await response.text()).toBe("")
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("a recognized credential denied for scope never feeds the IP ban tracker", async () => {
  const tokens = await authorizeAndExchange()
  const mintResponse = await server.request(
    "/api/oauth/claude_cli/create_api_key",
    {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    },
  )
  expect(mintResponse.status).toBe(200)
  const { raw_key: inferenceKey } = (await mintResponse.json()) as {
    raw_key: string
  }

  const clientIp = "198.51.100.78"
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await server.request(
      "/api/oauth/claude_cli/create_api_key",
      {
        method: "POST",
        headers: {
          "x-copilot-peer-ip": clientIp,
          authorization: `Bearer ${inferenceKey}`,
        },
      },
    )
    expect(response.status).toBe(401)
  }

  expect(isIpBlocked(clientIp)).toBe(false)
})

test("a wrong-scope OAuth credential cannot recover an actively banned IP", async () => {
  const store = new OAuthStore({ storage: authFixture.storage })
  setOAuthStoreForTest(store)
  const code = await store.issueAuthorizationCode({
    clientId: oauthClientId,
    redirectUri: oauthRedirectUri,
    scopes: ["user:profile"],
    state: oauthState,
    codeChallenge: createPkceChallenge(oauthVerifier),
  })
  const exchanged = await store.exchangeAuthorizationCode({
    code,
    clientId: oauthClientId,
    redirectUri: oauthRedirectUri,
    state: oauthState,
    codeVerifier: oauthVerifier,
  })
  if (exchanged.status !== "ok") throw new Error("Failed to issue test token")

  const clientIp = "198.51.100.79"
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  const response = await server.request("/api/claude_code/metrics", {
    method: "POST",
    headers: {
      authorization: `Bearer ${exchanged.tokens.accessToken}`,
      "x-copilot-peer-ip": clientIp,
    },
  })

  expect(response.status).toBe(401)
  expect(isIpBlocked(clientIp)).toBe(true)
})

async function authorizeAndExchange(): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_token_expires_in: number
  scope: string
  token_type: string
}> {
  const query = authorizationQuery()
  const authorizeResponse = await server.request(
    `/oauth/authorize?${query.toString()}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: "test-secret-key" }).toString(),
    },
  )
  expect(authorizeResponse.status).toBe(302)
  const location = authorizeResponse.headers.get("location")
  expect(location).not.toBeNull()
  const code = new URL(location ?? oauthRedirectUri).searchParams.get("code")
  expect(code).toStartWith("cc_code_")

  const tokenResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri,
      client_id: oauthClientId,
      code_verifier: oauthVerifier,
      state: oauthState,
    }),
  })
  expect(tokenResponse.status).toBe(200)
  return (await tokenResponse.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    refresh_token_expires_in: number
    scope: string
    token_type: string
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

async function issueAuthorizationCode(): Promise<string> {
  const authorizeResponse = await server.request(
    `/oauth/authorize?${authorizationQuery().toString()}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: "test-secret-key" }).toString(),
    },
  )
  expect(authorizeResponse.status).toBe(302)
  const location = authorizeResponse.headers.get("location")
  const code = new URL(location ?? oauthRedirectUri).searchParams.get("code")
  expect(code).toStartWith("cc_code_")
  return code ?? ""
}

test("digest-listed OAuth grants cannot mint broader credentials", async () => {
  await setInferenceCredentialDigests(sha256Hex("test-secret-key"))
  const bootstrapResponse = await server.request(
    `/oauth/authorize?${authorizationQuery().toString()}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: " test-secret-key " }).toString(),
    },
  )
  expect(bootstrapResponse.status).toBe(401)

  await setInferenceCredentialDigests(undefined)
  const code = await issueAuthorizationCode()
  await setInferenceCredentialDigests(sha256Hex(code))

  const codeResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri,
      client_id: oauthClientId,
      code_verifier: oauthVerifier,
      state: oauthState,
    }),
  })
  expect(codeResponse.status).toBe(400)
  expect(await codeResponse.json()).toEqual({ error: "invalid_grant" })

  await setInferenceCredentialDigests(undefined)
  const tokens = await authorizeAndExchange()
  await setInferenceCredentialDigests(sha256Hex(tokens.refresh_token))

  const refreshResponse = await refreshOauthToken(tokens.refresh_token)
  expect(refreshResponse.status).toBe(400)
  expect(await refreshResponse.json()).toEqual({ error: "invalid_grant" })
})

test("rejects arbitrary refresh tokens without disclosing the gateway key", async () => {
  const response = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: "audit-invalid",
      client_id: oauthClientId,
    }),
  })

  expect(response.status).toBe(400)
  const text = await response.text()
  expect(text).toContain("invalid_grant")
  expect(text).not.toContain("test-secret-key")
})

test("parses large OAuth fields and still rejects unsupported content types", async () => {
  const largeFieldResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: "x".repeat(20_000),
      client_id: oauthClientId,
    }),
  })
  expect(largeFieldResponse.status).toBe(400)
  expect(await largeFieldResponse.json()).toEqual({ error: "invalid_grant" })
  expect(largeFieldResponse.headers.get("cache-control")).toBe("no-store")

  const unsupportedResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "grant_type=refresh_token",
  })
  expect(unsupportedResponse.status).toBe(400)
  expect(await unsupportedResponse.json()).toEqual({ error: "invalid_request" })
})

test("rejects conflicting credential headers", async () => {
  const response = await server.request("/api/oauth/profile", {
    headers: {
      authorization: "Bearer test-secret-key",
      "x-api-key": "different-secret-key",
    },
  })
  expect(response.status).toBe(401)
})

test("binds one-use authorization codes to client, redirect, state, and S256 PKCE", async () => {
  const query = authorizationQuery()
  const authorizeResponse = await server.request(
    `/oauth/authorize?${query.toString()}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: "test-secret-key" }).toString(),
    },
  )
  const location = authorizeResponse.headers.get("location")
  const code = new URL(location ?? oauthRedirectUri).searchParams.get("code")

  const wrongVerifierResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri,
      client_id: oauthClientId,
      code_verifier: "x".repeat(64),
      state: oauthState,
    }),
  })
  expect(wrongVerifierResponse.status).toBe(400)

  const validRequest = {
    grant_type: "authorization_code",
    code,
    redirect_uri: oauthRedirectUri,
    client_id: oauthClientId,
    code_verifier: oauthVerifier,
    state: oauthState,
  }
  const validResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validRequest),
  })
  expect(validResponse.status).toBe(200)

  const replayResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validRequest),
  })
  expect(replayResponse.status).toBe(400)
  expect(await replayResponse.json()).toEqual({ error: "invalid_grant" })
})

test("issues scoped opaque tokens and a distinct inference-only API key", async () => {
  const tokens = await authorizeAndExchange()

  expect(tokens.access_token).toStartWith("cc_at_")
  expect(tokens.refresh_token).toStartWith("cc_rt_")
  expect(tokens.access_token).not.toBe("test-secret-key")
  expect(tokens.refresh_token).not.toBe("test-secret-key")
  expect(tokens.expires_in).toBe(100 * 365 * 24 * 60 * 60)
  expect(tokens.refresh_token_expires_in).toBe(tokens.expires_in)
  expect(tokens.token_type).toBe("bearer")

  const profileResponse = await server.request("/api/oauth/profile", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
  expect(profileResponse.status).toBe(200)

  const apiKeyResponse = await server.request(
    "/api/oauth/claude_cli/create_api_key",
    {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    },
  )
  expect(apiKeyResponse.status).toBe(200)
  const { raw_key: rawKey } = (await apiKeyResponse.json()) as {
    raw_key: string
  }
  expect(rawKey).toStartWith("sk-copilot-")
  expect(rawKey).not.toBe(tokens.access_token)
  expect(rawKey).not.toBe("test-secret-key")
  expect(await resolveCredential(rawKey, ["user:inference"])).not.toBeNull()
  expect(await resolveCredential(rawKey, ["user:profile"])).toBeNull()
  const inferenceProfileResponse = await server.request("/api/oauth/profile", {
    headers: { authorization: `Bearer ${rawKey}` },
  })
  expect(inferenceProfileResponse.status).toBe(401)
  const inferenceCreateKeyResponse = await server.request(
    "/api/oauth/claude_cli/create_api_key",
    {
      method: "POST",
      headers: { authorization: `Bearer ${rawKey}` },
    },
  )
  expect(inferenceCreateKeyResponse.status).toBe(401)
  const oauthAdminResponse = await server.request("/dashboard/api/overview", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
  expect(oauthAdminResponse.status).toBe(401)

  const persisted = JSON.stringify(
    await authFixture.storage.read(async (session) => {
      const tables = [
        "capi_oauth_codes",
        "capi_oauth_access",
        "capi_oauth_refresh",
        "capi_oauth_families",
        "capi_inference_credentials",
      ]
      const records = []
      for (const table of tables)
        records.push(
          await session.query({ sql: `SELECT * FROM ${table}`, args: [] }),
        )
      return records
    }),
  )
  expect(persisted).not.toContain(tokens.access_token)
  expect(persisted).not.toContain(tokens.refresh_token)
  expect(persisted).not.toContain(rawKey)
  expect(persisted).not.toContain("test-secret-key")
})

test("gateway credentials cannot impersonate OAuth or mint inference keys", async () => {
  const profileResponse = await server.request("/api/oauth/profile", {
    headers: { authorization: "Bearer test-secret-key" },
  })
  expect(profileResponse.status).toBe(401)

  const createKeyResponse = await server.request(
    "/api/oauth/claude_cli/create_api_key",
    {
      method: "POST",
      headers: { authorization: "Bearer test-secret-key" },
    },
  )
  expect(createKeyResponse.status).toBe(401)
})

test("retries refresh tokens without expiring or revoking the session", async () => {
  const initial = await authorizeAndExchange()

  const rotatedResponse = await refreshOauthToken(initial.refresh_token)
  expect(rotatedResponse.status).toBe(200)
  const rotated = (await rotatedResponse.json()) as {
    access_token: string
    refresh_token: string
  }
  expect(rotated.refresh_token).toBe(initial.refresh_token)

  const replayResponse = await refreshOauthToken(initial.refresh_token)
  expect(replayResponse.status).toBe(200)
  const replayed = (await replayResponse.json()) as {
    access_token: string
    refresh_token: string
  }
  expect(replayed.refresh_token).toBe(initial.refresh_token)

  expect((await refreshOauthToken(rotated.refresh_token)).status).toBe(200)
  expect(await resolveCredential(rotated.access_token)).not.toBeNull()
  expect(await resolveCredential(replayed.access_token)).not.toBeNull()
  expect(await resolveCredential(initial.access_token)).not.toBeNull()
})

function refreshOauthToken(refreshToken: string): Promise<Response> {
  return Promise.resolve(
    server.request("/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: oauthClientId,
        scope: "user:profile user:inference",
      }),
    }),
  )
}

test("revokes an OAuth token family", async () => {
  const tokens = await authorizeAndExchange()
  const revokeResponse = await server.request("/v1/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: tokens.access_token,
      client_id: oauthClientId,
    }).toString(),
  })
  expect(revokeResponse.status).toBe(200)
  expect(await resolveCredential(tokens.access_token)).toBeNull()
  expect(await resolveCredential(tokens.refresh_token)).toBeNull()
})
