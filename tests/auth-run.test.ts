import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

import { runAuth } from "../src/auth"
import { useProtocolDatabase } from "./helpers/protocol-database"

const originalFetch = globalThis.fetch
const responses: Array<Response> = []
const requests: Array<Request> = []

const fetchMock = mock(
  (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request ?
        new Request(input, init)
      : new Request(input.toString(), init)
    requests.push(request)
    const response = responses.shift()
    if (!response) throw new Error(`Unexpected fetch: ${request.url}`)
    return Promise.resolve(response)
  },
)

useProtocolDatabase()

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  responses.length = 0
  requests.length = 0
  fetchMock.mockClear()
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

function queuePublicDeviceLogin(): void {
  responses.push(
    Response.json({
      device_code: "device-code",
      expires_in: 900,
      interval: 0,
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
    }),
    Response.json({ access_token: "gho_public" }),
    Response.json({ id: 123, login: "octocat" }),
  )
}

test("runAuth validates and stores a public OAuth account without printing the token", async () => {
  queuePublicDeviceLogin()
  responses.push(
    Response.json({
      endpoints: { api: "https://api.githubcopilot.com" },
      login: "octocat",
    }),
    Response.json({ data: [{ id: "gpt-test" }], object: "list" }),
  )
  const stdout = spyOn(process.stdout, "write").mockImplementation(
    (() => true) as typeof process.stdout.write,
  )

  try {
    await runAuth({
      deviceCode: true,
      host: "github.com",
      verbose: false,
      webFlow: false,
    })

    expect(requests.map(({ url }) => url)).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/copilot_internal/user",
      "https://api.githubcopilot.com/models",
    ])
    expect(requests[3]?.headers.get("authorization")).toBe("Bearer gho_public")
    expect(requests[4]?.headers.get("authorization")).toBe("Bearer gho_public")
    expect(stdout).not.toHaveBeenCalled()
  } finally {
    stdout.mockRestore()
  }
})

test("runAuth does not print a public token when direct Copilot validation fails", async () => {
  queuePublicDeviceLogin()
  responses.push(new Response("forbidden", { status: 403 }))
  const stdout = spyOn(process.stdout, "write").mockImplementation(
    (() => true) as typeof process.stdout.write,
  )

  try {
    const error = await runAuth({
      deviceCode: true,
      host: "github.com",
      verbose: false,
      webFlow: false,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      "Failed to get Copilot user information (HTTP 403)",
    )
    expect(requests.map(({ url }) => url)).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/copilot_internal/user",
    ])
    expect(stdout).not.toHaveBeenCalled()
  } finally {
    stdout.mockRestore()
  }
})
