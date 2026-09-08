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
