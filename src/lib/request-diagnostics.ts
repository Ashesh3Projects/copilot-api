const GOOGLE_MODEL_ROUTE_REFERENCE =
  /(\/(?:v1beta\/models|v1\/models|models)\/)([^/?#\s"'<>]+)\/?(?=$|[?#\s"'<>])/gi
const GOOGLE_MODEL_ACTION_PATH =
  /^\/(?:v1beta\/models|v1\/models|models)\/[^/?#]+\/?(?:[?#].*)?$/i
const SUPPORTED_GOOGLE_MODEL_ACTION_PATH =
  /^\/(?:v1beta\/models|v1\/models|models)\/[^/?#]+:(?:generateContent|streamGenerateContent)$/
const REDACTED_QUERY_VALUE = "[REDACTED]"
const SENSITIVE_QUERY_PARAMETER =
  /(?:^|[_-])(?:access[_-]?token|api[_-]?key|authorization|code[_-]?verifier|credential|key|password|refresh[_-]?token|secret|token)(?:$|[_-])/i
const CODEX_PLUGIN_SEARCH_REFERENCE =
  /\/ps\/plugins\/search\/?(?:[?#\s"'<>]|$)/i
const CODEX_PLUGIN_CATEGORY_REFERENCE =
  /\/ps\/plugin-categories\/[^/?#\s"'<>]+\/plugins\/?(?:[?#\s"'<>]|$)/i
const CODEX_PLUGIN_SEARCH_QUERY_PARAMETERS = new Set(["pagetoken", "q"])
const CODEX_PLUGIN_CATEGORY_QUERY_PARAMETERS = new Set(["pagetoken"])
const NO_ADDITIONAL_QUERY_PARAMETERS = new Set<string>()

function redactDiagnosticQuery(
  query: string,
  additionalParameters: ReadonlySet<string>,
): string {
  return query
    .split("&")
    .map((entry) => {
      const equals = entry.indexOf("=")
      const rawKey = equals === -1 ? entry : entry.slice(0, equals)
      let key = rawKey
      try {
        key = decodeURIComponent(rawKey.replaceAll("+", " "))
      } catch {
        // Retain malformed keys and still apply the sensitive-name pattern.
      }
      if (
        !SENSITIVE_QUERY_PARAMETER.test(key)
        && !additionalParameters.has(key.toLowerCase())
      ) {
        return entry
      }
      return `${rawKey}=${REDACTED_QUERY_VALUE}`
    })
    .join("&")
}

function redactSensitiveQueryParameters(value: string): string {
  const queryStart = value.indexOf("?")
  if (queryStart === -1) return value
  const pluginSearch = containsCodexPluginSearchReference(
    value.slice(0, queryStart + 1),
  )
  const pluginCategory = containsCodexPluginCategoryReference(
    value.slice(0, queryStart + 1),
  )
  const fragmentStart = value.indexOf("#", queryStart)
  const queryEnd = fragmentStart === -1 ? value.length : fragmentStart
  const query = value.slice(queryStart + 1, queryEnd)
  let additionalParameters = NO_ADDITIONAL_QUERY_PARAMETERS
  if (pluginSearch) additionalParameters = CODEX_PLUGIN_SEARCH_QUERY_PARAMETERS
  else if (pluginCategory) {
    additionalParameters = CODEX_PLUGIN_CATEGORY_QUERY_PARAMETERS
  }
  const redacted = redactDiagnosticQuery(query, additionalParameters)
  return `${value.slice(0, queryStart + 1)}${redacted}${value.slice(queryEnd)}`
}

export function sanitizeSensitiveDiagnosticQuery(value: string): string {
  return redactSensitiveQueryParameters(
    value.includes("?") ? value : `?${value}`,
  ).slice(value.includes("?") ? 0 : 1)
}

export function sanitizeCodexPluginSearchDiagnosticQuery(
  value: string,
): string {
  const prefix = value.startsWith("?") ? "?" : ""
  return `${prefix}${redactDiagnosticQuery(
    value.slice(prefix.length),
    CODEX_PLUGIN_SEARCH_QUERY_PARAMETERS,
  )}`
}

export function containsCodexPluginSearchReference(value: string): boolean {
  return CODEX_PLUGIN_SEARCH_REFERENCE.test(value)
}

export function containsCodexPluginCategoryReference(value: string): boolean {
  return CODEX_PLUGIN_CATEGORY_REFERENCE.test(value)
}

export function isCodexPluginSearchRequest(
  method: string,
  path: string,
): boolean {
  return (
    method.toUpperCase() === "GET"
    && /^\/ps\/plugins\/search\/?(?:[?#].*)?$/i.test(path)
  )
}

export function isCodexPluginCategoryRequest(
  method: string,
  path: string,
): boolean {
  return (
    method.toUpperCase() === "GET"
    && /^\/ps\/plugin-categories\/[^/?#]+\/plugins\/?(?:[?#].*)?$/i.test(path)
  )
}

/**
 * Replace the private Google model/action segment with the registered route
 * template while retaining safe surrounding diagnostics such as method and
 * query parameters.
 */
export function sanitizeRequestDiagnosticReference(
  method: string,
  value: string,
): string {
  const templated =
    method.toUpperCase() === "POST" ?
      value.replaceAll(
        GOOGLE_MODEL_ROUTE_REFERENCE,
        (match, prefix: string, segment: string) =>
          isGoogleModelActionRequest(method, `${prefix}${segment}`) ?
            `${prefix}:modelAction`
          : match,
      )
    : value
  return redactSensitiveQueryParameters(templated)
}

export function isGoogleModelActionPath(value: string): boolean {
  return GOOGLE_MODEL_ACTION_PATH.test(value)
}

export function isGoogleModelActionRequest(
  method: string,
  path: string,
): boolean {
  if (method.toUpperCase() !== "POST" || !isGoogleModelActionPath(path)) {
    return false
  }
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/$/, "")
  const segment = pathname.slice(pathname.lastIndexOf("/") + 1)
  return segment.includes(":") || !["intent", "session"].includes(segment)
}

/**
 * Unknown actions and paths that cannot reach the mounted Google handler must
 * be classified before debug logging considers cloning or reading the body.
 */
export function isCredentialControlRequest(reference: string): boolean {
  const path = reference
    .replace(/^[A-Z]+\s+/, "")
    .replace(/^https?:\/\/[^/]+/, "")
  return /^\/dashboard\/(?:auth(?:[/?#]|$)|api\/(?:credentials|custom-providers)(?:[/?#]|$))/.test(
    path,
  )
}

export function shouldOmitRequestBodyFromDiagnostics(path: string): boolean {
  if (isCredentialControlRequest(path)) return true
  if (/^\/v1\/audio\/transcriptions\/?(?:[?#]|$)/.test(path)) return true
  if (/^\/v1\/codex\/auth\/refresh\/?(?:[?#]|$)/.test(path)) return true
  if (!isGoogleModelActionPath(path)) return false
  return !SUPPORTED_GOOGLE_MODEL_ACTION_PATH.test(path)
}
