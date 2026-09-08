import { afterEach, expect, test } from "bun:test"
const uiApiPath = "../ui/src/lib/api"
const { api } = (await import(uiApiPath)) as {
  // eslint-disable-next-line max-params -- Mirrors the optional mutation metadata argument of the browser API.
  api: (
    method: string,
    path: string,
    body: unknown,
    mutation: { expectedRevision: number },
  ) => Promise<unknown>
}
const originalFetch = globalThis.fetch
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalDocument)
    Object.defineProperty(globalThis, "document", originalDocument)
  else Reflect.deleteProperty(globalThis, "document")
})
test("dashboard mutation binds revision, unique operation and CSRF without exposing secrets", async () => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-copilot_admin_csrf=fixture" },
  })
  let observed: RequestInit | undefined
  globalThis.fetch = (async (_input, init) => {
    await Promise.resolve()
    observed = init
    return Response.json({ ok: true })
  }) as typeof fetch
  await api(
    "PATCH",
    "/dashboard/api/accounts/0",
    { enabled: false },
    { expectedRevision: 7 },
  )
  const headers = new Headers(observed?.headers)
  expect(headers.get("if-match")).toBe('"7"')
  expect(headers.get("idempotency-key")).toMatch(/^[\da-f-]{36}$/)
  expect(headers.get("x-copilot-csrf")).toBe("fixture")
})

test("ambiguous mutation retries keep their operation identity without retaining plaintext credentials", async () => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-copilot_admin_csrf=fixture" },
  })
  const ids: Array<string | null> = []
  let attempt = 0
  globalThis.fetch = (async (_input, init) => {
    await Promise.resolve()
    ids.push(new Headers(init?.headers).get("idempotency-key"))
    attempt++
    if (attempt === 1)
      return Response.json(
        {
          error: { code: "storage_commit_unknown", message: "Outcome unknown" },
        },
        { status: 503 },
      )
    return Response.json({ ok: true })
  }) as typeof fetch
  let rejected = false
  try {
    await api(
      "PUT",
      "/dashboard/api/credentials/groq",
      { apiKey: "synthetic-private-key" },
      { expectedRevision: 3 },
    )
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)
  await api(
    "PUT",
    "/dashboard/api/credentials/groq",
    { apiKey: "synthetic-private-key" },
    { expectedRevision: 4 },
  )
  expect(ids[1]).toBe(ids[0])
  await api(
    "PUT",
    "/dashboard/api/credentials/groq",
    { apiKey: "synthetic-private-key" },
    { expectedRevision: 4 },
  )
  expect(ids[2]).not.toBe(ids[0])
})

test("late duplicate responses do not erase a newer mutation retry identity", async () => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-copilot_admin_csrf=fixture" },
  })
  const pending: Array<{
    id: string | null
    reply: ReturnType<typeof Promise.withResolvers<Response>>
  }> = []
  globalThis.fetch = ((_input, init) => {
    const reply = Promise.withResolvers<Response>()
    pending.push({
      id: new Headers(init?.headers).get("idempotency-key"),
      reply,
    })
    return reply.promise
  }) as typeof fetch
  async function until(count: number) {
    for (let i = 0; i < 100 && pending.length < count; i++) await Bun.sleep(1)
    expect(pending.length).toBe(count)
  }
  const path = "/dashboard/api/test-overlap",
    body = { same: "input" },
    revision = { expectedRevision: 1 }
  const a = api("POST", path, body, revision)
  await until(1)
  const b = api("POST", path, body, revision)
  await until(2)
  expect(pending[0].id).toBe(pending[1].id)
  pending[0].reply.resolve(Response.json({ ok: true }))
  await a
  const c = api("POST", path, body, revision)
  await until(3)
  expect(pending[2].id).not.toBe(pending[0].id)
  pending[1].reply.resolve(Response.json({ ok: true }))
  await b
  pending[2].reply.resolve(Response.json({ error: "Unknown" }, { status: 503 }))
  let failed = false
  try {
    await c
  } catch {
    failed = true
  }
  expect(failed).toBe(true)
  const d = api("POST", path, body, revision)
  await until(4)
  pending[3].reply.resolve(Response.json({ ok: true }))
  await d
  expect(pending[3].id).toBe(pending[2].id)
})
