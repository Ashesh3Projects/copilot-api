/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejection assertions must be awaited. */
import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { withAccountLeaseScope } from "~/lib/account-lease-context"
import {
  routedFetch,
  runWithPinnedRoutedAccount,
  runWithRoutedModelSelection,
} from "~/lib/account-router"
import {
  createAccountMutationContext,
  getAccountsService,
} from "~/lib/accounts-service"
import { mergeConfigWithDefaults } from "~/lib/config"
import { state } from "~/lib/state"
import { credentialDigest } from "~/lib/storage/credentials-repository"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import {
  closeStorageRuntime,
  getStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"

import { createSchemaFixture } from "./helpers/storage-schema"

const originalFetch = globalThis.fetch
const originalMultiToken = state.isMultiToken
const gatewayKey = "pin-review-gateway-fixture"
const targetModel = "pin-only-first-model"
let fixture: Awaited<ReturnType<typeof createSchemaFixture>>
let firstId: number
let secondId: number
let modelGate: PromiseWithResolvers<undefined>
let imageStarted: PromiseWithResolvers<undefined>
let imageGate: PromiseWithResolvers<undefined>
const sends: Array<{ token: string; integrationId: string | null }> = []

function model(id: string): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "fixture",
    capabilities: {
      family: "test",
      object: "model_capabilities",
      tokenizer: "cl100k_base",
      type: "chat",
      limits: { max_output_tokens: 1024 },
      supports: { streaming: true, tool_calls: true, vision: true },
    },
    supported_endpoints: ["/v1/messages", "/responses"],
  }
}

const context = (input: unknown) =>
  createAccountMutationContext(
    fixture.storage,
    "account.update",
    input,
    "admin:pin-fixture",
  )

async function changeIntegration() {
  await getAccountsService().update(
    firstId,
    { integrationId: "first-next" },
    await context({ firstId }),
  )
}

beforeEach(async () => {
  sends.length = 0
  modelGate = Promise.withResolvers<undefined>()
  imageStarted = Promise.withResolvers<undefined>()
  imageGate = Promise.withResolvers<undefined>()
  fixture = await createSchemaFixture()
  globalThis.fetch = (async (input, init) => {
    const request =
      input instanceof Request ?
        new Request(input, init)
      : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.hostname === "attachment.test") {
      imageStarted.resolve(undefined)
      await imageGate.promise
      return new Response("fixture-image", {
        headers: { "content-type": "image/png" },
      })
    }
    const token = (request.headers.get("authorization") ?? "").replace(
      /^(?:Bearer|token) /,
      "",
    )
    const first = token === "first-fixture"
    if (url.pathname === "/user")
      return Response.json({
        id: first ? 1 : 2,
        login: first ? "first" : "second",
      })
    if (url.pathname === "/copilot_internal/user")
      return Response.json({
        endpoints: { api: "https://api.githubcopilot.com" },
      })
    const integrationId = request.headers.get("copilot-integration-id")
    if (url.pathname === "/models") {
      if (integrationId === "first-next") await modelGate.promise
      return Response.json({
        object: "list",
        data: [model(first ? targetModel : "pin-only-second-model")],
      })
    }
    if (!["/responses", "/v1/messages"].includes(url.pathname))
      throw new Error(`Unexpected fixture request: ${url.pathname}`)
    sends.push({ token, integrationId })
    return Response.json({
      id: "msg_pin_fixture",
      type: "message",
      role: "assistant",
      model: targetModel,
      content: [{ type: "text", text: "fixture" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }) as typeof fetch
  await initializeStorageRuntime({
    storage: fixture.storage,
    config: { kind: "sqlite", path: fixture.path },
  })
  await mergeConfigWithDefaults()
  state.isMultiToken = true
  const service = getAccountsService()
  firstId = (
    await service.create(
      { token: "first-fixture", integrationId: "first-integration" },
      await context({ first: true }),
    )
  ).value.id
  secondId = (
    await service.create(
      { token: "second-fixture", integrationId: "second-integration" },
      await context({ second: true }),
    )
  ).value.id
})

afterEach(async () => {
  imageGate.resolve(undefined)
  modelGate.resolve(undefined)
  await getAccountsService().whenIdle()
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  globalThis.fetch = originalFetch
  state.isMultiToken = originalMultiToken
  await closeStorageRuntime()
  await fixture.close()
})

test("delayed Messages image preparation cannot switch accounts during integration refresh", async () => {
  const digest = credentialDigest(gatewayKey)
  await fixture.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES(?,?,?,?)",
      args: [digest, digest, "pin fixture", Date.now()],
    },
    {
      sql: "INSERT INTO capi_gateway_secrets(credential_id,secret_value,updated_at) VALUES(?,?,?)",
      args: [digest, gatewayKey, Date.now()],
    },
  ])
  const pending = Promise.resolve(
    server.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        "content-type": "application/json",
        "x-client-session-id": "pin-fixture-session",
      },
      body: JSON.stringify({
        model: targetModel,
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "url",
                  url: "https://attachment.test/pin.png",
                },
              },
            ],
          },
        ],
      }),
    }),
  )
  try {
    await Promise.race([
      imageStarted.promise,
      pending.then(() => {
        throw new Error("Request finished before image preparation")
      }),
    ])
    await changeIntegration()
    expect(
      tokenPool.getAllAccounts().find((account) => account.id === firstId)
        ?.models.size,
    ).toBe(0)
    expect(
      tokenPool
        .getAllAccounts()
        .find((account) => account.id === secondId)
        ?.models.has(targetModel),
    ).toBe(false)
    imageGate.resolve(undefined)
    const response = await pending
    const body: unknown = await response.json()
    expect(sends).toEqual([])
    expect(response.status).toBe(503)
    expect(body).toMatchObject({ type: "error", error: { type: "api_error" } })
  } finally {
    imageGate.resolve(undefined)
    await pending
  }
})

test.each(["explicit", "async", "selected"] as const)(
  "%s pins remain authoritative when refresh empties their model catalog",
  async (kind) => {
    await changeIntegration()
    const send = () =>
      routedFetch("/responses", undefined, {
        modelId: targetModel,
        ...(kind === "explicit" ?
          { routedAccountPin: { accountId: firstId } }
        : {}),
      })
    const dispatch = {
      explicit: send,
      async: () => runWithPinnedRoutedAccount(firstId, send),
      selected: () =>
        runWithRoutedModelSelection(
          { accountPin: { accountId: firstId } },
          send,
        ),
    }
    await expect(dispatch[kind]()).rejects.toMatchObject({
      clientBody: { error: { code: "account_unavailable" } },
    })
    expect(sends).toEqual([])
  },
)

test("unpinned unknown models still use the healthy fallback account", async () => {
  await changeIntegration()
  const result = await routedFetch("/responses", undefined, {
    modelId: "unknown-fixture-model",
  })
  await result.response.text()
  expect(result.account?.id).toBe(secondId)
  expect(sends).toEqual([
    { token: "second-fixture", integrationId: "second-integration" },
  ])
})

test("an admitted leased account finishes under its request snapshot during integration refresh", async () => {
  const snapshot = getStorageRuntime().snapshot.get()
  await withRequestSnapshot(snapshot, () =>
    withAccountLeaseScope(undefined, async () => {
      const options = {
        modelId: targetModel,
        routedAccountPin: { accountId: firstId },
      }
      const first = await routedFetch("/responses", undefined, options)
      await first.response.text()
      await changeIntegration()
      const continued = await routedFetch("/responses", undefined, options)
      await continued.response.text()
      expect(continued.account?.id).toBe(firstId)
    }),
  )
  expect(sends).toEqual([
    { token: "first-fixture", integrationId: "first-integration" },
    { token: "first-fixture", integrationId: "first-integration" },
  ])
})
