interface ProviderSecretOptions {
  apiKey?: unknown
  apiKeyEnv?: unknown
  enabled?: unknown
  clearApiKey?: unknown
  clearHeaders?: unknown
  replaceHeaders?: unknown
  headers?: unknown
}

export function providerSecretInputError(
  body: ProviderSecretOptions,
): string | undefined {
  if (body.apiKey !== undefined && typeof body.apiKey !== "string")
    return "apiKey must be a string"
  if (body.apiKeyEnv !== undefined)
    return "apiKeyEnv is no longer supported; store a provider key in the dashboard"
  for (const value of [
    body.enabled,
    body.clearApiKey,
    body.clearHeaders,
    body.replaceHeaders,
  ])
    if (value !== undefined && typeof value !== "boolean")
      return "Provider flags must be boolean"
  if (body.headers !== undefined && !isStringRecord(body.headers))
    return "headers must be an object of strings"
  if (body.replaceHeaders && (body.clearHeaders || body.headers === undefined))
    return "Header replacement requires a header map and cannot also clear headers"
  return undefined
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string")
  )
}
