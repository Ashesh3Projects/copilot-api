import type { ParsedToolCall } from "./response-tool-calls"
import type { ParsedResponsesBody } from "./responses-body"
import type { LlmDebugLogRequest } from "./types"

export const REQUEST_EXPORT_MEDIA_TYPES = {
  curl: "text/plain;charset=utf-8",
  http: "message/http;charset=utf-8",
  json: "application/json;charset=utf-8",
} as const

export const RESPONSE_EXPORT_MEDIA_TYPES = {
  http: "message/http;charset=utf-8",
  json: "application/json;charset=utf-8",
  markdown: "text/markdown;charset=utf-8",
} as const

export interface HttpResponseExportSource {
  body: string | null
  headers: Record<string, string>
  status: number
  statusText: string
}

interface DownloadAnchor {
  click: () => void
  download: string
  href: string
  remove: () => void
}

interface DownloadDocument {
  body: {
    append: (anchor: DownloadAnchor) => void
  }
  createElement: (tagName: "a") => DownloadAnchor
}

export interface DownloadEnvironment {
  createObjectURL: (blob: Blob) => string
  document: DownloadDocument
  revokeObjectURL: (url: string) => void
}

interface FormattedToolArguments {
  language: "json" | "text"
  value: string
}

function formattedToolArguments(
  toolCall: ParsedToolCall,
): FormattedToolArguments {
  if (toolCall.argumentsJson !== null) {
    return {
      language: "json",
      value: JSON.stringify(toolCall.argumentsJson, null, 2),
    }
  }
  return { language: "text", value: toolCall.arguments }
}

export function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function buildCurlRequest(request: LlmDebugLogRequest): string {
  const lines = [
    `curl --request ${quotePosixShell(request.method.toUpperCase())}`,
    `  --url ${quotePosixShell(request.url)}`,
  ]
  for (const [key, value] of Object.entries(request.headers)) {
    lines.push(`  --header ${quotePosixShell(`${key}: ${value}`)}`)
  }
  if (request.body !== null) {
    lines.push(`  --data-raw ${quotePosixShell(request.body)}`)
  }
  return lines.join(" \\\n")
}

export function buildRawHttpRequest(request: LlmDebugLogRequest): string {
  let target = request.path
  let host: string | undefined
  try {
    const url = new URL(request.url)
    target = `${url.pathname}${url.search}`
    host = url.host
  } catch {
    // Preserve the captured path when the captured URL cannot be parsed.
  }

  const headers = Object.entries(request.headers)
  const hasHost = headers.some(([key]) => key.toLowerCase() === "host")
  const lines = [`${request.method.toUpperCase()} ${target} HTTP/1.1`]
  if (host && !hasHost) lines.push(`Host: ${host}`)
  for (const [key, value] of headers) lines.push(`${key}: ${value}`)
  lines.push("", request.body ?? "")
  return lines.join("\r\n")
}

export function formatRequestJson(body: string | null): string | null {
  if (body === null) return null
  try {
    return `${JSON.stringify(JSON.parse(body), null, 2)}\n`
  } catch {
    return null
  }
}

function fencedCode(language: "json" | "text", value: string): string {
  let longestBacktickRun = 0
  for (const match of value.matchAll(/`+/g)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length)
  }
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1))
  return `${fence}${language}\n${value}\n${fence}`
}

function toolCallMarkdown(toolCall: ParsedToolCall, index: number): string {
  const metadata = [
    toolCall.name ? `Name: ${toolCall.name}` : null,
    toolCall.callId ? `Call ID: ${toolCall.callId}` : null,
    toolCall.id ? `Item ID: ${toolCall.id}` : null,
  ].filter((line): line is string => line !== null)
  const formatted = formattedToolArguments(toolCall)
  return [
    `### Tool call ${index + 1}`,
    metadata.length > 0 ? fencedCode("text", metadata.join("\n")) : null,
    fencedCode(formatted.language, formatted.value),
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n")
}

export function buildAssistantOutputMarkdown(
  parsed: ParsedResponsesBody | null,
): string | null {
  if (!parsed || (!parsed.assistantText && parsed.toolCalls.length === 0)) {
    return null
  }

  const sections = ["# Assistant output"]
  if (parsed.assistantText) {
    sections.push(parsed.assistantText)
  } else {
    const count = parsed.toolCalls.length
    const noun = count === 1 ? "tool call" : "tool calls"
    sections.push(
      `The model returned ${count} ${noun} and no assistant message.`,
    )
  }

  if (parsed.toolCalls.length > 0) {
    sections.push(
      "## Tool calls",
      parsed.toolCalls
        .map((toolCall, index) => toolCallMarkdown(toolCall, index))
        .join("\n\n"),
    )
  }
  return `${sections.join("\n\n")}\n`
}

function formattedJson(body: string | null): string | null {
  if (body === null) return null
  try {
    return `${JSON.stringify(JSON.parse(body), null, 2)}\n`
  } catch {
    return null
  }
}

export function buildResponseJson(
  response: HttpResponseExportSource | undefined,
  parsed: ParsedResponsesBody | null,
): string | null {
  const direct = formattedJson(response?.body ?? null)
  if (direct !== null) return direct
  if (!parsed) return null

  return `${JSON.stringify(
    {
      status: parsed.status,
      assistantText: parsed.assistantText,
      toolCalls: parsed.toolCalls,
      reasoningText: parsed.reasoningText,
      errorMessage: parsed.errorMessage,
      usage: parsed.usage,
      copilotUsage: parsed.copilotUsage,
      response: parsed.response,
      events: parsed.events,
    },
    null,
    2,
  )}\n`
}

export function buildRawHttpResponse(
  response: HttpResponseExportSource,
): string {
  const statusLine = `HTTP/1.1 ${response.status} ${response.statusText}`
  const lines = [statusLine]
  for (const [key, value] of Object.entries(response.headers)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push("")
  return `${lines.join("\r\n")}\r\n${response.body ?? ""}`
}

export function downloadTextFile(
  filename: string,
  contents: string,
  type: string,
): void {
  downloadTextFileWithEnvironment(
    { contents, filename, type },
    defaultDownloadEnvironment(),
  )
}

export function downloadTextFileWithEnvironment(
  file: { contents: string; filename: string; type: string },
  environment: DownloadEnvironment,
): void {
  const { contents, filename, type } = file
  const objectUrl = environment.createObjectURL(new Blob([contents], { type }))
  try {
    const anchor = environment.document.createElement("a")
    anchor.href = objectUrl
    anchor.download = filename
    environment.document.body.append(anchor)
    try {
      anchor.click()
    } finally {
      anchor.remove()
    }
  } finally {
    environment.revokeObjectURL(objectUrl)
  }
}

function defaultDownloadEnvironment(): DownloadEnvironment {
  const globals = globalThis as typeof globalThis & {
    document: DownloadDocument
  }
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    document: globals.document,
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  }
}

export function exportErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ?
      error.message
    : "Export failed"
}

export function reportExportError(
  onError: ((message: string) => void) | undefined,
  error: unknown,
): string {
  const message = exportErrorMessage(error)
  onError?.(message)
  return message
}
