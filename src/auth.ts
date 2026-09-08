#!/usr/bin/env node

import { defineCommand } from "citty"
import { createConsola } from "consola"
import { createInterface } from "node:readline"

import {
  getAccountsService,
  createAccountMutationContext,
} from "./lib/accounts-service"
import {
  DEFAULT_GITHUB_DOMAIN,
  normalizeGitHubDomain,
} from "./lib/github-instance"
import {
  initializeStorageRuntime,
  closeStorageRuntime,
} from "./lib/storage/runtime"
import { loginViaWebFlow } from "./services/github/auth-flow"
import { getDeviceCode } from "./services/github/get-device-code"
import { pollAccessToken } from "./services/github/poll-access-token"

const authLogger = createConsola({
  stderr: process.stderr,
  stdout: process.stderr,
})

export interface RunAuthOptions {
  deviceCode: boolean
  host?: string
  verbose: boolean
  webFlow: boolean
}

export interface AuthTextPrompt {
  close: () => void
  question: (message: string) => Promise<string>
  write: (message: string) => void
}

interface AuthTextPromptStreams {
  input?: NodeJS.ReadableStream
  output?: Pick<NodeJS.WritableStream, "write">
}

interface NumberedChoice<T extends string> {
  label: string
  value: T
}

export function createAuthTextPrompt(
  streams: AuthTextPromptStreams = {},
): AuthTextPrompt {
  const input = streams.input ?? process.stdin
  const output = streams.output ?? process.stderr
  const lineReader = createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  })
  const lines = lineReader[Symbol.asyncIterator]()

  return {
    close() {
      lineReader.close()
    },
    async question(message) {
      output.write(message)
      const result = await lines.next()
      if (result.done) throw new Error("Authentication cancelled")
      return result.value.trim()
    },
    write(message) {
      output.write(message)
    },
  }
}

export async function promptNumberedChoice<T extends string>(
  prompt: AuthTextPrompt,
  message: string,
  choices: Array<NumberedChoice<T>>,
): Promise<T> {
  prompt.write(`${message}\n`)
  for (const [index, choice] of choices.entries()) {
    prompt.write(`  ${index + 1}. ${choice.label}\n`)
  }

  while (true) {
    const answer = await prompt.question(`Enter 1-${choices.length}: `)
    for (const [index, choice] of choices.entries()) {
      if (answer === String(index + 1)) return choice.value
    }
    prompt.write(`Please enter a number from 1 to ${choices.length}.\n`)
  }
}

function prefersLoopbackWebFlow(): boolean {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false
  const remoteMarkers = [
    process.env.SSH_CONNECTION,
    process.env.SSH_CLIENT,
    process.env.SSH_TTY,
    process.env.CODESPACES,
    process.env.REMOTE_CONTAINERS,
    process.env.CI,
  ]
  return remoteMarkers.every((marker) => !marker)
}

export async function selectInstanceDomain(
  host?: string,
  prompt?: AuthTextPrompt,
): Promise<string> {
  if (host) return normalizeGitHubDomain(host)
  if (!prompt) throw new Error("Authentication prompt is unavailable")

  const account = await promptNumberedChoice(
    prompt,
    "What account do you want to log into?",
    [
      { label: "GitHub.com", value: "github.com" },
      {
        label: "GitHub Enterprise Cloud (*.ghe.com)",
        value: "enterprise",
      },
    ],
  )
  if (account === "github.com") return DEFAULT_GITHUB_DOMAIN

  const enterpriseHost = await prompt.question(
    "Enter your GitHub Enterprise instance domain (for example, msft.ghe.com): ",
  )
  if (!enterpriseHost) throw new Error("Authentication cancelled")
  return normalizeGitHubDomain(enterpriseHost)
}

export async function selectAuthMethod(
  options: RunAuthOptions,
  prompt?: AuthTextPrompt,
  preferWebFlow = prefersLoopbackWebFlow(),
): Promise<"device" | "web"> {
  if (options.deviceCode) return "device"
  if (options.webFlow) return "web"
  if (!prompt) throw new Error("Authentication prompt is unavailable")

  const web: NumberedChoice<"web"> = {
    label: "Sign in with your browser",
    value: "web",
  }
  const device: NumberedChoice<"device"> = {
    label: "Sign in with a device code",
    value: "device",
  }
  const optionsList = preferWebFlow ? [web, device] : [device, web]
  optionsList[0] = {
    ...optionsList[0],
    label: `${optionsList[0]?.label} (recommended)`,
  }

  return await promptNumberedChoice(
    prompt,
    "How do you want to sign in?",
    optionsList,
  )
}

async function deviceCodeLogin(instanceDomain: string): Promise<string> {
  authLogger.start("Requesting device code from GitHub...")
  const response = await getDeviceCode(instanceDomain)
  authLogger.box(
    `Open ${response.verification_uri}\nand enter code: ${response.user_code}`,
  )
  authLogger.start("Waiting for authorization...")
  return await pollAccessToken(response, instanceDomain)
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    authLogger.level = 5
    authLogger.info("Verbose logging enabled")
  }

  const requiresPrompt =
    !options.host || (!options.deviceCode && !options.webFlow)
  const prompt = requiresPrompt ? createAuthTextPrompt() : undefined
  let instanceDomain: string
  let method: "device" | "web"
  try {
    instanceDomain = await selectInstanceDomain(options.host, prompt)
    method = await selectAuthMethod(options, prompt)
  } finally {
    prompt?.close()
  }
  const token =
    method === "device" ?
      await deviceCodeLogin(instanceDomain)
    : await loginViaWebFlow(instanceDomain, (url) => {
        authLogger.info("Opening GitHub authorization in your browser...")
        authLogger.info(`If the browser does not open, visit: ${url}`)
      })
  const runtime = await initializeStorageRuntime()
  try {
    const service = getAccountsService()
    const input = { token, instanceDomain }
    const context = await createAccountMutationContext(
      runtime.storage,
      "account.create",
      input,
      "owner:cli",
    )
    const created = await service.create(input, context)
    authLogger.success(
      `Saved account #${created.value.id} (${created.value.login ?? "GitHub"} on ${instanceDomain}) to ${runtime.config.kind}`,
    )
  } finally {
    await closeStorageRuntime()
  }
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub auth flow without running the server",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    host: {
      type: "string",
      description: "GitHub.com or a GitHub Enterprise Cloud *.ghe.com host",
    },
    "device-code": {
      type: "boolean",
      default: false,
      description: "Use the GitHub device code flow",
    },
    "web-flow": {
      type: "boolean",
      default: false,
      description: "Use the browser OAuth flow with a loopback callback",
    },
  },
  run({ args }) {
    if (args["device-code"] && args["web-flow"]) {
      throw new Error("--device-code and --web-flow cannot be used together")
    }
    return runAuth({
      deviceCode: args["device-code"],
      host: args.host,
      verbose: args.verbose,
      webFlow: args["web-flow"],
    })
  },
})
