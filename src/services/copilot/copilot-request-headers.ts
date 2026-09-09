import { sanitizeCopilotHeaderValue } from "./copilot-contract"

// Reviewed against github/copilot-api at 090bcefa58 (2026-09-09):
// docs/api/schema.yaml, pkg/rest/requestctx/requestctx.go and
// pkg/rest/middleware. Authentication and identity are built by copilotHeaders;
// this final allowlist also covers direct calls, retries and debug replay.
const COPILOT_REQUEST_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "authorization",
  "content-type",
  "copilot-harness-id",
  "copilot-integration-id",
  "copilot-session-token",
  "copilot-subsystem-id",
  "copilot-vision-request",
  "editor-version",
  "openai-intent",
  "user-agent",
  "x-agent-task-id",
  "x-client-machine-id",
  "x-client-session-id",
  "x-copilot-client-exp-assignment-context",
  "x-github-api-version",
  "x-github-repository-host",
  "x-github-repository-nwo",
  "x-initiator",
  "x-interaction-id",
  "x-interaction-type",
  "x-model-provider-preference",
  "x-parent-agent-id",
  "x-request-id",
])

// Only BetaHeaderAllow entries from pkg/llmapi/messagesapi/beta_headers.go
// at the revision above. Removed, rejected and unknown flags stay local.
// CAPI injects model-required flags (e.g. fast mode) itself.
const COPILOT_ANTHROPIC_BETAS = new Set([
  "adaptive-thinking-2026-01-28",
  "advanced-tool-use-2025-11-20",
  "advisor-tool-2026-03-01",
  "claude-code-20250219",
  "compact-2026-01-12",
  "computer-use-2025-01-24",
  "computer-use-2025-11-24",
  "context-management-2025-06-27",
  "fallback-credit-2026-07-01",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
  "mid-conv-tool-change-2026-07-01",
  "mid-conversation-system-2026-04-07",
  "task-budgets-2026-03-13",
  "thinking-binding-controls-2026-08-01",
  "token-efficient-tools-2025-02-19",
])

// The same registry explicitly directs these clients to advanced-tool-use.
const COPILOT_ANTHROPIC_BETA_ALIASES = new Map([
  ["tool-examples-2025-10-29", "advanced-tool-use-2025-11-20"],
  ["tool-search-tool-2025-10-19", "advanced-tool-use-2025-11-20"],
])

function filterCopilotAnthropicBeta(values: Array<string>): string | undefined {
  const allowed = new Set<string>()
  for (const value of values) {
    for (const segment of value.split(",")) {
      const identifier = sanitizeCopilotHeaderValue(segment)
      if (!identifier) continue
      const beta = COPILOT_ANTHROPIC_BETA_ALIASES.get(identifier) ?? identifier
      if (COPILOT_ANTHROPIC_BETAS.has(beta)) allowed.add(beta)
    }
  }
  return sanitizeCopilotHeaderValue([...allowed].join(","))
}

/** Apply only when dispatching to Copilot, after local routing consumed flags. */
export function filterCopilotRequestHeaders(
  headersInit: RequestInit["headers"],
): Record<string, string> {
  let entries: Array<[string, unknown]> | Array<Array<string>>
  if (headersInit instanceof Headers) {
    entries = [...headersInit.entries()]
  } else if (Array.isArray(headersInit)) {
    entries = headersInit
  } else {
    entries = Object.entries(headersInit ?? {})
  }

  const headers: Record<string, string> = {}
  const betaValues: Array<string> = []
  let betaHeaderName: string | undefined
  for (const [name, value] of entries) {
    const canonicalName = name.toLowerCase()
    if (
      !COPILOT_REQUEST_HEADERS.has(canonicalName)
      || typeof value !== "string"
    ) {
      continue
    }
    if (canonicalName === "anthropic-beta") {
      betaHeaderName ??= name
      betaValues.push(value)
    } else {
      headers[name] = value
    }
  }

  const beta = filterCopilotAnthropicBeta(betaValues)
  if (beta && betaHeaderName) headers[betaHeaderName] = beta
  return headers
}
