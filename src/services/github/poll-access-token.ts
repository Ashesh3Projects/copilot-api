import consola from "consola"

import { GITHUB_CLIENT_ID, standardHeaders } from "~/lib/api-config"
import { DEFAULT_GITHUB_DOMAIN, githubBaseUrl } from "~/lib/github-instance"
import { sleep } from "~/lib/utils"

import type { DeviceCodeResponse } from "./get-device-code"

type PollSleep = (milliseconds: number) => Promise<unknown>

const defaultPollNow = () => Date.now()
let pollNow = defaultPollNow
let pollSleep: PollSleep = sleep

export function setPollAccessTokenRuntimeForTest(runtime?: {
  now?: () => number
  sleep?: PollSleep
}): void {
  pollNow = runtime?.now ?? defaultPollNow
  pollSleep = runtime?.sleep ?? sleep
}

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
  instanceDomain = DEFAULT_GITHUB_DOMAIN,
): Promise<string> {
  const expiresAt = pollNow() + deviceCode.expires_in * 1000
  let pollIntervalSeconds = Math.ceil(deviceCode.interval * 1.2)
  let slowDownCount = 0
  consola.debug(
    `Polling access token with interval of ${pollIntervalSeconds * 1000}ms`,
  )

  while (pollNow() < expiresAt) {
    try {
      const json = await pollAccessTokenOnce(
        deviceCode.device_code,
        instanceDomain,
      )
      const { access_token, error, error_description, interval } = json

      if (access_token) return access_token
      const terminalError = terminalOAuthError(error, error_description)
      if (terminalError) throw terminalError
      if (error === "slow_down") {
        slowDownCount++
        const baseInterval =
          typeof interval === "number" && Number.isFinite(interval) ?
            interval
          : deviceCode.interval
        pollIntervalSeconds = Math.min(
          60,
          Math.ceil(baseInterval + slowDownCount * 5),
        )
      }
    } catch (error) {
      if (error instanceof TerminalOAuthError) throw error
      consola.debug(
        `Access-token poll failed: ${error instanceof Error ? error.name : "Unknown error"}`,
      )
    }
    await pollSleep(pollIntervalSeconds * 1000)
  }

  throw new Error("GitHub device code expired before authorization completed")
}

export interface AccessTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
  interval?: number
  token_type?: string
  scope?: string
}

/** One upstream attempt, shared by durable dashboard and interactive CLI flows. */
export async function pollAccessTokenOnce(
  deviceCode: string,
  instanceDomain = DEFAULT_GITHUB_DOMAIN,
): Promise<AccessTokenResponse> {
  const response = await fetch(
    `${githubBaseUrl(instanceDomain)}/login/oauth/access_token`,
    {
      method: "POST",
      headers: {
        ...standardHeaders(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    },
  )
  if (!response.ok)
    throw new Error(
      `GitHub device authorization is unavailable (HTTP ${response.status})`,
    )
  return (await response.json()) as AccessTokenResponse
}

class TerminalOAuthError extends Error {}

function terminalOAuthError(
  error: string | undefined,
  description: string | undefined,
): TerminalOAuthError | undefined {
  if (!error || error === "authorization_pending" || error === "slow_down") {
    return undefined
  }
  return new TerminalOAuthError(description || `GitHub OAuth failed: ${error}`)
}
