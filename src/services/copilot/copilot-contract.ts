import { Buffer } from "node:buffer"
import util from "node:util"

export const COPILOT_API_VERSION = "2026-08-01"
export const DEFAULT_COPILOT_INTEGRATION_ID = "copilot-developer-cli"

const MAX_INTEGRATION_ID_LENGTH = 128
const MAX_SAFE_RESPONSE_HEADER_VALUE_LENGTH = 8 * 1024

const SAFE_RESPONSE_HEADERS = new Set([
  "retry-after",
  "x-copilot-api-exp-assignment-context",
  "x-copilot-service-request-id",
  "x-github-copilot-request-te",
  "x-github-request-id",
])
const SAFE_RESPONSE_PREFIXES = ["x-quota-snapshot-", "x-usage-ratelimit-"]
const HEADERS_ENTRIES = Object.getOwnPropertyDescriptor(
  Headers.prototype,
  "entries",
)?.value as (() => IterableIterator<[string, string]>) | undefined

function hasHeaderControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint === undefined
      || codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true
    }
  }
  return false
}

export function sanitizeCopilotHeaderValue(
  value: string | null | undefined,
  maxLength = 1024,
): string | undefined {
  if (
    value === null
    || value === undefined
    || hasHeaderControlCharacter(value)
  ) {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > maxLength) {
    return undefined
  }
  return trimmed
}

export function resolveCopilotIntegrationId(value: string | undefined): string {
  if (!value?.trim()) return DEFAULT_COPILOT_INTEGRATION_ID
  const sanitized = sanitizeCopilotHeaderValue(value, MAX_INTEGRATION_ID_LENGTH)
  if (!sanitized) {
    throw new Error(
      "COPILOT_INTEGRATION_ID must be 128 characters or fewer and contain no control characters",
    )
  }
  return sanitized
}

/** Account overrides are nullable, trimmed HTTP field values, never global settings. */
export function normalizeAccountIntegrationId(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (
    typeof value !== "string"
    || !/^[\x20-\x7e]*$/.test(value)
    || value.trim().length > MAX_INTEGRATION_ID_LENGTH
  )
    throw new TypeError(
      "Integration ID must contain only printable ASCII characters and be 128 characters or fewer",
    )
  return value.trim() || null
}

export function collectSafeCopilotResponseHeaders(
  headers: Headers,
): Record<string, string> {
  const result: Record<string, string> = {}

  try {
    if (util.types.isProxy(headers)) return result
  } catch {
    return result
  }

  let entries: IterableIterator<[string, string]>
  if (HEADERS_ENTRIES) {
    try {
      entries = Reflect.apply(HEADERS_ENTRIES, headers, [])
    } catch {
      entries = headers.entries()
    }
  } else {
    entries = headers.entries()
  }

  for (const [name, value] of entries) {
    const canonicalName = name.toLowerCase()
    const isSafeName =
      SAFE_RESPONSE_HEADERS.has(canonicalName)
      || SAFE_RESPONSE_PREFIXES.some((prefix) =>
        canonicalName.startsWith(prefix),
      )
    if (
      !isSafeName
      || Buffer.byteLength(value, "utf8")
        > MAX_SAFE_RESPONSE_HEADER_VALUE_LENGTH
      || hasHeaderControlCharacter(value)
    ) {
      continue
    }
    result[canonicalName] = value
  }

  return result
}
