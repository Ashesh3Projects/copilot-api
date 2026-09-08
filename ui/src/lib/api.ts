const LEGACY_STORAGE_KEYS = ["dashboard_api_key", "ff_api_key"]

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
// eslint-disable-next-line max-params -- Optional revision and operation metadata are independent from the request body.
export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  mutation?: MutationOptions,
): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers["content-type"] = "application/json"
  if (!["GET"].includes(method)) {
    headers["idempotency-key"] = mutation?.operationId ?? crypto.randomUUID()
    if (mutation?.expectedRevision !== undefined)
      headers["if-match"] = JSON.stringify(String(mutation.expectedRevision))
    const csrfToken = getCookie("__Host-copilot_admin_csrf")
    if (csrfToken) headers["x-copilot-csrf"] = csrfToken
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!response.ok) {
    const message = await extractErrorMessage(
      response,
      `Request failed with status ${response.status}`,
    )
    throw new ApiError(response.status, message)
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return undefined as T
  }

  return (await response.json()) as T
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
