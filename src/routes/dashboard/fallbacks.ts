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
import { getModelRoutingSafety } from "~/lib/model-routing-safety"

export async function handleGetFallbacks(c: Context) {
  return c.json({
    config: await getModelFallbackConfig(),
    cache: getModelFallbackCacheStats(),
    safety: getModelRoutingSafety(),
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

  const committed = await setModelFallbackConfig(config)
  return c.json({
    config: committed,
    cache: getModelFallbackCacheStats(),
    safety: getModelRoutingSafety(committed),
  })
}

export function handleClearFallbackCache(c: Context) {
  return c.json({ success: true, cleared: clearModelFallbackCache() })
}
