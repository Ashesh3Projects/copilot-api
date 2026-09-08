import type { Context } from "hono"

import consola from "consola"
import { Hono } from "hono"

import { extractRequestCredential } from "~/lib/credential-resolver"
import { trustedJwtDigestStore } from "~/lib/trusted-jwt-digests"

const CHATGPT_PLUGIN_SERVICE_URL = "https://chatgpt.com/backend-api/ps/"
const PLUGIN_HOME_PATH = "plugins/home"
const PLUGIN_ID_PATTERN =
  /^(?:plugins_[0-9a-f]{32}|(?:plugins~)?Plugin_[0-9a-f]{32}|plugin_[A-Za-z0-9][\w-]{0,247})$/
const CATEGORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const EMPTY_PLUGIN_PAGE = {
  plugins: [],
  pagination: { next_page_token: null },
}

const EMPTY_RECOMMENDATIONS = {
  enabled: true,
  plugins: [],
}

interface PublicPluginDocument {
  payload: unknown
  sourceHeaders: Headers
}

export interface CodexPluginServiceDependencies {
  fetchImpl?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function unauthorized(c: Context): Response {
  c.header("Cache-Control", "no-store")
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
}

async function authorize(c: Context): Promise<Response | null> {
  const credential = extractRequestCredential(c.req.raw)
  if (credential === null) return unauthorized(c)
  return (
      (await trustedJwtDigestStore.findEnabledCredential(credential)) === null
    ) ?
      unauthorized(c)
    : null
}

function createPublicPluginHeaders(request: Request): Headers {
  const source = request.headers
  const headers = new Headers({
    accept: "application/json",
    "accept-encoding": "identity",
  })

  for (const name of ["oai-language", "oai-product-sku", "originator"]) {
    const value = source.get(name)
    if (value !== null) headers.set(name, value)
  }

  return headers
}

function publicPluginResponse(document: PublicPluginDocument): Response {
  const headers = new Headers({
    "Cache-Control": "private, max-age=300",
    "Content-Type": "application/json; charset=UTF-8",
    Vary: "OAI-Language, OAI-Product-Sku",
  })
  for (const name of ["content-language", "etag", "last-modified"]) {
    const value = document.sourceHeaders.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Response(JSON.stringify(document.payload), { headers })
}

function publicPluginError(c: Context): Response {
  c.header("Cache-Control", "no-store")
  return c.json(
    {
      error: {
        message: "Plugin directory temporarily unavailable",
        type: "upstream_error",
      },
    },
    502,
  )
}

function getSafeErrorName(error: unknown): string {
  if (
    typeof error === "object"
    && error !== null
    && "name" in error
    && typeof error.name === "string"
    && error.name.length > 0
  ) {
    return error.name
  }
  return "UnknownError"
}

async function loadPublicPluginDocument(
  c: Context,
  upstreamPath: string,
  fetchImpl: typeof fetch,
): Promise<PublicPluginDocument | null> {
  try {
    const response = await fetchImpl(
      new URL(upstreamPath, CHATGPT_PLUGIN_SERVICE_URL),
      {
        method: "GET",
        headers: createPublicPluginHeaders(c.req.raw),
        redirect: "error",
        signal: c.req.raw.signal,
      },
    )
    const contentType = response.headers.get("content-type")?.toLowerCase()
    if (
      response.status !== 200
      || !contentType?.startsWith("application/json")
    ) {
      await response.body?.cancel()
      consola.warn("[codex-plugins] Public directory request rejected", {
        pathname: c.req.path,
        status: response.status,
      })
      return null
    }
    return { payload: await response.json(), sourceHeaders: response.headers }
  } catch (error) {
    consola.error("[codex-plugins] Public directory request failed", {
      errorName: getSafeErrorName(error),
      pathname: c.req.path,
    })
    return null
  }
}

function getHomeSections(
  payload: unknown,
): Array<Record<string, unknown>> | null {
  if (!isRecord(payload) || !Array.isArray(payload.sections)) return null
  return payload.sections.filter((section) => isRecord(section))
}

function isValidPublicPluginDetail(
  payload: unknown,
  expectedPluginId: string,
): payload is Record<string, unknown> {
  return (
    isRecord(payload)
    && !Array.isArray(payload)
    && payload.id === expectedPluginId
    && isRecord(payload.release)
    && isRecord(payload.release.interface)
  )
}

function invalidPublicPluginDocument(c: Context): Response {
  consola.warn("[codex-plugins] Public directory response was invalid", {
    pathname: c.req.path,
  })
  return publicPluginError(c)
}

export function createCodexPluginServiceRoutes(
  dependencies: CodexPluginServiceDependencies = {},
): Hono {
  const routes = new Hono()
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch

  routes.get("/plugins/home", async (c) => {
    const authResponse = await authorize(c)
    if (authResponse !== null) return authResponse
    const document = await loadPublicPluginDocument(
      c,
      PLUGIN_HOME_PATH,
      fetchImpl,
    )
    if (document === null) return publicPluginError(c)
    if (getHomeSections(document.payload) === null) {
      return invalidPublicPluginDocument(c)
    }
    return publicPluginResponse(document)
  })

  routes.get("/plugin-categories/:categorySlug/plugins", async (c) => {
    const authResponse = await authorize(c)
    if (authResponse !== null) return authResponse
    const categorySlug = c.req.param("categorySlug")
    if (!CATEGORY_SLUG_PATTERN.test(categorySlug)) return c.notFound()
    const document = await loadPublicPluginDocument(
      c,
      PLUGIN_HOME_PATH,
      fetchImpl,
    )
    if (document === null) return publicPluginError(c)
    const sections = getHomeSections(document.payload)
    if (sections === null) return invalidPublicPluginDocument(c)
    const section = sections.find(({ url_slug: slug }) => slug === categorySlug)
    const plugins = section?.plugins
    document.payload = {
      plugins: Array.isArray(plugins) ? plugins : [],
      pagination: { next_page_token: null },
    }
    return publicPluginResponse(document)
  })

  for (const path of [
    "/plugins/list",
    "/plugins/search",
    "/plugins/installed",
    "/plugins/workspace/created",
    "/plugins/workspace/shared",
  ]) {
    routes.get(path, async (c) => {
      const authResponse = await authorize(c)
      if (authResponse !== null) return authResponse
      c.header("Cache-Control", "no-store")
      return c.json(EMPTY_PLUGIN_PAGE)
    })
  }

  routes.get("/plugins/suggested/codex", async (c) => {
    const authResponse = await authorize(c)
    if (authResponse !== null) return authResponse
    c.header("Cache-Control", "no-store")
    return c.json(EMPTY_RECOMMENDATIONS)
  })

  routes.get("/plugins/:pluginId", async (c) => {
    const authResponse = await authorize(c)
    if (authResponse !== null) return authResponse
    const pluginId = c.req.param("pluginId")
    if (!PLUGIN_ID_PATTERN.test(pluginId)) return c.notFound()
    const document = await loadPublicPluginDocument(
      c,
      `plugins/${encodeURIComponent(pluginId)}`,
      fetchImpl,
    )
    if (document === null) return publicPluginError(c)
    if (!isValidPublicPluginDetail(document.payload, pluginId)) {
      return invalidPublicPluginDocument(c)
    }
    return publicPluginResponse(document)
  })

  return routes
}

export const codexPluginServiceRoutes = createCodexPluginServiceRoutes()
