/* eslint-disable require-atomic-updates -- test lifecycle hooks serialize this isolated storage fixture. */
import { expect } from "bun:test"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  issueAdminSetupCode,
  setAdminAuthClockForTest,
} from "../../src/lib/admin-auth"
import { mergeConfigWithDefaults } from "../../src/lib/config"
import { server } from "../../src/server"
import { createAuthStorageFixture } from "./auth-storage"

let storageFixture:
  | Awaited<ReturnType<typeof createAuthStorageFixture>>
  | undefined

export const TEST_ADMIN_ORIGIN = "https://gateway.example.com"
export const TEST_GATEWAY_KEY = "test-dashboard-gateway-key-with-enough-entropy"
export const TEST_ADMIN_PASSWORD = "test dashboard administrator password"

export interface TestAdminSession {
  cookie: string
  csrf: string
}

function setCookies(response: Response): Array<string> {
  const cookies = response.headers.getSetCookie()
  return cookies.length > 0 ?
      cookies
    : [response.headers.get("set-cookie") ?? ""]
}

export async function createTestAdminSession(
  options: { reuseStorage?: boolean } = {},
): Promise<TestAdminSession> {
  delete process.env.COPILOT_ADMIN_PASSWORD_HASH
  if (!options.reuseStorage) {
    await storageFixture?.close()
    storageFixture = await createAuthStorageFixture()
  }
  await mergeConfigWithDefaults()
  setAdminAuthClockForTest()
  const { code } = await issueAdminSetupCode()
  process.env.COPILOT_ADMIN_ORIGIN = TEST_ADMIN_ORIGIN
  const setup = await server.request("/dashboard/auth/setup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: TEST_ADMIN_ORIGIN,
    },
    body: JSON.stringify({
      setupCode: code,
      gatewayKey: TEST_GATEWAY_KEY,
      password: TEST_ADMIN_PASSWORD,
    }),
  })
  expect(setup.status).toBe(201)
  const cookies = setCookies(setup)
  const session = cookies
    .find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE}=`))
    ?.split(";", 1)[0]
  const csrfCookie = cookies
    .find((value) => value.startsWith(`${ADMIN_CSRF_COOKIE}=`))
    ?.split(";", 1)[0]
  expect(session).toBeTruthy()
  expect(csrfCookie).toBeTruthy()
  const csrf = csrfCookie?.slice(`${ADMIN_CSRF_COOKIE}=`.length) ?? ""
  return { cookie: `${session}; ${csrfCookie}`, csrf }
}

export function adminHeaders(
  session: TestAdminSession,
  mutating = true,
): Record<string, string> {
  return {
    cookie: session.cookie,
    ...(mutating ?
      {
        origin: TEST_ADMIN_ORIGIN,
        "x-copilot-csrf": session.csrf,
        "content-type": "application/json",
      }
    : {}),
  }
}

export async function resetTestAdminSession(): Promise<void> {
  await storageFixture?.close()
  storageFixture = undefined
  setAdminAuthClockForTest()
  delete process.env.COPILOT_ADMIN_ORIGIN
  delete process.env.COPILOT_ADMIN_PASSWORD_HASH
}
