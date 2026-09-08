import { afterEach, beforeEach, expect, test } from "bun:test"

import { routedFetch } from "~/lib/account-router"
import { getAccountsService } from "~/lib/accounts-service"
import {
  isModelEnabledForAccount,
  setModelRoutingOverride,
} from "~/lib/model-routing"
import { state } from "~/lib/state"
import { withSettingsActor } from "~/lib/storage/domain-settings"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const modelId = "snapshot-routing-model"

beforeEach(async () => {
  state.isMultiToken = true
  const model = {
    id: modelId,
    name: "Snapshot routing model",
    object: "model",
    version: "test",
    vendor: "openai",
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      family: "gpt",
      limits: { max_output_tokens: 4096 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
  for (const id of [1, 2]) {
    const account = tokenPool.addAccount(
      `snapshot-github-${id}`,
      "individual",
      id,
    )
    account.copilotToken = `snapshot-copilot-${id}`
    account.healthy = true
    account.models = new Set([modelId])
    account.modelsData = [model]
  }
  await seedProtocolDatabase()
  await getStorageRuntime().snapshot.refreshIfChanged()
  await getAccountsService().refreshRuntime()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
})

test.each(["account hydration", "direct index refresh"])(
  "new requests honor committed model disable after stale %s while an admitted stream completes",
  async (refresh) => {
    const runtime = getStorageRuntime()
    const old = runtime.snapshot.get()
    const source = new TransformStream<Uint8Array, Uint8Array>()
    let sends = 0
    globalThis.fetch = (async () => {
      sends += 1
      await Promise.resolve()
      return sends === 1 ?
          new Response(source.readable)
        : Response.json({
            id: "unexpected",
            object: "chat.completion",
            model: modelId,
            created: 1,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "unexpected dispatch" },
                finish_reason: "stop",
              },
            ],
          })
    }) as unknown as typeof fetch
    const admitted = await withRequestSnapshot(old, () =>
      routedFetch(
        "/chat/completions",
        { method: "POST", body: JSON.stringify({ model: modelId }) },
        { modelId },
      ),
    )
    expect(admitted.account?.id).toBe(1)
    await withSettingsActor("admin:snapshot-test", async () => {
      await setModelRoutingOverride(modelId, 1, false)
      await setModelRoutingOverride(modelId, 2, false)
    })
    await withRequestSnapshot(old, async () => {
      expect(isModelEnabledForAccount(modelId, 1)).toBe(true)
      if (refresh === "account hydration")
        await getAccountsService().refreshRuntime()
      else {
        await getAccountsService().refreshRuntime()
        tokenPool.rebuildModelIndex()
      }
    })
    const response = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    })
    expect(response.status).toBe(403)
    expect(sends).toBe(1)
    expect(isModelEnabledForAccount(modelId, 1)).toBe(false)
    expect(tokenPool.getEligibleAccountIdsForModel(modelId)).toEqual([])
    const reading = admitted.response.text()
    const writer = source.writable.getWriter()
    await writer.write(new TextEncoder().encode("admitted stream completed"))
    await writer.close()
    expect(await reading).toBe("admitted stream completed")
  },
)
