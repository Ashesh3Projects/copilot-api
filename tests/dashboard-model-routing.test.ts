import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"

import type { Account } from "../src/lib/token-pool"
import type { ModelRouting } from "../ui/src/lib/types"

import { tokenPool } from "../src/lib/token-pool"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import { server } from "../src/server"
import {
  formatModelRoutingAccountDetails,
  formatModelRoutingAccountSummary,
} from "../ui/src/lib/model-routing"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

const ACCOUNT_ID = 8301
const ACCOUNT_WITHOUT_USERNAME_ID = 8302
const GITHUB_TOKEN = "dashboard-model-routing-secret-token"
const GITHUB_TOKEN_WITHOUT_USERNAME =
  "dashboard-model-routing-second-secret-token"

let adminSession: TestAdminSession
const accounts: Array<Account> = [
  {
    id: ACCOUNT_ID,
    accountType: "individual",
    githubInstanceDomain: "github.com",
    githubToken: GITHUB_TOKEN,
    githubUsername: "octocat",
    healthy: true,
    enabled: false,
    deleting: false,
    models: new Set(["dashboard-routing-model"]),
    modelsData: [],
  },
  {
    id: ACCOUNT_WITHOUT_USERNAME_ID,
    accountType: "business",
    githubInstanceDomain: "github.com",
    githubToken: GITHUB_TOKEN_WITHOUT_USERNAME,
    healthy: false,
    enabled: true,
    deleting: true,
    models: new Set(),
    modelsData: [],
  },
]
const getAllAccountsSpy = spyOn(tokenPool, "getAllAccounts")

beforeAll(async () => {
  adminSession = await createTestAdminSession()
  getAllAccountsSpy.mockReturnValue(accounts)
})

afterAll(async () => {
  getAllAccountsSpy.mockRestore()
  await resetTestAdminSession()
})

test("model routing requires dashboard authentication", async () => {
  const response = await server.request("/dashboard/api/model-routing")

  expect(response.status).toBe(401)
})

test("model routing returns account usernames without GitHub tokens", async () => {
  const response = await server.request("/dashboard/api/model-routing", {
    headers: adminHeaders(adminSession, false),
  })
  const body = (await response.json()) as ModelRouting
  const listedAccount = body.accounts.find(
    (candidate) => candidate.id === ACCOUNT_ID,
  )
  const accountWithoutUsername = body.accounts.find(
    (candidate) => candidate.id === ACCOUNT_WITHOUT_USERNAME_ID,
  )

  expect(response.status).toBe(200)
  expect(listedAccount).toEqual({
    id: ACCOUNT_ID,
    accountType: "individual",
    githubUsername: "octocat",
    healthy: true,
    enabled: false,
    deleting: false,
    modelsCount: 1,
  })
  expect(accountWithoutUsername).toEqual({
    id: ACCOUNT_WITHOUT_USERNAME_ID,
    accountType: "business",
    healthy: false,
    enabled: true,
    deleting: true,
    modelsCount: 0,
  })
  expect(Object.hasOwn(accountWithoutUsername ?? {}, "githubUsername")).toBe(
    false,
  )
  expect(
    body.accounts.every((account) => !Object.hasOwn(account, "githubToken")),
  ).toBe(true)
  const serializedBody = JSON.stringify(body)
  expect(serializedBody).not.toContain(GITHUB_TOKEN)
  expect(serializedBody).not.toContain(GITHUB_TOKEN_WITHOUT_USERNAME)
})

test("model routing account formatters include the GitHub username", () => {
  const account = {
    id: 3,
    accountType: "individual",
    githubUsername: "octocat",
    healthy: true,
    modelsCount: 46,
  }

  expect(formatModelRoutingAccountDetails(account)).toBe("@octocat · 46 models")
  expect(formatModelRoutingAccountSummary(account)).toBe(
    "Account #3, @octocat, individual, Healthy",
  )
})

test("model routing account formatters fall back without a username", () => {
  const account = {
    id: 3,
    accountType: "individual",
    healthy: false,
    modelsCount: 46,
  }

  expect(formatModelRoutingAccountDetails(account)).toBe("46 models")
  expect(formatModelRoutingAccountSummary(account)).toBe(
    "Account #3, individual, Unhealthy",
  )
})

test("model routing summaries expose disabled and removing account availability", () => {
  const account = {
    id: 4,
    accountType: "individual",
    healthy: true,
    modelsCount: 2,
  }
  expect(formatModelRoutingAccountSummary({ ...account, enabled: false })).toBe(
    "Account #4, individual, Disabled",
  )
  expect(
    formatModelRoutingAccountSummary({
      ...account,
      enabled: false,
      deleting: true,
    }),
  ).toBe("Account #4, individual, Removing")
})

test("generated dashboard includes GitHub username account labels", () => {
  const formatterStart = DASHBOARD_HTML.indexOf("modelsCount")
  expect(formatterStart).toBeGreaterThanOrEqual(0)

  const formatterRegion = DASHBOARD_HTML.slice(
    Math.max(0, formatterStart - 40),
    formatterStart + 160,
  )
  expect(formatterRegion).toMatch(
    /const ([\w$]+)=`\$\{([\w$]+)\.modelsCount\} models`;return \2\.githubUsername\?`@\$\{\2\.githubUsername\} · \$\{\1\}`:\1\}/,
  )
})
