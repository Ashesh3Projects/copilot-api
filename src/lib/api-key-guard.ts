import type { Context, Next } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"

import {
  hasSuppliedRequestCredential,
  resolveGatewayCredential,
  resolveRequestCredential,
} from "./credential-resolver"
import {
  extractClientIp,
  isIpAllowedForWhitelistedRoute,
  isIpBanned,
  isIpBlocked,
  recordFailedAttempt,
  trustAuthenticatedIp,
} from "./ip-blocker"
import { sanitizeRequestDiagnosticReference } from "./request-diagnostics"
import { isAllowedTransparentProxyRequest } from "./transparent-proxy"

const verifiedTransparentRequests = new WeakSet<Request>()

export function isVerifiedTransparentProxyRequest(request: Request): boolean {
  return verifiedTransparentRequests.has(request)
}

/**
 * API key guard middleware. Invalid credentials receive a small, bounded and
 * uniform authentication response.
 *
 * Credential authority always comes from the initialized database.
 */
export async function apiKeyGuard(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  if (isAllowedTransparentProxyRequest(c)) {
    return await guardTransparentProxyRequest(c, next)
  }

  return await guardOrdinaryRequest(c, next)
}

async function guardOrdinaryRequest(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  const clientIp = extractClientIp(c)
  const diagnosticPath = sanitizeRequestDiagnosticReference(
    c.req.method,
    c.req.path,
  )
  const credentialSupplied = hasSuppliedRequestCredential(c.req.raw)

  if (credentialSupplied) {
    const credential = await resolveRequestCredential(c.req.raw, [
      "user:inference",
    ])
    if (credential) {
      if (clientIp !== null) await trustAuthenticatedIp(clientIp)
      await next()
      return
    }

    if (clientIp !== null) {
      const alreadyBanned = isIpBanned(clientIp)
      const attempts = recordFailedAttempt(clientIp)
      consola.warn(
        `[api-key-guard] Failed auth from ${clientIp} → ${c.req.method} ${diagnosticPath} (attempt ${attempts}/3)`,
      )
      if (attempts >= 3 && !alreadyBanned) {
        consola.error(
          `[api-key-guard] IP ${clientIp} banned after ${attempts} failed attempts`,
        )
        Sentry.captureMessage(`IP banned: ${clientIp}`, {
          level: "error",
          extra: { ip: clientIp, attempts, path: diagnosticPath },
        })
      }
    }
    return unauthorizedResponse(c)
  }

  if (clientIp !== null && isIpBlocked(clientIp)) {
    consola.warn(
      `[api-key-guard] Blocked request from banned IP ${clientIp} → ${c.req.method} ${diagnosticPath}`,
    )
    Sentry.captureMessage(`Blocked banned IP: ${clientIp}`, {
      level: "warning",
      extra: { ip: clientIp, method: c.req.method, path: diagnosticPath },
    })
    return unauthorizedResponse(c)
  }

  if (clientIp !== null) {
    const attempts = recordFailedAttempt(clientIp)
    consola.warn(
      `[api-key-guard] Failed auth from ${clientIp} → ${c.req.method} ${diagnosticPath} (attempt ${attempts}/3)`,
    )
    if (attempts >= 3) {
      consola.error(
        `[api-key-guard] IP ${clientIp} banned after ${attempts} failed attempts`,
      )
      Sentry.captureMessage(`IP banned: ${clientIp}`, {
        level: "error",
        extra: { ip: clientIp, attempts, path: diagnosticPath },
      })
    }
  }

  return unauthorizedResponse(c)
}

async function guardTransparentProxyRequest(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  const clientIp = extractClientIp(c)
  const gatewayHeaderPresent = c.req.raw.headers.has("x-copilot-gateway-key")
  const rawGatewayCredential =
    c.req.raw.headers.get("x-copilot-gateway-key") ?? ""

  let authorized = false
  if (gatewayHeaderPresent) {
    authorized =
      (await resolveGatewayCredential(rawGatewayCredential, ["user:inference"]))
      !== null
    if (authorized && clientIp !== null) await trustAuthenticatedIp(clientIp)
  } else if (clientIp !== null) {
    authorized = await isIpAllowedForWhitelistedRoute(clientIp)
  }

  if (!authorized) {
    if (clientIp !== null && !isIpBanned(clientIp)) {
      recordFailedAttempt(clientIp)
    }
    return unauthorizedResponse(c)
  }

  verifiedTransparentRequests.add(c.req.raw)
  try {
    await next()
  } finally {
    verifiedTransparentRequests.delete(c.req.raw)
  }
}

function unauthorizedResponse(c: Context): Response {
  c.header("Cache-Control", "no-store")
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
}
