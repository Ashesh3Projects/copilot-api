import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"
import {
  CAPI_RESPONSES_MAX_REQUEST_BYTES,
  RESPONSES_RECOVERY_MARGIN_BYTES,
} from "~/services/copilot/responses-payload-recovery"

import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const requestBodies: Array<Record<string, unknown>> = []
const requestHeaders: Array<Headers> = []

const successResponse = () =>
  Response.json({
    id: "resp_recovered",
    object: "response",
    model: "gpt-4o",
    output: [],
    status: "completed",
  })

const fetchMock = mock((_url: string, init?: RequestInit) => {
  requestHeaders.push(new Headers(init?.headers))
  if (typeof init?.body === "string") {
    requestBodies.push(JSON.parse(init.body) as Record<string, unknown>)
  }
  return successResponse()
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  requestBodies.length = 0
  requestHeaders.length = 0
  fetchMock.mockClear()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
})

test("recovers oversized ordinary Responses payloads before one upstream dispatch", async () => {
  const preservedOutput =
    "BEGIN-ORDINARY\n" + "x".repeat(26 * 1024 * 1024) + "\nEND-ORDINARY"
  const inlineFile = `data:application/pdf;base64,${"A".repeat(7 * 1024 * 1024)}`

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: [
          {
            type: "custom_tool_call_output",
            call_id: "call_ordinary",
            output: [
              { type: "input_text", text: preservedOutput },
              {
                type: "input_file",
                filename: "oversized.pdf",
                file_data: inlineFile,
              },
            ],
          },
        ],
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(requestBodies).toHaveLength(1)
  const serialized = JSON.stringify(requestBodies[0])
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    CAPI_RESPONSES_MAX_REQUEST_BYTES - RESPONSES_RECOVERY_MARGIN_BYTES,
  )
  expect(serialized).toContain("BEGIN-ORDINARY")
  expect(serialized).toContain("END-ORDINARY")
  expect(serialized).toContain("call_ordinary")
  expect(serialized).not.toContain(inlineFile)
  expect(serialized).toContain(
    "omitted to fit the CAPI Responses request-size limit",
  )
  expect(serialized).not.toContain("UTF-8 bytes omitted during compaction")
})

test("rejects oversized ordinary preserved text without calling upstream", async () => {
  const error = await seedProtocolDatabase()
    .then(() =>
      createResponses(
        {
          model: "gpt-4o",
          input: [
            {
              type: "message",
              role: "developer",
              content: "preserved".repeat(4 * 1024 * 1024),
            },
          ],
        },
        { vision: false, initiator: "user" },
      ),
    )
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(413)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "responses_payload_too_large" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("removes the vision header when recovery removes every attachment", async () => {
  const preservedOutput = "x".repeat(31 * 1024 * 1024)
  const inlineFile = `data:application/pdf;base64,${"A".repeat(2 * 1024 * 1024)}`

  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: [
          {
            type: "custom_tool_call_output",
            call_id: "call_header",
            output: [
              { type: "input_text", text: preservedOutput },
              {
                type: "input_file",
                filename: "header.pdf",
                file_data: inlineFile,
              },
            ],
          },
        ],
      },
      { vision: true, initiator: "user" },
    ),
  )

  expect(requestBodies).toHaveLength(1)
  expect(JSON.stringify(requestBodies[0])).not.toContain(inlineFile)
  expect(requestHeaders[0]?.has("Copilot-Vision-Request")).toBe(false)
})

test("sets the vision header from nested recovered screenshots", async () => {
  await seedProtocolDatabase().then(() =>
    createResponses(
      {
        model: "gpt-4o",
        input: [
          {
            type: "function_call_output",
            call_id: "call_nested_header",
            output: [
              {
                type: "computer_screenshot",
                image_url: "data:image/png;base64,abc",
              },
            ],
          },
        ],
      },
      { vision: false, initiator: "user" },
    ),
  )

  expect(requestBodies).toHaveLength(1)
  expect(requestHeaders[0]?.get("Copilot-Vision-Request")).toBe("true")
})

test.skipIf(typeof Bun.Image !== "function")(
  "downscales an incident-shaped ordinary turn and keeps the image on wire",
  async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    )
    const paddedPng = Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)])
    const originalImage = `data:image/png;base64,${paddedPng.toString("base64")}`
    const history = "x".repeat(32_625 * 1024)

    await seedProtocolDatabase().then(() =>
      createResponses(
        {
          model: "gpt-4o",
          input: [
            {
              type: "function_call_output",
              call_id: "call_incident_history",
              output: history,
            },
            {
              type: "function_call_output",
              call_id: "call_incident_image",
              output: [{ type: "input_image", image_url: originalImage }],
            },
          ],
        },
        { vision: true, initiator: "user" },
      ),
    )

    expect(requestBodies).toHaveLength(1)
    const serialized = JSON.stringify(requestBodies[0])
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      CAPI_RESPONSES_MAX_REQUEST_BYTES - RESPONSES_RECOVERY_MARGIN_BYTES,
    )
    expect(serialized).toContain("call_incident_history")
    expect(serialized).toContain("call_incident_image")
    expect(serialized).toContain("data:image/png;base64,")
    expect(serialized).not.toContain(originalImage)
    expect(serialized).not.toContain(
      "omitted to fit the CAPI Responses request-size limit",
    )
    expect(requestHeaders[0]?.get("Copilot-Vision-Request")).toBe("true")
  },
  { timeout: 15_000 },
)
