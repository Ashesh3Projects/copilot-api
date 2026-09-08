import type { Context } from "hono"

import { ZodError } from "zod"

import {
  clearModelFallbackCache,
  getModelFallbackCacheStats,
} from "~/lib/model-fallback"
import {
  getModelFallbackConfig,
  setModelFallbackConfig,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"

export async function handleGetFallbacks(c: Context) {
  return c.json({
    config: await getModelFallbackConfig(),
    cache: getModelFallbackCacheStats(),
  })
}

export async function handleSetFallbacks(c: Context) {
  let body: unknown
  try {
    body = await c.req.json<unknown>()
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400)
  }

  let config: ReturnType<typeof validateModelFallbackConfig>
  try {
    config = validateModelFallbackConfig(body)
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => {
        const field = issue.path.join(".")
        return field ? `${field}: ${issue.message}` : issue.message
      })
      return c.json({ error: details.join("; ") }, 400)
    }
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid fallback settings",
      },
      400,
    )
  }

  return c.json({
    config: await setModelFallbackConfig(config),
    cache: getModelFallbackCacheStats(),
  })
}

export function handleClearFallbackCache(c: Context) {
  return c.json({ success: true, cleared: clearModelFallbackCache() })
}
