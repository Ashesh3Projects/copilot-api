const LEGACY_STORAGE_KEYS = ["dashboard_api_key", "ff_api_key"]
interface PendingMutation {
  id: string
  revision?: number
  createdAt: number
}
// Only hashes and operation metadata are retained, never request bodies or credentials.
const pendingMutations = new Map<string, PendingMutation>()
async function mutationAttempt(
  method: string,
  path: string,
  request: { body?: string; options?: MutationOptions },
): Promise<{ key?: string; value: PendingMutation }> {
  const now = Date.now()
  if (request.options?.operationId)
    return {
      value: {
        id: request.options.operationId,
        revision: request.options.expectedRevision,
        createdAt: now,
      },
    }
  for (const [key, value] of pendingMutations)
    if (now - value.createdAt > 30 * 60_000) pendingMutations.delete(key)
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([method, path, request.body ?? null]),
    ),
  )
  const key = Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")
  let value = pendingMutations.get(key)
  if (!value) {
    if (pendingMutations.size >= 64)
      pendingMutations.delete(pendingMutations.keys().next().value ?? "")
    value = {
      id: crypto.randomUUID(),
      revision: request.options?.expectedRevision,
      createdAt: now,
    }
    pendingMutations.set(key, value)
  }
  return { key, value }
}
function finishMutation(
  attempt: { key?: string; value: PendingMutation } | undefined,
): void {
  if (attempt?.key && pendingMutations.get(attempt.key) === attempt.value)
    pendingMutations.delete(attempt.key)
}

export function clearLegacyCredentials(): void {
  for (const key of LEGACY_STORAGE_KEYS) {
    sessionStorage.removeItem(key)
    localStorage.removeItem(key)
  }
}

function getCookie(name: string): string | null {
  const prefix = `${name}=`
  for (const segment of document.cookie.split(";")) {
    const value = segment.trim()
    if (value.startsWith(prefix)) return value.slice(prefix.length)
  }
  return null
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function extractErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const data: unknown = await response.clone().json()
    if (data && typeof data === "object" && "error" in data) {
      const error = (data as { error: unknown }).error
      if (typeof error === "string") return error
      if (error && typeof error === "object" && "message" in error) {
        const message = (error as { message: unknown }).message
        if (typeof message === "string") return message
      }
    }
  } catch {
    // fall through to text/fallback below
  }
  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch {
    // ignore
  }
  return fallback
}

export interface MutationOptions {
  expectedRevision?: number
  operationId?: string
}
function mutationHeaders(
  attempt: { value: PendingMutation } | undefined,
): Record<string, string> {
  if (!attempt) return {}
  const csrf = getCookie("__Host-copilot_admin_csrf")
  return {
    "idempotency-key": attempt.value.id,
    ...(attempt.value.revision === undefined ?
      {}
    : { "if-match": JSON.stringify(String(attempt.value.revision)) }),
    ...(csrf ? { "x-copilot-csrf": csrf } : {}),
  }
}
// eslint-disable-next-line max-params -- Optional revision and operation metadata are independent from the request body.
export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  mutation?: MutationOptions,
): Promise<T> {
  const serialized = body === undefined ? undefined : JSON.stringify(body)
  const attempt =
    method === "GET" ? undefined : (
      await mutationAttempt(method, path, {
        body: serialized,
        options: mutation,
      })
    )
  const headers = mutationHeaders(attempt)
  if (body !== undefined) headers["content-type"] = "application/json"

  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: serialized,
  })

  if (!response.ok) {
    if (response.status < 500) finishMutation(attempt)
    const message = await extractErrorMessage(
      response,
      `Request failed with status ${response.status}`,
    )
    throw new ApiError(response.status, message)
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    finishMutation(attempt)
    return undefined as T
  }
  const result = (await response.json()) as T
  finishMutation(attempt)
  return result
}

export function get<T>(path: string): Promise<T> {
  return api<T>("GET", path)
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>("POST", path, body)
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return api<T>("PATCH", path, body)
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return api<T>("PUT", path, body)
}

export function del<T>(path: string, body?: unknown): Promise<T> {
  return api<T>("DELETE", path, body)
}

export async function authProbe(): Promise<unknown> {
  return get("/dashboard/auth/session")
}
