#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import os from "node:os"

import packageJson from "../package.json" with { type: "json" }
import {
  initializeStorageRuntime,
  closeStorageRuntime,
} from "./lib/storage/runtime"
import { hasStoredAccounts } from "./lib/storage/runtime-status"

interface DebugInfo {
  version: string
  runtime: {
    name: string
    version: string
    platform: string
    arch: string
  }
  storage: { kind: string }
  tokenExists: boolean
}

interface RunDebugOptions {
  json: boolean
}

function getRuntimeInfo() {
  const isBun = typeof Bun !== "undefined"

  return {
    name: isBun ? "bun" : "node",
    version: isBun ? Bun.version : process.version.slice(1),
    platform: os.platform(),
    arch: os.arch(),
  }
}

async function getDebugInfo(): Promise<DebugInfo> {
  const runtime = await initializeStorageRuntime()
  try {
    const tokenExists = await hasStoredAccounts(runtime.storage)
    return {
      version: packageJson.version,
      runtime: getRuntimeInfo(),
      storage: { kind: runtime.config.kind },
      tokenExists,
    }
  } finally {
    await closeStorageRuntime()
  }
}
function printDebugInfoPlain(info: DebugInfo): void {
  consola.info(`copilot-api debug

Version: ${info.version}
Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})

Database: ${info.storage.kind}

Token exists: ${info.tokenExists ? "Yes" : "No"}`)
}

function printDebugInfoJson(info: DebugInfo): void {
  console.log(JSON.stringify(info, null, 2))
}

export async function runDebug(options: RunDebugOptions): Promise<void> {
  const debugInfo = await getDebugInfo()

  if (options.json) {
    printDebugInfoJson(debugInfo)
  } else {
    printDebugInfoPlain(debugInfo)
  }
}

export const debug = defineCommand({
  meta: {
    name: "debug",
    description: "Print debug information about the application",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "Output debug information as JSON",
    },
  },
  run({ args }) {
    return runDebug({
      json: args.json,
    })
  },
})
