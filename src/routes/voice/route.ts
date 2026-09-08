import consola from "consola"

import { resolveRequestCredential } from "~/lib/credential-resolver"
import { resolveProtectedCredential } from "~/lib/protected-credential"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { admitWebSocketTurn } from "~/lib/storage/websocket-admission"

import { transcribe } from "./groq-stt"
import { pcmToWav } from "./pcm-to-wav"

export interface VoiceSession {
  authenticationRequest?: Request
  pcmChunks: Array<Uint8Array>
  totalBytes: number
  language: string
  finalized: boolean
  released: boolean
  transcriptionAbort?: AbortController
}

export type VoiceUpgradeResult = "upgraded" | "auth_failed" | "no_match"

function createSession(language: string, request: Request): VoiceSession {
  return {
    authenticationRequest: new Request(request.url, {
      headers: request.headers,
    }),
    pcmChunks: [],
    totalBytes: 0,
    language,
    finalized: false,
    released: false,
  }
}

function appendAudio(session: VoiceSession, data: Uint8Array): void {
  session.pcmChunks.push(data)
  session.totalBytes += data.length
}

function getAudioBuffer(session: VoiceSession): Uint8Array {
  const buffer = new Uint8Array(session.totalBytes)
  let offset = 0
  for (const chunk of session.pcmChunks) {
    buffer.set(chunk, offset)
    offset += chunk.length
  }
  return buffer
}

function clearAudio(session: VoiceSession): void {
  session.pcmChunks = []
  session.totalBytes = 0
}

function isSessionReleased(session: VoiceSession): boolean {
  return session.released
}

function releaseSession(session: VoiceSession): void {
  if (session.released) return
  session.released = true
  session.transcriptionAbort?.abort()
  session.authenticationRequest = undefined
  clearAudio(session)
}

function closeAndRelease(
  ws: { close(code?: number, reason?: string): void },
  session: VoiceSession,
  close: { code: number; reason: string },
): void {
  releaseSession(session)
  ws.close(close.code, close.reason)
}

function rejectTranscriptionAdmission(
  session: VoiceSession,
  ws: {
    send(data: string): void
    close(code?: number, reason?: string): void
  },
  status: "unavailable" | "unauthorized",
): void {
  const unavailable = status === "unavailable"
  ws.send(
    JSON.stringify({
      type: "TranscriptError",
      description:
        unavailable ?
          "Database storage is temporarily unavailable."
        : "Authentication failed",
    }),
  )
  closeAndRelease(ws, session, {
    code: unavailable ? 1011 : 1008,
    reason: unavailable ? "Storage unavailable" : "Authentication failed",
  })
}

async function finalizeAudio(
  session: VoiceSession,
  ws: {
    send(data: string | ArrayBuffer | Uint8Array): void
    close(code?: number, reason?: string): void
  },
): Promise<void> {
  if (session.finalized || session.released) return
  session.finalized = true

  if (session.totalBytes === 0) {
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
    clearAudio(session)
    ws.close(1000, "Voice stream complete")
    return
  }

  const pcm = getAudioBuffer(session)
  clearAudio(session)

  try {
    const wav = pcmToWav(pcm)
    session.transcriptionAbort = new AbortController()
    const admission =
      session.authenticationRequest ?
        await admitWebSocketTurn(session.authenticationRequest, [
          "voice:transcribe",
        ])
      : undefined
    if (isSessionReleased(session)) return
    if (admission && admission.status !== "authorized") {
      rejectTranscriptionAdmission(session, ws, admission.status)
      return
    }
    const execute = () =>
      transcribe(wav, session.language, {
        signal: session.transcriptionAbort?.signal,
      })
    const result =
      admission ?
        await withRequestSnapshot(admission.snapshot, execute)
      : await execute()
    if (isSessionReleased(session)) return
    if (result.text) {
      ws.send(JSON.stringify({ type: "TranscriptText", data: result.text }))
    }
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
    ws.close(1000, "Voice stream complete")
  } catch (error) {
    if (isSessionReleased(session)) return
    const message =
      error instanceof Error ? error.message : "Transcription failed"
    consola.error("[voice]", message)
    ws.send(
      JSON.stringify({
        type: "TranscriptError",
        description: "Transcription failed",
      }),
    )
    ws.close(1011, "Transcription failed")
  }
}

export const voiceWebSocket = {
  open(_ws: { data: { session: VoiceSession } }) {
    consola.debug("[voice] WebSocket connected")
  },

  message(
    ws: {
      data: { session: VoiceSession }
      send(data: string | ArrayBuffer | Uint8Array): void
      close(code?: number, reason?: string): void
    },
    message: string | Buffer | Uint8Array,
  ) {
    const session = ws.data.session
    if (session.finalized || session.released) return

    if (typeof message !== "string") {
      const audio =
        message instanceof Uint8Array ? message : new Uint8Array(message)
      appendAudio(session, audio)
      return
    }

    let parsed: { type?: unknown }
    try {
      parsed = JSON.parse(message) as { type?: unknown }
    } catch {
      closeAndRelease(ws, session, {
        code: 4007,
        reason: "Invalid voice control message",
      })
      return
    }

    if (parsed.type === "CloseStream") {
      void finalizeAudio(session, ws)
    } else if (parsed.type !== "KeepAlive") {
      closeAndRelease(ws, session, {
        code: 4007,
        reason: "Invalid voice control message",
      })
    }
  },

  close(ws: { data: { session: VoiceSession } }) {
    releaseSession(ws.data.session)
    consola.debug("[voice] WebSocket closed")
  },
}

export const VOICE_WS_PATH = "/api/ws/speech_to_text/voice_stream"

export async function tryUpgradeVoiceWebSocket(
  req: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): Promise<VoiceUpgradeResult> {
  const url = new URL(req.url)
  if (url.pathname !== VOICE_WS_PATH) return "no_match"

  const auth = await resolveProtectedCredential(
    req,
    async () => await resolveRequestCredential(req, ["voice:transcribe"]),
    { trustClientIp: true },
  )
  if (auth.status !== "authorized") return "auth_failed"

  const origin = req.headers.get("origin")
  const configuredOrigin = process.env.COPILOT_VOICE_ORIGIN?.trim()
  if (origin && (!configuredOrigin || origin !== configuredOrigin)) {
    return "auth_failed"
  }

  const session = createSession(url.searchParams.get("language") ?? "en", req)
  const upgraded = server.upgrade(req, {
    data: { type: "voice" as const, session },
  })
  if (!upgraded) {
    releaseSession(session)
    return "no_match"
  }
  return "upgraded"
}
