/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejects assertions require awaiting despite their typings. */
import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  authenticateAdminRequest,
  changeAdminPassword,
  issueAdminSetupCode,
  loginAdmin,
  logoutAdmin,
  resetAdminPassword,
  setAdminAuthClockForTest,
  setupAdminAuth,
} from "../src/lib/admin-auth"
import { createAdminRepository } from "../src/lib/storage/admin-repository"
import { credentialDigest } from "../src/lib/storage/credentials-repository"
import { getStoreRevision } from "../src/lib/storage/operations"
import { createAuthStorageFixture } from "./helpers/auth-storage"

let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
const password = "administrator password"
const gateway = "initial gateway key"
beforeEach(async () => {
  fixture = await createAuthStorageFixture()
})
afterEach(async () => {
  setAdminAuthClockForTest()
  await fixture.close()
})
function request(session: { token: string; csrfToken: string }) {
  return new Request("http://localhost/dashboard", {
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE}=${session.token}; ${ADMIN_CSRF_COOKIE}=${session.csrfToken}`,
      origin: "http://localhost",
      "x-copilot-csrf": session.csrfToken,
    },
  })
}
async function setup() {
  const { code } = await issueAdminSetupCode()
  const result = await setupAdminAuth(gateway, password, code)
  if (!("session" in result)) throw new Error("Setup fixture failed")
  return result.session
}
async function markers() {
  return fixture.storage.read((sql) =>
    sql.query({
      sql: "SELECT id,kind,actor_id,input_digest,result_json FROM capi_applied_operations WHERE kind LIKE 'admin.%'",
      args: [],
    }),
  )
}

test("administrator mutations reconcile committed-but-lost responses without replay or raw operation results", async () => {
  fixture.loseNextCommitResponse()
  const { code } = await issueAdminSetupCode()
  fixture.loseNextCommitResponse()
  const result = await setupAdminAuth(gateway, password, code)
  expect(result).toHaveProperty("session")
  if (!("session" in result)) throw new Error("Setup failed")
  fixture.loseNextCommitResponse()
  const loggedIn = await loginAdmin(gateway, password)
  expect(loggedIn).not.toBeNull()
  fixture.loseNextCommitResponse()
  const changed = await changeAdminPassword(
    request(result.session),
    password,
    "changed password",
  )
  expect(changed).not.toHaveProperty("error")
  fixture.loseNextCommitResponse()
  await resetAdminPassword("recovered password")
  expect(await loginAdmin(gateway, "recovered password")).not.toBeNull()
  const records = await markers()
  expect(records.map((row) => row.kind)).toContain("admin.setup")
  expect(records.map((row) => row.kind)).toContain("admin.password.change")
  for (const secret of [
    code,
    password,
    gateway,
    result.session.token,
    result.session.csrfToken,
  ])
    expect(JSON.stringify(records)).not.toContain(secret)
  expect(
    records.every((row) => row.result_json === '{"status":"committed"}'),
  ).toBe(true)
})

test("pending uncertain operation blocks new writes until its own marker is readable", async () => {
  await setup()
  fixture.loseNextCommitResponse({ failReads: true })
  await expect(resetAdminPassword("first reset")).rejects.toMatchObject({
    code: "storage_commit_unknown",
  })
  await expect(
    createAdminRepository(fixture.storage).logout("another-session"),
  ).rejects.toMatchObject({ code: "storage_commit_unknown" })
  fixture.failReads(false)
  const before = await markers()
  await resetAdminPassword("second reset")
  expect((await markers()).length).toBe(before.length + 1)
  expect(await loginAdmin(gateway, "first reset")).toBeNull()
  expect(await loginAdmin(gateway, "second reset")).not.toBeNull()
})

test("sliding refresh and logout reconcile without changing the configuration revision", async () => {
  const session = await setup()
  const before = await getStoreRevision(fixture.storage)
  setAdminAuthClockForTest({ now: () => Date.now() + 6 * 60_000 })
  fixture.loseNextCommitResponse()
  expect(await authenticateAdminRequest(request(session))).not.toBeNull()
  fixture.loseNextCommitResponse()
  await logoutAdmin(request(session))
  expect(await authenticateAdminRequest(request(session))).toBeNull()
  expect(await getStoreRevision(fixture.storage)).toBe(before)
  expect((await markers()).map((row) => row.kind)).toContain(
    "admin.session.refresh",
  )
  expect((await markers()).map((row) => row.kind)).toContain(
    "admin.session.logout",
  )
})

test.each(["hex", "base64url"] as const)(
  "login final transaction observes an inference reservation in %s added after gateway precheck",
  async (encoding) => {
    await setup()
    const before = await fixture.storage.read((sql) =>
      sql.query({
        sql: "SELECT count(*) AS count FROM capi_admin_sessions",
        args: [],
      }),
    )
    const digest =
      encoding === "hex" ?
        credentialDigest(gateway)
      : Buffer.from(credentialDigest(gateway), "hex").toString("base64url")
    fixture.beforeNextTransaction(async (connection) => {
      await connection.transaction(async (sql) => {
        await sql.execute({
          sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,enabled,scopes_json,created_at,updated_at) VALUES (?,?,?,?,0,?,?,?)",
          args: [
            digest,
            "login-race",
            "managed",
            "inference-managed:login-race",
            '["user:inference"]',
            Date.now(),
            Date.now(),
          ],
        })
      })
    })
    expect(await loginAdmin(gateway, password)).toBeNull()
    expect(
      await fixture.storage.read((sql) =>
        sql.query({
          sql: "SELECT count(*) AS count FROM capi_admin_sessions",
          args: [],
        }),
      ),
    ).toEqual(before)
  },
)

test("a setup code lost with an unreadable commit is never returned by a later issuance", async () => {
  fixture.loseNextCommitResponse({ failReads: true })
  await expect(issueAdminSetupCode()).rejects.toMatchObject({
    code: "storage_commit_unknown",
  })
  await expect(issueAdminSetupCode()).rejects.toMatchObject({
    code: "storage_commit_unknown",
  })
  fixture.failReads(false)
  const prior = await fixture.storage.read((sql) =>
    sql.query({ sql: "SELECT digest FROM capi_setup_codes", args: [] }),
  )
  const fresh = await issueAdminSetupCode()
  const records = await fixture.storage.read((sql) =>
    sql.query({
      sql: "SELECT digest,invalidated_at FROM capi_setup_codes ORDER BY created_at",
      args: [],
    }),
  )
  expect(records).toHaveLength(2)
  expect(
    records.find((row) => row.digest === prior[0]?.digest)?.invalidated_at,
  ).toBeNumber()
  const result = await setupAdminAuth(gateway, password, fresh.code)
  expect(result).toHaveProperty("session")
})
