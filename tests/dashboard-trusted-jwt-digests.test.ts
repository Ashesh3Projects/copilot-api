import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import {
  trustedJwtDigestStore,
  type TrustedJwtDigestEntry,
} from "~/lib/trusted-jwt-digests"
import { DASHBOARD_HTML } from "~/routes/dashboard/page-generated"
import { server } from "~/server"

import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  TEST_ADMIN_ORIGIN,
  type TestAdminSession,
} from "./helpers/admin-session"

const COLLECTION_PATH = "/dashboard/api/trusted-jwt-digests"
const UNKNOWN_ID = "6f9619ff-8b86-4be5-9c13-11c0c978a999"

let admin: TestAdminSession

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function withoutCsrfHeaders(): Record<string, string> {
  return {
    cookie: admin.cookie,
    origin: TEST_ADMIN_ORIGIN,
    "content-type": "application/json",
  }
}

test("generated dashboard exposes trusted JWT digest controls", () => {
  expect(DASHBOARD_HTML).toContain("Trusted JWT Digests")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/trusted-jwt-digests")
  expect(DASHBOARD_HTML).not.toContain("Paste raw JWT")
})

beforeEach(async () => {
  trustedJwtDigestStore.resetAfterTest()
  admin = await createTestAdminSession()
})

afterEach(async () => {
  await resetTestAdminSession()
  trustedJwtDigestStore.resetAfterTest()
})

test("dashboard adds, lists, disables, enables, and deletes a digest", async () => {
  const digest = sha256Hex("device.jwt.signature")
  const add = await server.request(COLLECTION_PATH, {
    method: "POST",
    headers: adminHeaders(admin),
    body: JSON.stringify({
      label: "  Office PC  ",
      digest: digest.toUpperCase(),
    }),
  })
  expect(add.status).toBe(200)
  const entry = (await add.json()) as TrustedJwtDigestEntry
  expect(entry).toMatchObject({
    label: "Office PC",
    digest,
    enabled: true,
  })

  const list = await server.request(COLLECTION_PATH, {
    headers: adminHeaders(admin, false),
  })
  expect(list.status).toBe(200)
  expect(await list.json()).toEqual([entry])

  const disable = await server.request(`${COLLECTION_PATH}/${entry.id}`, {
    method: "PATCH",
    headers: adminHeaders(admin),
    body: JSON.stringify({ enabled: false }),
  })
  expect(disable.status).toBe(200)
  expect(await disable.json()).toMatchObject({ enabled: false })

  const enable = await server.request(`${COLLECTION_PATH}/${entry.id}`, {
    method: "PATCH",
    headers: adminHeaders(admin),
    body: JSON.stringify({ enabled: true }),
  })
  expect(enable.status).toBe(200)
  expect(await enable.json()).toMatchObject({ enabled: true })

  const remove = await server.request(`${COLLECTION_PATH}/${entry.id}`, {
    method: "DELETE",
    headers: adminHeaders(admin),
  })
  expect(remove.status).toBe(200)
  expect(await remove.json()).toEqual({ success: true })

  const emptyList = await server.request(COLLECTION_PATH, {
    headers: adminHeaders(admin, false),
  })
  expect(await emptyList.json()).toEqual([])
})

test("all trusted digest routes require an administrator session", async () => {
  const requests = [
    { method: "GET", path: COLLECTION_PATH },
    {
      method: "POST",
      path: COLLECTION_PATH,
      body: JSON.stringify({ label: "Office", digest: sha256Hex("office") }),
    },
    {
      method: "PATCH",
      path: `${COLLECTION_PATH}/${UNKNOWN_ID}`,
      body: JSON.stringify({ enabled: false }),
    },
    { method: "DELETE", path: `${COLLECTION_PATH}/${UNKNOWN_ID}` },
  ]

  for (const request of requests) {
    const response = await server.request(request.path, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: request.body,
    })
    expect(response.status).toBe(401)
  }
})

test("trusted digest mutations require CSRF", async () => {
  const requests = [
    {
      method: "POST",
      path: COLLECTION_PATH,
      body: JSON.stringify({ label: "Office", digest: sha256Hex("office") }),
    },
    {
      method: "PATCH",
      path: `${COLLECTION_PATH}/${UNKNOWN_ID}`,
      body: JSON.stringify({ enabled: false }),
    },
    { method: "DELETE", path: `${COLLECTION_PATH}/${UNKNOWN_ID}` },
  ]

  for (const request of requests) {
    const response = await server.request(request.path, {
      method: request.method,
      headers: withoutCsrfHeaders(),
      body: request.body,
    })
    expect(response.status).toBe(401)
  }
})

test("adding a digest rejects invalid JSON, fields, labels, and digests", async () => {
  const digest = sha256Hex("valid-device")
  const invalidBodies: Array<{ name: string; body: string }> = [
    { name: "malformed JSON", body: "{" },
    { name: "null", body: "null" },
    { name: "array", body: JSON.stringify(["label", "digest"]) },
    { name: "missing label", body: JSON.stringify({ digest }) },
    { name: "missing digest", body: JSON.stringify({ label: "Device" }) },
    {
      name: "extra raw JWT field",
      body: JSON.stringify({
        label: "Device",
        digest,
        rawJwt: "header.payload.signature",
      }),
    },
    {
      name: "raw JWT as digest",
      body: JSON.stringify({
        label: "Device",
        digest: "header.payload.signature",
      }),
    },
    { name: "non-string label", body: JSON.stringify({ label: 7, digest }) },
    { name: "blank label", body: JSON.stringify({ label: " \t ", digest }) },
    {
      name: "oversized label",
      body: JSON.stringify({ label: "x".repeat(81), digest }),
    },
    {
      name: "control-character label",
      body: JSON.stringify({ label: "Office\nPC", digest }),
    },
    {
      name: "empty digest",
      body: JSON.stringify({ label: "Device", digest: "" }),
    },
    {
      name: "short digest",
      body: JSON.stringify({ label: "Device", digest: "a".repeat(63) }),
    },
    {
      name: "long digest",
      body: JSON.stringify({ label: "Device", digest: "a".repeat(65) }),
    },
    {
      name: "non-hex digest",
      body: JSON.stringify({
        label: "Device",
        digest: `${"a".repeat(63)}g`,
      }),
    },
    {
      name: "non-string digest",
      body: JSON.stringify({ label: "Device", digest: 7 }),
    },
  ]

  for (const invalidBody of invalidBodies) {
    const response = await server.request(COLLECTION_PATH, {
      method: "POST",
      headers: adminHeaders(admin),
      body: invalidBody.body,
    })
    expect(response.status, invalidBody.name).toBe(400)
  }
  expect(await trustedJwtDigestStore.list()).toEqual([])
})

test("adding a duplicate digest returns conflict", async () => {
  const digest = sha256Hex("same-device")
  const first = await server.request(COLLECTION_PATH, {
    method: "POST",
    headers: adminHeaders(admin),
    body: JSON.stringify({ label: "First", digest }),
  })
  expect(first.status).toBe(200)

  const duplicate = await server.request(COLLECTION_PATH, {
    method: "POST",
    headers: adminHeaders(admin),
    body: JSON.stringify({ label: "Second", digest: digest.toUpperCase() }),
  })
  expect(duplicate.status).toBe(409)
  expect(await trustedJwtDigestStore.list()).toHaveLength(1)
})

test("patch requires exactly one boolean enabled field", async () => {
  const entry = await trustedJwtDigestStore.add({
    label: "Office",
    digest: sha256Hex("office-device"),
  })
  const invalidBodies: Array<{ name: string; body: string }> = [
    { name: "malformed JSON", body: "{" },
    { name: "null", body: "null" },
    { name: "array", body: JSON.stringify([false]) },
    { name: "missing enabled", body: JSON.stringify({}) },
    {
      name: "extra field",
      body: JSON.stringify({ enabled: false, label: "Office" }),
    },
    { name: "string enabled", body: JSON.stringify({ enabled: "false" }) },
    { name: "null enabled", body: JSON.stringify({ enabled: null }) },
    { name: "numeric enabled", body: JSON.stringify({ enabled: 0 }) },
  ]

  for (const invalidBody of invalidBodies) {
    const response = await server.request(`${COLLECTION_PATH}/${entry.id}`, {
      method: "PATCH",
      headers: adminHeaders(admin),
      body: invalidBody.body,
    })
    expect(response.status, invalidBody.name).toBe(400)
  }
  expect((await trustedJwtDigestStore.list())[0]?.enabled).toBe(true)
})

test("patch and delete return not found for an unknown valid UUID", async () => {
  const patch = await server.request(`${COLLECTION_PATH}/${UNKNOWN_ID}`, {
    method: "PATCH",
    headers: adminHeaders(admin),
    body: JSON.stringify({ enabled: false }),
  })
  expect(patch.status).toBe(404)

  const remove = await server.request(`${COLLECTION_PATH}/${UNKNOWN_ID}`, {
    method: "DELETE",
    headers: adminHeaders(admin),
  })
  expect(remove.status).toBe(404)
})

test("an inference JWT cannot access trusted digest dashboard routes", async () => {
  const rawJwt = "header.payload.inference-signature"
  await trustedJwtDigestStore.add({
    label: "Inference only",
    digest: sha256Hex(rawJwt),
  })
  const headers = {
    authorization: `Bearer ${rawJwt}`,
    origin: TEST_ADMIN_ORIGIN,
    "x-copilot-csrf": "not-an-admin-csrf-token",
    "content-type": "application/json",
  }
  const requests = [
    { method: "GET", path: COLLECTION_PATH },
    {
      method: "POST",
      path: COLLECTION_PATH,
      body: JSON.stringify({ label: "Second", digest: sha256Hex("second") }),
    },
    {
      method: "PATCH",
      path: `${COLLECTION_PATH}/${UNKNOWN_ID}`,
      body: JSON.stringify({ enabled: false }),
    },
    { method: "DELETE", path: `${COLLECTION_PATH}/${UNKNOWN_ID}` },
  ]

  for (const request of requests) {
    const response = await server.request(request.path, {
      method: request.method,
      headers,
      body: request.body,
    })
    expect(response.status).toBe(401)
  }
})
