import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"

import type { AzureOpenAIConfig } from "./types"

export const AZURE_OPENAI_MODEL_PREFIX = "azure_openai_"

export async function loadAzureOpenAIConfig(): Promise<AzureOpenAIConfig | null> {
  try {
    const content = await fs.readFile(PATHS.AZURE_OPENAI_CONFIG_PATH, "utf8")
    if (!content.trim()) {
      return null
    }

    const decoded = Buffer.from(content.trim(), "base64").toString("utf8")
    const config = JSON.parse(decoded) as AzureOpenAIConfig

    if (!config.endpoint || !config.apiKey) {
      return null
    }

    return config
  } catch {
    return null
  }
}

export async function saveAzureOpenAIConfig(
  config: AzureOpenAIConfig,
): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
  await fs.writeFile(PATHS.AZURE_OPENAI_CONFIG_PATH, encoded, "utf8")
  await fs.chmod(PATHS.AZURE_OPENAI_CONFIG_PATH, 0o600)
  consola.success("Azure OpenAI configuration saved")
}

export async function promptAzureOpenAISetup(): Promise<AzureOpenAIConfig | null> {
  const wantToAdd = await consola.prompt(
    "Would you like to add a custom Azure OpenAI endpoint?",
    {
      type: "confirm",
      initial: false,
    },
  )

  if (!wantToAdd) {
    return null
  }

  const endpoint = await consola.prompt(
    "Enter your Azure OpenAI endpoint URL (e.g., https://your-resource.openai.azure.com):",
    {
      type: "text",
    },
  )

  if (!endpoint || typeof endpoint !== "string" || !endpoint.trim()) {
    consola.warn("No endpoint provided, skipping Azure OpenAI setup")
    return null
  }

  const apiKey = await consola.prompt("Enter your Azure OpenAI API key:", {
    type: "text",
  })

  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    consola.warn("No API key provided, skipping Azure OpenAI setup")
    return null
  }

  const config: AzureOpenAIConfig = {
    endpoint: endpoint.trim().replace(/\/$/, ""), // Remove trailing slash
    apiKey: apiKey.trim(),
  }

  await saveAzureOpenAIConfig(config)
  return config
}

export function isAzureOpenAIModel(modelId: string): boolean {
  return modelId.startsWith(AZURE_OPENAI_MODEL_PREFIX)
}

export function getAzureDeploymentName(modelId: string): string {
  return modelId.slice(AZURE_OPENAI_MODEL_PREFIX.length)
}
