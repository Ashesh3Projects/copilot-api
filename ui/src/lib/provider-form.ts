export interface ProviderSecretValues {
  apiKey: string | null
  headers: Record<string, string>
}

interface ProviderSecretForm {
  apiKey: string
  clearApiKey: boolean
  clearHeaders: boolean
  headers: Array<{ key: string; value: string }>
}

function sameHeaders(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(
      ([key, value]) => Object.hasOwn(right, key) && right[key] === value,
    )
  )
}

export function providerSecretPatch(
  form: ProviderSecretForm,
  original?: ProviderSecretValues,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const apiKey = form.apiKey.trim()
  if (form.clearApiKey || (original?.apiKey && !apiKey))
    result.clearApiKey = true
  else if (apiKey && apiKey !== original?.apiKey) result.apiKey = apiKey
  if (form.clearHeaders) result.clearHeaders = true
  else {
    const headers = Object.fromEntries(
      form.headers
        .filter((row) => row.key.trim())
        .map((row) => [row.key.trim(), row.value]),
    )
    if (original) {
      if (!sameHeaders(headers, original.headers)) {
        result.headers = headers
        result.replaceHeaders = true
      }
    } else if (Object.keys(headers).length > 0) result.headers = headers
  }
  return result
}
