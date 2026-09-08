/** Legacy flags are accepted only as explicit migration input, never runtime authority. */
export function resolveApiKeyAuth(
  cliValue: string | undefined,
  _environmentValue: string | undefined,
): string | undefined {
  if (cliValue !== undefined) {
    throw new Error(
      "--api-key-auth no longer configures runtime credentials; use admin --setup-code or storage import-legacy --from-env",
    )
  }
  return undefined
}
