export function isStoredGatewayCredential(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && Array.from(value).every((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && code >= 0x21 && code <= 0x7e
    })
  )
}

export function normalizeGatewayCredential(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : value
  if (!isStoredGatewayCredential(normalized))
    throw new TypeError(
      "Gateway key must contain 1 to 4096 visible ASCII characters without whitespace",
    )
  return normalized
}

export function maskSecret(value: string): string {
  return value.length > 10 ?
      `${value.slice(0, 5)}...${value.slice(-5)}`
    : "**********"
}
