import { Hono, type HonoRequest } from "hono"

import { getConfig } from "~/lib/config"
import { getGroqApiKey } from "~/lib/custom-providers"
import { createProxyResponseHeaders } from "~/lib/proxy-http"
import { setRequestContext } from "~/lib/request-logger"
import {
  getRoutingTelemetryRequestState,
  updateRoutingTelemetryRequestState,
} from "~/lib/request-session"
import {
  recordUpstreamCall,
  type UpstreamOutcome,
} from "~/lib/routing-telemetry"
import { isAbortLikeError } from "~/services/copilot/transport-retry"

const GROQ_TRANSCRIPTIONS_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions"
const DEFAULT_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo"
const GROQ_TRANSCRIPTION_MODELS = new Set([
  "whisper-large-v3",
  "whisper-large-v3-turbo",
])
const PASSTHROUGH_RESPONSE_FORMATS = new Set(["json", "text", "verbose_json"])
const SUBTITLE_RESPONSE_FORMATS = new Set(["srt", "vtt"])

export const audioTranscriptionRoutes = new Hono()

function invalidRequest(message: string, param: string): Response {
  return Response.json(
    {
      error: {
        code: "invalid_request",
        message,
        param,
        type: "invalid_request_error",
      },
    },
    { status: 400 },
  )
}

function serverError(message: string, param: string | null): Response {
  return Response.json(
    {
      error: {
        code: "configuration_error",
        message,
        param,
        type: "server_error",
      },
    },
    { status: 500 },
  )
}

function resolveGroqModel(
  requestedModel: string,
  configuredModel: string | undefined,
): string | null {
  const fallbackModel =
    configuredModel?.trim() || DEFAULT_GROQ_TRANSCRIPTION_MODEL
  if (requestedModel === "whisper-1") {
    return GROQ_TRANSCRIPTION_MODELS.has(fallbackModel) ? fallbackModel : null
  }
  return GROQ_TRANSCRIPTION_MODELS.has(requestedModel) ? requestedModel : null
}

function resolveResponseFormat(value: Blob | string | null): string | null {
  if (value === null) return "json"
  if (typeof value !== "string" || value.trim().length === 0) return null
  const responseFormat = value.trim()
  return (
      PASSTHROUGH_RESPONSE_FORMATS.has(responseFormat)
        || SUBTITLE_RESPONSE_FORMATS.has(responseFormat)
    ) ?
      responseFormat
    : null
}

function groqOutcome(response: Response): UpstreamOutcome {
  if (response.status >= 500) return "server_error"
  if (response.status >= 400) return "client_error"
  return "success"
}

function recordGroqCall(model: string, outcome: UpstreamOutcome): void {
  const requestState = getRoutingTelemetryRequestState()
  updateRoutingTelemetryRequestState({
    destination: "Groq",
    model,
    provider: "Groq",
  })
  recordUpstreamCall({
    model,
    outcome,
    provider: "Groq",
    reason: "initial",
    route:
      requestState ?
        `${requestState.sourceProtocol} -> Groq`
      : "/v1/audio/transcriptions -> Groq",
  })
}

interface TranscriptionSegment {
  end: number
  start: number
  text: string
}

function parseSegments(value: unknown): Array<TranscriptionSegment> | null {
  if (!Array.isArray(value)) return null
  const segments: Array<TranscriptionSegment> = []
  for (const segment of value) {
    if (typeof segment !== "object" || segment === null) return null
    const record = segment as Record<string, unknown>
    if (
      typeof record.start !== "number"
      || !Number.isFinite(record.start)
      || typeof record.end !== "number"
      || !Number.isFinite(record.end)
      || typeof record.text !== "string"
    ) {
      return null
    }
    segments.push({
      end: Math.max(record.start, record.end),
      start: Math.max(0, record.start),
      text: record.text.trim(),
    })
  }
  return segments
}

function formatTimestamp(seconds: number, separator: "," | "."): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(totalMilliseconds / 3_600_000)
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000)
  const wholeSeconds = Math.floor((totalMilliseconds % 60_000) / 1000)
  const milliseconds = totalMilliseconds % 1000
  return [hours, minutes, wholeSeconds]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":")
    .concat(separator, milliseconds.toString().padStart(3, "0"))
}

function renderSubtitles(
  segments: Array<TranscriptionSegment>,
  responseFormat: "srt" | "vtt",
): string {
  const separator = responseFormat === "srt" ? "," : "."
  const cues = segments.map((segment, index) => {
    const timing = `${formatTimestamp(segment.start, separator)} --> ${formatTimestamp(segment.end, separator)}`
    return responseFormat === "srt" ?
        `${index + 1}\n${timing}\n${segment.text}`
      : `${timing}\n${segment.text}`
  })
  if (responseFormat === "vtt") {
    return cues.length === 0 ?
        "WEBVTT\n\n"
      : `WEBVTT\n\n${cues.join("\n\n")}\n\n`
  }
  return cues.length === 0 ? "" : `${cues.join("\n\n")}\n\n`
}

async function subtitleResponse(
  response: Response,
  responseFormat: "srt" | "vtt",
): Promise<Response> {
  let data: { segments?: unknown }
  try {
    data = (await response.json()) as { segments?: unknown }
  } catch {
    return Response.json(
      {
        error: {
          code: "invalid_upstream_response",
          message:
            "The transcription provider returned invalid timestamp data.",
          param: "response_format",
          type: "server_error",
        },
      },
      { status: 502 },
    )
  }
  const segments = parseSegments(data.segments)
  if (!segments) {
    return Response.json(
      {
        error: {
          code: "invalid_upstream_response",
          message: "The transcription provider returned no usable segments.",
          param: "response_format",
          type: "server_error",
        },
      },
      { status: 502 },
    )
  }
  const headers = createProxyResponseHeaders(response.headers)
  headers.delete("content-length")
  headers.set("content-type", "text/plain; charset=utf-8")
  return new Response(renderSubtitles(segments, responseFormat), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

interface PreparedTranscriptionRequest {
  formData: FormData
  requestedModel: string
  responseFormat: string
  upstreamModel: string
}

async function prepareTranscriptionRequest(
  request: HonoRequest,
  configuredModel: string | undefined,
): Promise<PreparedTranscriptionRequest | Response> {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return invalidRequest(
      "The request body must be multipart/form-data.",
      "body",
    )
  }

  if (!(formData.get("file") instanceof Blob)) {
    return invalidRequest("Missing required parameter: 'file'.", "file")
  }

  const modelValue = formData.get("model")
  if (typeof modelValue !== "string" || modelValue.trim().length === 0) {
    return invalidRequest("Missing required parameter: 'model'.", "model")
  }
  const requestedModel = modelValue.trim()
  const upstreamModel = resolveGroqModel(requestedModel, configuredModel)
  if (!upstreamModel) {
    if (requestedModel === "whisper-1" && configuredModel?.trim()) {
      return serverError(
        "The configured groqModel is not supported.",
        "groqModel",
      )
    }
    return invalidRequest(
      `The model '${modelValue}' is not supported by this transcription endpoint.`,
      "model",
    )
  }
  formData.set("model", upstreamModel)

  const responseFormat = resolveResponseFormat(formData.get("response_format"))
  if (!responseFormat) {
    return invalidRequest(
      "The requested response_format is not supported by this transcription endpoint.",
      "response_format",
    )
  }
  if (SUBTITLE_RESPONSE_FORMATS.has(responseFormat)) {
    formData.set("response_format", "verbose_json")
  }

  return { formData, requestedModel, responseFormat, upstreamModel }
}

async function fetchGroqTranscription(options: {
  apiKey: string
  formData: FormData
  model: string
  responseFormat: string
  signal: AbortSignal
}): Promise<Response> {
  const { apiKey, formData, model, responseFormat, signal } = options
  let response: Response
  try {
    response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal,
    })
  } catch (error) {
    recordGroqCall(
      model,
      isAbortLikeError(error) ? "aborted" : "transport_error",
    )
    throw error
  }

  if (response.ok && (responseFormat === "srt" || responseFormat === "vtt")) {
    const convertedResponse = await subtitleResponse(response, responseFormat)
    recordGroqCall(model, groqOutcome(convertedResponse))
    return convertedResponse
  }

  recordGroqCall(model, groqOutcome(response))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: createProxyResponseHeaders(response.headers),
  })
}

audioTranscriptionRoutes.post("/", async (c) => {
  const config = getConfig()
  const apiKey = getGroqApiKey()
  if (!apiKey) return serverError("Groq API key is not configured", null)

  const prepared = await prepareTranscriptionRequest(c.req, config.groqModel)
  if (prepared instanceof Response) return prepared

  setRequestContext(c, {
    model: prepared.upstreamModel,
    provider: "Groq",
    requestedModel: prepared.requestedModel,
  })

  return await fetchGroqTranscription({
    apiKey,
    formData: prepared.formData,
    model: prepared.upstreamModel,
    responseFormat: prepared.responseFormat,
    signal: c.req.raw.signal,
  })
})
