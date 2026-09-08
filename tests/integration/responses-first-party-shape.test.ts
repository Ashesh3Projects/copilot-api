import "./data-dir"

import { expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"

import {
  useIntegrationFixture,
  initializeTestState,
  postJSON,
  TEST_TIMEOUT,
} from "./setup"

const LIVE_TIMEOUT = TEST_TIMEOUT * 6
const MAX_PROVIDER_CANDIDATES = 6
const supportedEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

type SupportedEffort = (typeof supportedEfforts)[number]

interface Candidate {
  effort: SupportedEffort
  model: Model
}

interface SafeFailure {
  code?: string
  providerClass: string
  status: number
}

useIntegrationFixture()

await initializeTestState()

const candidates = firstCandidateByProvider(
  (state.models?.data ?? []).flatMap((model) => {
    if (!model.supported_endpoints?.includes("/responses")) return []
    if (model.capabilities.supports.tool_calls !== true) return []
    const effort = selectReasoningEffort(
      model.capabilities.supports.reasoning_effort,
    )
    return effort ? [{ effort, model }] : []
  }),
).slice(0, MAX_PROVIDER_CANDIDATES)

if (candidates.length === 0) {
  test.skip("live first-party Responses shape unavailable: catalog has no native model advertising tools and non-none reasoning", () => {})
} else {
  test(
    "accepts a current first-party-shaped Responses request",
    async () => {
      const failures: Array<SafeFailure> = []
      const logSpy = spyOn(console, "log").mockImplementation(() => {})

      try {
        for (const candidate of candidates) {
          const response = await postJSON(
            "/v1/responses",
            {
              model: candidate.model.id,
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: "Reply with exactly OK.",
                    },
                  ],
                },
              ],
              tools: [
                {
                  type: "function",
                  name: "lookup_synthetic_value",
                  description: "Return a synthetic value without side effects.",
                  parameters: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                  },
                  strict: true,
                },
              ],
              tool_choice: "none",
              reasoning: { effort: candidate.effort },
              include: ["reasoning.encrypted_content"],
              client_metadata: {
                "x-codex-turn-metadata": JSON.stringify({
                  turn_id: `turn-${randomUUID()}`,
                  request_kind: "turn",
                }),
              },
              max_output_tokens: 16,
              store: false,
              stream: false,
            },
            {
              "X-Agent-Task-Id": `task-${randomUUID()}`,
              "X-Parent-Agent-Id": `parent-${randomUUID()}`,
              "X-Interaction-Type": "conversation-agent",
            },
          )

          if (response.status === 200) {
            await response.arrayBuffer()
            expect(response.status).toBe(200)
            return
          }

          const failure = {
            code: await readSafeErrorCode(response),
            providerClass: classifyProvider(candidate.model),
            status: response.status,
          }
          failures.push(failure)
          if (!isSafeCandidateRejection(response.status)) {
            throw new Error(
              `First-party Responses probe stopped on a non-capability failure: ${JSON.stringify(failure)}`,
            )
          }
        }

        throw new Error(
          `No advertised provider accepted the first-party Responses shape: ${JSON.stringify(failures)}`,
        )
      } finally {
        logSpy.mockRestore()
      }
    },
    LIVE_TIMEOUT,
  )
}

function selectReasoningEffort(value: unknown): SupportedEffort | undefined {
  if (!Array.isArray(value)) return undefined
  const advertised = new Set(
    value.filter((item): item is string => typeof item === "string"),
  )
  return supportedEfforts.find((effort) => advertised.has(effort))
}

function firstCandidateByProvider(
  values: ReadonlyArray<Candidate>,
): Array<Candidate> {
  const selected: Array<Candidate> = []
  const providers = new Set<string>()

  for (const candidate of values) {
    const provider =
      candidate.model.vendor?.trim().toLowerCase()
      || `family:${candidate.model.capabilities.family.trim().toLowerCase()}`
    if (providers.has(provider)) continue
    providers.add(provider)
    selected.push(candidate)
  }

  return selected
}

function classifyProvider(model: Model): string {
  const value =
    `${model.vendor ?? ""} ${model.capabilities.family}`.toLowerCase()
  for (const provider of [
    "anthropic",
    "openai",
    "google",
    "gemini",
    "xai",
    "mistral",
    "deepseek",
  ]) {
    if (value.includes(provider)) {
      return provider === "gemini" ? "google" : provider
    }
  }
  return "other"
}

function isSafeCandidateRejection(status: number): boolean {
  return [400, 403, 404, 409, 422, 429].includes(status)
}

async function readSafeErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body: unknown = await response.json()
    if (!isRecord(body)) return undefined
    const error = isRecord(body.error) ? body.error : undefined
    return safeCode(error?.code) ?? safeCode(body.code)
  } catch {
    return undefined
  }
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]{1,80}$/.test(value) ?
      value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
