import "./helpers/auth-misc-data-dir"

import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  issueAdminSetupCode,
  setAdminAuthTestMode,
} from "../src/lib/admin-auth"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { getStorageRuntime } from "../src/lib/storage/runtime"
import { trustedJwtDigestStore } from "../src/lib/trusted-jwt-digests"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  setupProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const GATEWAY_KEY = "test-gateway-key-that-is-long-and-random"
const GATEWAY_DIGEST =
  "df2e72644a61cfed6c45f096088b19630fe03aac69c6f2e3757f0ea81107901c"
let setupCode = ""
const ADMIN_PASSWORD = "correct horse battery staple"
const ORIGIN = "https://gateway.example.com"

const originalAdminOrigin = process.env.COPILOT_ADMIN_ORIGIN
const originalAdminPasswordHash = process.env.COPILOT_ADMIN_PASSWORD_HASH
const originalInferenceCredentialDigests =
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
const originalGatewayKey = state.apiKeyAuth

async function setInferenceCredentialDigests(
  value: string | undefined,
): Promise<void> {
  await getStorageRuntime().storage.transaction(async (session) => {
    await session.execute({
      sql: "DELETE FROM capi_inference_credentials WHERE digest = ?",
      args: [GATEWAY_DIGEST],
    })
    if (value !== undefined)
      await session.execute({
        sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,scopes_json,created_at,updated_at) VALUES (?,?,'managed',?,'[\"user:inference\"]',?,?)",
        args: [value, value, `fixture:${value}`, Date.now(), Date.now()],
      })
  })
  if (value === undefined) {
    delete process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  } else {
    process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = value
  }
}

async function adminRequest(
  path: string,
  gatewayKey = GATEWAY_KEY,
): Promise<Response> {
  return await server.request(`/dashboard/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      gatewayKey,
      ...(path === "setup" ? { setupCode } : {}),
      password: ADMIN_PASSWORD,
    }),
  })
}

beforeEach(async () => {
  setIpAllowlistForTest([])
  resetIpSecurityForTest()
  setAdminAuthTestMode(true)
  setupCode = (await issueAdminSetupCode()).code
  delete process.env.COPILOT_ADMIN_PASSWORD_HASH
  process.env.COPILOT_ADMIN_ORIGIN = ORIGIN
  state.apiKeyAuth = GATEWAY_KEY
  await setInferenceCredentialDigests(undefined)
  trustedJwtDigestStore.resetAfterTest()
})

afterEach(() => {
  setIpAllowlistForTest([])
  resetIpSecurityForTest()
  setAdminAuthTestMode(false)
  state.apiKeyAuth = originalGatewayKey
  if (originalAdminOrigin === undefined) {
    delete process.env.COPILOT_ADMIN_ORIGIN
  } else {
    process.env.COPILOT_ADMIN_ORIGIN = originalAdminOrigin
  }
  if (originalAdminPasswordHash === undefined) {
    delete process.env.COPILOT_ADMIN_PASSWORD_HASH
  } else {
    process.env.COPILOT_ADMIN_PASSWORD_HASH = originalAdminPasswordHash
  }
  if (originalInferenceCredentialDigests === undefined)
    delete process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  else
    process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S =
      originalInferenceCredentialDigests
  trustedJwtDigestStore.resetAfterTest()
})

test("digest-listed gateway credentials cannot set up or log in as administrator", async () => {
  await setInferenceCredentialDigests(GATEWAY_DIGEST)
  expect((await adminRequest("setup")).status).toBe(401)

  await setInferenceCredentialDigests(undefined)
  expect((await adminRequest("setup")).status).toBe(201)

  await setInferenceCredentialDigests(GATEWAY_DIGEST)
  expect((await adminRequest("login")).status).toBe(401)

  await setInferenceCredentialDigests(GATEWAY_DIGEST)
  expect((await adminRequest("login", ` ${GATEWAY_KEY} `)).status).toBe(401)

  await setupProtocolDatabase()
  setupCode = (await issueAdminSetupCode()).code
  await setInferenceCredentialDigests(GATEWAY_DIGEST)
  state.apiKeyAuth = ` ${GATEWAY_KEY} `
  expect((await adminRequest("setup", ` ${GATEWAY_KEY} `)).status).toBe(401)

  await setupProtocolDatabase()
  setupCode = (await issueAdminSetupCode()).code
  await setInferenceCredentialDigests(GATEWAY_DIGEST)
  state.apiKeyAuth = GATEWAY_DIGEST
  expect((await adminRequest("setup", GATEWAY_DIGEST)).status).toBe(401)
})

test("dashboard-managed gateway credentials cannot set up or log in as administrator", async () => {
  const entry = await trustedJwtDigestStore.add({
    label: "Gateway collision",
    digest: GATEWAY_DIGEST,
  })
  expect((await adminRequest("setup")).status).toBe(401)

  await trustedJwtDigestStore.setEnabled(entry.id, false)
  expect((await adminRequest("setup")).status).toBe(401)

  await trustedJwtDigestStore.remove(entry.id)
  expect((await adminRequest("setup")).status).toBe(201)

  const loginEntry = await trustedJwtDigestStore.add({
    label: "Gateway login collision",
    digest: GATEWAY_DIGEST,
  })
  expect((await adminRequest("login")).status).toBe(401)

  await trustedJwtDigestStore.setEnabled(loginEntry.id, false)
  expect((await adminRequest("login")).status).toBe(401)
})
