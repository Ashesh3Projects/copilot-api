import { afterEach, beforeEach, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import {
  applyModelFallbackToPayload,
  clearModelFallbackCache,
  getModelFallbackCacheStats,
  getModelFallbackRedirect,
  recordModelFallbackResponse,
  runWithModelFallback,
} from "~/lib/model-fallback"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import {
  applyModelRedirect,
  setModelRedirectsForTest,
} from "~/lib/model-redirect"
import { analyzeModelRoutingSafety } from "~/lib/model-routing-safety"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

function redirect(sourceModel: string, targetModel: string, extra = {}) {
  return {
    id: `${sourceModel}-${targetModel}`,
    sourceModel,
    targetModel,
    sourceEffort: "all",
    enabled: true,
    ...extra,
  }
}

function fallbacks(edges: Array<[string, string]>) {
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: edges.map(([sourceModel, targetModel], index) => ({
        id: `fallback-${index}`,
        sourceModel,
        targetModel,
        enabled: true,
      })),
    }),
  )
}

beforeEach(() => {
  setModelRedirectsForTest([])
  fallbacks([])
  clearModelFallbackCache()
})

afterEach(() => {
  setModelRedirectsForTest([])
  setModelFallbackConfigForTest(null)
  clearModelFallbackCache()
})

async function request(failing: Set<string>, conversationKey?: string) {
  const attempts: Array<string> = []
  let failure: unknown
  try {
    await runWithModelFallback({ conversationKey }, async () => {
      const initial = await applyModelRedirect("gpt-6-astra")
      const payload = applyModelFallbackToPayload({ model: initial.model })
      attempts.push(payload.model)
      const response = new Response(null, {
        status: failing.has(payload.model) ? 422 : 200,
      })
      recordModelFallbackResponse(response)
      if (!response.ok) throw new HTTPError("upstream", response)
    })
  } catch (error) {
    failure = error
  }
  return { attempts, failure }
}

test("HTTP 422 fallback resolves its target through model redirects", async () => {
  setModelRedirectsForTest([redirect("gpt-5.6-sol", "gpt-5.6-sol-fast")])
  fallbacks([["gpt-6-astra", "gpt-5.6-sol"]])
  const result = await request(new Set(["gpt-6-astra"]))
  expect(result.failure).toBeUndefined()
  expect(result.attempts).toEqual(["gpt-6-astra", "gpt-5.6-sol-fast"])
})

test("mixed loops disable every redirect and fallback until corrected", async () => {
  setModelRedirectsForTest([
    redirect("gpt-5.6-sol", "gpt-6-astra"),
    redirect("unrelated", "another-model"),
  ])
  fallbacks([["gpt-6-astra", "gpt-5.6-sol"]])
  expect((await applyModelRedirect("unrelated")).model).toBe("unrelated")
  const result = await request(new Set(["gpt-6-astra", "gpt-5.6-sol"]))
  expect(result.attempts).toEqual(["gpt-6-astra"])
  expect(result.failure).toBeInstanceOf(HTTPError)

  setModelRedirectsForTest([redirect("gpt-5.6-sol", "gpt-5.6-sol-fast")])
  expect((await request(new Set(["gpt-6-astra"]))).attempts).toEqual([
    "gpt-6-astra",
    "gpt-5.6-sol-fast",
  ])
})

test("pure redirect loops bypass all redirects and fallbacks", async () => {
  setModelRedirectsForTest([redirect("a", "b"), redirect("b", "a")])
  fallbacks([["gpt-6-astra", "gpt-5.6-sol"]])
  expect((await applyModelRedirect("a")).model).toBe("a")
  expect((await request(new Set(["gpt-6-astra"]))).attempts).toEqual([
    "gpt-6-astra",
  ])
})

test("pure fallback loops bypass unrelated redirects too", async () => {
  setModelRedirectsForTest([redirect("source", "target")])
  fallbacks([
    ["a", "b"],
    ["b", "a"],
  ])
  expect((await applyModelRedirect("source")).model).toBe("source")
})

test("disabled and shadowed redirect edges cannot create a false mixed loop", async () => {
  setModelRedirectsForTest([
    redirect("gpt-5.6-sol", "gpt-5.6-sol-fast"),
    redirect("gpt-5.6-sol", "gpt-6-astra"),
    redirect("gpt-5.6-sol-fast", "gpt-6-astra", { enabled: false }),
  ])
  fallbacks([["gpt-6-astra", "gpt-5.6-sol"]])
  expect((await request(new Set(["gpt-6-astra"]))).attempts).toEqual([
    "gpt-6-astra",
    "gpt-5.6-sol-fast",
  ])
})

test("redirect edits invalidate conversation fallback targets", async () => {
  setModelRedirectsForTest([redirect("gpt-5.6-sol", "fast-a")])
  fallbacks([["gpt-6-astra", "gpt-5.6-sol"]])
  await request(new Set(["gpt-6-astra"]), "conversation")
  expect(getModelFallbackCacheStats().entries).toBe(1)
  setModelRedirectsForTest([redirect("gpt-5.6-sol", "fast-b")])
  expect(getModelFallbackCacheStats().entries).toBe(0)
  expect(
    (await request(new Set(["gpt-6-astra"]), "conversation")).attempts,
  ).toEqual(["gpt-6-astra", "fast-b"])
})

test("cached fallback redirects preserve the effort of each new request", async () => {
  setModelRedirectsForTest([redirect("gpt-5.6-sol", "gpt-5.6-sol-fast")])
  fallbacks([["gpt-6-astra", "gpt-5.6-sol"]])
  const observed: Array<string | undefined> = []
  for (const effort of ["low", "high"] as const) {
    await runWithModelFallback({ conversationKey: "effort" }, async () => {
      const payload = applyModelFallbackToPayload(
        { model: "gpt-6-astra" },
        { effort },
      )
      const response = new Response(null, {
        status: payload.model === "gpt-6-astra" ? 422 : 200,
      })
      recordModelFallbackResponse(response)
      if (!response.ok) throw new HTTPError("upstream", response)
      await Promise.resolve()
      observed.push(getModelFallbackRedirect()?.effort)
    })
  }
  expect(observed).toEqual(["low", "high"])
})

test("cached multi-hop fallbacks retain all earlier redirect effort overrides", async () => {
  setModelRedirectsForTest([redirect("b", "c", { targetEffort: "high" })])
  fallbacks([
    ["a", "b"],
    ["c", "d"],
  ])
  const observed: Array<{ model: string; effort?: string }> = []
  for (let i = 0; i < 2; i++) {
    await runWithModelFallback(
      { conversationKey: "multi-effort" },
      async () => {
        await Promise.resolve()
        const payload = applyModelFallbackToPayload(
          { model: "a" },
          { effort: "low" },
        )
        const response = new Response(null, {
          status: payload.model === "d" ? 200 : 422,
        })
        recordModelFallbackResponse(response)
        if (!response.ok) throw new HTTPError("upstream", response)
        observed.push({
          model: payload.model,
          effort: getModelFallbackRedirect()?.effort,
        })
      },
    )
  }
  expect(observed).toEqual([
    { model: "d", effort: "high" },
    { model: "d", effort: "high" },
  ])
})

test("a cached target normalizes its effort before following its next fallback", async () => {
  setModelRedirectsForTest([
    redirect("b", "gpt-5.2", { targetEffort: "xhigh" }),
    redirect("d", "end", { sourceEffort: "medium" }),
  ])
  fallbacks([
    ["a", "b"],
    ["gpt-5.2", "d"],
  ])
  const observed: Array<string> = []
  for (let i = 0; i < 2; i++) {
    await runWithModelFallback(
      { conversationKey: "normalized-cached" },
      async () => {
        await Promise.resolve()
        const payload = applyModelFallbackToPayload(
          { model: "a" },
          { effort: "low" },
        )
        observed.push(payload.model)
        const response = new Response(null, {
          status:
            payload.model === "a" || (i === 1 && payload.model === "gpt-5.2") ?
              422
            : 200,
        })
        recordModelFallbackResponse(response)
        if (!response.ok) throw new HTTPError("upstream", response)
      },
    )
  }
  expect(observed).toEqual(["a", "gpt-5.2", "gpt-5.2", "end"])
})

test("effort-changing mixed cycles are unsafe but effort-specific escape paths are valid", () => {
  const config = validateModelFallbackConfig({
    enabled: true,
    rules: [
      { id: "fallback", sourceModel: "a", targetModel: "b", enabled: true },
    ],
  })
  const looping = [
    {
      ...redirect("b", "a"),
      sourceEffort: "low" as const,
      targetEffort: "low" as const,
    },
  ]
  expect(analyzeModelRoutingSafety(looping, config).safe).toBe(false)
  const escaping = [
    {
      ...redirect("b", "a"),
      sourceEffort: "low" as const,
      targetEffort: "high" as const,
    },
  ]
  expect(analyzeModelRoutingSafety(escaping, config).safe).toBe(true)
})

test("combined analysis detects cycles longer than the per-request hop limit", () => {
  const config = validateModelFallbackConfig({
    enabled: true,
    rules: [
      { id: "a-b", sourceModel: "a", targetModel: "b" },
      { id: "c-d", sourceModel: "c", targetModel: "d" },
      { id: "e-f", sourceModel: "e", targetModel: "f" },
      { id: "g-h", sourceModel: "g", targetModel: "h" },
    ],
  })
  const redirects = [
    redirect("b", "c"),
    redirect("d", "e"),
    redirect("f", "g"),
    redirect("h", "a"),
  ].map((rule) => ({ ...rule, sourceEffort: "all" as const }))
  expect(analyzeModelRoutingSafety(redirects, config)).toMatchObject({
    safe: false,
    loop: { kind: "combined" },
  })
  expect(
    analyzeModelRoutingSafety(redirects, { ...config, enabled: false }).safe,
  ).toBe(true)
})
