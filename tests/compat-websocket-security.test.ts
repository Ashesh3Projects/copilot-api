import "./helpers/auth-misc-data-dir"

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  authenticateAdminRequest,
  issueAdminSetupCode,
  setAdminAuthTestMode,
  setupAdminAuth,
} from "../src/lib/admin-auth"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import {
  isIpBlocked,
  leaseIp,
  recordFailedAttempt,
  resetIpSecurityForTest,
} from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import {
  addClientEvents,
  createSession,
  getClientEvents,
} from "../src/routes/code-sessions/session-store"
import { directConnectRoutes } from "../src/routes/direct-connect/route"
import {
  createDirectConnectSession,
  handleDirectConnectWebSocket,
  listDirectConnectSessions,
  resetDirectConnectForTest,
} from "../src/routes/direct-connect/ws-handler"
import { healthRoutes } from "../src/routes/health/route"
import { remoteWebSocket } from "../src/routes/remote/websocket"
import {
  mintRemoteWebSocketTicket,
  resetRemoteWebSocketSecurityForTest,
  tryUpgradeRemoteWebSocket,
} from "../src/routes/remote/ws-security"
import {
  tryUpgradeVoiceWebSocket,
  type VoiceSession,
  voiceWebSocket,
} from "../src/routes/voice/route"
import { server } from "../src/server"
import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const originalGatewayKey = state.apiKeyAuth
const originalDirectConnect = process.env.COPILOT_API_ENABLE_DIRECT_CONNECT
const originalPublicBase = process.env.COPILOT_PUBLIC_BASE_URL
const originalTrustedCidrs = process.env.COPILOT_TRUSTED_PROXY_CIDRS
const originalAdminOrigin = process.env.COPILOT_ADMIN_ORIGIN
const originalAdminPasswordHash = process.env.COPILOT_ADMIN_PASSWORD_HASH
const TEST_ADMIN_ORIGIN = "https://admin.example.test"
let adminCookie = ""

function voiceUpgradeRequest(): Request {
  return new Request("http://localhost/api/ws/speech_to_text/voice_stream", {
    headers: { authorization: "Bearer gateway-secret" },
  })
}

beforeEach(async () => {
  setIpAllowlistForTest([])
  delete process.env.COPILOT_ADMIN_PASSWORD_HASH
  state.apiKeyAuth = "gateway-secret"
  process.env.COPILOT_ADMIN_ORIGIN = TEST_ADMIN_ORIGIN
  setAdminAuthTestMode(true)
  const setup = await setupAdminAuth(
    "gateway-secret",
    "correct horse battery staple",
    (await issueAdminSetupCode()).code,
  )
  if ("error" in setup) throw new Error(setup.error)
  adminCookie = `__Host-copilot_admin=${setup.session.token}; __Host-copilot_admin_csrf=${setup.session.csrfToken}`
  resetRemoteWebSocketSecurityForTest()
  resetDirectConnectForTest()
  resetIpSecurityForTest()
  delete process.env.COPILOT_API_ENABLE_DIRECT_CONNECT
  delete process.env.COPILOT_PUBLIC_BASE_URL
  delete process.env.COPILOT_TRUSTED_PROXY_CIDRS
})

afterEach(() => {
  state.apiKeyAuth = originalGatewayKey
  setAdminAuthTestMode(false)
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
  if (originalDirectConnect === undefined) {
    delete process.env.COPILOT_API_ENABLE_DIRECT_CONNECT
  } else {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = originalDirectConnect
  }
  if (originalPublicBase === undefined)
    delete process.env.COPILOT_PUBLIC_BASE_URL
  else process.env.COPILOT_PUBLIC_BASE_URL = originalPublicBase
  if (originalTrustedCidrs === undefined)
    delete process.env.COPILOT_TRUSTED_PROXY_CIDRS
  else process.env.COPILOT_TRUSTED_PROXY_CIDRS = originalTrustedCidrs
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
})

describe("health and Direct Connect exposure", () => {
  test("health exposes canonical and compatibility liveness routes before auth", async () => {
    for (const pathname of ["/health", "/health/health"]) {
      const response = await server.request(pathname)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "ok" })
    }

    for (const pathname of ["/health", "/health/health"]) {
      const response = await server.request(pathname, { method: "HEAD" })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("")
    }

    for (const [pathname, method] of [
      ["/health", "POST"],
      ["/health/health", "POST"],
      ["/health/unknown", "GET"],
    ] as const) {
      const response = await server.request(pathname, { method })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: "Not found" })
    }

    for (const pathname of ["/", "/health"]) {
      const response = await healthRoutes.request(`http://localhost${pathname}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "ok" })
    }
    expect(
      (await healthRoutes.request("http://localhost/unknown")).status,
    ).toBe(404)
  })

  test("Direct Connect is unavailable unless explicitly enabled", async () => {
    expect(
      (await directConnectRoutes.request("http://localhost/api/sessions"))
        .status,
    ).toBe(404)
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    expect(
      (
        await directConnectRoutes.request("http://localhost/api/sessions", {
          headers: { authorization: "Bearer gateway-secret" },
        })
      ).status,
    ).toBe(200)
  })

  test("Direct Connect returns the resolved public WebSocket URL", async () => {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    process.env.COPILOT_PUBLIC_BASE_URL = "https://public.example.test/gateway"
    const response = await directConnectRoutes.request(
      "http://internal.example.test:8443/",
      {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: "{}",
      },
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      session_id: string
      ws_url: string
    }
    expect(body.ws_url).toBe(
      `wss://public.example.test/gateway/ws/direct/${body.session_id}`,
    )
  })

  test("Direct Connect HTTP auth failures count toward the shared ban", async () => {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    const clientIp = "198.51.100.92"
    const headers = { "x-copilot-peer-ip": clientIp }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        (
          await directConnectRoutes.request("http://localhost/api/sessions", {
            headers,
          })
        ).status,
      ).toBe(401)
    }
    expect(isIpBlocked(clientIp)).toBe(true)
  })

  test("Direct Connect WebSocket auth recovers a banned IP with a valid credential", async () => {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    const clientIp = "198.51.100.93"
    const startModule = (await import("../src/start")) as Record<
      string,
      unknown
    >
    const authorize = startModule.isDirectConnectUpgradeAuthorized
    expect(typeof authorize).toBe("function")
    if (typeof authorize !== "function") return

    const request = new Request("http://localhost/ws/direct/dc_test", {
      headers: {
        "x-api-key": "gateway-secret",
        "x-copilot-peer-ip": clientIp,
      },
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        await (authorize as (request: Request) => Promise<string>)(
          new Request("http://localhost/ws/direct/dc_test", {
            headers: { "x-copilot-peer-ip": clientIp },
          }),
        ),
      ).toBe("unauthorized")
    }
    expect(isIpBlocked(clientIp)).toBe(true)
    expect(
      await (authorize as (request: Request) => Promise<string>)(request),
    ).toBe("authorized")
    expect(isIpBlocked(clientIp)).toBe(false)
  })

  test("start fetch returns uniform Direct Connect upgrade denials without breaking authorized upgrades", async () => {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    const clientIp = "198.51.100.95"
    const session = createDirectConnectSession(new URL("http://localhost/"))
    const startModule = (await import("../src/start")) as Record<
      string,
      unknown
    >
    const handleStartFetch = startModule.handleStartFetch
    expect(typeof handleStartFetch).toBe("function")
    if (typeof handleStartFetch !== "function") return

    const upgrade = mock(() => true)
    const bunServer = {
      requestIP: () => ({ address: clientIp }),
      upgrade,
    }
    const fetchUpgrade = (apiKey?: string) => {
      const headers = new Headers({ upgrade: "websocket" })
      if (apiKey) headers.set("x-api-key", apiKey)
      return (
        handleStartFetch as (
          request: Request,
          server: typeof bunServer,
        ) => Promise<Response>
      )(
        new Request(`http://localhost/ws/direct/${session.session_id}`, {
          headers,
        }),
        bunServer,
      )
    }

    expect((await fetchUpgrade()).status).toBe(401)
    expect((await fetchUpgrade("wrong-key")).status).toBe(401)
    expect(await fetchUpgrade("gateway-secret")).toBeUndefined()
    expect(upgrade).toHaveBeenCalledTimes(1)

    expect((await fetchUpgrade()).status).toBe(401)
    expect(isIpBlocked(clientIp)).toBe(false)
    expect(await fetchUpgrade("gateway-secret")).toBeUndefined()
    expect(upgrade).toHaveBeenCalledTimes(2)
  })

  test("Direct Connect allows multiple handlers for one session", () => {
    const session = createDirectConnectSession(new URL("http://localhost/"))
    const firstSend = mock(() => {})
    const secondSend = mock(() => {})
    const firstClose = mock(() => {})
    const secondClose = mock(() => {})

    handleDirectConnectWebSocket(
      { send: firstSend, close: firstClose },
      session.session_id,
    )
    handleDirectConnectWebSocket(
      { send: secondSend, close: secondClose },
      session.session_id,
    )

    expect(firstSend).toHaveBeenCalledTimes(1)
    expect(secondSend).toHaveBeenCalledTimes(1)
    expect(firstClose).not.toHaveBeenCalled()
    expect(secondClose).not.toHaveBeenCalled()
  })

  test("Direct Connect retains sessions without count eviction", () => {
    const first = createDirectConnectSession(new URL("http://localhost/"))
    for (let index = 0; index < 20; index += 1) {
      createDirectConnectSession(new URL("http://localhost/"))
    }
    expect(listDirectConnectSessions()).toHaveLength(21)
    expect(
      listDirectConnectSessions().some(
        (session) => session.id === first.session_id,
      ),
    ).toBe(true)
  })

  test("Direct Connect closes binary frames without logging their contents", () => {
    const session = createDirectConnectSession(new URL("http://localhost/"))
    const close = mock(() => {})
    const handlers = handleDirectConnectWebSocket(
      { send: () => {}, close },
      session.session_id,
    )
    handlers.onMessage(new Uint8Array([1, 2, 3]))
    expect(close).toHaveBeenCalledWith(4007, "Binary frames not supported")
    handlers.onClose()
  })
})

describe("Direct Connect JSON boundaries", () => {
  test("reject malformed and missing JSON before allocation", async () => {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    const initialCount = listDirectConnectSessions().length

    for (const request of [
      {
        body: "{",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        method: "POST",
      },
      {
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        method: "POST",
      },
    ]) {
      const response = await directConnectRoutes.request(
        "http://localhost/",
        request,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "Invalid JSON" })
      expect(listDirectConnectSessions()).toHaveLength(initialCount)
    }

    const valid = await directConnectRoutes.request("http://localhost/", {
      body: JSON.stringify({ cwd: String.raw`C:\compat` }),
      headers: {
        authorization: "Bearer gateway-secret",
        "content-type": "application/json",
      },
      method: "POST",
    })
    expect(valid.status).toBe(201)
    expect((await valid.json()) as { work_dir: string }).toMatchObject({
      work_dir: String.raw`C:\compat`,
    })
    expect(listDirectConnectSessions()).toHaveLength(initialCount + 1)
  })

  test("authenticates malformed requests before parsing", async () => {
    process.env.COPILOT_API_ENABLE_DIRECT_CONNECT = "true"
    const initialCount = listDirectConnectSessions().length
    const response = await directConnectRoutes.request("http://localhost/", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(401)
    expect(listDirectConnectSessions()).toHaveLength(initialCount)
  })
})

describe("voice WebSocket security", () => {
  test("rejects missing credentials before allocating a session", async () => {
    const upgrade = mock(() => true)
    const result = await tryUpgradeVoiceWebSocket(
      new Request("http://localhost/api/ws/speech_to_text/voice_stream"),
      { upgrade },
    )
    expect(result).toBe("auth_failed")
    expect(upgrade).not.toHaveBeenCalled()
  })

  test("records missing and invalid voice upgrade credentials", async () => {
    const clientIp = "198.51.100.94"
    const upgrade = mock(() => true)
    for (const apiKey of [undefined, undefined, "wrong-key"]) {
      const headers = new Headers({ "x-copilot-peer-ip": clientIp })
      if (apiKey) headers.set("x-api-key", apiKey)
      expect(
        await tryUpgradeVoiceWebSocket(
          new Request("http://localhost/api/ws/speech_to_text/voice_stream", {
            headers,
          }),
          { upgrade },
        ),
      ).toBe("auth_failed")
    }
    expect(isIpBlocked(clientIp)).toBe(true)
    expect(upgrade).not.toHaveBeenCalled()
  })

  test("a valid voice inference credential recovers an actively banned IP", async () => {
    const clientIp = "198.51.100.98"
    const upgrade = mock(() => true)
    recordFailedAttempt(clientIp)
    recordFailedAttempt(clientIp)
    recordFailedAttempt(clientIp)
    expect(isIpBlocked(clientIp)).toBe(true)

    expect(
      await tryUpgradeVoiceWebSocket(
        new Request("http://localhost/api/ws/speech_to_text/voice_stream", {
          headers: {
            authorization: "Bearer gateway-secret",
            "x-copilot-peer-ip": clientIp,
          },
        }),
        { upgrade },
      ),
    ).toBe("upgraded")
    expect(isIpBlocked(clientIp)).toBe(false)
  })

  test("accepts multiple voice connections for one gateway principal", async () => {
    const upgrade = mock(() => true)
    for (let index = 0; index < 5; index += 1) {
      expect(
        await tryUpgradeVoiceWebSocket(voiceUpgradeRequest(), { upgrade }),
      ).toBe("upgraded")
    }
    expect(upgrade).toHaveBeenCalledTimes(5)
  })

  test("accepts audio beyond the former aggregate boundary", () => {
    const close = mock(() => {})
    const session: VoiceSession = {
      pcmChunks: [],
      totalBytes: 0,
      language: "en",
      finalized: false,
      released: false,
    }
    const audio = new Uint8Array(4 * 1024 * 1024 + 1)
    voiceWebSocket.message({ data: { session }, send: () => {}, close }, audio)
    expect(close).not.toHaveBeenCalled()
    expect(session.totalBytes).toBe(audio.length)
  })

  test("accepts large voice control frames", () => {
    const close = mock(() => {})
    const session: VoiceSession = {
      pcmChunks: [],
      totalBytes: 0,
      language: "en",
      finalized: false,
      released: false,
    }
    voiceWebSocket.message(
      { data: { session }, send: () => {}, close },
      JSON.stringify({ type: "KeepAlive", padding: "x".repeat(70_000) }),
    )
    expect(close).not.toHaveBeenCalled()
  })

  test("finalizes an empty stream only once and closes it", () => {
    const close = mock(() => {})
    const send = mock(() => {})
    const session: VoiceSession = {
      pcmChunks: [],
      totalBytes: 0,
      language: "en",
      finalized: false,
      released: false,
    }
    const socket = { data: { session }, send, close }
    voiceWebSocket.message(socket, JSON.stringify({ type: "CloseStream" }))
    voiceWebSocket.message(socket, JSON.stringify({ type: "CloseStream" }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(1000, "Voice stream complete")
  })
})

describe("Remote Control WebSocket tickets", () => {
  test("tickets are session-bound and single-use", async () => {
    const codeSession = createSession("Audit", [])
    const admin = await authenticateAdminRequest(
      new Request(`${TEST_ADMIN_ORIGIN}/dashboard`, {
        headers: { cookie: adminCookie },
      }),
    )
    if (!admin) throw new Error("Expected authenticated admin session")
    const { ticket } = mintRemoteWebSocketTicket(
      admin.tokenHash,
      codeSession.id,
    )
    const upgrade = mock(() => true)
    const request = () =>
      new Request(`${TEST_ADMIN_ORIGIN}/ws/remote/${codeSession.id}`, {
        headers: {
          cookie: adminCookie,
          origin: TEST_ADMIN_ORIGIN,
          "sec-websocket-protocol": `copilot-remote, copilot-ticket.${ticket}`,
        },
      })
    expect(await tryUpgradeRemoteWebSocket(request(), { upgrade })).toBe(
      "upgraded",
    )
    expect(await tryUpgradeRemoteWebSocket(request(), { upgrade })).toBe(
      "auth_failed",
    )
    expect(upgrade).toHaveBeenCalledTimes(1)
  })

  test("retains pending tickets and allows multiple controllers", async () => {
    const codeSession = createSession("Many controllers", [])
    const admin = await authenticateAdminRequest(
      new Request(`${TEST_ADMIN_ORIGIN}/dashboard`, {
        headers: { cookie: adminCookie },
      }),
    )
    if (!admin) throw new Error("Expected authenticated admin session")

    const first = mintRemoteWebSocketTicket(admin.tokenHash, codeSession.id)
    for (let index = 0; index < 520; index += 1) {
      mintRemoteWebSocketTicket(admin.tokenHash, codeSession.id)
    }

    const upgrade = mock(() => true)
    const requestFor = (ticket: string) =>
      new Request(`${TEST_ADMIN_ORIGIN}/ws/remote/${codeSession.id}`, {
        headers: {
          cookie: adminCookie,
          origin: TEST_ADMIN_ORIGIN,
          "sec-websocket-protocol": `copilot-remote, copilot-ticket.${ticket}`,
        },
      })

    expect(
      await tryUpgradeRemoteWebSocket(requestFor(first.ticket), { upgrade }),
    ).toBe("upgraded")
    for (let index = 0; index < 4; index += 1) {
      const { ticket } = mintRemoteWebSocketTicket(
        admin.tokenHash,
        codeSession.id,
      )
      expect(
        await tryUpgradeRemoteWebSocket(requestFor(ticket), { upgrade }),
      ).toBe("upgraded")
    }
    expect(upgrade).toHaveBeenCalledTimes(5)
  })

  test("Remote Control sends complete catchup and accepts large messages", () => {
    const codeSession = createSession("Complete catchup", [])
    addClientEvents(
      codeSession.id,
      Array.from({ length: 600 }, (_, index) => ({
        event_type: "client_event",
        source: "worker",
        payload: { index },
        created_at: new Date(index).toISOString(),
      })),
    )
    const sent: Array<string> = []
    const close = mock(() => {})
    const socket = {
      data: {
        type: "remote-control" as const,
        sessionId: codeSession.id,
      },
      send: (data: string) => sent.push(data),
      close,
    }

    remoteWebSocket.open(socket)
    expect(sent).toHaveLength(600)
    remoteWebSocket.message(
      socket,
      JSON.stringify({
        type: "user",
        session_id: codeSession.id,
        message: { role: "user", content: "x".repeat(70_000) },
      }),
    )
    expect(close).not.toHaveBeenCalled()
    expect(getClientEvents(codeSession.id, 0)).toHaveLength(601)
    remoteWebSocket.close(socket)
  })

  test("does not expose raw admin session identifiers in minted tickets", () => {
    const codeSession = createSession("Audit", [])
    const result = mintRemoteWebSocketTicket(
      "admin-session-hash",
      codeSession.id,
    )
    expect(result.ticket).toHaveLength(43)
    expect(result.ticket).not.toContain("admin-session-hash")
  })

  test("rejects a valid admin session from a banned IP", async () => {
    const codeSession = createSession("Banned admin", [])
    const admin = await authenticateAdminRequest(
      new Request(`${TEST_ADMIN_ORIGIN}/dashboard`, {
        headers: { cookie: adminCookie },
      }),
    )
    if (!admin) throw new Error("Expected authenticated admin session")
    const { ticket } = mintRemoteWebSocketTicket(
      admin.tokenHash,
      codeSession.id,
    )
    const clientIp = "198.51.100.96"
    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordFailedAttempt(clientIp)
    }
    const upgrade = mock(() => true)

    expect(
      await tryUpgradeRemoteWebSocket(
        new Request(`${TEST_ADMIN_ORIGIN}/ws/remote/${codeSession.id}`, {
          headers: {
            cookie: adminCookie,
            origin: TEST_ADMIN_ORIGIN,
            "sec-websocket-protocol": `copilot-remote, copilot-ticket.${ticket}`,
            "x-copilot-peer-ip": clientIp,
          },
        }),
        { upgrade },
      ),
    ).toBe("auth_failed")
    expect(upgrade).not.toHaveBeenCalled()
  })

  test("accepts a valid admin session from a leased banned IP", async () => {
    const codeSession = createSession("Leased admin", [])
    const admin = await authenticateAdminRequest(
      new Request(`${TEST_ADMIN_ORIGIN}/dashboard`, {
        headers: { cookie: adminCookie },
      }),
    )
    if (!admin) throw new Error("Expected authenticated admin session")
    const { ticket } = mintRemoteWebSocketTicket(
      admin.tokenHash,
      codeSession.id,
    )
    const clientIp = "198.51.100.97"
    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordFailedAttempt(clientIp)
    }
    expect(leaseIp(clientIp, 60_000)).toBe(true)
    const upgrade = mock(() => true)

    expect(
      await tryUpgradeRemoteWebSocket(
        new Request(`${TEST_ADMIN_ORIGIN}/ws/remote/${codeSession.id}`, {
          headers: {
            cookie: adminCookie,
            origin: TEST_ADMIN_ORIGIN,
            "sec-websocket-protocol": `copilot-remote, copilot-ticket.${ticket}`,
            "x-copilot-peer-ip": clientIp,
          },
        }),
        { upgrade },
      ),
    ).toBe("upgraded")
    expect(upgrade).toHaveBeenCalledTimes(1)
  })

  test("session replay history retains all events", () => {
    const codeSession = createSession("Complete history", [])
    const events = Array.from({ length: 2025 }, (_, index) => ({
      event_type: "client_event",
      source: "worker",
      payload: { type: "message", index },
      created_at: new Date(index).toISOString(),
    }))
    addClientEvents(codeSession.id, events)
    const retained = getClientEvents(codeSession.id, 0)
    expect(retained).toHaveLength(2025)
    expect(retained[0]?.payload.index).toBe(0)
  })
})
