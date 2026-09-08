/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- async attempt callbacks and Bun rejection assertions model upstream outcomes */
import { afterEach, expect, spyOn, test } from "bun:test"

import { HTTPError, LocalHTTPError } from "~/lib/error"
import {
  applyModelFallbackToPayload,
  clearModelFallbackCache,
  getModelFallbackCacheStats,
  recordModelFallbackResponse,
  runWithModelFallback,
} from "~/lib/model-fallback"
import {
  setModelFallbackConfig,
  setModelFallbackConfigForTest,
} from "~/lib/model-fallback-config"
import { copilotResponseHeadersStorage } from "~/lib/request-session"

const config = {
  enabled: true,
  conversationAffinity: true,
  notifyClient: false,
  nativeClientNotice: false,
  affinityTtlSeconds: 86400,
  affinityMaxEntries: 10000,
  rules: [
    { id: "test", sourceModel: "source", targetModel: "target", enabled: true },
  ],
}

async function fakeRequest(
  options: Parameters<typeof runWithModelFallback>[0],
  beforeAccept?: () => void,
) {
  return await runWithModelFallback(options, async () => {
    const payload = applyModelFallbackToPayload({ model: "source" })
    if (payload.model === "target") beforeAccept?.()
    const response = new Response(null, {
      status: payload.model === "source" ? 422 : 200,
    })
    recordModelFallbackResponse(response)
    if (!response.ok) throw new HTTPError("upstream", response)
    return payload.model
  })
}

test("ordinary source successes do not claim fallback diagnostic headers", async () => {
  setModelFallbackConfigForTest({ ...config, notifyClient: true })
  const headers: Record<string, string> = {}
  await copilotResponseHeadersStorage.run(
    headers,
    async () =>
      await runWithModelFallback({}, async () => {
        applyModelFallbackToPayload({ model: "source" })
        recordModelFallbackResponse(new Response(null, { status: 200 }))
      }),
  )
  expect(headers).toEqual({})
})

test("final upstream 422 after existing compatibility retry remains eligible", async () => {
  setModelFallbackConfigForTest(config)
  let attempts = 0
  await runWithModelFallback({}, async () => {
    attempts++
    const payload = applyModelFallbackToPayload({ model: "source" })
    if (payload.model === "source") {
      recordModelFallbackResponse(new Response(null, { status: 400 }))
      const response = new Response(null, { status: 422 })
      recordModelFallbackResponse(response)
      throw new HTTPError("upstream", response)
    }
    recordModelFallbackResponse(new Response(null, { status: 200 }))
  })
  expect(attempts).toBe(2)
})

test("a later 422 after accepted output cannot restart the request", async () => {
  setModelFallbackConfigForTest(config)
  let attempts = 0
  await expect(
    runWithModelFallback({}, async () => {
      attempts++
      applyModelFallbackToPayload({ model: "source" })
      recordModelFallbackResponse(new Response(null, { status: 200 }))
      const response = new Response(null, { status: 422 })
      recordModelFallbackResponse(response)
      throw new HTTPError("later tool loop", response)
    }),
  ).rejects.toBeInstanceOf(HTTPError)
  expect(attempts).toBe(1)
})

test.each(["clear", "config"])(
  "in-flight accepted fallback does not repopulate after %s change",
  async (change) => {
    setModelFallbackConfigForTest(config)
    await fakeRequest({ conversationKey: "thread" }, () => {
      if (change === "clear") clearModelFallbackCache()
      else setModelFallbackConfigForTest(config)
    })
    expect(getModelFallbackCacheStats().entries).toBe(0)
  },
)

test("cache disabled still retries without remembering", async () => {
  setModelFallbackConfigForTest({ ...config, conversationAffinity: false })
  await fakeRequest({ conversationKey: "thread" })
  expect(getModelFallbackCacheStats().entries).toBe(0)
})

test("cache capacity evicts the oldest remembered conversation", async () => {
  setModelFallbackConfigForTest({ ...config, affinityMaxEntries: 1 })
  await fakeRequest({ conversationKey: "first" })
  await fakeRequest({ conversationKey: "second" })
  expect(getModelFallbackCacheStats().entries).toBe(1)
  let source: string | undefined
  await runWithModelFallback({ conversationKey: "first" }, async () => {
    source = applyModelFallbackToPayload({ model: "source" }).model
  })
  expect(source).toBe("source")
})

test("expired mappings are removed before dispatch", async () => {
  setModelFallbackConfigForTest({ ...config, affinityTtlSeconds: 60 })
  await fakeRequest({ conversationKey: "thread" })
  const future = Date.now() + 61_000
  const now = spyOn(Date, "now").mockReturnValue(future)
  try {
    expect(getModelFallbackCacheStats().entries).toBe(0)
    let source: string | undefined
    await runWithModelFallback({ conversationKey: "thread" }, async () => {
      source = applyModelFallbackToPayload({ model: "source" }).model
    })
    expect(source).toBe("source")
  } finally {
    now.mockRestore()
  }
})

test("queued config updates keep the captured TTL and revision consistent", async () => {
  setModelFallbackConfigForTest(config)
  const pendingUpdate = setModelFallbackConfig({
    ...config,
    affinityTtlSeconds: 60,
  })
  await Promise.resolve()
  await fakeRequest({ conversationKey: "thread" })
  await pendingUpdate
  const now = spyOn(Date, "now").mockReturnValue(Date.now() + 61_000)
  try {
    expect(getModelFallbackCacheStats().entries).toBe(0)
  } finally {
    now.mockRestore()
  }
})

test("concurrent successful transitions merge all known foreign signatures", async () => {
  setModelFallbackConfigForTest(config)
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let firstReached: (() => void) | undefined
  const firstPending = new Promise<void>((resolve) => {
    firstReached = resolve
  })
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the concurrent fixture belongs to this race
  const original = (signatures: Array<string>) => ({
    model: "source",
    input: signatures.map((signature) => ({
      type: "reasoning",
      encrypted_content: signature,
    })),
  })
  const request = (signatures: Array<string>, delayed: boolean) =>
    runWithModelFallback(
      { conversationKey: "concurrent", payload: original(signatures) },
      async () => {
        const payload = applyModelFallbackToPayload(original(signatures))
        if (payload.model === "target" && delayed) {
          firstReached?.()
          await firstGate
        }
        const response = new Response(null, {
          status: payload.model === "source" ? 422 : 200,
        })
        recordModelFallbackResponse(response)
        if (!response.ok) throw new HTTPError("upstream", response)
      },
    )
  const first = request(["old-a"], true)
  await firstPending
  await request(["old-a", "old-b"], false)
  releaseFirst?.()
  await first
  await runWithModelFallback({ conversationKey: "concurrent" }, async () => {
    const payload = applyModelFallbackToPayload(
      original(["old-a", "old-b", "new-target"]),
    )
    expect(payload.input).toEqual([
      { type: "reasoning", encrypted_content: "new-target" },
    ])
  })
})

afterEach(() => {
  clearModelFallbackCache()
  setModelFallbackConfigForTest(null)
})

test("switches any upstream HTTP 422 once and preserves fallback thinking on the next turn", async () => {
  setModelFallbackConfigForTest(config)
  const sent: Array<{
    model: string
    messages: Array<Record<string, unknown>>
  }> = []
  const request = async (signature: string) =>
    await runWithModelFallback(
      {
        headers: new Headers({
          authorization: "Bearer client-a",
          "thread-id": "thread",
        }),
      },
      async () => {
        const payload = applyModelFallbackToPayload({
          model: "source",
          messages: [
            {
              role: "assistant",
              content: "answer",
              reasoning_text: "reasoning",
              reasoning_opaque: signature,
            },
          ],
        })
        sent.push(payload)
        const response =
          payload.model === "source" ?
            new Response("arbitrary", { status: 422 })
          : Response.json({ ok: true })
        recordModelFallbackResponse(response)
        if (!response.ok) throw new HTTPError("upstream", response)
        return payload.model
      },
    )
  expect(await request("old-signature")).toBe("target")
  expect(await request("fallback-signature")).toBe("target")
  expect(sent.map((payload) => payload.model)).toEqual([
    "source",
    "target",
    "target",
  ])
  expect(sent[1].messages[0]).toEqual({ role: "assistant", content: "answer" })
  expect(sent[2].messages[0].reasoning_opaque).toBe("fallback-signature")
  expect(getModelFallbackCacheStats()).toEqual({ entries: 1 })
})

test.each([400, 401, 403, 408, 429, 500, 502, 503, 504])(
  "never switches HTTP %s",
  async (status) => {
    setModelFallbackConfigForTest(config)
    let attempts = 0
    await expect(
      runWithModelFallback({}, async () => {
        attempts++
        applyModelFallbackToPayload({ model: "source" })
        const response = new Response("failure", { status })
        recordModelFallbackResponse(response)
        throw new HTTPError("upstream", response)
      }),
    ).rejects.toBeInstanceOf(HTTPError)
    expect(attempts).toBe(1)
  },
)

test.each([
  new Error("network error"),
  new DOMException("timeout", "TimeoutError"),
  new DOMException("aborted", "AbortError"),
])("never switches transport errors", async (error) => {
  setModelFallbackConfigForTest(config)
  let attempts = 0
  await expect(
    runWithModelFallback({}, async () => {
      attempts++
      applyModelFallbackToPayload({ model: "source" })
      throw error
    }),
  ).rejects.toBe(error)
  expect(attempts).toBe(1)
})

test("does not retry synthetic or local 422 errors", async () => {
  setModelFallbackConfigForTest(config)
  let attempts = 0
  await expect(
    runWithModelFallback({}, async () => {
      attempts++
      applyModelFallbackToPayload({ model: "source" })
      const response = Response.json({ error: "local" }, { status: 422 })
      throw new LocalHTTPError("local", response, { error: "local" })
    }),
  ).rejects.toBeInstanceOf(LocalHTTPError)
  expect(attempts).toBe(1)
})

test("isolates child threads and credentials despite a shared parent session", async () => {
  setModelFallbackConfigForTest(config)
  const sent: Array<string> = []
  const request = (thread: string, credential: string) =>
    runWithModelFallback(
      {
        headers: new Headers({
          authorization: `Bearer ${credential}`,
          "session-id": "parent",
          "x-codex-parent-thread-id": "parent",
        }),
        payload: {
          client_metadata: { session_id: "parent", thread_id: thread },
        },
      },
      async () => {
        const payload = applyModelFallbackToPayload({ model: "source" })
        sent.push(payload.model)
        const response = new Response(null, {
          status: payload.model === "source" ? 422 : 200,
        })
        recordModelFallbackResponse(response)
        if (!response.ok) throw new HTTPError("upstream", response)
        return payload.model
      },
    )
  await request("child-a", "client-a")
  await request("child-a", "client-a")
  await request("child-b", "client-a")
  await request("child-a", "client-b")
  expect(sent).toEqual([
    "source",
    "target",
    "target",
    "source",
    "target",
    "source",
    "target",
  ])
  expect(getModelFallbackCacheStats().entries).toBe(3)
})

test("without identity repeats the 422 attempt on each request and never caches", async () => {
  setModelFallbackConfigForTest(config)
  const sent: Array<string> = []
  const request = () =>
    runWithModelFallback({}, async () => {
      const payload = applyModelFallbackToPayload({ model: "source" })
      sent.push(payload.model)
      const response = new Response(null, {
        status: payload.model === "source" ? 422 : 200,
      })
      recordModelFallbackResponse(response)
      if (!response.ok) throw new HTTPError("upstream", response)
      return payload.model
    })
  await request()
  await request()
  expect(sent).toEqual(["source", "target", "source", "target"])
  expect(getModelFallbackCacheStats().entries).toBe(0)
})
