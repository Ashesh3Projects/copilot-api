import "./data-dir"

import { expect, test } from "bun:test"

import { state } from "~/lib/state"

import {
  useIntegrationFixture,
  initializeTestState,
  postJSON,
  TEST_TIMEOUT,
} from "./setup"

useIntegrationFixture()

await initializeTestState()

const responsesModels =
  state.models?.data.filter((model) =>
    model.supported_endpoints?.includes("/responses"),
  ) ?? []
const messagesModel = state.models?.data.find((model) =>
  model.supported_endpoints?.includes("/v1/messages"),
)?.id
const longStablePrefix = "Stable explicit cache prefix. ".repeat(128)

test.skipIf(responsesModels.length === 0)(
  "accepts Responses explicit cache controls",
  async () => {
    let accepted = false
    for (const model of firstModelByProvider(responsesModels)) {
      const response = await postJSON("/v1/responses", {
        model: model.id,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: longStablePrefix,
                prompt_cache_breakpoint: { mode: "explicit" },
              },
              { type: "input_text", text: "Reply with OK." },
            ],
          },
        ],
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
        max_output_tokens: 32,
      })
      await response.arrayBuffer()
      if (response.status !== 200) continue
      accepted = true
      break
    }

    expect(accepted).toBe(true)
  },
  TEST_TIMEOUT,
)

test.skipIf(messagesModel === undefined)(
  "accepts native Messages 5m cache control",
  async () => {
    if (!messagesModel) throw new Error("Messages endpoint unavailable")

    const response = await postJSON("/v1/messages", {
      model: messagesModel,
      max_tokens: 32,
      cache_control: { type: "ephemeral", ttl: "5m" },
      messages: [{ role: "user", content: "Reply with OK." }],
    })

    expect(response.status).toBe(200)
  },
  TEST_TIMEOUT,
)

function firstModelByProvider<T extends { vendor?: string }>(
  models: ReadonlyArray<T>,
): Array<T> {
  const firstByProvider: Array<T> = []
  const providers = new Set<string>()

  for (const model of models) {
    const provider = model.vendor ?? ""
    if (providers.has(provider)) continue
    providers.add(provider)
    firstByProvider.push(model)
  }

  return firstByProvider
}
