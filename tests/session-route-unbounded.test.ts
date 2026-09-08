import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  createPkceChallenge,
  OAuthStore,
  setOAuthStoreForTest,
} from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import {
  getClientEvents,
  getSession,
} from "../src/routes/code-sessions/session-store"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

const VERIFIER = "v".repeat(64)
let accessToken: string

useProtocolDatabase()

beforeEach(async () => {
  state.apiKeyAuth = "session-gateway"
  await seedProtocolDatabase()
  const oauthStore = new OAuthStore()
  setOAuthStoreForTest(oauthStore)
  const code = await oauthStore.issueAuthorizationCode({
    clientId: "session-client",
    redirectUri: "http://localhost:8765/callback",
    scopes: ["user:sessions:claude_code"],
    state: "session-state-with-entropy",
    codeChallenge: createPkceChallenge(VERIFIER),
  })
  const result = await oauthStore.exchangeAuthorizationCode({
    code,
    clientId: "session-client",
    redirectUri: "http://localhost:8765/callback",
    state: "session-state-with-entropy",
    codeVerifier: VERIFIER,
  })
  if (result.status !== "ok") throw new Error("Failed to issue test token")
  accessToken = result.tokens.accessToken
})

afterEach(() => {
  state.apiKeyAuth = undefined
  setOAuthStoreForTest(null)
})

function headers(): Record<string, string> {
  return {
    authorization: "Be" + "arer " + accessToken,
    "content-type": "application/json",
  }
}

test("session compatibility accepts large event batches and bodies", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title: "Unbounded compat session" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id

  const response = await server.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      events: [
        ...Array.from({ length: 101 }, (_, index) => ({ index })),
        { content: "x".repeat(1024 * 1024 + 1) },
      ],
    }),
  })

  expect(response.status).toBe(200)
})

test("session compatibility fixes event JSON errors but keeps PATCH permissive", async () => {
  const sessionResponse = await server.request("/v1/code/sessions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title: "Peripheral JSON" }),
  })
  const sessionId = (
    (await sessionResponse.json()) as { session: { id: string } }
  ).session.id
  const beforeEvents = getClientEvents(sessionId, 0).length

  for (const request of [
    { body: "{", headers: headers(), method: "POST" },
    { headers: headers(), method: "POST" },
  ]) {
    const response = await server.request(
      `/v1/sessions/${sessionId}/events`,
      request,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Invalid JSON" })
    expect(getClientEvents(sessionId, 0)).toHaveLength(beforeEvents)
  }

  const unknown = await server.request(
    "/v1/sessions/cse_missing_peripheral/events",
    { body: "{", headers: headers(), method: "POST" },
  )
  expect(unknown.status).toBe(404)

  for (const request of [
    { body: "{", headers: headers(), method: "PATCH" },
    { headers: headers(), method: "PATCH" },
  ]) {
    const response = await server.request(`/v1/sessions/${sessionId}`, request)
    expect(response.status).toBe(200)
    expect(getSession(sessionId)?.title).toBe("Peripheral JSON")
  }

  const emptyEvents = await server.request(`/v1/sessions/${sessionId}/events`, {
    body: "{}",
    headers: headers(),
    method: "POST",
  })
  expect(emptyEvents.status).toBe(200)
  expect(getClientEvents(sessionId, 0)).toHaveLength(beforeEvents)
})
