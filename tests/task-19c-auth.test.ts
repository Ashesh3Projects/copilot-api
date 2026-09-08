import "./helpers/auth-misc-data-dir"

import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  extractRequestCredential,
  resolveGatewayCredential,
} from "../src/lib/credential-resolver"
import { resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalGateway = state.apiKeyAuth
const originalFetch = globalThis.fetch

let capturedHeaders: Headers | undefined

beforeEach(async () => {
  state.apiKeyAuth = "gateway-19c-private-marker"
  resetIpSecurityForTest()
  capturedHeaders = undefined
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers)
    return Promise.resolve(new Response("ok", { status: 202 }))
  }) as typeof fetch
  await seedProtocolDatabase({ gatewayKeys: ["gateway-19c-private-marker"] })
})

afterEach(() => {
  state.apiKeyAuth = originalGateway
  globalThis.fetch = originalFetch
  resetIpSecurityForTest()
})

function transparentHeaders(extra: Record<string, string> = {}) {
  return {
    host: "api.anthropic.com",
    "x-copilot-peer-ip": "198.51.100.211",
    ...extra,
  }
}

test("dedicated gateway credentials are gateway-only", async () => {
  expect(
    await resolveGatewayCredential("gateway-19c-private-marker"),
  ).toMatchObject({
    kind: "gateway",
  })
  expect(await resolveGatewayCredential(" wrong ")).toBeNull()
  expect(
    extractRequestCredential(
      new Request("http://localhost/v1/messages", {
        headers: { "x-copilot-gateway-key": "gateway-19c-private-marker" },
      }),
    ),
  ).toBeNull()
})

test("transparent auth preserves provider credentials and strips its gateway key", async () => {
  const response = await server.request("/unknown-provider-path", {
    headers: transparentHeaders({
      authorization: "Bearer provider-bearer-19c-private-marker",
      "x-api-key": "provider-x-api-key-19c-private-marker",
      "x-goog-api-key": "provider-google-19c-private-marker",
      "x-copilot-gateway-key": "gateway-19c-private-marker",
    }),
  })
  expect(response.status).toBe(202)
  expect(capturedHeaders?.get("authorization")).toBe(
    "Bearer provider-bearer-19c-private-marker",
  )
  expect(capturedHeaders?.get("x-api-key")).toBe(
    "provider-x-api-key-19c-private-marker",
  )
  expect(capturedHeaders?.get("x-goog-api-key")).toBe(
    "provider-google-19c-private-marker",
  )
  expect(capturedHeaders?.has("x-copilot-gateway-key")).toBe(false)
})

test("explicit invalid dedicated auth cannot fall back to IP authorization", async () => {
  const response = await server.request("/unknown-provider-path", {
    headers: transparentHeaders({ "x-copilot-gateway-key": "wrong" }),
  })
  expect(response.status).toBe(401)
  expect(capturedHeaders).toBeUndefined()
})

test("dedicated auth has no meaning on ordinary inference routes", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-copilot-gateway-key": "gateway-19c-private-marker",
      "x-copilot-peer-ip": "198.51.100.212",
    },
    body: JSON.stringify({ model: "claude-sonnet-4", messages: [] }),
  })
  expect(response.status).toBe(401)
  expect(capturedHeaders).toBeUndefined()
})
