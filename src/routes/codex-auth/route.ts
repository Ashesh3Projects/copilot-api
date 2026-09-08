import type { Context } from "hono"

import { Hono } from "hono"

import { parseCodexDesktopRefreshToken } from "~/lib/codex-desktop-refresh"
import { trustedJwtDigestStore } from "~/lib/trusted-jwt-digests"

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

interface RefreshRequestBody {
  client_id?: unknown
  grant_type?: unknown
  refresh_token?: unknown
}

const REFRESH_REQUEST_FIELDS = new Set([
  "client_id",
  "grant_type",
  "refresh_token",
])

function isRefreshRequestBody(value: unknown): value is RefreshRequestBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  return (
    keys.length === REFRESH_REQUEST_FIELDS.size
    && keys.every((key) => REFRESH_REQUEST_FIELDS.has(key))
  )
}

export const codexAuthRoutes = new Hono()

function setNoStoreHeaders(c: {
  header(name: string, value: string): void
}): void {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
}

function invalidRequest(c: Context): Response {
  setNoStoreHeaders(c)
  return c.json(
    {
      error: "invalid_request",
      error_description: "Invalid Codex refresh request.",
    },
    400,
  )
}

codexAuthRoutes.post("/refresh", async (c) => {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? ""
  const mediaType = contentType.split(";", 1)[0]?.trim()
  if (mediaType !== "application/json") {
    setNoStoreHeaders(c)
    return c.json(
      {
        error: "invalid_request",
        error_description: "Codex refresh requests must use JSON.",
      },
      415,
    )
  }

  let parsedBody: unknown
  try {
    parsedBody = await c.req.json()
  } catch {
    return invalidRequest(c)
  }
  if (!isRefreshRequestBody(parsedBody)) return invalidRequest(c)
  const body = parsedBody

  if (
    body.client_id !== CODEX_OAUTH_CLIENT_ID
    || body.grant_type !== "refresh_token"
    || typeof body.refresh_token !== "string"
  ) {
    return invalidRequest(c)
  }

  const jwt = parseCodexDesktopRefreshToken(body.refresh_token)
  if (!jwt || !(await trustedJwtDigestStore.findEnabledCredential(jwt))) {
    setNoStoreHeaders(c)
    return c.json(
      {
        error: "invalid_grant",
        error_description: "The refresh token is invalid or inactive.",
      },
      400,
    )
  }

  setNoStoreHeaders(c)
  return c.json({
    id_token: jwt,
    access_token: jwt,
    refresh_token: body.refresh_token,
  })
})
