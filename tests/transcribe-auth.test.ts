import "./helpers/auth-misc-data-dir"

import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"

import { setConfigForTest } from "../src/lib/config"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import {
  isIpBlocked,
  isIpWhitelisted,
  leaseIp,
  recordFailedAttempt,
  resetIpSecurityForTest,
  unwhitelistIp,
} from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { trustedJwtDigestStore } from "../src/lib/trusted-jwt-digests"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalApiKeyAuth = state.apiKeyAuth
const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) => {
  return new Response(JSON.stringify({ text: "hello from dictation" }), {
    headers: { "content-type": "application/json" },
  })
})

const chatCompletionsMock = mock(
  (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "cleaned text" } }],
      }),
      { headers: { "content-type": "application/json" } },
    )
  },
)

beforeEach(async () => {
  resetIpSecurityForTest()
  state.apiKeyAuth = undefined
  state.models = { object: "list", data: [] }
  state.copilotToken = "copilot-token"
  setConfigForTest({
    auth: { apiKeys: ["config-secret"] },
    groqApiKey: "groq-secret",
  })
  trustedJwtDigestStore.resetAfterTest()
  setIpAllowlistForTest([])
  fetchMock.mockClear()
  chatCompletionsMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  // Drop any IP whitelisted by an earlier test so each case starts from a
  // known, un-whitelisted state.
  for (const ip of [
    "203.0.113.44",
    "203.0.113.45",
    "203.0.113.46",
    "203.0.113.50",
    "203.0.113.51",
    "203.0.113.52",
    "203.0.113.53",
    "203.0.113.54",
    "203.0.113.55",
    "203.0.113.56",
  ]) {
    unwhitelistIp(ip)
  }
  await seedProtocolDatabase({ gatewayKeys: ["config-secret"] })
})

afterAll(() => {
  resetIpSecurityForTest()
  state.apiKeyAuth = originalApiKeyAuth
  state.models = originalModels
  state.copilotToken = originalCopilotToken
  setConfigForTest(null)
  trustedJwtDigestStore.resetAfterTest()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("configured inference auth persistently authorizes the same IP for transcribe only", async () => {
  const clientIp = "203.0.113.44"

  const modelsResponse = await server.request("/v1/models", {
    headers: {
      authorization: "Bearer config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
  })

  expect(modelsResponse.status).toBe(200)
  expect(isIpWhitelisted(clientIp)).toBe(false)

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const transcribeResponse = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(transcribeResponse.status).toBe(200)

  const transparentProxyResponse = await server.request("/api/desktop/update", {
    headers: {
      host: "claude.ai",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
  })
  expect(transparentProxyResponse.status).toBe(401)

  const codexResponsesResponse = await server.request("/codex/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: JSON.stringify({ instructions: "x", input: [] }),
  })
  expect(codexResponsesResponse.status).toBe(401)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wrongCredentialResponse = await server.request(
      "/api/desktop/update",
      {
        headers: {
          host: "claude.ai",
          "x-api-key": "wrong-key",
          "x-copilot-peer-ip": "127.0.0.1",
          "x-forwarded-for": clientIp,
        },
      },
    )
    expect(wrongCredentialResponse.status).toBe(401)
  }
  expect(isIpBlocked(clientIp)).toBe(false)
})

test("transcribe still rejects an IP that has not authenticated", async () => {
  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": "203.0.113.45",
    },
    body: formData,
  })

  expect(response.status).toBe(401)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("managed allowlist accepts a different IPv6 address for transcribe", async () => {
  const ipv4 = "203.0.113.46"
  const ipv6 = "2406:7400:63:c69b:78ad:65b1:41f5:ccce"

  const modelsResponse = await server.request("/v1/models", {
    headers: {
      authorization: "Bearer config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": ipv4,
    },
  })
  expect(modelsResponse.status).toBe(200)

  setIpAllowlistForTest([
    {
      ip: ipv6,
      enabled: true,
      source: "manual",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
    },
  ])

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": ipv6,
    },
    body: formData,
  })

  expect(response.status).toBe(200)
})

test("transcribe: a valid bearer directly authorizes and persists the IP fallback", async () => {
  const clientIp = "203.0.113.50"
  expect(isIpWhitelisted(clientIp)).toBe(false)

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(isIpWhitelisted(clientIp)).toBe(false)

  const fallbackFormData = new FormData()
  fallbackFormData.append(
    "file",
    new Blob(["audio"], { type: "audio/webm" }),
    "a.webm",
  )
  const fallback = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: fallbackFormData,
  })
  expect(fallback.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test("transcribe: a dashboard-managed ChatGPT-shaped JWT authorizes dictation", async () => {
  const clientIp = "203.0.113.57"
  const token = "header.chatgpt-shaped-payload.signature"
  await trustedJwtDigestStore.add({
    label: "Codex Desktop",
    digest: createHash("sha256").update(token, "utf8").digest("hex"),
  })

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: "hello from dictation" })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("transcribe: a valid x-api-key directly authorizes dictation", async () => {
  const clientIp = "203.0.113.51"

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-api-key": "config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("transcribe: an invalid supplied credential cannot fall through to an allowlisted IP", async () => {
  const clientIp = "203.0.113.52"
  setIpAllowlistForTest([{ ip: clientIp, enabled: true }])

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-key",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(401)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("Codex missing credentials count when no allowlist applies", async () => {
  const clientIp = "203.0.113.58"

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const formData = new FormData()
    formData.append(
      "file",
      new Blob(["audio"], { type: "audio/webm" }),
      "a.webm",
    )
    expect(
      (
        await server.request("/transcribe", {
          method: "POST",
          headers: {
            "x-copilot-peer-ip": "127.0.0.1",
            "x-forwarded-for": clientIp,
          },
          body: formData,
        })
      ).status,
    ).toBe(401)
  }

  expect(isIpBlocked(clientIp)).toBe(true)
})

test("Codex allowlist bypass does not record a failure", async () => {
  const clientIp = "203.0.113.59"
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  setIpAllowlistForTest([{ ip: clientIp, enabled: true }])

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")
  expect(
    (
      await server.request("/transcribe", {
        method: "POST",
        headers: {
          "x-copilot-peer-ip": "127.0.0.1",
          "x-forwarded-for": clientIp,
        },
        body: formData,
      })
    ).status,
  ).toBe(200)

  setIpAllowlistForTest([])
  expect(isIpBlocked(clientIp)).toBe(false)
})

test("Codex credential-free allowlists bypass bans without clearing history", async () => {
  const managedIp = "203.0.113.60"
  const leasedIp = "203.0.113.61"

  for (const clientIp of [managedIp, leasedIp]) {
    recordFailedAttempt(clientIp)
    recordFailedAttempt(clientIp)
    recordFailedAttempt(clientIp)
  }
  setIpAllowlistForTest([{ ip: managedIp, enabled: true }])
  leaseIp(leasedIp, 60_000)

  for (const clientIp of [managedIp, leasedIp]) {
    const formData = new FormData()
    formData.append(
      "file",
      new Blob(["audio"], { type: "audio/webm" }),
      "a.webm",
    )
    const response = await server.request("/transcribe", {
      method: "POST",
      headers: {
        "x-copilot-peer-ip": "127.0.0.1",
        "x-forwarded-for": clientIp,
      },
      body: formData,
    })

    expect(response.status).toBe(200)
  }
  expect(fetchMock).toHaveBeenCalledTimes(2)

  setIpAllowlistForTest([])
  expect(unwhitelistIp(leasedIp)).toBe(true)
  expect(isIpBlocked(managedIp)).toBe(true)
  expect(isIpBlocked(leasedIp)).toBe(true)
})

test("transcribe: an invalid bearer cannot authorize a fresh IP", async () => {
  setConfigForTest({ groqApiKey: "groq-secret" })
  const clientIp = "203.0.113.53"

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  // Without any auth at all, a fresh IP is rejected.
  const reject = await server.request("/transcribe", {
    method: "POST",
    headers: {
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })
  expect(reject.status).toBe(401)

  // A supplied invalid bearer fails closed.
  const rejectBearer = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer anything",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })
  expect(rejectBearer.status).toBe(401)
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("codex-responses: direct Authorization Bearer is accepted", async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    chatCompletionsMock as unknown as typeof fetch

  const clientIp = "203.0.113.54"

  const response = await server.request("/codex/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      instructions: "cleanup",
      input: [
        { type: "message", role: "user", content: [{ text: "hi there" }] },
      ],
    }),
  })

  expect(response.status).toBe(200)
  const text = await response.text()
  // Hono streamSSE wraps each writeSSE in `data: ...\n\n`.
  expect(text).toContain('"type":"response.output_text.done"')
  expect(text).toContain('"text":"cleaned text"')
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("codex-responses: wrong bearer returns a uniform authentication response", async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    chatCompletionsMock as unknown as typeof fetch

  const clientIp = "203.0.113.55"

  const response = await server.request("/codex/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-key",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
      "content-type": "application/json",
    },
    body: JSON.stringify({ instructions: "x", input: [] }),
  })

  expect(response.status).toBe(401)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("www-authenticate")).toBe(
    "Be" + 'arer realm="copilot-api"',
  )
  expect(await response.json()).toEqual({
    error: { message: "Unauthorized", type: "authentication_error" },
  })
  expect(chatCompletionsMock).not.toHaveBeenCalled()
  expect(isIpWhitelisted(clientIp)).toBe(false)
})

test("codex-responses: invalid bearer cannot fall through to an allowed IP", async () => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    chatCompletionsMock as unknown as typeof fetch

  const clientIp = "203.0.113.55"
  setIpAllowlistForTest([{ ip: clientIp, enabled: true }])

  const response = await server.request("/codex/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-key",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
      "content-type": "application/json",
    },
    body: JSON.stringify({ instructions: "x", input: [] }),
  })

  expect(response.status).toBe(401)
  expect(chatCompletionsMock).not.toHaveBeenCalled()
})

test("codex-responses: missing credentials return 401 and count failures", async () => {
  const clientIp = "203.0.113.62"

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await server.request("/codex/responses", {
      method: "POST",
      headers: {
        "x-copilot-peer-ip": "127.0.0.1",
        "x-forwarded-for": clientIp,
        "content-type": "application/json",
      },
      body: JSON.stringify({ instructions: "x", input: [] }),
    })
    expect(response.status).toBe(401)
  }

  expect(isIpBlocked(clientIp)).toBe(true)
})

test("codex-responses: an active ban returns 401 for a valid credential", async () => {
  const clientIp = "203.0.113.63"
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)

  const response = await server.request("/codex/responses", {
    method: "POST",
    headers: {
      authorization: "******",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
      "content-type": "application/json",
    },
    body: JSON.stringify({ instructions: "x", input: [] }),
  })

  expect(response.status).toBe(401)
})

test("codex-responses: an active lease suppresses a ban after valid credential authentication", async () => {
  const clientIp = "203.0.113.64"
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  recordFailedAttempt(clientIp)
  leaseIp(clientIp, 60_000)

  const response = await server.request("/codex/responses", {
    method: "POST",
    headers: {
      "x-api-key": "config-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
      "content-type": "application/json",
    },
    body: JSON.stringify({ instructions: "x", input: [] }),
  })
  expect(response.status).toBe(200)
})

test("transcribe: --api-key-auth CLI key directly authorizes dictation", async () => {
  await seedProtocolDatabase({ gatewayKeys: ["cli-secret"] })
  state.apiKeyAuth = "cli-secret"
  setConfigForTest({ groqApiKey: "groq-secret" }) // no config keys
  const clientIp = "203.0.113.56"

  const formData = new FormData()
  formData.append("file", new Blob(["audio"], { type: "audio/webm" }), "a.webm")

  const response = await server.request("/transcribe", {
    method: "POST",
    headers: {
      authorization: "Bearer cli-secret",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: formData,
  })

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(isIpWhitelisted(clientIp)).toBe(false)
})
