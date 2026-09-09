import { afterEach, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import {
  applyModelFallbackToPayload,
  getModelFallbackCacheStats,
  recordModelFallbackResponse,
  runWithModelFallback,
  clearModelFallbackCache,
} from "~/lib/model-fallback"
import {
  setModelFallbackConfig,
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import {
  applyModelRedirect,
  loadModelRedirects,
  updateModelRedirect,
  addModelRedirect,
  setModelRedirectsForTest,
} from "~/lib/model-redirect"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { getStorageRuntime } from "~/lib/storage/runtime"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

afterEach(() => {
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  clearModelFallbackCache()
})

test("admitted requests keep their redirect snapshot while later requests bypass newly introduced loops", async () => {
  await loadModelRedirects()
  setModelFallbackConfigForTest(null)
  const rule = await addModelRedirect("sol", "sol-fast")
  await setModelFallbackConfig(
    validateModelFallbackConfig({
      enabled: true,
      rules: [
        {
          id: "fallback",
          sourceModel: "astra",
          targetModel: "sol",
          enabled: true,
        },
      ],
    }),
  )
  const admitted = getStorageRuntime().snapshot.get()
  await updateModelRedirect(rule.id, { targetModel: "astra" })
  const sent: Array<string> = []
  await withRequestSnapshot(admitted, () =>
    runWithModelFallback({ conversationKey: "snapshot-thread" }, async () => {
      const redirect = await applyModelRedirect("astra")
      const payload = applyModelFallbackToPayload({ model: redirect.model })
      sent.push(payload.model)
      const response = new Response(null, {
        status: payload.model === "astra" ? 422 : 200,
      })
      recordModelFallbackResponse(response)
      if (!response.ok) throw new HTTPError("upstream", response)
    }),
  )
  expect(sent).toEqual(["astra", "sol-fast"])
  expect(getModelFallbackCacheStats().entries).toBe(0)
  expect((await applyModelRedirect("sol")).model).toBe("sol")
  const latest: Array<string> = []
  // Bun's rejection matcher waits for the Promise but its declaration returns void.
  // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression
  await expect(
    runWithModelFallback({ conversationKey: "snapshot-thread" }, async () => {
      await Promise.resolve()
      const payload = applyModelFallbackToPayload({ model: "astra" })
      latest.push(payload.model)
      const response = new Response(null, { status: 422 })
      recordModelFallbackResponse(response)
      throw new HTTPError("upstream", response)
    }),
  ).rejects.toBeInstanceOf(HTTPError)
  expect(latest).toEqual(["astra"])
})
