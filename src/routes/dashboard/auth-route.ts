import { Hono } from "hono"
import { deleteCookie, generateCookie, setCookie } from "hono/cookie"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  authenticateAdminRequest,
  changeAdminPassword,
  getAdminAuthStatus,
  isAllowedAdminOrigin,
  loginAdmin,
  logoutAdmin,
  setupAdminAuth,
  type CreatedAdminSession,
} from "~/lib/admin-auth"
import {
  extractClientIp,
  isIpBlocked,
  recordFailedAttempt,
} from "~/lib/ip-blocker"

export const dashboardAuthRoutes = new Hono()

dashboardAuthRoutes.use("*", async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    await next()
    return
  }
  if (!isAllowedAdminOrigin(c.req.header("origin") ?? null)) {
    noStore(c)
    return c.json({ error: "Authentication failed" }, 401)
  }
  await next()
})

function noStore(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "no-store")
}

function setSessionCookies(
  c: Parameters<typeof setCookie>[0],
  session: CreatedAdminSession,
): void {
  setSessionCookieValues(c, session.token, session.csrfToken)
}

function setSessionCookieValues(
  c: Parameters<typeof setCookie>[0],
  token: string,
  csrfToken: string,
): void {
  const maxAge = Math.floor(ADMIN_SESSION_TTL_MS / 1000)
  setCookie(c, ADMIN_SESSION_COOKIE, token, {
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge,
  })
  setCookie(c, ADMIN_CSRF_COOKIE, csrfToken, {
    secure: true,
    httpOnly: false,
    sameSite: "Strict",
    path: "/",
    maxAge,
  })
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie")
  if (!header) return undefined
  let value: string | undefined
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=")
    if (separator < 1 || segment.slice(0, separator).trim() !== name) continue
    value = segment.slice(separator + 1).trim()
  }
  return value
}

export function getRefreshedSessionCookieHeaders(
  request: Request,
): Array<string> {
  const token = readCookie(request, ADMIN_SESSION_COOKIE)
  const csrfToken = readCookie(request, ADMIN_CSRF_COOKIE)
  if (!token || !csrfToken) return []

  const maxAge = Math.floor(ADMIN_SESSION_TTL_MS / 1000)
  return [
    generateCookie(ADMIN_SESSION_COOKIE, token, {
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge,
    }),
    generateCookie(ADMIN_CSRF_COOKIE, csrfToken, {
      secure: true,
      httpOnly: false,
      sameSite: "Strict",
      path: "/",
      maxAge,
    }),
  ]
}

function clearSessionCookies(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, ADMIN_SESSION_COOKIE, {
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  })
  deleteCookie(c, ADMIN_CSRF_COOKIE, {
    secure: true,
    httpOnly: false,
    sameSite: "Strict",
    path: "/",
  })
}

function authenticationFailed(c: {
  json(value: unknown, status: 401 | 403): Response
}): Response {
  return c.json({ error: "Authentication failed" }, 401)
}

dashboardAuthRoutes.get("/status", async (c) => {
  noStore(c)
  return c.json(await getAdminAuthStatus())
})

dashboardAuthRoutes.get("/session", async (c) => {
  noStore(c)
  const session = await authenticateAdminRequest(c.req.raw)
  if (!session) return authenticationFailed(c)
  for (const cookie of getRefreshedSessionCookieHeaders(c.req.raw)) {
    c.header("Set-Cookie", cookie, { append: true })
  }
  return c.json({
    authenticated: true,
    expiresAt: session.expiresAt,
  })
})

dashboardAuthRoutes.post("/setup", async (c) => {
  noStore(c)
  const clientIp = extractClientIp(c)
  if (clientIp !== null && isIpBlocked(clientIp)) {
    return authenticationFailed(c)
  }
  const body = await c.req.json<unknown>().catch(() => null)
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Invalid request" }, 400)
  }
  const { gatewayKey, password, setupCode } = body as Record<string, unknown>
  if (
    typeof gatewayKey !== "string"
    || typeof password !== "string"
    || typeof setupCode !== "string"
  ) {
    if (clientIp !== null) recordFailedAttempt(clientIp)
    return c.json({ error: "Invalid request" }, 400)
  }
  const result = await setupAdminAuth(gatewayKey, password, setupCode)
  if ("error" in result) {
    if (result.error === "Authentication failed" && clientIp !== null) {
      recordFailedAttempt(clientIp)
    }
    const status = result.error.includes("already configured") ? 409 : 401
    return c.json({ error: result.error }, status)
  }
  setSessionCookies(c, result.session)
  return c.json({ authenticated: true }, 201)
})

dashboardAuthRoutes.post("/login", async (c) => {
  noStore(c)
  const clientIp = extractClientIp(c)
  if (clientIp !== null && isIpBlocked(clientIp)) {
    return authenticationFailed(c)
  }
  const body = await c.req.json<unknown>().catch(() => null)
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return authenticationFailed(c)
  }
  const { gatewayKey, password } = body as Record<string, unknown>
  if (typeof gatewayKey !== "string" || typeof password !== "string") {
    if (clientIp !== null) recordFailedAttempt(clientIp)
    return authenticationFailed(c)
  }
  const session = await loginAdmin(gatewayKey, password)
  if (!session) {
    if (clientIp !== null) recordFailedAttempt(clientIp)
    return authenticationFailed(c)
  }
  setSessionCookies(c, session)
  return c.json({ authenticated: true })
})

dashboardAuthRoutes.post("/logout", async (c) => {
  noStore(c)
  const session = await authenticateAdminRequest(c.req.raw, {
    requireCsrf: true,
  })
  if (!session) return authenticationFailed(c)
  await logoutAdmin(c.req.raw)
  clearSessionCookies(c)
  return c.json({ authenticated: false })
})

dashboardAuthRoutes.put("/password", async (c) => {
  noStore(c)
  const clientIp = extractClientIp(c)
  const body = await c.req
    .json<{ currentPassword?: unknown; newPassword?: unknown }>()
    .catch(() => null)
  if (
    !body
    || typeof body.currentPassword !== "string"
    || typeof body.newPassword !== "string"
  ) {
    return c.json({ error: "Invalid request" }, 400)
  }
  const result = await changeAdminPassword(
    c.req.raw,
    body.currentPassword,
    body.newPassword,
  )
  if ("error" in result) {
    if (result.reason === "credential" && clientIp !== null) {
      recordFailedAttempt(clientIp)
    }
    let status: 400 | 401 | 409 = 401
    if (result.reason === "validation") status = 400
    if (result.reason === "managed") status = 409
    return c.json({ error: result.error }, status)
  }
  setSessionCookies(c, result)
  return c.json({ authenticated: true })
})
