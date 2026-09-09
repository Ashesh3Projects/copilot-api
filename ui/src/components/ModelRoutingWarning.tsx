import { Banner } from "@astryxdesign/core/Banner"

import type { ModelRoutingSafety } from "../lib/types"

export function ModelRoutingWarning({
  safety,
}: {
  safety?: ModelRoutingSafety
}) {
  if (!safety || safety.safe) return null
  const path = safety.loop?.models.join(" → ")
  return (
    <Banner
      status="error"
      title="Routing loop detected — redirects and fallbacks are paused"
      description={`Requests use their original model until you fix or disable the conflicting rules.${path ? ` Loop: ${path}.` : ""}`}
    />
  )
}
