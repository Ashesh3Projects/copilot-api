import type { Context } from "hono"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { routedFetch } from "~/lib/account-router"
import { replayCustomProviderRequest } from "~/lib/custom-providers"
import { getLlmDebugLog, type LlmDebugLogEntry } from "~/lib/llm-debug-log"
import { tokenPool } from "~/lib/token-pool"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import {
  detectInitiator,
  hasVisionContent,
} from "~/services/copilot/copilot-client"

interface ReplayRequestBody {
  body?: unknown
}

interface ReplayStreamEvent {
  data: unknown
  rawData: string
  event?: string
  id?: string
  retry?: number
}

interface ReplaySummary {
  finishReason?: string
  responseId?: string
  usage?: unknown
}

const REPLAYABLE_LLM_DEBUG_PATHS = new Set(["/chat/completions", "/responses"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseReplayBody(
  body: ReplayRequestBody | null,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  if (!body || body.body === undefined || body.body === null) {
    return { ok: false, error: "body is required" }
  }

  if (typeof body.body === "string") {
    const trimmed = body.body.trim()
    if (!trimmed) return { ok: false, error: "body cannot be empty" }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!isRecord(parsed)) {
        return { ok: false, error: "body must be a JSON object" }
      }
      return { ok: true, payload: parsed }
    } catch {
      return { ok: false, error: "body must be valid JSON" }
    }
  }

  if (!isRecord(body.body)) {
    return { ok: false, error: "body must be a JSON object or JSON string" }
  }

  return { ok: true, payload: body.body }
}

function extractReplayModel(payload: Record<string, unknown>): string | null {
  return typeof payload.model === "string" && payload.model.trim().length > 0 ?
      payload.model.trim()
    : null
}

function replayHeaderOptions(path: string, payload: Record<string, unknown>) {
  if (path === "/chat/completions") {
    const chatPayload = payload as unknown as ChatCompletionsPayload
    const messages = chatPayload.messages
    const safeMessages = Array.isArray(messages) ? messages : []

    return {
      vision: hasVisionContent(safeMessages),
      initiator: detectInitiator(safeMessages),
    }
  }

  return getResponsesRequestOptions(payload as unknown as ResponsesPayload)
}

function headerRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function getChoiceFinishReason(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined
  const first = value.choices[0] as unknown
  if (!isRecord(first)) return undefined
  return typeof first.finish_reason === "string" ?
      first.finish_reason
    : undefined
}

function updateSummaryFromValue(summary: ReplaySummary, value: unknown): void {
  if (!isRecord(value)) return

  if (typeof value.id === "string") {
    summary.responseId = value.id
  }

  if (isRecord(value.usage)) {
    summary.usage = value.usage
  }

  const finishReason = getChoiceFinishReason(value)
  if (finishReason) {
    summary.finishReason = finishReason
  }

  const response = value.response
  if (!isRecord(response)) return

  if (typeof response.id === "string") {
    summary.responseId = response.id
  }
  if (isRecord(response.usage)) {
    summary.usage = response.usage
  }
  if (isRecord(response.incomplete_details)) {
    const reason = response.incomplete_details.reason
    if (typeof reason === "string") {
      summary.finishReason = reason
    }
  }
  if (!summary.finishReason && typeof response.status === "string") {
    summary.finishReason = response.status
  }
}

function parseSseReplayBody(body: string): {
  streamEvents: Array<ReplayStreamEvent>
  summary: ReplaySummary
} {
  const streamEvents: Array<ReplayStreamEvent> = []
  const summary: ReplaySummary = {}
  let eventName: string | undefined
  let eventId: string | undefined
  let retry: number | undefined
  let dataLines: Array<string> = []

  const flush = () => {
    if (dataLines.length === 0 && !eventName && !eventId) return
    const rawData = dataLines.join("\n")
    const data = rawData === "[DONE]" ? rawData : parseJsonOrText(rawData)
    streamEvents.push({
      data,
      rawData,
      ...(eventName ? { event: eventName } : {}),
      ...(eventId ? { id: eventId } : {}),
      ...(retry !== undefined ? { retry } : {}),
    })
    updateSummaryFromValue(summary, data)
    eventName = undefined
    eventId = undefined
    retry = undefined
    dataLines = []
  }

  for (const rawLine of body.replaceAll("\r\n", "\n").split("\n")) {
    if (rawLine === "") {
      flush()
      continue
    }

    const separator = rawLine.indexOf(":")
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator)
    const rawValue = separator === -1 ? "" : rawLine.slice(separator + 1)
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue

    switch (field) {
      case "event": {
        eventName = value
        break
      }
      case "id": {
        eventId = value
        break
      }
      case "retry": {
        const parsedRetry = Number(value)
        if (Number.isFinite(parsedRetry)) retry = parsedRetry
        break
      }
      case "data": {
        dataLines.push(value)
        break
      }
      default: {
        break
      }
    }
  }

  flush()
  return { streamEvents, summary }
}

function parseReplayResponse(body: string): {
  parsed: unknown
  streamEvents: Array<ReplayStreamEvent>
  summary: ReplaySummary
} {
  const trimmedBody = body.trimStart()
  if (
    trimmedBody.startsWith("data:")
    || trimmedBody.startsWith("event:")
    || body.includes("\nevent:")
  ) {
    const { streamEvents, summary } = parseSseReplayBody(body)
    return { parsed: null, streamEvents, summary }
  }

  const parsed = parseJsonOrText(body)
  const summary: ReplaySummary = {}
  updateSummaryFromValue(summary, parsed)
  return { parsed, streamEvents: [], summary }
}

function replayAccountAvailable(
  entry: LlmDebugLogEntry,
  modelId: string,
): boolean {
  if (
    entry.upstream?.kind !== "copilot"
    || entry.upstream.accountId === undefined
  )
    return true
  return Boolean(
    tokenPool.getEligibleAccountForModel(modelId, entry.upstream.accountId),
  )
}

export async function handleReplayLlmDebugLog(c: Context) {
  const id = c.req.param("id") ?? ""
  const entry = await getLlmDebugLog(id)
  if (!entry) return c.json({ error: "Debug log not found" }, 404)

  const path = entry.request.path
  if (!REPLAYABLE_LLM_DEBUG_PATHS.has(path)) {
    return c.json({ error: `Replay is not supported for ${path}` }, 400)
  }

  if (entry.request.method.toUpperCase() !== "POST") {
    return c.json({ error: "Only POST LLM debug logs can be replayed" }, 400)
  }

  const body = await c.req.json<ReplayRequestBody>().catch(() => null)
  const parsedBody = parseReplayBody(body)
  if (!parsedBody.ok) return c.json({ error: parsedBody.error }, 400)

  const modelId = extractReplayModel(parsedBody.payload)
  if (!modelId) return c.json({ error: "body.model is required" }, 400)

  if (!replayAccountAvailable(entry, modelId)) {
    return c.json(
      {
        error:
          "The original Copilot account is unavailable for this replay model.",
      },
      409,
    )
  }

  const startedAtMs = Date.now()
  const response =
    entry.upstream?.kind === "custom" ?
      await replayCustomProviderRequest({
        providerId: entry.upstream.providerId,
        originalUrl: entry.request.url,
        payload: parsedBody.payload,
        signal: c.req.raw.signal,
      })
    : (
        await routedFetch(
          path,
          {
            body: JSON.stringify(parsedBody.payload),
            method: "POST",
            signal: c.req.raw.signal,
          },
          {
            headerOptions: replayHeaderOptions(path, parsedBody.payload),
            modelId,
            ...((
              entry.upstream?.kind === "copilot"
              && entry.upstream.accountId !== undefined
            ) ?
              { routedAccountPin: { accountId: entry.upstream.accountId } }
            : {}),
          },
        )
      ).response
  const responseBody = await response.text()
  const durationMs = Date.now() - startedAtMs
  const replayResponse = parseReplayResponse(responseBody)

  return c.json({
    body: responseBody,
    durationMs,
    finishReason: replayResponse.summary.finishReason ?? null,
    headers: headerRecord(response.headers),
    parsed: replayResponse.parsed,
    responseId: replayResponse.summary.responseId ?? null,
    status: response.status,
    statusText: response.statusText,
    streamEvents: replayResponse.streamEvents,
    usage: replayResponse.summary.usage ?? null,
  })
}
