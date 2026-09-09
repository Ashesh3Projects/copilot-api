import { isCredentialControlRequest } from "~/lib/request-diagnostics"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Reuse the Sentry scrubber's descriptor-safe accessor; never invoke telemetry getters. */
export function isCredentialControlTelemetry(
  event: Record<string, unknown>,
  readOwnValue: (value: Record<string, unknown>, key: string) => unknown,
): boolean {
  const containers = [
    event,
    readOwnValue(event, "request"),
    readOwnValue(event, "data"),
    readOwnValue(event, "attributes"),
  ]
  const references = [
    "url",
    "transaction",
    "description",
    "http.route",
    "http.target",
    "http.url",
    "url.full",
    "request.url",
  ]
  return containers.some(
    (container) =>
      isRecord(container)
      && references.some((key) => {
        const stored = readOwnValue(container, key)
        const value = isRecord(stored) ? readOwnValue(stored, "value") : stored
        return typeof value === "string" && isCredentialControlRequest(value)
      }),
  )
}
