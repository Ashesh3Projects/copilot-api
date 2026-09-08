import { afterAll, beforeEach, expect, mock, test } from "bun:test"

import { setConfigForTest } from "../src/lib/config"
import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { shouldOmitRequestBodyFromDiagnostics } from "../src/lib/request-diagnostics"
import {
  getRoutingTelemetrySnapshotForTest as getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

const originalApiKeyAuth = state.apiKeyAuth
const originalFetch = globalThis.fetch
const originalGroqApiKey = process.env.GROQ_API_KEY

const fetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ text: "hello from groq" }), {
      headers: { "content-type": "application/json" },
    }),
)

function getFetchUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.href
  return url.url
}

useProtocolDatabase()

beforeEach(() => {
  state.apiKeyAuth = "gateway-secret"
  setConfigForTest({
    groqApiKey: "groq-secret",
    groqModel: "whisper-large-v3",
  })
  delete process.env.GROQ_API_KEY
  resetIpSecurityForTest()
  resetRoutingTelemetryForTest()
  setIpAllowlistForTest([])
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  setConfigForTest(null)
  resetIpSecurityForTest()
  setIpAllowlistForTest([])
  if (originalGroqApiKey === undefined) {
    delete process.env.GROQ_API_KEY
  } else {
    process.env.GROQ_API_KEY = originalGroqApiKey
  }
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

function createTranscriptionForm(model = "whisper-1"): FormData {
  const formData = new FormData()
  formData.append(
    "file",
    new Blob(["audio-bytes"], { type: "audio/webm" }),
    "recording.webm",
  )
  formData.append("model", model)
  return formData
}

async function requestTranscription(
  formData: FormData,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await protocolRequest("/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: "Bearer gateway-secret",
      ...headers,
    },
    body: formData,
  })
}

test("maps OpenAI whisper-1 requests to the configured Groq model", async () => {
  const formData = createTranscriptionForm()
  formData.append("language", "en")
  formData.append("prompt", "Ashesh, Copilot API")
  formData.append("response_format", "json")
  formData.append("temperature", "0")

  const response = await requestTranscription(formData)

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(await response.json()).toEqual({ text: "hello from groq" })
  expect(fetchMock).toHaveBeenCalledTimes(1)

  const [url, init] = fetchMock.mock.calls[0]
  expect(getFetchUrl(url)).toBe(
    "https://api.groq.com/openai/v1/audio/transcriptions",
  )
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer groq-secret",
  )

  const upstreamForm = init?.body as FormData
  expect(upstreamForm.get("model")).toBe("whisper-large-v3")
  expect(upstreamForm.get("language")).toBe("en")
  expect(upstreamForm.get("prompt")).toBe("Ashesh, Copilot API")
  expect(upstreamForm.get("response_format")).toBe("json")
  expect(upstreamForm.get("temperature")).toBe("0")

  const file = upstreamForm.get("file")
  expect(file).toBeInstanceOf(Blob)
  expect((file as File).name).toBe("recording.webm")
  expect(await (file as Blob).text()).toBe("audio-bytes")
})

test("passes Groq-native Whisper model IDs through unchanged", async () => {
  const response = await requestTranscription(
    createTranscriptionForm("whisper-large-v3-turbo"),
  )

  expect(response.status).toBe(200)
  const upstreamForm = fetchMock.mock.calls[0]?.[1]?.body as FormData
  expect(upstreamForm.get("model")).toBe("whisper-large-v3-turbo")
})

test("uses the default Groq model for whisper-1 when none is configured", async () => {
  setConfigForTest({ groqApiKey: "groq-secret" })

  const response = await requestTranscription(createTranscriptionForm())

  expect(response.status).toBe(200)
  const upstreamForm = fetchMock.mock.calls[0]?.[1]?.body as FormData
  expect(upstreamForm.get("model")).toBe("whisper-large-v3-turbo")
})

test("rejects an unsupported configured whisper-1 target as a server configuration error", async () => {
  setConfigForTest({
    groqApiKey: "groq-secret",
    groqModel: "distil-whisper-large-v3-en",
  })

  const response = await requestTranscription(createTranscriptionForm())

  expect(response.status).toBe(500)
  expect(await response.json()).toMatchObject({
    error: {
      code: "configuration_error",
      param: "groqModel",
      type: "server_error",
    },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("does not let groqModel configuration authorize arbitrary direct model IDs", async () => {
  setConfigForTest({
    groqApiKey: "groq-secret",
    groqModel: "gpt-4o-transcribe",
  })

  const response = await requestTranscription(
    createTranscriptionForm("gpt-4o-transcribe"),
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { param: "model", type: "invalid_request_error" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("preserves Groq text transcription responses", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("Hello from text format", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
  )
  const formData = createTranscriptionForm()
  formData.append("response_format", "text")

  const response = await requestTranscription(formData)

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
  expect(await response.text()).toBe("Hello from text format")
  const upstreamForm = fetchMock.mock.calls[0]?.[1]?.body as FormData
  expect(upstreamForm.get("response_format")).toBe("text")
})

test("renders OpenAI SRT from Groq verbose segments", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        text: "Hello world",
        segments: [
          { start: 0, end: 1.25, text: " Hello" },
          { start: 61.5, end: 62.75, text: " world " },
        ],
      }),
  )
  const formData = createTranscriptionForm()
  formData.append("response_format", "srt")

  const response = await requestTranscription(formData)

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
  expect(await response.text()).toBe(
    "1\n00:00:00,000 --> 00:00:01,250\nHello\n\n"
      + "2\n00:01:01,500 --> 00:01:02,750\nworld\n\n",
  )
  const upstreamForm = fetchMock.mock.calls[0]?.[1]?.body as FormData
  expect(upstreamForm.get("response_format")).toBe("verbose_json")
})

test("renders OpenAI VTT from Groq verbose segments", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        text: "Hello",
        segments: [{ start: 0, end: 1.25, text: "Hello" }],
      }),
  )
  const formData = createTranscriptionForm()
  formData.append("response_format", "vtt")

  const response = await requestTranscription(formData)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe(
    "WEBVTT\n\n00:00:00.000 --> 00:00:01.250\nHello\n\n",
  )
  const upstreamForm = fetchMock.mock.calls[0]?.[1]?.body as FormData
  expect(upstreamForm.get("response_format")).toBe("verbose_json")
})

test("renders empty subtitle documents for silent audio", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ text: "", segments: [] }),
  )
  const srtForm = createTranscriptionForm()
  srtForm.append("response_format", "srt")

  const srtResponse = await requestTranscription(srtForm)

  expect(srtResponse.status).toBe(200)
  expect(await srtResponse.text()).toBe("")

  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ text: "", segments: [] }),
  )
  const vttForm = createTranscriptionForm()
  vttForm.append("response_format", "vtt")

  const vttResponse = await requestTranscription(vttForm)

  expect(vttResponse.status).toBe(200)
  expect(await vttResponse.text()).toBe("WEBVTT\n\n")
})

test("counts malformed Groq subtitle data as a server error", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ text: "Hello", segments: [{ text: "Hello" }] }),
  )
  const formData = createTranscriptionForm()
  formData.append("response_format", "srt")

  const response = await requestTranscription(formData)

  expect(response.status).toBe(502)
  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.models[0]?.outcomes.serverError).toBe(1)
  expect(snapshot.models[0]?.outcomes.success).toBe(0)
})

test("forwards Groq API errors without replacing their status or body", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          error: {
            code: "audio_too_long",
            message: "Audio exceeds the supported duration.",
            type: "invalid_request_error",
          },
        }),
        {
          status: 413,
          headers: { "content-type": "application/json" },
        },
      ),
  )

  const response = await requestTranscription(createTranscriptionForm())

  expect(response.status).toBe(413)
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(await response.json()).toEqual({
    error: {
      code: "audio_too_long",
      message: "Audio exceeds the supported duration.",
      type: "invalid_request_error",
    },
  })
})

test("rejects requests without an audio file before calling Groq", async () => {
  const formData = new FormData()
  formData.append("model", "whisper-1")

  const response = await requestTranscription(formData)

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { param: "file", type: "invalid_request_error" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects requests without a model before calling Groq", async () => {
  const formData = createTranscriptionForm()
  formData.delete("model")

  const response = await requestTranscription(formData)

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { param: "model", type: "invalid_request_error" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects transcription models that Groq cannot serve", async () => {
  const response = await requestTranscription(
    createTranscriptionForm("gpt-4o-transcribe"),
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { param: "model", type: "invalid_request_error" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects retired Groq transcription model IDs", async () => {
  const response = await requestTranscription(
    createTranscriptionForm("distil-whisper-large-v3-en"),
  )

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { param: "model", type: "invalid_request_error" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects response formats unavailable for the Whisper compatibility route", async () => {
  const formData = createTranscriptionForm()
  formData.append("response_format", "diarized_json")

  const response = await requestTranscription(formData)

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { param: "response_format", type: "invalid_request_error" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("returns an OpenAI-shaped error for non-multipart bodies", async () => {
  const response = await protocolRequest("/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: "Bearer gateway-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "whisper-1" }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: { param: "body", type: "invalid_request_error" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("returns a bounded server error when Groq is not configured", async () => {
  setConfigForTest({})

  const response = await requestTranscription(createTranscriptionForm())

  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    error: {
      code: "configuration_error",
      message: "Groq API key is not configured",
      param: null,
      type: "server_error",
    },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("does not let transparent-proxy IP allowlisting bypass endpoint auth", async () => {
  const clientIp = "203.0.113.90"
  setIpAllowlistForTest([{ ip: clientIp, enabled: true, source: "manual" }])

  const response = await protocolRequest("/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      host: "api.anthropic.com",
      "x-copilot-peer-ip": "127.0.0.1",
      "x-forwarded-for": clientIp,
    },
    body: createTranscriptionForm(),
  })

  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({
    error: { message: "Unauthorized", type: "authentication_error" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("records Groq request and upstream telemetry", async () => {
  const response = await requestTranscription(createTranscriptionForm())

  expect(response.status).toBe(200)
  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals).toMatchObject({ requests: 1, upstreamCalls: 1 })
  expect(snapshot.models[0]).toMatchObject({
    model: "whisper-large-v3",
    provider: "Groq",
    requests: 1,
    upstreamCalls: 1,
  })
  expect(snapshot.routes[0]).toMatchObject({
    route: "Audio Transcriptions -> Groq",
    requests: 1,
    upstreamCalls: 1,
  })
})

test("records Groq transport failures without leaking the provider error", async () => {
  fetchMock.mockImplementationOnce(() => {
    throw new Error("private network marker")
  })

  const response = await requestTranscription(createTranscriptionForm())

  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain("private network marker")
  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.models[0]?.outcomes.transportError).toBe(1)
})

test("omits multipart audio bodies from ordinary debug diagnostics", () => {
  expect(shouldOmitRequestBodyFromDiagnostics("/v1/audio/transcriptions")).toBe(
    true,
  )
})

async function protocolRequest(
  input: Parameters<typeof server.request>[0],
  init?: RequestInit,
) {
  await seedProtocolDatabase()
  const headers = new Headers(init?.headers)
  return server.request(input, { ...init, headers })
}
