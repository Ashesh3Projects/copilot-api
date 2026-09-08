export function providerSecretPatch(form: {
  apiKey: string
  clearApiKey: boolean
  clearHeaders: boolean
  headers: Array<{ key: string; value: string }>
}): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (form.clearApiKey) result.clearApiKey = true
  else if (form.apiKey.trim()) result.apiKey = form.apiKey.trim()
  if (form.clearHeaders) result.clearHeaders = true
  else {
    const headers = Object.fromEntries(
      form.headers
        .filter((row) => row.key.trim())
        .map((row) => [row.key.trim(), row.value]),
    )
    if (Object.keys(headers).length > 0) result.headers = headers
  }
  return result
}
