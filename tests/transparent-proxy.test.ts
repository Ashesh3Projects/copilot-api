import "./helpers/auth-misc-data-dir"

import { afterAll, beforeEach, expect, mock, test } from "bun:test"

import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import {
  isIpBlocked,
  leaseIp,
  recordFailedAttempt,
  resetIpSecurityForTest,
  unwhitelistIp,
} from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalApiKeyAuth = state.apiKeyAuth
const originalFetch = globalThis.fetch

function getFetchUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.href
  return url.url
}

const fetchMock = mock((url: string | URL | Request, _init?: RequestInit) => {
  return new Response(`proxied:${getFetchUrl(url)}`, {
    status: 202,
    headers: { "x-upstream": "anthropic" },
  })
})

beforeEach(async () => {
  state.apiKeyAuth = "test-secret-key"
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  await seedProtocolDatabase({ gatewayKeys: ["test-secret-key"] })
})

afterAll(() => {
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
  state.apiKeyAuth = originalApiKeyAuth
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

function whitelistIp(ip: string): void {
  setIpAllowlistForTest([{ ip, enabled: true, source: "manual" }])
}

function trustedHeaders(ip: string): Record<string, string> {
  return { "x-copilot-peer-ip": "127.0.0.1", "x-forwarded-for": ip }
}

test("proxies unknown routes for whitelisted redirected Anthropic hosts", async () => {
  const ip = "198.51.100.10"
  whitelistIp(ip)

  const response = await server.request("/random-endpoint?channel=stable", {
    headers: {
      host: "api.anthropic.com",
      ...trustedHeaders(ip),
    },
  })

  expect(response.status).toBe(202)
  expect(response.headers.get("x-upstream")).toBe("anthropic")
  expect(await response.text()).toBe(
    "proxied:https://api.anthropic.com/random-endpoint?channel=stable",
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("passes upstream redirects through without following them", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://claude.ai/download/latest" },
      })
    },
  )

  const ip = "198.51.100.16"
  whitelistIp(ip)

  const response = await server.request("/api/desktop/update", {
    headers: {
      host: "claude.ai",
      ...trustedHeaders(ip),
    },
  })

  const requestInit = fetchMock.mock.calls.at(-1)?.[1] as
    | { redirect?: string }
    | undefined

  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(
    "https://claude.ai/download/latest",
  )
  expect(requestInit?.redirect).toBe("manual")
})

test("strips compressed body headers from transparent proxy responses", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response('{"servers":[]}', {
        status: 200,
        headers: {
          "content-encoding": "br",
          "content-length": "128",
          "content-type": "application/json",
        },
      })
    },
  )

  const ip = "198.51.100.15"
  whitelistIp(ip)

  const response = await server.request(
    "/mcp-registry/v0/servers?version=latest&limit=100",
    {
      headers: {
        host: "api.anthropic.com",
        ...trustedHeaders(ip),
      },
    },
  )

  const requestInit = fetchMock.mock.calls.at(-1)?.[1] as
    | { headers?: Headers }
    | undefined

  expect(response.status).toBe(200)
  expect(response.headers.get("content-encoding")).toBeNull()
  expect(response.headers.get("content-length")).toBeNull()
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(await response.text()).toBe('{"servers":[]}')
  expect(requestInit?.headers?.get("accept-encoding")).toBe("identity")
  expect(requestInit?.headers?.has("host")).toBe(false)
})

test("strips dynamic hop-by-hop headers from transparent proxy responses", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response("ok", {
        headers: {
          connection: "x-internal-hop",
          "content-length": "2",
          "x-internal-hop": "remove-me",
          "x-visible": "keep-me",
        },
      })
    },
  )

  const ip = "198.51.100.17"
  whitelistIp(ip)

  const response = await server.request("/mcp-registry/v0/servers", {
    headers: {
      host: "api.anthropic.com",
      ...trustedHeaders(ip),
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("connection")).toBeNull()
  expect(response.headers.get("x-internal-hop")).toBeNull()
  expect(response.headers.get("x-visible")).toBe("keep-me")
  expect(response.headers.get("content-length")).toBe("2")
})

test("proxies unknown /api routes for whitelisted redirected Claude hosts", async () => {
  const ip = "198.51.100.11"
  whitelistIp(ip)

  const response = await server.request("/api/desktop/update", {
    headers: {
      host: "claude.ai",
      ...trustedHeaders(ip),
    },
  })

  expect(response.status).toBe(202)
  expect(await response.text()).toBe(
    "proxied:https://claude.ai/api/desktop/update",
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("OAuth proxy sink permits credential-free managed and leased IPs despite bans", async () => {
  const managedIp = "198.51.100.18"
  const leasedIp = "198.51.100.19"
  for (const ip of [managedIp, leasedIp]) {
    recordFailedAttempt(ip)
    recordFailedAttempt(ip)
    recordFailedAttempt(ip)
  }
  whitelistIp(managedIp)
  leaseIp(leasedIp, 60_000)

  for (const ip of [managedIp, leasedIp]) {
    const response = await server.request("/api/desktop/update", {
      headers: {
        host: "claude.ai",
        ...trustedHeaders(ip),
      },
    })
    expect(response.status).toBe(202)
  }

  setIpAllowlistForTest([])
  expect(unwhitelistIp(leasedIp)).toBe(true)
  expect(isIpBlocked(managedIp)).toBe(true)
  expect(isIpBlocked(leasedIp)).toBe(true)
})

test("OAuth proxy sink rejects and records an explicitly invalid credential", async () => {
  const ip = "198.51.100.20"
  whitelistIp(ip)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await server.request("/api/desktop/update", {
      headers: {
        host: "claude.ai",
        "x-copilot-gateway-key": "wrong-key",
        ...trustedHeaders(ip),
      },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      error: { message: "Unauthorized", type: "authentication_error" },
    })
  }

  setIpAllowlistForTest([])
  expect(isIpBlocked(ip)).toBe(true)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("OAuth proxy sink valid explicit credentials recover actively banned IPs", async () => {
  const allowedIp = "198.51.100.22"
  const allowed = await server.request("/api/desktop/update", {
    headers: {
      host: "claude.ai",
      "x-copilot-gateway-key": "test-secret-key",
      ...trustedHeaders(allowedIp),
    },
  })
  expect(allowed.status).toBe(202)

  const bannedIp = "198.51.100.23"
  recordFailedAttempt(bannedIp)
  recordFailedAttempt(bannedIp)
  recordFailedAttempt(bannedIp)
  const banned = await server.request("/api/desktop/update", {
    headers: {
      host: "claude.ai",
      "x-copilot-gateway-key": "test-secret-key",
      ...trustedHeaders(bannedIp),
    },
  })
  expect(banned.status).toBe(202)
  expect(isIpBlocked(bannedIp)).toBe(false)
})

test("OAuth proxy sink accepts a valid explicit credential from an actively leased banned IP", async () => {
  const ip = "198.51.100.24"
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  recordFailedAttempt(ip)
  leaseIp(ip, 60_000)

  const response = await server.request("/api/desktop/update", {
    headers: {
      host: "claude.ai",
      "x-copilot-gateway-key": "test-secret-key",
      ...trustedHeaders(ip),
    },
  })

  expect(response.status).toBe(202)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("OAuth proxy sink records missing credentials from a non-allowlisted IP", async () => {
  const ip = "198.51.100.21"

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await server.request("/api/desktop/update", {
      headers: {
        host: "claude.ai",
        ...trustedHeaders(ip),
      },
    })
    expect(response.status).toBe(401)
  }

  expect(isIpBlocked(ip)).toBe(true)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("blocks event logging for whitelisted redirected Claude hosts", async () => {
  const ip = "198.51.100.13"
  whitelistIp(ip)

  const response = await server.request("/api/event_logging/v2/batch", {
    method: "POST",
    headers: {
      host: "claude.ai",
      ...trustedHeaders(ip),
    },
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toBe("")
  expect(fetchMock).not.toHaveBeenCalled()
})

test("does not proxy fallback routes for non-redirected hosts", async () => {
  const response = await server.request("/random-endpoint", {
    headers: {
      authorization: "Bearer test-secret-key",
      host: "localhost",
      "x-forwarded-for": "198.51.100.12",
    },
  })

  expect(response.status).toBe(404)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("does not let whitelisted redirected hosts bypass owned API route auth", async () => {
  const ip = "198.51.100.14"
  whitelistIp(ip)

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { host: "api.anthropic.com", ...trustedHeaders(ip) },
  })

  expect(response.status).toBe(401)
  expect(fetchMock).not.toHaveBeenCalled()
})
