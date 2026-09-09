/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejects assertions require awaiting despite their typings. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

import {
  extractRequestCredential,
  hasSuppliedRequestCredential,
  isGoogleApiCredentialPath,
  isConfiguredInferenceCredential,
  registerCredentialProvider,
  resolveCredential,
  resolveGatewayCredential,
  resolveRequestCredentialKind,
} from "../src/lib/credential-resolver"
import {
  createPkceChallenge,
  OAuthStore,
  setOAuthStoreForTest,
} from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import {
  credentialDigest,
  createCredentialsRepository,
  insertGatewayCredential,
} from "../src/lib/storage/credentials-repository"
import { getStoreRevision } from "../src/lib/storage/operations"
import { createAuthStorageFixture } from "./helpers/auth-storage"

const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const redirectUri = "http://localhost:54545/callback"
const verifier = "v".repeat(64)
const oauthState = "state-with-enough-entropy-123456789"
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let store: OAuthStore
let oldEnv: string | undefined
beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  store = new OAuthStore({ storage: fixture.storage })
  setOAuthStoreForTest(store)
  oldEnv = process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  await fixture.storage.transaction(async (sql) => {
    await insertGatewayCredential(sql, {
      id: "fixture-gateway",
      credential: "gateway-secret",
      label: "Gateway",
      createdAt: Date.now(),
    })
  })
})
afterEach(async () => {
  setOAuthStoreForTest(null)
  state.apiKeyAuth = undefined
  if (oldEnv === undefined)
    delete process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  else process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = oldEnv
  await fixture.close()
})
function bearer(token: string): Request {
  return new Request("http://localhost/protected", {
    headers: { authorization: `Bearer ${token}` },
  })
}
function request(pathname: string, headers?: Record<string, string>): Request {
  return new Request(
    `http://localhost${pathname}`,
    headers === undefined ? undefined : { headers: new Headers(headers) },
  )
}
async function issueOAuthToken(): Promise<string> {
  const code = await store.issueAuthorizationCode({
    clientId,
    redirectUri,
    scopes: ["user:profile", "user:inference"],
    state: oauthState,
    codeChallenge: createPkceChallenge(verifier),
  })
  const result = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    state: oauthState,
    codeVerifier: verifier,
  })
  if (result.status !== "ok") throw new Error("Failed to issue OAuth token")
  return result.tokens.accessToken
}
async function inference(raw: string, enabled = true) {
  const id = randomUUID()
  await fixture.storage.transaction(async (sql) => {
    await sql.execute({
      sql: "INSERT INTO capi_inference_credentials (digest,id,kind,principal_id,enabled,scopes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      args: [
        credentialDigest(raw),
        id,
        "managed",
        `inference-managed:${id}`,
        enabled ? 1 : 0,
        '["user:inference"]',
        Date.now(),
        Date.now(),
      ],
    })
  })
  return id
}

test("distinguishes gateway, OAuth and inference-only credentials with stable principals", async () => {
  const oauth = await issueOAuthToken()
  const key = await store.mintInferenceCredential()
  expect(
    await resolveRequestCredentialKind(bearer("gateway-secret"), "gateway"),
  ).toMatchObject({
    kind: "gateway",
    principalId: `gateway:${credentialDigest("gateway-secret").slice(0, 16)}`,
  })
  expect(
    await resolveRequestCredentialKind(bearer(oauth), "oauth", {
      requiredScopes: ["user:profile"],
    }),
  ).toMatchObject({ kind: "oauth" })
  expect(
    await resolveRequestCredentialKind(bearer(key), "inference-client", {
      requiredScopes: ["user:inference"],
    }),
  ).toMatchObject({ kind: "inference-client" })
  expect(
    await resolveRequestCredentialKind(bearer(oauth), "gateway"),
  ).toBeNull()
  expect(await resolveCredential(key, ["org:create_api_key"])).toBeNull()
  expect(await resolveCredential(oauth, ["voice:transcribe"])).not.toBeNull()
})

test("configured inference scopes cannot expand beyond inference", async () => {
  const id = await inference("managed.jwt.signature")
  expect(
    await resolveCredential("managed.jwt.signature", ["user:inference"]),
  ).toMatchObject({
    kind: "inference-client",
    principalId: `inference-managed:${id}`,
    scopes: new Set(["user:inference"]),
  })
  expect(
    await resolveCredential("managed.jwt.signature", ["user:profile"]),
  ).toBeNull()
  expect(
    await resolveCredential("managed.jwt.signature", ["voice:transcribe"]),
  ).toBeNull()
  expect(
    await resolveCredential(credentialDigest("managed.jwt.signature")),
  ).toBeNull()
  expect(
    await resolveCredential(
      credentialDigest("managed.jwt.signature").toUpperCase(),
    ),
  ).toBeNull()
})

test("disabled and revoked inference credentials block gateway and OAuth elevation", async () => {
  const oauth = await issueOAuthToken()
  await inference("gateway-secret", false)
  await inference(oauth, false)
  expect(await resolveCredential("gateway-secret")).toBeNull()
  expect(await resolveGatewayCredential("gateway-secret")).toBeNull()
  expect(await resolveCredential(oauth)).toBeNull()
  await fixture.storage.transaction(async (sql) => {
    await sql.execute({
      sql: "UPDATE capi_inference_credentials SET enabled = 1, revoked_at = ?",
      args: [Date.now()],
    })
  })
  expect(await isConfiguredInferenceCredential(oauth)).toBe(true)
  expect(await resolveCredential(oauth)).toBeNull()
})

test("digest literals cannot authenticate even when they collide with gateway raw input", async () => {
  const literal = credentialDigest("inference-only-secret")
  await inference("inference-only-secret")
  await fixture.storage.transaction(async (sql) => {
    await insertGatewayCredential(sql, {
      id: "literal-key",
      credential: literal,
      label: "Literal",
      createdAt: Date.now(),
    })
  })
  expect(await resolveCredential(literal)).toBeNull()
  expect(await resolveGatewayCredential(literal)).toBeNull()
  expect(await resolveCredential(credentialDigest("gateway-secret"))).toBeNull()
})

test("legacy environment and process state never override database credentials", async () => {
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S =
    credentialDigest("environment-token")
  state.apiKeyAuth = "legacy-gateway"
  expect(await resolveCredential("environment-token")).toBeNull()
  expect(await resolveCredential("legacy-gateway")).toBeNull()
  expect(await resolveCredential("gateway-secret")).toMatchObject({
    kind: "gateway",
  })
})

test("preserves internal bearer whitespace for inference classification", async () => {
  await inference("inference  secret")
  expect(
    await resolveRequestCredentialKind(
      bearer("inference  secret"),
      "inference-client",
    ),
  ).not.toBeNull()
  expect(await resolveCredential("inference secret")).toBeNull()
})

test("custom gateway keys remain revealable across restart and last-key deletion is rejected", async () => {
  const repo = createCredentialsRepository(fixture.storage)
  const context = {
    actorId: "admin:fixture",
    operationId: randomUUID(),
    kind: "gateway.create",
    inputDigest: "create-key",
    expectedRevision: await getStoreRevision(fixture.storage),
  }
  const raw = "fixture-custom-laptop-gateway"
  const input = { label: "Laptop", credential: raw }
  const created = await repo.create(input, context)
  expect(created.value.maskedValue).toBe("fixtu...teway")
  expect(await resolveCredential(raw)).toMatchObject({
    kind: "gateway",
  })
  const replayed = await repo.create(input, context)
  expect(replayed).toEqual(created)
  expect(await repo.reveal(created.value.id)).toMatchObject({ credential: raw })
  expect(JSON.stringify(await repo.list())).not.toContain(raw)
  expect(JSON.stringify(await repo.list())).not.toContain("digest")
  const markers = await fixture.storage.read((sql) =>
    sql.query({
      sql: "SELECT result_json FROM capi_applied_operations",
      args: [],
    }),
  )
  expect(JSON.stringify(markers)).not.toContain(raw)
  await repo.remove("fixture-gateway", {
    ...context,
    operationId: randomUUID(),
    kind: "gateway.delete",
    expectedRevision: created.revision,
  })
  expect(await resolveCredential("gateway-secret")).toBeNull()
  await fixture.restart()
  expect(await resolveCredential(raw)).not.toBeNull()
  await expect(
    repo.remove(created.value.id, {
      ...context,
      operationId: randomUUID(),
      kind: "gateway.delete",
      expectedRevision: await getStoreRevision(fixture.storage),
    }),
  ).rejects.toThrow("last gateway")
})

test("digest-only gateway records never authenticate or appear as usable keys", async () => {
  const raw = "fixture-digest-only-gateway"
  await fixture.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES('digest-only',?,'Digest only',0)",
      args: [credentialDigest(raw)],
    },
  ])
  const repository = createCredentialsRepository(fixture.storage)
  expect(await resolveGatewayCredential(raw)).toBeNull()
  expect(await repository.reveal("digest-only")).toBeNull()
  expect((await repository.list()).map((key) => key.id)).not.toContain(
    "digest-only",
  )
})

test("a gateway metadata/raw mismatch cannot authenticate", async () => {
  await fixture.storage.atomicBatch([
    {
      sql: "UPDATE capi_gateway_secrets SET secret_value=? WHERE credential_id=?",
      args: ["fixture-wrong-value", "fixture-gateway"],
    },
  ])
  expect(await resolveGatewayCredential("gateway-secret")).toBeNull()
  await expect(
    createCredentialsRepository(fixture.storage).reveal("fixture-gateway"),
  ).rejects.toMatchObject({ code: "storage_schema" })
})

test("fresh indexed reads observe revocation and lookup errors stay typed", async () => {
  const key = await inference("revoked-later")
  expect(await resolveCredential("revoked-later")).not.toBeNull()
  await fixture.storage.transaction(async (sql) => {
    await sql.execute({
      sql: "UPDATE capi_inference_credentials SET revoked_at = ? WHERE id = ?",
      args: [Date.now(), key],
    })
  })
  expect(await resolveCredential("revoked-later")).toBeNull()
  fixture.failReads()
  await expect(resolveCredential("gateway-secret")).rejects.toMatchObject({
    code: "storage_unavailable",
  })
})

test("rejects ambiguous credentials and accepts long credential values", () => {
  expect(
    extractRequestCredential(
      new Request("http://localhost", {
        headers: {
          authorization: "Bearer first",
          "x-api-key": "second",
        },
      }),
    ),
  ).toBeNull()
  const longCredential = "x".repeat(4097)
  expect(
    extractRequestCredential(
      new Request("http://localhost", {
        headers: { authorization: `Bearer ${longCredential}` },
      }),
    ),
  ).toBe(longCredential)
})

test("recognizes only exact Google API credential action paths", () => {
  for (const prefix of ["", "/v1", "/v1beta"]) {
    for (const action of [
      "generateContent",
      "streamGenerateContent",
      "countTokens",
    ]) {
      const pathname = `${prefix}/models/model.with-dashes:${action}`
      expect(isGoogleApiCredentialPath(pathname)).toBe(true)
      expect(isGoogleApiCredentialPath(`${pathname}/`)).toBe(true)
    }
  }

  for (const pathname of [
    "/models",
    "/v1/models",
    "/v1beta/models",
    "/models/:generateContent",
    "/models/a/b:generateContent",
    "/v2/models/x:generateContent",
    "/models/x:futureAction",
    "/models/x:GenerateContent",
    "/proxy/v1/models/x:generateContent",
    "/v1/responses",
    "/v1/models/x:generateContent/extra",
    "/v1/models/x:generateContent//",
  ]) {
    expect(isGoogleApiCredentialPath(pathname)).toBe(false)
  }
})

test("collects, trims, and deduplicates Google query and header credentials", () => {
  const googlePath = "/v1/models/model.with-dashes:generateContent"
  expect(extractRequestCredential(request(`${googlePath}?key=shared`))).toBe(
    "shared",
  )
  expect(
    extractRequestCredential(
      request(`${googlePath}?key=%20shared%20`, {
        authorization: "Bearer shared",
        "x-api-key": " shared ",
        "x-goog-api-key": "shared",
      }),
    ),
  ).toBe("shared")
  expect(
    extractRequestCredential(
      request(`${googlePath}?key=first&key=second`, {
        "x-goog-api-key": "first",
      }),
    ),
  ).toBeNull()
  expect(
    extractRequestCredential(
      request(`${googlePath}?key=shared&key=%20shared%20`),
    ),
  ).toBe("shared")
  expect(
    extractRequestCredential(request(`${googlePath}?key=&key=shared`)),
  ).toBe("shared")
  expect(
    extractRequestCredential(request(`${googlePath}?key=first&key=second`)),
  ).toBeNull()
})

test("limits query credentials to Google actions and preserves supplied-attempt semantics", () => {
  const googlePath = "/v1beta/models/x:countTokens"
  expect(
    hasSuppliedRequestCredential(request(`${googlePath}?key=shared`)),
  ).toBe(true)
  expect(hasSuppliedRequestCredential(request(`${googlePath}?key=%20`))).toBe(
    false,
  )
  expect(extractRequestCredential(request(`${googlePath}?key=%20`))).toBeNull()

  for (const pathname of [
    "/v1/responses?key=shared",
    "/v1/models/x:futureAction?key=shared",
    "/v2/models/x:generateContent?key=shared",
    "/v1/responses?next=/v1/models/x:generateContent&key=shared",
  ]) {
    expect(hasSuppliedRequestCredential(request(pathname))).toBe(false)
    expect(extractRequestCredential(request(pathname))).toBeNull()
  }

  const suppliedHeaders: Array<Record<string, string>> = [
    { "x-api-key": "" },
    { "x-goog-api-key": "" },
    { authorization: "" },
    { authorization: "Basic malformed" },
  ]
  for (const headers of suppliedHeaders) {
    expect(
      hasSuppliedRequestCredential(request("/v1/responses", headers)),
    ).toBe(true)
    expect(
      extractRequestCredential(request("/v1/responses", headers)),
    ).toBeNull()
  }
})

test("dispatches worker, environment, and admin through typed providers", async () => {
  const unregisterWorker = registerCredentialProvider(
    "worker",
    (_request, context) =>
      context.sessionId === "session-1" ?
        {
          kind: "worker",
          principalId: "worker:session-1",
          scopes: new Set(),
        }
      : null,
  )
  const unregisterEnvironment = registerCredentialProvider(
    "environment",
    (_request, context) =>
      context.environmentId === "environment-1" ?
        {
          kind: "environment",
          principalId: "environment:environment-1",
          scopes: new Set(),
        }
      : null,
  )
  const unregisterAdmin = registerCredentialProvider("admin", () => ({
    kind: "admin",
    principalId: "admin:test",
    scopes: new Set(),
  }))

  try {
    const request = new Request("http://localhost/protected")
    expect(
      await resolveRequestCredentialKind(request, "worker", {
        sessionId: "session-1",
      }),
    ).toMatchObject({ kind: "worker" })
    expect(
      await resolveRequestCredentialKind(request, "environment", {
        environmentId: "environment-1",
      }),
    ).toMatchObject({ kind: "environment" })
    expect(await resolveRequestCredentialKind(request, "admin")).toMatchObject({
      kind: "admin",
    })
  } finally {
    unregisterWorker()
    unregisterEnvironment()
    unregisterAdmin()
  }
})
