/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async rejection matchers have void type declarations. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  createOAuthStorageFixture,
  newOAuthStoreForTest,
  oauthClientId,
  oauthScopes,
} from "./helpers/oauth-storage"

const {
  hashOAuthSecret,
  OAUTH_AUTHORIZATION_CODE_TTL_MS,
  OAUTH_CLIENT_TOKEN_LIFETIME_SECONDS,
} = await import("~/lib/oauth-store")
let fixture: Awaited<ReturnType<typeof createOAuthStorageFixture>>
beforeEach(async () => {
  fixture = await createOAuthStorageFixture()
})
afterEach(async () => {
  await fixture.close()
})

test("persists only digests and resolves OAuth and inference credentials after reopening", async () => {
  const code = await fixture.issueCode()
  const result = await fixture.store.exchangeAuthorizationCode({
    ...fixture.binding,
    code,
  })
  expect(result.status).toBe("ok")
  if (result.status !== "ok") return
  const key = await fixture.store.mintInferenceCredential()
  const principal = await fixture.store.resolveAccessToken(
    result.tokens.accessToken,
  )
  const inference = await fixture.store.resolveInferenceCredential(key)
  await fixture.storage.close()
  const reopened = await fixture.connect()
  const next = newOAuthStoreForTest(reopened)
  expect(await next.resolveAccessToken(result.tokens.accessToken)).toEqual(
    principal,
  )
  expect(await next.resolveInferenceCredential(key)).toEqual(inference)
  expect(inference).toMatchObject({ scopes: ["user:inference"] })
  expect(await next.resolveAccessToken(key)).toBeNull()
  expect(
    await next.resolveInferenceCredential(result.tokens.accessToken),
  ).toBeNull()
  const rows = await reopened.read(async (session) => {
    const names = await session.query({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'capi_%'",
      args: [],
    })
    const data = []
    for (const row of names)
      data.push(
        await session.query({
          sql: `SELECT * FROM ${String(row.name)}`,
          args: [],
        }),
      )
    return JSON.stringify(data)
  })
  const bytes = (await readFile(fixture.databasePath)).toString("utf8")
  for (const secret of [
    code,
    result.tokens.accessToken,
    result.tokens.refreshToken,
    key,
  ]) {
    expect(rows).not.toContain(secret)
    expect(bytes).not.toContain(secret)
  }
  expect(rows).toContain(hashOAuthSecret(key))
  expect(
    await next.refreshAccessToken({
      refreshToken: result.tokens.refreshToken,
      clientId: oauthClientId,
    }),
  ).toMatchObject({ status: "ok" })
})

test("authorization codes expire at the exact TTL while tokens remain valid past advertised expiry", async () => {
  const now = Date.now()
  const code = await fixture.issueCode(now)
  expect(
    await fixture.store.exchangeAuthorizationCode({
      ...fixture.binding,
      code,
      now: now + OAUTH_AUTHORIZATION_CODE_TTL_MS,
    }),
  ).toEqual({ status: "invalid_grant" })
  const tokens = await fixture.issue(now)
  expect(tokens.expiresIn).toBe(OAUTH_CLIENT_TOKEN_LIFETIME_SECONDS)
  expect(tokens.refreshTokenExpiresIn).toBe(OAUTH_CLIENT_TOKEN_LIFETIME_SECONDS)
  expect(
    await fixture.store.resolveAccessToken(
      tokens.accessToken,
      now + (tokens.expiresIn + 1) * 1000,
    ),
  ).toMatchObject({ scopes: oauthScopes })
})

test("legacy token expiry metadata does not expire the grant", async () => {
  const tokens = await fixture.issue(1000)
  await fixture.storage.transaction(async (session) => {
    for (const table of [
      "capi_oauth_access",
      "capi_oauth_refresh",
      "capi_oauth_families",
    ]) {
      await session.execute({
        sql: `UPDATE ${table} SET expires_at = 2000`,
        args: [],
      })
    }
  })
  expect(
    await fixture.store.resolveAccessToken(tokens.accessToken, 3000),
  ).toMatchObject({ scopes: oauthScopes })
  expect(
    await fixture.store.refreshAccessToken({
      refreshToken: tokens.refreshToken,
      clientId: oauthClientId,
      now: 3000,
    }),
  ).toMatchObject({ status: "ok" })
})

test.each([
  { clientId: "wrong-client" },
  { redirectUri: "http://localhost:54546/callback" },
  { state: "wrong-state" },
  { codeVerifier: "wrong-verifier" },
])(
  "mismatched binding %p leaves code usable and successful exchange consumes it",
  async (mismatch) => {
    const code = await fixture.issueCode()
    const input = { ...fixture.binding, code }
    expect(
      await fixture.store.exchangeAuthorizationCode({ ...input, ...mismatch }),
    ).toEqual({ status: "invalid_grant" })
    expect(await fixture.store.exchangeAuthorizationCode(input)).toMatchObject({
      status: "ok",
    })
    expect(await fixture.store.exchangeAuthorizationCode(input)).toEqual({
      status: "invalid_grant",
    })
  },
)

test("refresh downscopes without narrowing the reusable original grant", async () => {
  const tokens = await fixture.issue()
  const narrow = await fixture.store.refreshAccessToken({
    refreshToken: tokens.refreshToken,
    clientId: oauthClientId,
    scopes: ["user:inference", "user:inference"],
  })
  expect(narrow).toMatchObject({
    status: "ok",
    tokens: { refreshToken: tokens.refreshToken, scopes: ["user:inference"] },
  })
  for (const requested of [
    [],
    ["unknown"],
    ["user:inference", "org:create_api_key"],
  ]) {
    expect(
      await fixture.store.refreshAccessToken({
        refreshToken: tokens.refreshToken,
        clientId: oauthClientId,
        scopes: requested,
      }),
    ).toEqual({ status: "invalid_scope" })
  }
  const next = newOAuthStoreForTest(await fixture.connect())
  expect(
    await next.refreshAccessToken({
      refreshToken: tokens.refreshToken,
      clientId: oauthClientId,
    }),
  ).toMatchObject({
    status: "ok",
    tokens: { refreshToken: tokens.refreshToken, scopes: oauthScopes },
  })
})

test("invalid refresh and unknown revocation leave durable state unchanged", async () => {
  const code = await fixture.issueCode()
  const before = await fixture.storage.read((session) =>
    session.query({ sql: "SELECT * FROM capi_applied_operations", args: [] }),
  )
  expect(
    await fixture.store.refreshAccessToken({
      refreshToken: "unknown",
      clientId: oauthClientId,
    }),
  ).toEqual({ status: "invalid_grant" })
  await fixture.store.revokeToken("unknown")
  expect(
    await fixture.storage.read((session) =>
      session.query({ sql: "SELECT * FROM capi_applied_operations", args: [] }),
    ),
  ).toEqual(before)
  expect(
    await fixture.store.exchangeAuthorizationCode({ ...fixture.binding, code }),
  ).toMatchObject({ status: "ok" })
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT value FROM capi_metadata WHERE key = 'config_revision'",
        args: [],
      }),
    ),
  ).toEqual([{ value: "0" }])
})

test("malformed persisted scopes fail closed instead of authorizing", async () => {
  const tokens = await fixture.issue()
  await fixture.storage.transaction((session) =>
    session.execute({
      sql: "UPDATE capi_oauth_access SET scopes_json = '[\"*\"]' WHERE digest = ?",
      args: [hashOAuthSecret(tokens.accessToken)],
    }),
  )
  await expect(
    fixture.store.resolveAccessToken(tokens.accessToken),
  ).rejects.toThrow("Invalid OAuth")
})

test("revocation reaches all family tokens and separately revokes inference credentials", async () => {
  const tokens = await fixture.issue()
  const refreshed = await fixture.store.refreshAccessToken({
    refreshToken: tokens.refreshToken,
    clientId: oauthClientId,
  })
  expect(refreshed.status).toBe("ok")
  const key = await fixture.store.mintInferenceCredential()
  const next = newOAuthStoreForTest(await fixture.connect())
  await next.revokeToken(tokens.accessToken)
  expect(await fixture.store.resolveAccessToken(tokens.accessToken)).toBeNull()
  if (refreshed.status === "ok")
    expect(
      await fixture.store.resolveAccessToken(refreshed.tokens.accessToken),
    ).toBeNull()
  expect(
    await fixture.store.refreshAccessToken({
      refreshToken: tokens.refreshToken,
      clientId: oauthClientId,
    }),
  ).toEqual({ status: "invalid_grant" })
  expect(await fixture.store.resolveInferenceCredential(key)).not.toBeNull()
  await next.revokeToken(key)
  expect(await fixture.store.resolveInferenceCredential(key)).toBeNull()
})
