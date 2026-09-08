export interface CompatibilityContractRow {
  behavior: string
  surface: string
}

export const ANTHROPIC_HTTP_ERROR_STATUS_TYPES = [
  { status: 400, type: "invalid_request_error" },
  { status: 401, type: "authentication_error" },
  { status: 403, type: "permission_error" },
  { status: 404, type: "not_found_error" },
  { status: 413, type: "request_too_large" },
  { status: 429, type: "rate_limit_error" },
  { status: 500, type: "api_error" },
] as const

export const STREAM_BEHAVIOR_CONTRACT = [
  {
    surface: "Messages handled HTTP failure",
    behavior: `exactly one dialect-correct error outcome after closing open blocks; preserve partial output and the owned upstream failure representation when present (${ANTHROPIC_HTTP_ERROR_STATUS_TYPES.map(({ type }) => type).join(", ")})`,
  },
  {
    surface: "Synthetic Responses-from-Messages failure",
    behavior: "error then response.failed",
  },
  {
    surface: "Native Responses terminal families",
    behavior:
      "preserve response.completed, response.incomplete, response.failed, and error terminal objects in their established protocol representation; exactly one terminal",
  },
  {
    surface: "Committed Chat stream failure",
    behavior:
      "preserve emitted partial chunks, then emit one Chat error event and one [DONE]; no writes after abort",
  },
  {
    surface: "Source end and abort",
    behavior:
      "clean EOF without a terminal synthesizes one dialect-local failure; abort or detach emits nothing further",
  },
] as const satisfies ReadonlyArray<CompatibilityContractRow>

export const SESSION_TOKEN_PRIVACY_CONTRACT = [
  {
    surface: "Administrator-only LLM Debug",
    behavior: "session token value is redacted",
  },
  {
    surface: "Ordinary handler logs",
    behavior: "session token value is redacted",
  },
  {
    surface: "Configuration export",
    behavior: "token-keyed values are redacted",
  },
  {
    surface: "Inference forwarding",
    behavior:
      "multi-account mode also requires issuer proof for the selected account",
  },
  {
    surface: "Token-required control plane",
    behavior:
      "issuer mismatch or unknown proof is rejected locally without upstream send",
  },
] as const satisfies ReadonlyArray<CompatibilityContractRow>

export const ERROR_ENVELOPE_CONTRACT = [
  {
    surface: "Final non-empty upstream HTTP failure",
    behavior:
      "exact response body in normal client, ordinary logs, and Sentry; preserve upstream status and content type",
  },
  {
    surface: "Local, empty-body, unreadable-body, or transport-only failure",
    behavior:
      "use the existing dialect/protocol-shaped proxy-authored fallback",
  },
] as const satisfies ReadonlyArray<CompatibilityContractRow>

export const ATTACHMENT_URL_CONTRACT = [
  {
    surface: "Runtime-valid absolute HTTP(S) attachment/file URL",
    behavior:
      "fetchable without destination, DNS, IP, userinfo, or redirect-target filtering; caller abort, timeout, byte, and redirect limits remain",
  },
] as const satisfies ReadonlyArray<CompatibilityContractRow>
