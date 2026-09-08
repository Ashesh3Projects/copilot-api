import consola from "consola"
import { createHash, randomUUID } from "node:crypto"

import type { Account } from "~/lib/token-pool"

import {
  getLeasedAccount,
  leaseAccount,
  unavailableAccount,
  withAccountLeaseScope,
} from "~/lib/account-lease-context"
import { getLastUsedAccountId } from "~/lib/account-router"
import { getAccountsService } from "~/lib/accounts-service"
import {
  getClientSessionId,
  setLastUsedRoutedAccountId,
} from "~/lib/request-session"
import { state } from "~/lib/state"
import { getRequestSnapshot } from "~/lib/storage/request-snapshot"
import { peekStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { copilotBaseUrl } from "~/services/copilot/copilot-client"
import { createCopilotTransportInit } from "~/services/copilot/transport-options"

// --- MCP Session State ---

interface McpSessionState {
  id: string | null
  promise: Promise<string> | null
}

const mcpSessions = new Map<string, McpSessionState>()

// --- JSON-RPC Helpers ---

interface JsonRpcRequest {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
  id: string | number
}

interface McpTextContent {
  type: "text"
  text: string
}

interface McpToolResult {
  content: Array<McpTextContent | Record<string, unknown>>
  isError?: boolean
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  result?: McpToolResult
  error?: { code: number; message: string; data?: unknown }
  id: string | number
}

const MCP_PATH = "/mcp/readonly"
const MCP_PROTOCOL_VERSION = "2025-03-26"
const MCP_WEB_SEARCH_TOOL = "web_search"
const MCP_SESSION_RETRY_STATUSES = new Set([401, 403, 404])

interface McpCredentials {
  baseUrl: string
  cacheKey: string
  githubToken: string
}

interface McpFetchOptions {
  credentials: McpCredentials
  sessionId: string | null
  signal?: AbortSignal
}

export interface WebSearchExecutionOptions {
  modelId?: string
  sessionId?: string
}

export interface WebSearchToolOptions {
  allowedDomains?: Array<string>
  blockedDomains?: Array<string>
  searchContextSize?: string
  userLocation?: Record<string, unknown>
}

function previousMcpAccount(databaseAccounts: boolean): Account | undefined {
  const routedAccountId = getLastUsedAccountId()
  if (routedAccountId === undefined) return undefined
  const account =
    getLeasedAccount(routedAccountId)
    ?? tokenPool.getAllAccounts().find((item) => item.id === routedAccountId)
  if (databaseAccounts && !account) throw unavailableAccount()
  return account
}

function selectMcpAccount(
  options: WebSearchExecutionOptions,
): Account | undefined {
  const account =
    options.modelId ?
      tokenPool.getAccountForModelBySession(
        options.modelId,
        options.sessionId ?? getClientSessionId(),
      )
    : undefined
  if (!account && options.modelId && tokenPool.hasKnownModel(options.modelId)) {
    throw new Error(
      `No enabled account is available for model "${options.modelId}"`,
    )
  }
  return account ?? tokenPool.getFirstHealthyAccount()
}

const getMcpCredentials = (
  options: WebSearchExecutionOptions,
): McpCredentials => {
  const databaseAccounts = peekStorageRuntime() !== undefined
  let account = previousMcpAccount(databaseAccounts)
  if (!account && (state.isMultiToken || databaseAccounts))
    account = selectMcpAccount(options)
  if (databaseAccounts) {
    if (!account) throw unavailableAccount()
    account = leaseAccount(account)
  }
  if (account) setLastUsedRoutedAccountId(account.id)
  const githubToken = account?.githubToken ?? state.githubToken
  if (!githubToken) {
    throw new Error("GitHub token is not set. Cannot call MCP endpoint.")
  }

  return {
    githubToken,
    baseUrl: account ? tokenPool.getBaseUrl(account) : copilotBaseUrl(),
    cacheKey: account ? mcpCredentialCacheKey(account) : "default",
  }
}

function mcpCredentialCacheKey(account: Account): string {
  const credential = createHash("sha256")
    .update(JSON.stringify([account.githubInstanceDomain, account.githubToken]))
    .digest("hex")
  return `account:${account.id}:${account.credentialRevision ?? 0}:${credential}`
}

const getSessionState = (cacheKey: string): McpSessionState => {
  let session = mcpSessions.get(cacheKey)
  if (!session) {
    session = { id: null, promise: null }
    mcpSessions.set(cacheKey, session)
  }
  return session
}

const mcpHeaders = (
  credentials: McpCredentials,
  sessionId?: string | null,
): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    Authorization: `Bearer ${credentials.githubToken}`,
    "X-MCP-Host": "copilot-cli",
    "X-MCP-Tools": MCP_WEB_SEARCH_TOOL,
  }

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId
  }

  return headers
}

const mcpFetch = async (
  body: JsonRpcRequest,
  options: McpFetchOptions,
): Promise<Response> => {
  const url = `${options.credentials.baseUrl}${MCP_PATH}`
  return fetch(
    url,
    createCopilotTransportInit({
      method: "POST",
      headers: mcpHeaders(options.credentials, options.sessionId),
      body: JSON.stringify(body),
      signal: options.signal,
    }),
  )
}

/**
 * Parse response body as JSON, handling both direct JSON and SSE (text/event-stream)
 * responses. MCP Streamable HTTP transport may return either format.
 */
const parseResponseBody = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get("content-type") ?? ""

  if (contentType.includes("text/event-stream")) {
    // Parse SSE: extract JSON-RPC messages from `data:` lines
    const text = await response.text()
    const lines = text.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue

      const data = trimmed.slice(5).trim()
      if (!data || data === "[DONE]") continue

      try {
        return JSON.parse(data)
      } catch {
        // Try next data line
      }
    }

    throw new Error("No valid JSON-RPC message found in SSE response")
  }

  return response.json()
}

// --- MCP Session Initialization ---

const initializeSession = async (
  credentials: McpCredentials,
): Promise<string> => {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "copilot-api",
        version: "1.0.0",
      },
    },
    id: randomUUID(),
  }

  const response = await mcpFetch(request, {
    credentials,
    sessionId: null,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`MCP initialize failed: ${response.status} ${errorText}`)
  }

  // Extract session ID from response header
  const sessionId = response.headers.get("Mcp-Session-Id")

  // Consume the response body to close the connection
  await parseResponseBody(response).catch(() => {})

  if (!sessionId) {
    throw new Error("MCP initialize response missing Mcp-Session-Id header")
  }

  consola.debug("MCP session initialized:", sessionId)
  return sessionId
}

/**
 * Ensure an MCP session exists. Serializes concurrent callers so only one
 * initialization request is made, and all callers receive the same session ID.
 */
const ensureSession = async (credentials: McpCredentials): Promise<string> => {
  const session = getSessionState(credentials.cacheKey)
  if (session.id) {
    return session.id
  }

  if (session.promise) {
    return session.promise
  }

  session.promise = initializeSession(credentials)
    .then((id) => {
      session.id = id
      session.promise = null
      return id
    })
    .catch((error: unknown) => {
      session.promise = null
      throw error
    })

  return session.promise
}

/**
 * Invalidate the current MCP session, but only if the caller's session matches
 * the current global one. This prevents a stale caller from resetting a
 * freshly-initialized session obtained by another concurrent call.
 */
const invalidateSession = (
  credentials: McpCredentials,
  callerSessionId: string,
): void => {
  const session = getSessionState(credentials.cacheKey)
  if (session.id === callerSessionId) {
    session.id = null
  }
}

// --- Web Search Execution ---

export const executeWebSearch = async (
  query: string,
  signal?: AbortSignal,
  options: WebSearchExecutionOptions = {},
): Promise<string> => {
  if (peekStorageRuntime() && !getRequestSnapshot())
    await getAccountsService().refreshRuntime()
  return withAccountLeaseScope(signal, () =>
    executeWebSearchTurn(query, signal, options),
  )
}

const executeWebSearchTurn = async (
  query: string,
  signal: AbortSignal | undefined,
  options: WebSearchExecutionOptions,
): Promise<string> => {
  try {
    signal?.throwIfAborted()
    const credentials = getMcpCredentials(options)
    // Capture session ID locally so concurrent calls don't interfere
    const sessionId = await ensureSession(credentials)

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: MCP_WEB_SEARCH_TOOL,
        arguments: { query },
      },
      id: randomUUID(),
    }

    const response = await mcpFetch(request, {
      credentials,
      sessionId,
      signal,
    })

    if (!response.ok) {
      // Session may have expired — invalidate and retry once
      if (MCP_SESSION_RETRY_STATUSES.has(response.status)) {
        consola.warn("MCP session expired, re-initializing")
        invalidateSession(credentials, sessionId)
        const newSessionId = await ensureSession(credentials)

        const retryResponse = await mcpFetch(request, {
          credentials,
          sessionId: newSessionId,
          signal,
        })
        if (!retryResponse.ok) {
          const errorText = await retryResponse.text()
          consola.error("MCP web_search retry failed:", errorText)
          return `Web search failed: ${retryResponse.status}`
        }
        return parseSearchResponse(await parseResponseBody(retryResponse))
      }

      const errorText = await response.text()
      consola.error("MCP web_search failed:", errorText)
      return `Web search failed: ${response.status}`
    }

    return parseSearchResponse(await parseResponseBody(response))
  } catch (error: unknown) {
    if (
      signal?.aborted
      || (error instanceof Error && error.name === "AbortError")
    ) {
      throw error
    }
    const message = error instanceof Error ? error.message : "Unknown MCP error"
    consola.error("MCP web search error:", message)
    // Reset sessions on transport/protocol errors so the next attempt re-initializes.
    mcpSessions.clear()
    return `Web search failed: ${message}`
  }
}

const parseSearchResponse = (json: unknown): string => {
  const rpcResponse = json as JsonRpcResponse

  if (rpcResponse.error) {
    consola.warn("MCP web_search returned error:", rpcResponse.error)
    return `Web search error: ${rpcResponse.error.message}`
  }

  if (!rpcResponse.result?.content) {
    return "No search results found."
  }

  const textParts = rpcResponse.result.content
    .filter((c): c is McpTextContent => c.type === "text" && "text" in c)
    .map((c) => c.text)

  if (textParts.length === 0) {
    return "No search results found."
  }

  const text = textParts.join("\n\n")
  return rpcResponse.result.isError ? `Web search error: ${text}` : text
}

// --- Web Search Tool Definition ---

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const stringArray = (value: unknown): Array<string> | undefined => {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  )
  return strings.length > 0 ? strings : undefined
}

const firstStringArray = (
  values: Array<unknown>,
): Array<string> | undefined => {
  for (const value of values) {
    const strings = stringArray(value)
    if (strings) return strings
  }
  return undefined
}

const getFunctionParameters = (
  tool: unknown,
): Record<string, unknown> | undefined => {
  if (!isRecord(tool)) return undefined
  const definition = isRecord(tool.function) ? tool.function : tool
  if (isRecord(definition.parameters)) return definition.parameters
  return isRecord(definition.input_schema) ? definition.input_schema : undefined
}

const getDefaultDomains = (
  parameters: Record<string, unknown> | undefined,
  name: "allowed_domains" | "blocked_domains",
): Array<string> | undefined => {
  if (!parameters || !isRecord(parameters.properties)) return undefined
  const property = parameters.properties[name]
  return isRecord(property) ? stringArray(property.default) : undefined
}

export const getWebSearchToolOptions = (
  tool: unknown,
): WebSearchToolOptions => {
  if (!isRecord(tool)) return {}

  const filters = isRecord(tool.filters) ? tool.filters : undefined
  const parameters = getFunctionParameters(tool)
  const allowedDomains =
    firstStringArray([
      tool.allowed_domains,
      tool.allowedDomains,
      filters?.allowed_domains,
      filters?.allowedDomains,
    ]) ?? getDefaultDomains(parameters, "allowed_domains")
  const blockedDomains =
    firstStringArray([
      tool.blocked_domains,
      tool.blockedDomains,
      tool.exclude_domains,
      tool.excludeDomains,
      filters?.blocked_domains,
      filters?.blockedDomains,
    ]) ?? getDefaultDomains(parameters, "blocked_domains")
  const userLocation =
    isRecord(tool.user_location) ? tool.user_location : undefined
  const searchContextSize =
    typeof tool.search_context_size === "string" ?
      tool.search_context_size
    : undefined

  return {
    ...(allowedDomains ? { allowedDomains } : {}),
    ...(blockedDomains ? { blockedDomains } : {}),
    ...(userLocation ? { userLocation } : {}),
    ...(searchContextSize ? { searchContextSize } : {}),
  }
}

const describeWebSearch = (options: WebSearchToolOptions): string => {
  const constraints: Array<string> = []
  if (options.allowedDomains) {
    constraints.push(
      `Only use these domains: ${options.allowedDomains.join(", ")}.`,
    )
  }
  if (options.blockedDomains) {
    constraints.push(
      `Do not use these domains: ${options.blockedDomains.join(", ")}.`,
    )
  }
  if (options.userLocation) {
    constraints.push(
      `Use this approximate user location when relevant: ${JSON.stringify(options.userLocation)}.`,
    )
  }

  return [
    "Search the web for current information. Always include the source URLs as markdown hyperlinks in the answer.",
    ...constraints,
  ].join(" ")
}

const createWebSearchParameters = (
  options: WebSearchToolOptions,
): Record<string, unknown> => {
  const properties: Record<string, unknown> = {
    query: {
      type: "string",
      description: "A clear, standalone natural-language search request",
    },
  }

  if (options.allowedDomains) {
    properties.allowed_domains = {
      type: "array",
      items: { type: "string" },
      default: options.allowedDomains,
      description: "Domains the caller requires the search to use",
    }
  }
  if (options.blockedDomains) {
    properties.blocked_domains = {
      type: "array",
      items: { type: "string" },
      default: options.blockedDomains,
      description: "Domains the caller requires the search to avoid",
    }
  }

  return {
    type: "object",
    properties,
    required: ["query"],
  }
}

export const createWebSearchFunctionTool = (tool?: unknown) => {
  const options = getWebSearchToolOptions(tool)
  return {
    type: "function" as const,
    function: {
      name: MCP_WEB_SEARCH_TOOL,
      description: describeWebSearch(options),
      parameters: createWebSearchParameters(options),
    },
  }
}

export const createWebSearchResponsesTool = (tool?: unknown) => {
  const functionTool = createWebSearchFunctionTool(tool).function
  return {
    type: "function" as const,
    name: functionTool.name,
    description: functionTool.description,
    parameters: functionTool.parameters,
    strict: false,
  }
}

export const createHostedWebSearchTool = (
  tool?: unknown,
): Record<string, unknown> | null => {
  const source = isRecord(tool) ? tool : {}
  const options = getWebSearchToolOptions(source)
  // Copilot's hosted Responses schema supports an allowlist but not a
  // blocklist. Keep blocked-domain searches on the MCP-backed function path.
  if (options.blockedDomains) return null

  return {
    type: "web_search",
    ...(typeof source.external_web_access === "boolean" ?
      { external_web_access: source.external_web_access }
    : {}),
    ...(options.allowedDomains ?
      { filters: { allowed_domains: options.allowedDomains } }
    : {}),
    ...(options.userLocation ? { user_location: options.userLocation } : {}),
    ...(options.searchContextSize ?
      { search_context_size: options.searchContextSize }
    : {}),
  }
}

export const createWebSearchAnthropicTool = (tool?: unknown) => {
  const source = isRecord(tool) ? tool : {}
  const functionTool = createWebSearchFunctionTool(tool).function
  const maxUses = source.max_uses
  return {
    name: functionTool.name,
    description: functionTool.description,
    input_schema: functionTool.parameters,
    ...((
      typeof maxUses === "number" && Number.isInteger(maxUses) && maxUses > 0
    ) ?
      { max_uses: maxUses }
    : {}),
  }
}

export const isChatWebSearchFunctionTool = (tool: unknown): boolean =>
  isRecord(tool)
  && tool.type === "function"
  && isRecord(tool.function)
  && tool.function.name === MCP_WEB_SEARCH_TOOL

export const isResponsesWebSearchFunctionTool = (tool: unknown): boolean =>
  isRecord(tool)
  && tool.type === "function"
  && tool.name === MCP_WEB_SEARCH_TOOL

export const buildWebSearchQuery = (
  rawArguments: string,
  functionTool?: unknown,
): string => {
  let query = rawArguments
  let argumentOptions: WebSearchToolOptions = {}
  try {
    const args = JSON.parse(rawArguments) as Record<string, unknown>
    if (typeof args.query === "string" && args.query.length > 0) {
      query = args.query
    }
    argumentOptions = getWebSearchToolOptions(args)
  } catch {
    // Some providers return the query as a bare string. Keep it verbatim.
  }

  const parameters = getFunctionParameters(functionTool)
  const allowedDomains =
    getDefaultDomains(parameters, "allowed_domains")
    ?? argumentOptions.allowedDomains
  const blockedDomains =
    getDefaultDomains(parameters, "blocked_domains")
    ?? argumentOptions.blockedDomains
  const constraints: Array<string> = []
  if (allowedDomains) {
    constraints.push(`Only use sources from: ${allowedDomains.join(", ")}.`)
  }
  if (blockedDomains) {
    constraints.push(`Do not use sources from: ${blockedDomains.join(", ")}.`)
  }

  return constraints.length > 0 ?
      `${query}\n\nSearch constraints: ${constraints.join(" ")}`
    : query
}

// --- Helpers for detecting web_search tool calls ---

export const isWebSearchToolType = (tool: { type?: string }): boolean => {
  return (
    typeof tool.type === "string"
    && /^web_search(?:_[a-z\d]+)*$/.test(tool.type)
  )
}

export const resetWebSearchSessionsForTest = (): void => {
  mcpSessions.clear()
}
