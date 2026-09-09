import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { HStack } from "@astryxdesign/core/Stack"
import { Tooltip } from "@astryxdesign/core/Tooltip"

import type { LlmDebugFallback } from "../lib/types"

import { InfoIcon } from "../icons"

export function fallbackDescription(fallback: LlmDebugFallback): string {
  const route =
    fallback.configuredTargetModel === fallback.targetModel ?
      `${fallback.fromModel} → ${fallback.targetModel}`
    : `${fallback.fromModel} → ${fallback.configuredTargetModel} → ${fallback.targetModel} (Model Redirect)`
  const hop =
    fallback.hop > 1 ?
      ` Fallback hop ${fallback.hop}, originally requested ${fallback.sourceModel}.`
    : ""
  return fallback.cached ?
      `This request uses the conversation's remembered HTTP 422 fallback: ${route}.${hop} No new HTTP 422 was required for this request.`
    : `This request was sent because ${fallback.fromModel} returned HTTP 422. ${route}.${hop}`
}

export function LlmFallbackBadge({ fallback }: { fallback: LlmDebugFallback }) {
  return (
    <Tooltip content={fallbackDescription(fallback)}>
      <span>
        <HStack gap={1} vAlign="center">
          <InfoIcon
            width={14}
            height={14}
            style={{ color: "var(--color-warning)" }}
            aria-hidden="true"
          />
          <Badge
            variant="warning"
            label={fallback.cached ? "Cached fallback" : "Fallback"}
          />
        </HStack>
      </span>
    </Tooltip>
  )
}

export function LlmFallbackBanner({
  fallback,
}: {
  fallback: LlmDebugFallback
}) {
  return (
    <Banner
      status={fallback.cached ? "info" : "warning"}
      title={
        fallback.cached ?
          "Cached fallback request"
        : "Fallback request · HTTP 422"
      }
      description={fallbackDescription(fallback)}
    />
  )
}
