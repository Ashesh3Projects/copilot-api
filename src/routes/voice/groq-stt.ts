import { getConfig } from "~/lib/config"
import { getGroqApiKey } from "~/lib/custom-providers"

export interface TranscriptionResult {
  text: string
}

export interface TranscribeOptions {
  contentType?: string
  filename?: string
  signal?: AbortSignal
}

/**
 * Sends an audio buffer to Groq's Whisper API for transcription.
 * Defaults to a WAV envelope (used by the streaming voice WebSocket).
 * Pass `contentType`/`filename` to forward other formats (e.g. WebM from Codex Desktop dictation).
 */
export async function transcribe(
  audio: Uint8Array,
  language?: string,
  options: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const config = getConfig()
  const apiKey = getGroqApiKey()

  if (!apiKey) {
    throw new Error("Groq API key is not configured")
  }

  const model = config.groqModel ?? "whisper-large-v3-turbo"
  const url = "https://api.groq.com/openai/v1/audio/transcriptions"
  const contentType = options.contentType ?? "audio/wav"
  const filename = options.filename ?? "audio.wav"

  const formData = new FormData()
  formData.append("file", new Blob([audio], { type: contentType }), filename)
  formData.append("model", model)
  formData.append("response_format", "json")

  if (language && language !== "auto") {
    formData.append("language", language)
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal: options.signal,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Groq API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as { text?: string }
  return { text: data.text?.trim() ?? "" }
}
