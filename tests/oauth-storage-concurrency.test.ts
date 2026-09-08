/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async rejection matchers have void type declarations. */
import { afterEach, beforeEach, expect, test } from "bun:test"

import type { SqlSession, Storage } from "~/lib/storage/types"

import {
  StorageCommitUnknownError,
  StorageUnavailableError,
} from "~/lib/storage/errors"

import {
  createOAuthStorageFixture,
  newOAuthStoreForTest,
  oauthClientId,
} from "./helpers/oauth-storage"

const { hashOAuthSecret } = await import("~/lib/oauth-store")
let fixture: Awaited<ReturnType<typeof createOAuthStorageFixture>>
beforeEach(async () => {
  fixture = await createOAuthStorageFixture()
})
afterEach(async () => {
  await fixture.close()
})

test("racing authorization exchanges consume one code exactly once", async () => {
  const code = await fixture.issueCode()
  const input = { ...fixture.binding, code }
  const other = newOAuthStoreForTest(fixture.storage)
  const results = await Promise.all([
    fixture.store.exchangeAuthorizationCode(input),
    other.exchangeAuthorizationCode(input),
  ])
  expect(results.map((result) => result.status).sort()).toEqual([
    "invalid_grant",
    "ok",
  ])
  const fresh = newOAuthStoreForTest(await fixture.connect())
  expect(await fresh.exchangeAuthorizationCode(input)).toEqual({
    status: "invalid_grant",
  })
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_oauth_families",
        args: [],
      }),
    ),
  ).toEqual([{ count: 1 }])
})

test("racing refresh calls retain original refresh value, principal, and family", async () => {
  const tokens = await fixture.issue()
  const principal = await fixture.store.resolveAccessToken(tokens.accessToken)
  const other = newOAuthStoreForTest(fixture.storage)
  const results = await Promise.all(
    [fixture.store, other].map((store) =>
      store.refreshAccessToken({
        refreshToken: tokens.refreshToken,
        clientId: oauthClientId,
      }),
    ),
  )
  expect(results.map((result) => result.status)).toEqual(["ok", "ok"])
  for (const result of results) {
    if (result.status !== "ok") continue
    expect(result.tokens.refreshToken).toBe(tokens.refreshToken)
    expect(
      await fixture.store.resolveAccessToken(result.tokens.accessToken),
    ).toEqual(principal)
  }
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(DISTINCT family_id) AS families, COUNT(*) AS tokens FROM capi_oauth_access",
        args: [],
      }),
    ),
  ).toEqual([{ families: 1, tokens: 3 }])
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_oauth_refresh",
        args: [],
      }),
    ),
  ).toEqual([{ count: 1 }])
})

test.each([true, false])(
  "refresh racing revocation cannot resurrect a family (revoke first %p)",
  async (revokeFirst) => {
    const tokens = await fixture.issue()
    const refresh = () =>
      fixture.store.refreshAccessToken({
        refreshToken: tokens.refreshToken,
        clientId: oauthClientId,
      })
    const revoke = () => fixture.store.revokeToken(tokens.refreshToken)
    await (revokeFirst ?
      Promise.all([revoke(), refresh()])
    : Promise.all([refresh(), revoke()]))
    const next = newOAuthStoreForTest(await fixture.connect())
    expect(await next.resolveAccessToken(tokens.accessToken)).toBeNull()
    expect(
      await next.refreshAccessToken({
        refreshToken: tokens.refreshToken,
        clientId: oauthClientId,
      }),
    ).toEqual({ status: "invalid_grant" })
    expect(
      await fixture.storage.read((session) =>
        session.query({
          sql: "SELECT COUNT(*) AS count FROM capi_oauth_access WHERE revoked_at IS NULL",
          args: [],
        }),
      ),
    ).toEqual([{ count: 0 }])
  },
)

function failingStorage(
  mode: "rollback" | "unknown" | "unknown-unreadable" | "read",
) {
  let unavailable = mode === "read"
  const storage: Storage = {
    async read(work) {
      if (unavailable) throw new StorageUnavailableError()
      return fixture.storage.read(work)
    },
    async transaction(work) {
      const value = await fixture.storage.transaction(async (session) => {
        const result = await work(session)
        if (mode === "rollback") throw new StorageUnavailableError()
        return result
      })
      if (mode === "unknown-unreadable") unavailable = true
      if (mode.startsWith("unknown")) throw new StorageCommitUnknownError()
      return value
    },
    atomicBatch: (statements) => fixture.storage.atomicBatch(statements),
    close: async () => {},
  }
  return {
    storage,
    restoreReads: () => {
      unavailable = false
    },
  }
}

test("failed commit rolls back code consumption and all issued tokens", async () => {
  const code = await fixture.issueCode()
  const failing = newOAuthStoreForTest(failingStorage("rollback").storage)
  await expect(
    failing.exchangeAuthorizationCode({ ...fixture.binding, code }),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_oauth_access",
        args: [],
      }),
    ),
  ).toEqual([{ count: 0 }])
  expect(
    await fixture.store.exchangeAuthorizationCode({ ...fixture.binding, code }),
  ).toMatchObject({ status: "ok" })
})

test("database read outage is propagated instead of invalid grant or absent credential", async () => {
  const tokens = await fixture.issue()
  const store = newOAuthStoreForTest(failingStorage("read").storage)
  await expect(
    store.resolveAccessToken(tokens.accessToken),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
})

test("lost commit response reconciles marker without replaying secret issuance", async () => {
  const code = await fixture.issueCode()
  const store = newOAuthStoreForTest(failingStorage("unknown").storage)
  const result = await store.exchangeAuthorizationCode({
    ...fixture.binding,
    code,
  })
  expect(result.status).toBe("ok")
  if (result.status !== "ok") return
  expect(
    await fixture.store.resolveAccessToken(result.tokens.accessToken),
  ).not.toBeNull()
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_oauth_access",
        args: [],
      }),
    ),
  ).toEqual([{ count: 1 }])
  const markers = await fixture.storage.read((session) =>
    session.query({ sql: "SELECT * FROM capi_applied_operations", args: [] }),
  )
  expect(markers.length).toBeGreaterThan(0)
  expect(JSON.stringify(markers)).not.toContain(result.tokens.accessToken)
  expect(JSON.stringify(markers)).not.toContain(result.tokens.refreshToken)
})

test("unreconciled commit blocks later OAuth mutation until fresh read confirms it", async () => {
  const code = await fixture.issueCode()
  const faults = failingStorage("unknown-unreadable")
  const store = newOAuthStoreForTest(faults.storage)
  await expect(
    store.exchangeAuthorizationCode({ ...fixture.binding, code }),
  ).rejects.toBeInstanceOf(StorageCommitUnknownError)
  await expect(store.mintInferenceCredential()).rejects.toBeInstanceOf(
    StorageCommitUnknownError,
  )
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_inference_credentials",
        args: [],
      }),
    ),
  ).toEqual([{ count: 0 }])
  faults.restoreReads()
  // A completed exchange cannot reconstruct plaintext once its request is gone.
  expect(
    await store.exchangeAuthorizationCode({ ...fixture.binding, code }),
  ).toEqual({ status: "invalid_grant" })
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_oauth_access",
        args: [],
      }),
    ),
  ).toEqual([{ count: 1 }])
})

test("failure midway through family revocation leaves every credential valid", async () => {
  const tokens = await fixture.issue()
  const storage: Storage = {
    read: (work) => fixture.storage.read(work),
    transaction: (work) =>
      fixture.storage.transaction((session) => {
        let updates = 0
        const injected: SqlSession = {
          query: (statement) => session.query(statement),
          async execute(statement) {
            const value = await session.execute(statement)
            if (
              statement.sql.startsWith("UPDATE capi_oauth")
              && ++updates === 2
            )
              throw new StorageUnavailableError()
            return value
          },
        }
        return work(injected)
      }),
    atomicBatch: (statements) => fixture.storage.atomicBatch(statements),
    close: async () => {},
  }
  await expect(
    newOAuthStoreForTest(storage).revokeToken(tokens.refreshToken),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  expect(
    await fixture.store.resolveAccessToken(tokens.accessToken),
  ).not.toBeNull()
  expect(
    await fixture.store.refreshAccessToken({
      refreshToken: tokens.refreshToken,
      clientId: oauthClientId,
    }),
  ).toMatchObject({ status: "ok" })
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT revoked_at FROM capi_oauth_refresh WHERE digest = ?",
        args: [hashOAuthSecret(tokens.refreshToken)],
      }),
    ),
  ).toEqual([{ revoked_at: null }])
})

test("missing runtime rejects asynchronously through the existing store API", async () => {
  const { OAuthStore } = await import("~/lib/oauth-store")
  const store = new OAuthStore()
  const result = store.resolveAccessToken("absent")
  await expect(result).rejects.toBeInstanceOf(StorageUnavailableError)
})

test("independent SQLite processes exchange a shared code only once", async () => {
  const code = await fixture.issueCode()
  const runner = `
    process.env.DATA_DIR = process.env.DATA_DIR;
    const { LocalSqliteStorage } = await import('./src/lib/storage/local-sqlite.ts');
    const { OAuthStore } = await import('./src/lib/oauth-store.ts');
    const input = await Bun.stdin.json();
    const storage = new LocalSqliteStorage(input.path);
    try {
      await Bun.sleep(Math.max(0, input.startAt - Date.now()));
      const result = await new OAuthStore({ storage }).exchangeAuthorizationCode(input.exchange);
      process.stdout.write(JSON.stringify({ status: result.status }));
    } finally { await storage.close(); }
  `
  const startAt = Date.now() + 300
  const run = async () => {
    const child = Bun.spawn([process.execPath, "--eval", runner], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, DATA_DIR: fixture.directory },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await child.stdin.write(
      JSON.stringify({
        path: fixture.databasePath,
        startAt,
        exchange: { ...fixture.binding, code },
      }),
    )
    await child.stdin.flush()
    await child.stdin.end()
    const [exit, output, diagnostic] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(diagnostic).toBe("")
    expect(exit).toBe(0)
    return JSON.parse(output) as { status: string }
  }
  const results = await Promise.all([run(), run()])
  expect(results.map((result) => result.status).sort()).toEqual([
    "invalid_grant",
    "ok",
  ])
  expect(
    await fixture.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count FROM capi_oauth_families",
        args: [],
      }),
    ),
  ).toEqual([{ count: 1 }])
})

test.skipIf(process.env.CAP_STORAGE_REMOTE_TEST !== "1")(
  "live Turso OAuth exchange refresh and revocation races",
  async () => {
    const {
      createRemoteOAuthStorageFixture,
      oauthRedirectUri,
      oauthScopes,
      oauthState,
      oauthVerifier,
    } = await import("./helpers/oauth-storage")
    const { createPkceChallenge } = await import("~/lib/oauth-store")
    const remote = await createRemoteOAuthStorageFixture()
    try {
      const binding = {
        clientId: oauthClientId,
        redirectUri: oauthRedirectUri,
        state: oauthState,
        codeVerifier: oauthVerifier,
      }
      const code = await remote.store.issueAuthorizationCode({
        ...binding,
        scopes: oauthScopes,
        codeChallenge: createPkceChallenge(oauthVerifier),
      })
      const exchanges = await Promise.all(
        [remote.store, newOAuthStoreForTest(remote.peerStorage())].map(
          (store) => store.exchangeAuthorizationCode({ ...binding, code }),
        ),
      )
      expect(exchanges.map((result) => result.status).sort()).toEqual([
        "invalid_grant",
        "ok",
      ])
      const issued = exchanges.find((result) => result.status === "ok")
      if (issued?.status !== "ok")
        throw new Error("No successful remote exchange")
      const tokens = issued.tokens
      const principal = await remote.store.resolveAccessToken(
        tokens.accessToken,
      )
      const refreshInput = {
        refreshToken: tokens.refreshToken,
        clientId: oauthClientId,
      }
      const refreshed = await Promise.all([
        remote.store.refreshAccessToken(refreshInput),
        newOAuthStoreForTest(remote.peerStorage()).refreshAccessToken(
          refreshInput,
        ),
      ])
      for (const result of refreshed) {
        expect(result.status).toBe("ok")
        if (result.status !== "ok") continue
        expect(result.tokens.refreshToken).toBe(tokens.refreshToken)
        expect(
          await remote.store.resolveAccessToken(result.tokens.accessToken),
        ).toEqual(principal)
      }
      await Promise.all([
        remote.store.refreshAccessToken(refreshInput),
        newOAuthStoreForTest(remote.peerStorage()).revokeToken(
          tokens.refreshToken,
        ),
      ])
      expect(
        await remote.store.resolveAccessToken(tokens.accessToken),
      ).toBeNull()
      expect(await remote.store.refreshAccessToken(refreshInput)).toEqual({
        status: "invalid_grant",
      })
    } finally {
      await remote.close()
    }
  },
  120_000,
)
