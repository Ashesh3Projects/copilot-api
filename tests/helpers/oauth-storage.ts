import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import type { Storage } from "~/lib/storage/types"

import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"

const testRoot = resolve(import.meta.dir, "../../.superpowers/test-data/oauth")
process.env.DATA_DIR = testRoot
const { OAuthStore, createPkceChallenge } = await import("~/lib/oauth-store")

export const oauthClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const oauthRedirectUri = "http://localhost:54545/callback"
export const oauthState = "state-with-enough-entropy-123456789"
export const oauthVerifier = "v".repeat(64)
export const oauthScopes = ["user:profile", "user:inference"]

export function newOAuthStoreForTest(storage: Storage) {
  return new OAuthStore({ storage })
}

export async function createOAuthStorageFixture() {
  await mkdir(testRoot, { recursive: true })
  const directory = await mkdtemp(join(testRoot, "store-"))
  const databasePath = join(directory, "copilot-api.sqlite")
  const connections: Array<Storage> = []
  async function connect() {
    const storage = new LocalSqliteStorage(databasePath)
    connections.push(storage)
    await migrateStorage(storage)
    return storage
  }
  const storage = await connect()
  const store = newOAuthStoreForTest(storage)
  const binding = {
    clientId: oauthClientId,
    redirectUri: oauthRedirectUri,
    state: oauthState,
    codeVerifier: oauthVerifier,
  }
  async function issueCode(now = Date.now()) {
    return store.issueAuthorizationCode({
      ...binding,
      scopes: oauthScopes,
      codeChallenge: createPkceChallenge(oauthVerifier),
      now,
    })
  }
  return {
    directory,
    databasePath,
    storage,
    store,
    binding,
    connect,
    issueCode,
    async issue(now = Date.now()) {
      const code = await issueCode(now)
      const result = await store.exchangeAuthorizationCode({
        ...binding,
        code,
        now,
      })
      if (result.status !== "ok")
        throw new Error("Fixture code exchange failed")
      return result.tokens
    },
    async close() {
      for (const connection of connections) await connection.close()
      const checked = resolve(directory)
      if (!checked.startsWith(`${testRoot}${sep}`))
        throw new Error("Unsafe fixture path")
      await rm(checked, { recursive: true, force: true })
    },
  }
}

export async function createRemoteOAuthStorageFixture() {
  const { createStorage } = await import("~/lib/storage/client")
  const { resolveStorageConfig } = await import("~/lib/storage/config")
  const { initialTables } = await import("~/lib/storage/migrations/001-initial")
  const config = resolveStorageConfig()
  if (config.kind !== "turso")
    throw new Error("Remote OAuth test requires Turso configuration")
  const selected = [
    "capi_metadata",
    "capi_applied_operations",
    "capi_oauth_codes",
    "capi_oauth_families",
    "capi_oauth_access",
    "capi_oauth_refresh",
    "capi_inference_credentials",
  ] as const
  const prefix = `test_oauth_${crypto.randomUUID().replaceAll("-", "")}_`
  const mapping = new Map(selected.map((name) => [name, `${prefix}${name}`]))
  const rewrite = (sql: string) =>
    sql.replaceAll(/\bcapi_\w+\b/g, (name) => {
      const renamed = mapping.get(name as (typeof selected)[number])
      if (!renamed)
        throw new Error("OAuth test accessed an unexpected application table")
      return renamed
    })
  const underlying = createStorage(config)
  const wrap = (
    session: import("~/lib/storage/types").SqlSession,
  ): import("~/lib/storage/types").SqlSession => ({
    query: (statement) =>
      session.query({ ...statement, sql: rewrite(statement.sql) }),
    execute: (statement) =>
      session.execute({ ...statement, sql: rewrite(statement.sql) }),
  })
  const peerStorage = (): Storage => ({
    read: (work) => underlying.read((session) => work(wrap(session))),
    transaction: (work) =>
      underlying.transaction((session) => work(wrap(session))),
    atomicBatch: (statements) =>
      underlying.atomicBatch(
        statements.map((statement) => ({
          ...statement,
          sql: rewrite(statement.sql),
        })),
      ),
    close: () => underlying.close(),
  })
  const storage = peerStorage()
  async function close() {
    try {
      await underlying.atomicBatch(
        [...selected].reverse().map((name) => ({
          sql: `DROP TABLE IF EXISTS ${mapping.get(name)}`,
          args: [],
        })),
      )
    } finally {
      await underlying.close()
    }
  }
  try {
    await storage.atomicBatch(
      selected.map((name) => ({
        sql: `CREATE TABLE ${name} (${initialTables[name]})`,
        args: [],
      })),
    )
    await storage.atomicBatch([
      {
        sql: "INSERT INTO capi_metadata (key, value) VALUES ('config_revision', '0')",
        args: [],
      },
    ])
  } catch (error) {
    await close()
    throw error
  }
  return { storage, store: newOAuthStoreForTest(storage), peerStorage, close }
}
