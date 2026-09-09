export function generateGatewayKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `cop-${Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")}`
}
