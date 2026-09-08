import { afterEach, beforeEach, expect, test } from "bun:test"

import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
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
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

const GATEWAY_KEY = "compat-test-gateway-key"
const CLIENT_ID = "compat-test-client"
const VERIFIER = "v".repeat(64)
let oauthStore: OAuthStore

useProtocolDatabase()

beforeEach(async () => {
  setIpAllowlistForTest([])
  state.apiKeyAuth = GATEWAY_KEY
  await seedProtocolDatabase()
  resetIpSecurityForTest()
  oauthStore = new OAuthStore()
  setOAuthStoreForTest(oauthStore)
})

afterEach(() => {
  setIpAllowlistForTest([])
  resetIpSecurityForTest()
  state.apiKeyAuth = undefined
  setOAuthStoreForTest(null)
})

async function issueOAuthAccessToken(scopes: Array<string>): Promise<string> {
  const code = await oauthStore.issueAuthorizationCode({
    clientId: CLIENT_ID,
    redirectUri: "http://localhost:8765/callback",
    scopes,
    state: "compat-test-state",
    codeChallenge: createPkceChallenge(VERIFIER),
  })
  const result = await oauthStore.exchangeAuthorizationCode({
    code,
    clientId: CLIENT_ID,
    redirectUri: "http://localhost:8765/callback",
    state: "compat-test-state",
    codeVerifier: VERIFIER,
  })
  if (result.status !== "ok") throw new Error("Failed to issue test token")
  return result.tokens.accessToken
}

function bearer(value: string): { authorization: string } {
  return { authorization: `Bearer ${value}` }
}

test("subscriber compatibility routes reject missing, gateway, and inference credentials", async () => {
  const inferenceKey = await oauthStore.mintInferenceCredential()
  const routes = [
    ["GET", "/v1/code/triggers"],
    ["POST", "/v1/code/github/import-token"],
    ["GET", "/v1/environment_providers"],
    ["POST", "/v1/environment_providers/cloud/create"],
    ["GET", "/v1/mcp_servers"],
    ["GET", "/v1/session_ingress/session/session_test"],
    ["GET", "/v1/ultrareview/quota"],
  ] as const

  for (const [method, path] of routes) {
    expect((await server.request(path, { method })).status).toBe(401)
    expect(
      (await server.request(path, { method, headers: bearer(GATEWAY_KEY) }))
        .status,
    ).toBe(401)
    expect(
      (await server.request(path, { method, headers: bearer(inferenceKey) }))
        .status,
    ).toBe(401)
  }
})

test("session-scoped OAuth reaches session compatibility stubs only", async () => {
  const accessToken = await issueOAuthAccessToken(["user:sessions:claude_code"])
  const headers = bearer(accessToken)

  expect((await server.request("/v1/code/triggers", { headers })).status).toBe(
    200,
  )
  expect(
    (
      await server.request("/v1/code/github/import-token", {
        method: "POST",
        headers,
      })
    ).status,
  ).toBe(200)
  expect(
    (await server.request("/v1/environment_providers", { headers })).status,
  ).toBe(200)
  expect(
    (
      await server.request("/v1/session_ingress/session/session_test", {
        headers,
      })
    ).status,
  ).toBe(200)
  expect(
    (await server.request("/v1/ultrareview/quota", { headers })).status,
  ).toBe(200)
  expect((await server.request("/v1/mcp_servers", { headers })).status).toBe(
    401,
  )
})

test("MCP compatibility requires the dedicated OAuth scope", async () => {
  const accessToken = await issueOAuthAccessToken(["user:mcp_servers"])
  const response = await server.request("/v1/mcp_servers", {
    headers: bearer(accessToken),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ data: [] })
  expect(
    (
      await server.request("/v1/code/triggers", {
        headers: bearer(accessToken),
      })
    ).status,
  ).toBe(401)
})

test("unimplemented trigger descendants remain behind OAuth", async () => {
  expect((await server.request("/v1/code/triggers/example")).status).toBe(401)

  const accessToken = await issueOAuthAccessToken(["user:sessions:claude_code"])
  expect(
    (
      await server.request("/v1/code/triggers/example", {
        headers: bearer(accessToken),
      })
    ).status,
  ).toBe(404)
})

test("compatibility scope failures never count toward the shared ban", async () => {
  const clientIp = "198.51.100.95"
  const headers = {
    ...bearer(GATEWAY_KEY),
    "x-copilot-peer-ip": clientIp,
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(
      (await server.request("/v1/code/triggers", { headers })).status,
    ).toBe(401)
  }

  expect(isIpBlocked(clientIp)).toBe(false)
})

test("compatibility routes still deny a client banned elsewhere", async () => {
  const clientIp = "198.51.100.96"
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  expect(isIpBlocked(clientIp)).toBe(true)

  const accessToken = await issueOAuthAccessToken(["user:sessions:claude_code"])
  expect(
    (
      await server.request("/v1/code/triggers", {
        headers: {
          ...bearer(accessToken),
          "x-copilot-peer-ip": clientIp,
        },
      })
    ).status,
  ).toBe(401)
})
