import type { ModelsResponse } from "~/services/copilot/get-models"

import { HTTPError } from "~/lib/error"
import {
  normalizeCopilotApiBaseUrl,
  resolveCopilotApiBaseUrl,
} from "~/lib/github-instance"
import { copilotHeaders } from "~/services/copilot/copilot-client"
import { createCopilotTransportInit } from "~/services/copilot/transport-options"

import { getCopilotUsage } from "./get-copilot-usage"

export interface ResolvedCopilotOAuth {
  baseUrl: string
  accountSubject?: string
  login?: string
  models: ModelsResponse
  token: string
}

function validateModelsResponse(value: unknown): ModelsResponse {
  if (
    typeof value !== "object"
    || value === null
    || !("object" in value)
    || value.object !== "list"
    || !("data" in value)
    || !Array.isArray(value.data)
    || !value.data.every(
      (model: unknown) =>
        typeof model === "object"
        && model !== null
        && "id" in model
        && typeof model.id === "string"
        && model.id.length > 0,
    )
  ) {
    throw new TypeError("Invalid Copilot models response")
  }
  return value as ModelsResponse
}

async function discoverCopilotOAuth(options: {
  accountType: string
  githubToken: string
  instanceDomain: string
}): Promise<Omit<ResolvedCopilotOAuth, "models">> {
  const copilotUser = await getCopilotUsage(
    options.githubToken,
    options.instanceDomain,
  )
  const discoveredBaseUrl = copilotUser.endpoints?.api
  return {
    baseUrl: resolveCopilotApiBaseUrl(
      options.instanceDomain,
      discoveredBaseUrl,
      options.accountType,
    ),
    login: copilotUser.login,
    accountSubject: copilotUser.analytics_tracking_id,
    token: options.githubToken,
  }
}

export async function rediscoverCopilotOAuthBaseUrl(options: {
  accountType: string
  currentBaseUrl: string
  githubToken: string
  instanceDomain: string
}): Promise<string | undefined> {
  const copilotUser = await getCopilotUsage(
    options.githubToken,
    options.instanceDomain,
  )
  const discoveredBaseUrl = copilotUser.endpoints?.api
  if (!discoveredBaseUrl) return undefined

  const baseUrl = normalizeCopilotApiBaseUrl(
    discoveredBaseUrl,
    options.instanceDomain,
  )
  if (!baseUrl || baseUrl === options.currentBaseUrl) return undefined
  return baseUrl
}

export async function resolveCopilotOAuth(options: {
  accountType: string
  githubToken: string
  instanceDomain: string
  integrationId?: string | null
}): Promise<ResolvedCopilotOAuth> {
  const discovered = await discoverCopilotOAuth(options)
  const response = await fetch(
    `${discovered.baseUrl}/models`,
    createCopilotTransportInit({
      headers: copilotHeaders({
        copilotToken: options.githubToken,
        integrationId: options.integrationId ?? null,
      }),
    }),
  )
  if (!response.ok) {
    throw new HTTPError(
      `Failed to validate Copilot model access (HTTP ${response.status})`,
      response,
    )
  }

  return {
    ...discovered,
    models: validateModelsResponse(await response.json()),
  }
}
