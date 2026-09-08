#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import invariant from "tiny-invariant"

import { resolveApiKeyAuth } from "~/lib/api-key-auth-config"

import packageJson from "../package.json" with { type: "json" }
import { getAccountsService } from "./lib/accounts-service"
import { initializeAdminAuth } from "./lib/admin-auth"
import { mergeConfigWithDefaults } from "./lib/config"
import { resolveRequestCredential } from "./lib/credential-resolver"
import { ensureModelRoutingOverridesLoaded } from "./lib/model-routing"
import { ensureModelSettingsLoaded } from "./lib/model-settings"
import { generateVirtualModels } from "./lib/model-suffix"
import { resolveProtectedCredential } from "./lib/protected-credential"
import { initProxyFromEnv } from "./lib/proxy"
import { initSentry } from "./lib/sentry"
import { generateEnvScript } from "./lib/shell"
import { installShutdown } from "./lib/shutdown"
import { state } from "./lib/state"
import { initializeStorageRuntime } from "./lib/storage/runtime"
import { createHistoryRuntime } from "./lib/telemetry-writer"
import { tokenPool } from "./lib/token-pool"
import { isDirectConnectEnabled } from "./routes/direct-connect/route"
import {
  DIRECT_CONNECT_WS_PATH,
  getDirectConnectSession,
  handleDirectConnectWebSocket,
} from "./routes/direct-connect/ws-handler"
import { remoteWebSocket } from "./routes/remote/websocket"
import { tryUpgradeRemoteWebSocket } from "./routes/remote/ws-security"
import {
  tryUpgradeResponsesWebSocket,
  responsesWebSocket,
} from "./routes/responses/websocket"
import { tryUpgradeVoiceWebSocket, voiceWebSocket } from "./routes/voice/route"
import { server } from "./server"
import { resolveCopilotIntegrationId } from "./services/copilot/copilot-contract"
import { getVSCodeVersion } from "./services/get-vscode-version"

async function cacheVSCodeVersion(): Promise<void> {
  state.vsCodeVersion = await getVSCodeVersion()
  consola.info(`Editor version: vscode/${state.vsCodeVersion}`)
}

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  insecure: boolean
  debug: boolean
  apiKeyAuth?: string
  host?: string
}

function getAllModelIds(): Array<string> {
  const baseModelIds = state.models?.data.map((model) => model.id) ?? []
  const virtualModelIds =
    state.models ?
      generateVirtualModels(state.models.data).map((model) => model.id)
    : []
  return [...baseModelIds, ...virtualModelIds]
}

async function promptClaudeCodeSetup(
  serverUrl: string,
  allModelIds: Array<string>,
): Promise<void> {
  invariant(state.models, "Models should be loaded by now")

  const selectedModel = await consola.prompt(
    "Select a model to use with Claude Code",
    {
      type: "select",
      options: allModelIds,
    },
  )

  const selectedSmallModel = await consola.prompt(
    "Select a small model to use with Claude Code",
    {
      type: "select",
      options: allModelIds,
    },
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

/** Load the durable registry; upstream health never blocks the dashboard. */
async function initializeTokens(options: RunServerOptions): Promise<void> {
  if (options.githubToken)
    throw new Error(
      "--github-token is no longer a runtime credential source. Add the account in the dashboard or import legacy configuration.",
    )
  await getAccountsService().refreshRuntime()
  state.isMultiToken = tokenPool.getAllAccounts().length > 1
  state.models = tokenPool.getAllModels()
  state.githubToken = undefined
  state.copilotToken = undefined
  void cacheVSCodeVersion().catch(() =>
    consola.warn("Could not refresh client version metadata"),
  )
}
async function initializePersistentConfig(): Promise<void> {
  await mergeConfigWithDefaults()
  await ensureModelSettingsLoaded()
  await ensureModelRoutingOverridesLoaded()
}

export async function isDirectConnectUpgradeAuthorized(
  request: Request,
): Promise<"authorized" | "blocked" | "disabled" | "unauthorized"> {
  if (!isDirectConnectEnabled()) return "disabled"
  const auth = await resolveProtectedCredential(
    request,
    async () => await resolveRequestCredential(request, ["user:inference"]),
    { trustClientIp: true },
  )
  if (auth.status === "authorized") return "authorized"
  return auth.status === "blocked" ? "blocked" : "unauthorized"
}

function setTrustedPeerIp(
  request: Request,
  bunServer: { requestIP(req: Request): { address: string } | null },
): void {
  const peerIp = bunServer.requestIP(request)?.address
  request.headers.delete("x-copilot-peer-ip")
  if (peerIp) request.headers.set("x-copilot-peer-ip", peerIp)
}

interface StartFetchServer {
  requestIP(req: Request): { address: string } | null
  upgrade(req: Request, options?: object): boolean
}

// Upgrade dispatch covers four independently secured WebSocket protocols.

export async function handleStartFetch(
  req: Request,
  bunServer: StartFetchServer,
): Promise<Response> {
  // Never trust this internal header from a client. Derive it from Bun's
  // socket peer for HTTP and WebSocket requests alike.
  setTrustedPeerIp(req, bunServer)
  // WebSocket upgrade must happen before Hono routing
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const voiceResult = await tryUpgradeVoiceWebSocket(req, bunServer)
    if (voiceResult === "upgraded") {
      return undefined as unknown as Response
    }
    if (voiceResult === "auth_failed") {
      return new Response("Unauthorized", { status: 401 })
    }
    const wsResult = await tryUpgradeResponsesWebSocket(req, bunServer)
    if (wsResult === "upgraded") {
      return undefined as unknown as Response
    }
    if (wsResult === "auth_failed") {
      return new Response("Unauthorized", { status: 401 })
    }
    // Direct Connect WebSocket upgrade
    const url = new URL(req.url)
    if (url.pathname.startsWith(DIRECT_CONNECT_WS_PATH + "/")) {
      const directConnectAuth = await isDirectConnectUpgradeAuthorized(req)
      if (
        directConnectAuth === "blocked"
        || directConnectAuth === "unauthorized"
      ) {
        return new Response("Unauthorized", { status: 401 })
      }
      if (directConnectAuth !== "authorized") {
        return new Response("Not Found", { status: 404 })
      }
      const sessionId = url.pathname.slice(DIRECT_CONNECT_WS_PATH.length + 1)
      if (sessionId && getDirectConnectSession(sessionId)) {
        const upgraded = bunServer.upgrade(req, {
          data: {
            type: "direct-connect" as const,
            sessionId,
          },
        })
        if (upgraded) return undefined as unknown as Response
      }
      return new Response("Not Found", { status: 404 })
    }
    const remoteResult = await tryUpgradeRemoteWebSocket(req, bunServer)
    if (remoteResult === "upgraded") {
      return undefined as unknown as Response
    }
    if (remoteResult === "auth_failed") {
      return new Response("Unauthorized", { status: 401 })
    }
  }
  return server.fetch(req)
}

// Combined WebSocket handler that dispatches by the authenticated connection type.
const combinedWebSocket = {
  open(ws: { data: { type: string; sessionId?: string } }) {
    switch (ws.data.type) {
      case "voice": {
        voiceWebSocket.open(
          ws as unknown as Parameters<typeof voiceWebSocket.open>[0],
        )

        break
      }
      case "responses": {
        responsesWebSocket.open(
          ws as unknown as Parameters<typeof responsesWebSocket.open>[0],
        )

        break
      }
      case "direct-connect": {
        const dcWs = ws as {
          data: {
            type: string
            sessionId: string
            dcHandlers?: {
              onMessage: (message: string | Buffer | Uint8Array) => void
              onClose: () => void
            }
          }
          send(data: string | ArrayBuffer | Uint8Array): void
          close(code?: number, reason?: string): void
        }
        const handlers = handleDirectConnectWebSocket(dcWs, dcWs.data.sessionId)
        dcWs.data.dcHandlers = handlers

        break
      }
      case "remote-control": {
        remoteWebSocket.open(
          ws as unknown as Parameters<typeof remoteWebSocket.open>[0],
        )

        break
      }
      // No default
    }
  },
  message(
    ws: {
      data: { type: string; sessionId?: string }
      send: (data: string | ArrayBuffer | Uint8Array) => void
      close: (code?: number, reason?: string) => void
    },
    message: string | Buffer | Uint8Array,
  ) {
    switch (ws.data.type) {
      case "voice": {
        voiceWebSocket.message(
          ws as unknown as Parameters<typeof voiceWebSocket.message>[0],
          message,
        )

        break
      }
      case "responses": {
        void responsesWebSocket.message(
          ws as unknown as Parameters<typeof responsesWebSocket.message>[0],
          message,
        )

        break
      }
      case "direct-connect": {
        const dcWs = ws as {
          data: {
            type: string
            dcHandlers?: {
              onMessage: (message: string | Buffer | Uint8Array) => void
              onClose: () => void
            }
          }
        }
        dcWs.data.dcHandlers?.onMessage(message)

        break
      }
      case "remote-control": {
        remoteWebSocket.message(
          ws as unknown as Parameters<typeof remoteWebSocket.message>[0],
          message,
        )

        break
      }
      // No default
    }
  },
  close(ws: { data: { type: string; sessionId?: string } }) {
    switch (ws.data.type) {
      case "voice": {
        voiceWebSocket.close(
          ws as unknown as Parameters<typeof voiceWebSocket.close>[0],
        )

        break
      }
      case "responses": {
        responsesWebSocket.close(
          ws as unknown as Parameters<typeof responsesWebSocket.close>[0],
        )

        break
      }
      case "direct-connect": {
        const dcWs = ws as {
          data: {
            type: string
            dcHandlers?: {
              onMessage: (message: string | Buffer | Uint8Array) => void
              onClose: () => void
            }
          }
        }
        dcWs.data.dcHandlers?.onClose()

        break
      }
      case "remote-control": {
        remoteWebSocket.close(
          ws as unknown as Parameters<typeof remoteWebSocket.close>[0],
        )

        break
      }
      // No default
    }
  },
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const storageRuntime = await initializeStorageRuntime()
  await mergeConfigWithDefaults()
  await createHistoryRuntime(storageRuntime.storage)
  await initializeAdminAuth()
  initSentry()

  consola.info(`copilot-api v${packageJson.version}`)

  if (options.insecure) {
    // Disable SSL certificate verification globally
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    consola.warn("SSL certificate verification disabled (insecure mode)")
  }

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.showToken = options.showToken
  state.debug = options.debug
  state.verbose = options.verbose
  state.apiKeyAuth = options.apiKeyAuth
  state.copilotIntegrationId = resolveCopilotIntegrationId(
    process.env.COPILOT_INTEGRATION_ID,
  )

  if (options.apiKeyAuth)
    consola.info(
      "API key authentication enabled - unauthorized requests receive a bounded denial",
    )
  if (options.host) consola.info(`Binding to host: ${options.host}`)

  if (options.debug) {
    consola.info("Debug mode enabled - raw HTTP requests will be logged")
  }

  await initializePersistentConfig()

  await initializeTokens(options)

  const allModelIds = getAllModelIds()

  consola.info(
    `Available models: \n${allModelIds.map((id) => `- ${id}`).join("\n")}`,
  )

  const serverUrl = `http://${options.host ?? "localhost"}:${options.port}`

  if (options.claudeCode) {
    await promptClaudeCodeSetup(serverUrl, allModelIds)
  }

  consola.box(`🌐 Operator Dashboard: ${serverUrl}/dashboard`)

  const runningServer = Bun.serve({
    port: options.port,
    hostname: options.host,
    idleTimeout: 0,
    fetch: handleStartFetch,
    websocket: combinedWebSocket,
  })

  const host = options.host ?? "localhost"
  consola.info(`Listening on: http://${host}:${options.port}/`)

  installShutdown(() => {
    void runningServer.stop(false)
  })
}

function resolveStartupApiKeyAuth(
  cliValue: string | undefined,
): string | undefined {
  try {
    return resolveApiKeyAuth(cliValue, process.env.COPILOT_API_KEY_AUTH)
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide instance_domain:token or a bare GitHub.com token directly",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show the GitHub/Copilot OAuth credential during setup",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    insecure: {
      type: "boolean",
      default: false,
      description:
        "Disable SSL certificate verification (for corporate proxies with self-signed certs)",
    },
    debug: {
      alias: "d",
      type: "boolean",
      default: false,
      description:
        "Log raw HTTP requests received by the server (headers, method, path)",
    },
    "api-key-auth": {
      type: "string",
      description:
        "API key for incoming request authentication. Mismatched keys receive a bounded denial.",
    },
    host: {
      type: "string",
      description:
        "Hostname/IP to bind the server to (e.g., 0.0.0.0 for all interfaces)",
    },
  },
  run({ args }) {
    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      insecure: args.insecure,
      debug: args.debug,
      apiKeyAuth: resolveStartupApiKeyAuth(args["api-key-auth"]),
      host: args.host,
    })
  },
})
