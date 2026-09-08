/** Limits diagnostics only. Inference payloads are forwarded without this limit. */
export const DEBUG_CAPTURE_MAX_BYTES = 1024 * 1024
export const DEBUG_CAPTURE_MEMORY_MAX_BYTES = 16 * 1024 * 1024
export const DEBUG_REDACTED = "[REDACTED]"
let retainedBytes = 0

export function debugCaptureMemoryUsage(): number {
  return retainedBytes
}

export function reserveDebugCaptureMemory(bytes: number): boolean {
  if (
    bytes < 0
    || !Number.isFinite(bytes)
    || retainedBytes + bytes > DEBUG_CAPTURE_MEMORY_MAX_BYTES
  )
    return false
  retainedBytes += bytes
  return true
}

export function releaseDebugCaptureMemory(bytes: number): void {
  retainedBytes -= bytes
}

export interface CapturedBody {
  body: string | null
  bodyBytes: number
  /** False after a streaming overflow: bodyBytes is the observed lower bound. */
  bodyBytesComplete?: boolean
  truncated?: boolean
  redacted?: boolean
  omittedReason?: "size-limit" | "unsupported" | "read-error" | "queue-pressure"
}

function secretKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase()
  return (
    /authorization|cookie|password|passwd|apikey|accesstoken|refreshtoken|idtoken|subscriptionkey|clientsecret|sessiontoken|credential|privatekey|secret/.test(
      normalized,
    )
    || /^(?:token|auth|sessionid|threadid|conversationid|promptcachekey|safetyidentifier|signature|sig|key)$/.test(
      normalized,
    )
  )
}

function secretHeader(key: string): boolean {
  return (
    secretKey(key)
    || /session|thread|conversation|interaction|agent.task|token|csrf/i.test(
      key,
    )
  )
}

/** Custom provider headers may use arbitrary credential names. */
function protectedHeader(key: string, customProvider: boolean): boolean {
  return (
    secretHeader(key)
    || (customProvider
      && !/^(?:accept|content-type|user-agent|anthropic-version|anthropic-beta)$/i.test(
        key,
      ))
  )
}

/** Lives only with the active request and is never part of a queued payload. */
export function debugCredentialLiterals(
  headers: Record<string, string>,
  url?: string,
  customProvider = false,
): Array<string> {
  const secrets = new Set<string>()
  for (const [key, value] of Object.entries(headers)) {
    if (!protectedHeader(key, customProvider) || !value) continue
    secrets.add(value)
    if (/authorization/i.test(key)) secrets.add(value.replace(/^\S+\s+/, ""))
    if (/cookie/i.test(key)) {
      for (const part of value.split(";")) {
        const at = part.indexOf("=")
        if (at !== -1 && part.slice(at + 1).trim())
          secrets.add(part.slice(at + 1).trim())
      }
    }
  }
  collectUrlCredentials(url, secrets)
  return [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
}

function collectUrlCredentials(
  url: string | undefined,
  secrets: Set<string>,
): void {
  if (url) {
    try {
      const parsed = new URL(url)
      for (const part of [parsed.username, parsed.password]) {
        if (part) secrets.add(decodeURIComponent(part))
      }
      for (const [key, value] of parsed.searchParams)
        if (secretKey(key) && value) secrets.add(value)
    } catch {
      /* Unsupported URLs are omitted by sanitizeDebugUrl. */
    }
  }
}

export function sanitizeDebugUrl(value: string): string {
  try {
    const relative = value.startsWith("/")
    const url = new URL(value, relative ? "https://debug.invalid" : undefined)
    url.username = ""
    url.password = ""
    url.hash = ""
    for (const key of url.searchParams.keys())
      if (secretKey(key)) url.searchParams.set(key, DEBUG_REDACTED)
    return relative ? `${url.pathname}${url.search}` : url.toString()
  } catch {
    return "[unavailable URL]"
  }
}

export function sanitizeDebugText(
  value: string,
  secrets: ReadonlyArray<string> = [],
): string {
  // Embedded JSON and incomplete fragments cannot be safely reconstructed with
  // a value regex. Omit the entire string when a quoted credential key occurs.
  const decodedKeys = value
    .replaceAll(/\\u([\da-f]{4})/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/\\(["'])/g, "$1")
  for (const match of decodedKeys.matchAll(/["']([^"'\r\n]{1,128})["']\s*:/g)) {
    if (secretKey(match[1])) return DEBUG_REDACTED
  }
  let result = value
  for (const secret of secrets)
    if (secret) result = result.replaceAll(secret, DEBUG_REDACTED)
  return result
    .replaceAll(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [REDACTED]")
    .replaceAll(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|authorization|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replaceAll(/https?:\/\/[^\s<>"']+/gi, (url) => sanitizeDebugUrl(url))
}

export function sanitizeDebugHeaders(
  headers: Record<string, string>,
  secrets: ReadonlyArray<string> = [],
  customProvider = false,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      protectedHeader(key, customProvider) ? DEBUG_REDACTED : (
        sanitizeDebugText(value, secrets)
      ),
    ]),
  )
}

function scrubValue(
  value: unknown,
  secrets: ReadonlyArray<string>,
  depth = 0,
): unknown {
  if (depth > 64) throw new Error("Unsupported diagnostic nesting")
  if (typeof value === "string") {
    const scrubbed = sanitizeDebugText(value, secrets)
    if (/^\s*[[{]/.test(value)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(value) as unknown
      } catch {
        if (
          /"\s*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*"\s*:/i.test(
            value,
          )
        )
          throw new Error("Unsupported embedded diagnostic JSON")
        return scrubbed
      }
      const cleaned = scrubValue(parsed, secrets, depth + 1)
      return JSON.stringify(parsed) === JSON.stringify(cleaned) ?
          scrubbed
        : JSON.stringify(cleaned)
    }
    return scrubbed
  }
  if (Array.isArray(value))
    return value.map((item: unknown) => scrubValue(item, secrets, depth + 1))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitizeDebugText(key, secrets),
        secretKey(key) ? DEBUG_REDACTED : scrubValue(item, secrets, depth + 1),
      ]),
    )
  return value
}

function scrubJson(body: string, secrets: ReadonlyArray<string>): string {
  const parsed: unknown = JSON.parse(body)
  const cleaned = scrubValue(parsed, secrets)
  // Preserve exact ordinary payload formatting for existing diagnostic/replay consumers.
  return JSON.stringify(parsed) === JSON.stringify(cleaned) ?
      body
    : JSON.stringify(cleaned)
}

function scrubSse(body: string, secrets: ReadonlyArray<string>): string {
  return body
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n")
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      const safeData =
        !data || data === "[DONE]" ? data : scrubJson(data, secrets)
      let inserted = false
      return lines
        .flatMap((line) => {
          if (!line.startsWith("data:"))
            return [sanitizeDebugText(line, secrets)]
          if (inserted) return []
          inserted = true
          return [`data: ${safeData}`]
        })
        .join("\n")
    })
    .join("\n\n")
}

export function sanitizeDebugCapture(input: {
  body: string | null
  contentType?: string
  knownCredentials?: ReadonlyArray<string>
  bodyBytes?: number
  bodyBytesComplete?: boolean
  truncated?: boolean
  omittedReason?: CapturedBody["omittedReason"]
}): CapturedBody {
  const bodyBytes =
    input.bodyBytes ?? (input.body === null ? 0 : Buffer.byteLength(input.body))
  const base = {
    bodyBytes,
    bodyBytesComplete: input.bodyBytesComplete ?? true,
    redacted: false,
    ...(input.truncated ? { truncated: true } : {}),
  }
  if (
    bodyBytes > DEBUG_CAPTURE_MAX_BYTES
    || input.omittedReason === "size-limit"
  )
    return { ...base, body: null, truncated: true, omittedReason: "size-limit" }
  if (input.body === null)
    return {
      ...base,
      body: null,
      ...(input.omittedReason ? { omittedReason: input.omittedReason } : {}),
    }
  try {
    const secrets = input.knownCredentials ?? []
    const body =
      (
        input.contentType?.includes("text/event-stream")
        || /^(?:data:|event:)/.test(input.body.trimStart())
      ) ?
        scrubSse(input.body, secrets)
      : scrubJson(input.body, secrets)
    if (Buffer.byteLength(body) > DEBUG_CAPTURE_MAX_BYTES)
      return {
        ...base,
        body: null,
        truncated: true,
        omittedReason: "size-limit",
      }
    return { ...base, body, redacted: body !== input.body }
  } catch {
    return { ...base, body: null, omittedReason: "unsupported" }
  }
}

/** Clone tees the response. The bounded reader never awaits the client branch. */
export async function captureDebugResponseBody(
  response: Response,
  signal?: AbortSignal,
): Promise<CapturedBody> {
  if (signal?.aborted)
    throw new DOMException("Diagnostic capture aborted", "AbortError")
  const stream = response.clone().body as ReadableStream<Uint8Array> | null
  const reader = stream?.getReader()
  if (!reader) return { body: null, bodyBytes: 0, bodyBytesComplete: true }
  const chunks: Array<Uint8Array> = []
  let reservedBytes = 0
  const releaseBuffer = () => {
    chunks.length = 0
    releaseDebugCaptureMemory(reservedBytes)
    reservedBytes = 0
  }
  const state = { aborted: false }
  const cancel = () => {
    state.aborted = true
    releaseBuffer()
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  // A permanently stalled upstream must not retain a diagnostic reader forever.
  const timeout = setTimeout(cancel, 60 * 60_000)
  timeout.unref()
  let bodyBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (state.aborted)
        throw new DOMException("Diagnostic capture aborted", "AbortError")
      if (done) break
      bodyBytes += value.byteLength
      if (bodyBytes > DEBUG_CAPTURE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined)
        return {
          body: null,
          bodyBytes,
          bodyBytesComplete: false,
          truncated: true,
          omittedReason: "size-limit",
        }
      }
      // Reserve before copying, including concat and UTF-16 decode headroom.
      const reservation = value.byteLength * 4
      if (!reserveDebugCaptureMemory(reservation)) {
        void reader.cancel().catch(() => undefined)
        return {
          body: null,
          bodyBytes,
          bodyBytesComplete: false,
          truncated: true,
          omittedReason: "queue-pressure",
        }
      }
      reservedBytes += reservation
      chunks.push(value.slice())
    }
    const body = new TextDecoder(undefined, { fatal: true }).decode(
      Buffer.concat(chunks),
    )
    return { body, bodyBytes, bodyBytesComplete: true }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", cancel)
    releaseBuffer()
    reader.releaseLock()
  }
}
