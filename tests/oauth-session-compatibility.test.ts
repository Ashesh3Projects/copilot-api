import "./helpers/auth-misc-data-dir"

import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { routedControlPlaneFetch, routedFetch } from "~/lib/account-router"
import { setConfigForTest } from "~/lib/config"
import { setModelRoutingOverridesForTest } from "~/lib/model-routing"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const requests: Array<Request> = []
const model: Model = {
  id: "oauth-model",
  name: "OAuth model",
  object: "model",
  preview: false,
  vendor: "openai",
  version: "1",
  model_picker_enabled: true,
  supported_endpoints: ["/responses"],
  capabilities: {
    family: "gpt",
    limits: {},
    object: "model_capabilities",
    supports: {},
    tokenizer: "cl100k_base",
    type: "chat",
  },
}
const jwt = (sub: string) =>
  `e30.${Buffer.from(JSON.stringify({ sub, selected_model: model.id })).toString("base64url")}.c2ln`

beforeEach(async () => {
  for (const account of tokenPool.getAllAccounts())
    tokenPool.removeAccountForTest(account.id)
  requests.length = 0
  Object.assign(state, {
    isMultiToken: true,
    apiKeyAuth: undefined,
    copilotToken: "gho_first",
    githubToken: undefined,
    models: { object: "list", data: [model] },
  })
  setConfigForTest({ auth: { apiKeys: [] } })
  setModelRoutingOverridesForTest({})
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request ?
        new Request(input, init)
      : new Request(input.toString(), init)
    await Promise.resolve()
    requests.push(request)
    if (request.url.endsWith("/copilot_internal/user")) {
      return Response.json({
        analytics_tracking_id:
          request.headers.get("authorization") === "Bearer gho_second" ?
            "subject-second"
          : "subject-first",
        endpoints: { api: "https://api.githubcopilot.com" },
      })
    }
    if (request.url.endsWith("/models"))
      return Response.json({ object: "list", data: [model] })
    return Response.json({ success: true })
  }) as typeof fetch
  await seedProtocolDatabase()
})

afterEach(() => {
  for (const account of tokenPool.getAllAccounts())
    tokenPool.removeAccountForTest(account.id)
  Object.assign(state, originalState)
  globalThis.fetch = originalFetch
  setConfigForTest(null)
})

test("OAuth session refresh and inference select the authenticated token subject", async () => {
  const first = tokenPool.addAccount("gho_first", "individual", 901)
  const second = tokenPool.addAccount("gho_second", "individual", 902)
  await tokenPool.initializeAccount(first)
  await tokenPool.initializeAccount(second)
  await seedProtocolDatabase()
  requests.length = 0
  const token = jwt("subject-second")
  const refresh = await routedControlPlaneFetch({
    path: "/models/session",
    copilotSessionToken: token,
  })
  expect(refresh.response.status).toBe(200)
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer gho_second")
  expect(requests[0]?.headers.get("copilot-session-token")).toBe(token)
  const inference = await routedFetch(
    "/responses",
    { method: "POST", body: "{}" },
    {
      modelId: model.id,
      headerOptions: { copilotSessionToken: token },
    },
  )
  expect(inference.response.status).toBe(200)
  expect(requests[1]?.headers.get("authorization")).toBe("Bearer gho_second")
  expect(requests[1]?.headers.get("copilot-session-token")).toBe(token)
})

test("OAuth session refresh rejects a subject that does not belong to any account", async () => {
  const account = tokenPool.addAccount("gho_first", "individual", 901)
  await tokenPool.initializeAccount(account)
  await seedProtocolDatabase()
  requests.length = 0
  const refresh = await routedControlPlaneFetch({
    path: "/models/session",
    copilotSessionToken: jwt("other"),
  })
  expect(refresh.response.status).toBe(409)
  expect(requests).toHaveLength(0)
})

test("account rediscovery replaces or clears the authenticated session subject", async () => {
  const account = tokenPool.addAccount("gho_first", "individual", 901)
  await tokenPool.initializeAccount(account)
  account.githubToken = "gho_second"
  await tokenPool.reinitializeAccount(account)
  await seedProtocolDatabase()
  requests.length = 0
  const previous = await routedControlPlaneFetch({
    path: "/models/session",
    copilotSessionToken: jwt("subject-first"),
  })
  expect(previous.response.status).toBe(409)
  expect(requests).toHaveLength(0)
  const current = await routedControlPlaneFetch({
    path: "/models/session",
    copilotSessionToken: jwt("subject-second"),
  })
  expect(current.response.status).toBe(200)
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer gho_second")
})

test("model-session acquire preserves concrete hints and additive client options", async () => {
  state.isMultiToken = false
  await seedProtocolDatabase()
  const payload = {
    auto_mode: { model_hints: ["oauth-model"] },
    fusion_mode: { policy: "balanced", contract_version: 1 },
  }
  const result = await server.request("/models/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
    body: JSON.stringify(payload),
  })
  expect(result.status).toBe(200)
  expect(await requests[0]?.json()).toEqual(payload)
})

test("model-session refresh remains token-only even if a client includes acquisition options", async () => {
  state.isMultiToken = false
  await seedProtocolDatabase()
  const result = await server.request("/models/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
      "copilot-session-token": jwt("subject-first"),
    },
    body: JSON.stringify({ auto_mode: { model_hints: ["oauth-model"] } }),
  })
  expect(result.status).toBe(200)
  expect(await requests[0]?.text()).toBe("")
})
