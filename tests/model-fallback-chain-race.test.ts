import { afterEach, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import {
  applyModelFallbackToPayload,
  clearModelFallbackCache,
  recordModelFallbackResponse,
  runWithModelFallback,
} from "~/lib/model-fallback"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"

function history(signatures: Array<string>) {
  return {
    model: "race-a",
    input: signatures.map((encryptedContent) => ({
      type: "reasoning",
      encrypted_content: encryptedContent,
    })),
  }
}

afterEach(() => {
  clearModelFallbackCache()
  setModelFallbackConfigForTest(null)
})

test("an older fallback success cannot replace a newer chain destination or discard its foreign history", async () => {
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: [
        {
          id: "race-ab",
          sourceModel: "race-a",
          targetModel: "race-b",
          enabled: true,
        },
        {
          id: "race-bc",
          sourceModel: "race-b",
          targetModel: "race-c",
          enabled: true,
        },
      ],
    }),
  )
  const enteredOlderTarget = Promise.withResolvers<undefined>()
  const releaseOlderTarget = Promise.withResolvers<undefined>()
  const attempts: Array<{ request: string; model: string }> = []
  const request = (signatures: Array<string>, older: boolean) =>
    runWithModelFallback(
      { conversationKey: "race-conversation", payload: history(signatures) },
      async () => {
        const payload = applyModelFallbackToPayload(history(signatures))
        attempts.push({
          request: older ? "older" : "newer",
          model: payload.model,
        })
        if (older && payload.model === "race-b") {
          enteredOlderTarget.resolve(undefined)
          await releaseOlderTarget.promise
        }
        const response = new Response(null, {
          status:
            (
              payload.model === "race-a"
              || (!older && payload.model === "race-b")
            ) ?
              422
            : 200,
        })
        recordModelFallbackResponse(response)
        if (!response.ok) throw new HTTPError("upstream", response)
      },
    )

  const older = request(["old-a-one"], true)
  await enteredOlderTarget.promise
  try {
    await request(["old-a-one", "old-a-two"], false)
  } finally {
    releaseOlderTarget.resolve(undefined)
    await older
  }
  expect(attempts).toEqual([
    { request: "older", model: "race-a" },
    { request: "older", model: "race-b" },
    { request: "newer", model: "race-a" },
    { request: "newer", model: "race-b" },
    { request: "newer", model: "race-c" },
  ])

  await runWithModelFallback({ conversationKey: "race-conversation" }, () => {
    const payload = applyModelFallbackToPayload(
      history(["old-a-one", "old-a-two", "new-c"]),
    )
    expect(payload.model).toBe("race-c")
    expect(payload.input).toEqual([
      { type: "reasoning", encrypted_content: "new-c" },
    ])
    return Promise.resolve()
  })
})
