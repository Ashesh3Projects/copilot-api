import "./helpers/auth-misc-data-dir"

import { afterAll, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { shouldOmitRequestBodyFromDiagnostics } from "../src/lib/request-diagnostics"
import { trustedJwtDigestStore } from "../src/lib/trusted-jwt-digests"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function createSyntheticJwt(overrides?: {
  algorithm?: string
  audience?: string
  issuer?: string
}): string {
  const header = base64UrlJson({
    alg: overrides?.algorithm ?? "none",
    typ: "JWT",
  })
  const payload = base64UrlJson({
    iss: overrides?.issuer ?? "https://auth.openai.com",
    aud: overrides?.audience ?? "https://api.openai.com/v1",
    sub: "friendly-user",
    iat: 1_788_307_200,
    email: "friendly@example.com",
    "https://api.openai.com/profile": {
      email: "friendly@example.com",
      name: "Friendly User",
    },
    "https://api.openai.com/auth": {
      chatgpt_user_id: "friendly-user",
      chatgpt_plan_type: "plus",
      chatgpt_account_id: "friendly-user",
    },
  })
  return `${header}.${payload}.${Buffer.alloc(32, 7).toString("base64url")}`
}

function createRefreshToken(jwt: string): string {
  return `local_codex_v1.${Buffer.from(jwt, "utf8").toString("base64url")}`
}

async function registerJwt(jwt: string, enabled = true): Promise<void> {
  const entry = await trustedJwtDigestStore.add({
    label: "Codex Desktop",
    digest: createHash("sha256").update(jwt, "utf8").digest("hex"),
  })
  if (!enabled) await trustedJwtDigestStore.setEnabled(entry.id, false)
}

async function refreshRequest(
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Response> {
  return await server.request("/v1/codex/auth/refresh", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  trustedJwtDigestStore.resetAfterTest()
})

afterAll(() => {
  trustedJwtDigestStore.resetAfterTest()
})

test("refreshes an enabled managed Codex Desktop JWT without rotating secrets", async () => {
  const jwt = createSyntheticJwt()
  const refreshToken = createRefreshToken(jwt)
  await registerJwt(jwt)

  const response = await refreshRequest({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("pragma")).toBe("no-cache")
  expect(await response.json()).toEqual({
    id_token: jwt,
    access_token: jwt,
    refresh_token: refreshToken,
  })
})

test.each([
  ["unknown", false],
  ["disabled", true],
] as const)(
  "rejects an %s managed JWT as invalid_grant",
  async (_name, disabled) => {
    const jwt = createSyntheticJwt()
    if (disabled) await registerJwt(jwt, false)

    const response = await refreshRequest({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: createRefreshToken(jwt),
    })

    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      error: "invalid_grant",
      error_description: "The refresh token is invalid or inactive.",
    })
  },
)

test.each([
  [
    "wrong token version",
    `local_codex_v2.${Buffer.from(createSyntheticJwt()).toString("base64url")}`,
  ],
  ["invalid base64url", "local_codex_v1.not+base64"],
  ["not a JWT", createRefreshToken("not-a-jwt")],
  [
    "signed algorithm",
    createRefreshToken(createSyntheticJwt({ algorithm: "HS256" })),
  ],
  [
    "wrong issuer",
    createRefreshToken(createSyntheticJwt({ issuer: "https://example.com" })),
  ],
  [
    "wrong audience",
    createRefreshToken(createSyntheticJwt({ audience: "https://example.com" })),
  ],
] as const)(
  "rejects a malformed local refresh token: %s",
  async (_name, refreshToken) => {
    const response = await refreshRequest({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_grant",
      error_description: "The refresh token is invalid or inactive.",
    })
  },
)

test.each([
  ["wrong client", { client_id: "wrong", grant_type: "refresh_token" }],
  ["wrong grant", { client_id: CLIENT_ID, grant_type: "authorization_code" }],
] as const)(
  "rejects %s before accepting a refresh token",
  async (_name, body) => {
    const response = await refreshRequest({
      ...body,
      refresh_token: createRefreshToken(createSyntheticJwt()),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "Invalid Codex refresh request.",
    })
  },
)

test("requires JSON and valid JSON", async () => {
  const wrongType = await refreshRequest("grant_type=refresh_token", {
    "content-type": "application/x-www-form-urlencoded",
  })
  expect(wrongType.status).toBe(415)

  const malformed = await refreshRequest("{")
  expect(malformed.status).toBe(400)
  expect(await malformed.json()).toEqual({
    error: "invalid_request",
    error_description: "Invalid Codex refresh request.",
  })

  const jsonp = await refreshRequest(
    {
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: createRefreshToken(createSyntheticJwt()),
    },
    { "content-type": "application/jsonp" },
  )
  expect(jsonp.status).toBe(415)
})

test("rejects unexpected refresh request fields", async () => {
  const jwt = createSyntheticJwt()
  await registerJwt(jwt)

  const response = await refreshRequest({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: createRefreshToken(jwt),
    unexpected: "field",
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: "invalid_request",
    error_description: "Invalid Codex refresh request.",
  })
})

test.each([null, [], "refresh_token"])(
  "rejects non-object JSON bodies without an internal error",
  async (body) => {
    const response = await refreshRequest(body)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "Invalid Codex refresh request.",
    })
  },
)

test("does not expose the refresh route through unsupported methods", async () => {
  const anonymous = await server.request("/v1/codex/auth/refresh")
  expect(anonymous.status).toBe(401)
  await seedProtocolDatabase({
    gatewayKeys: ["refresh-method-test-key"],
    singleAccount: false,
  })
  const response = await server.request("/v1/codex/auth/refresh", {
    headers: { authorization: "Bearer refresh-method-test-key" },
  })

  expect(response.status).toBe(404)
})

test("keeps refresh tokens out of raw debug request diagnostics", () => {
  expect(
    shouldOmitRequestBodyFromDiagnostics("/v1/codex/auth/refresh"),
  ).toBeTrue()
})
