import { homedir } from "node:os"
import { join, resolve } from "node:path"

export type StorageConfig =
  | { readonly kind: "sqlite"; readonly path: string }
  | { readonly kind: "turso"; readonly url: string; readonly authToken: string }

export function normalizeTursoUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    if (
      !["https:", "turso:"].includes(url.protocol)
      || !url.hostname
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname && url.pathname !== "/")
    )
      throw new Error()
    return `${url.protocol}//${url.host}`
  } catch {
    throw new Error("Invalid Turso database URL")
  }
}

export function resolveStorageConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StorageConfig {
  const url = env.TURSO_DATABASE_URL?.trim() ?? ""
  const authToken = env.TURSO_AUTH_TOKEN?.trim() ?? ""
  if (Boolean(url) !== Boolean(authToken))
    throw new Error(
      "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be configured together",
    )
  if (url)
    return Object.freeze({
      kind: "turso",
      url: normalizeTursoUrl(url),
      authToken,
    })
  const directory =
    env.DATA_DIR?.trim() || join(homedir(), ".local", "share", "copilot-api")
  return Object.freeze({
    kind: "sqlite",
    path: join(resolve(directory), "copilot-api.sqlite"),
  })
}
