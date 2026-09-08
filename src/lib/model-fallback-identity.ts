import { resolveCustomProviderModel } from "~/lib/custom-providers"
import { state } from "~/lib/state"

/** Preserve exact rule IDs while identifying aliases of one upstream model. */
export function getModelFallbackIdentity(model: string): string {
  const reference = resolveCustomProviderModel({
    model,
    kind: "chat",
    copilotModelIds: new Set(state.models?.data.map((entry) => entry.id) ?? []),
  })
  return JSON.stringify(
    reference ?
      ["custom", reference.provider.id, reference.upstreamModel]
    : ["copilot", model],
  )
}
