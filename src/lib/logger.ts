import consola, { type ConsolaInstance } from "consola"
import util from "node:util"

import {
  readDescriptorSnapshotValue,
  snapshotDescriptorChain,
} from "./descriptor-chain"
import { state } from "./state"

const OMITTED_HANDLER_LOG_OBJECT = "[OBJECT OMITTED]"
const SAFE_HANDLER_LOG_ERROR_NAMES = new Set([
  "AbortError",
  "Error",
  "TypeError",
])
const SAFE_HANDLER_LOG_ENUMS = new Set([
  "aborted",
  "cancelled",
  "chat",
  "completed",
  "complete",
  "connection",
  "error",
  "exhausted",
  "failed",
  "incomplete",
  "messages",
  "network",
  "pending",
  "rejected",
  "response_received",
  "responses",
  "retrying",
  "streaming",
  "/chat/completions",
  "/responses",
  "/v1/messages",
])
const SAFE_HANDLER_LOG_STRING_FIELDS = new Set([
  "destination",
  "errorClass",
  "event",
  "inputKind",
  "outcome",
  "path",
  "provider",
  "reason",
  "source",
  "status",
  "target",
  "terminalStatus",
  "transport",
  "type",
])
const SAFE_HANDLER_LOG_MESSAGES = new Set([
  "Anthropic Beta header present:",
  "ChatCompletions fallback streaming",
  "Compact ChatCompletions result received",
  "Compact request for model:",
  "Compact Responses result received",
  "Copilot raw stream event:",
  "Detected Subagent marker",
  "Forwarding native Responses result",
  "Forwarding native Responses stream",
  "Google AI request payload:",
  "Is compact request:",
  "Native messages stream failed",
  "Non-streaming response from Copilot:",
  "Non-streaming Responses result:",
  "Prepared Anthropic bridge request",
  "Prepared request",
  "Prepared Chat fallback request",
  "Prepared translated Chat request",
  "Prepared translated Responses request",
  "Received Anthropic request",
  "Received Chat fallback response",
  "Received native Messages response",
  "Received non-streaming Chat response",
  "Received non-streaming Responses result",
  "Received Responses request",
  "Reduced oversized Responses fallback compaction payload",
  "Responses raw stream event:",
  "Routing custom model",
  "Responses stream ended without completion; sending error event",
  "Streaming native /v1/messages response",
  "Streaming response from Copilot",
  "Streaming response from Copilot (Responses API)",
  "Translated Anthropic response",
  "Translated custom provider Anthropic response",
  "Translated OpenAI payload:",
  "Translated Responses payload:",
  "Using function tool apply_patch for responses",
])
const HANDLER_LOG_DESCRIPTOR_KEYS = new Set(["name"])
const HANDLER_LOG_DESCRIPTOR_DEPTH = 5

export const sanitizeHandlerLogArguments = (args: Array<unknown>) =>
  args.map((arg, index) =>
    index === 0 && typeof arg === "string" ?
      sanitizeHandlerLogMessage(arg)
    : sanitizeHandlerLogValue(arg),
  )

const formatArgs = (args: Array<unknown>) =>
  sanitizeHandlerLogArguments(args)
    .map((arg) =>
      typeof arg === "string" ? arg : (
        util.inspect(arg, { depth: 4, colors: false })
      ),
    )
    .join(" ")

function sanitizeHandlerLogValue(value: unknown): unknown {
  if (typeof value === "string") return "[REDACTED]"
  if (typeof value !== "object" || value === null)
    return sanitizeHandlerLogPrimitive(value)
  if (isHandlerLogProxy(value)) return OMITTED_HANDLER_LOG_OBJECT
  const descriptors = getSafeOwnPropertyDescriptors(value)
  if (!descriptors) return OMITTED_HANDLER_LOG_OBJECT
  if (Array.isArray(value)) return sanitizeHandlerLogArray(descriptors)
  const descriptorSnapshot = snapshotDescriptorChain(value, {
    keys: HANDLER_LOG_DESCRIPTOR_KEYS,
    maxDepth: HANDLER_LOG_DESCRIPTOR_DEPTH,
  })
  if (!descriptorSnapshot) return OMITTED_HANDLER_LOG_OBJECT
  if (descriptorSnapshot.errorKind) {
    return sanitizeHandlerLogError(descriptorSnapshot)
  }
  if (!isPlainHandlerLogRecord(value)) return OMITTED_HANDLER_LOG_OBJECT

  const sanitized: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) {
      sanitized[key] = OMITTED_HANDLER_LOG_OBJECT
      continue
    }
    sanitized[key] = sanitizeHandlerLogField(key, descriptor.value)
  }
  return sanitized
}

function sanitizeHandlerLogPrimitive(value: unknown): unknown {
  return (
      typeof value === "number" || typeof value === "boolean" || value === null
    ) ?
      value
    : "[REDACTED]"
}

function readHandlerLogDescriptorValue(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): unknown {
  if (!Object.hasOwn(descriptors, key)) return undefined
  const descriptor = descriptors[key]
  return "value" in descriptor ? descriptor.value : undefined
}

function sanitizeHandlerLogArray(
  descriptors: Record<string, PropertyDescriptor>,
): string {
  const length = readHandlerLogDescriptorValue(descriptors, "length")
  return typeof length === "number" && Number.isSafeInteger(length) ?
      `[${length} items omitted]`
    : OMITTED_HANDLER_LOG_OBJECT
}

function sanitizeHandlerLogMessage(value: string): string {
  if (SAFE_HANDLER_LOG_MESSAGES.has(value)) return value

  for (const message of SAFE_HANDLER_LOG_MESSAGES) {
    if (value.startsWith(message)) return message.replace(/:$/, "")
  }

  return "Log"
}

function sanitizeHandlerLogField(key: string, value: unknown): unknown {
  if (typeof value !== "string") return sanitizeHandlerLogValue(value)
  if (
    SAFE_HANDLER_LOG_STRING_FIELDS.has(key)
    && SAFE_HANDLER_LOG_ENUMS.has(value)
  ) {
    return value
  }
  return "[REDACTED]"
}

function sanitizeHandlerLogError(
  snapshot: ReturnType<typeof snapshotDescriptorChain>,
): { name: string } {
  const ownName = readDescriptorSnapshotValue(snapshot, "name")
  const errorName = ownName ?? snapshot?.errorKind
  if (
    typeof errorName === "string"
    && SAFE_HANDLER_LOG_ERROR_NAMES.has(errorName)
  ) {
    return { name: errorName }
  }
  return { name: "Error" }
}

function isHandlerLogProxy(value: object): boolean {
  try {
    return util.types.isProxy(value)
  } catch {
    return true
  }
}

function getSafeOwnPropertyDescriptors(
  value: object,
): Record<string, PropertyDescriptor> | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value)
  } catch {
    return undefined
  }
}

function isPlainHandlerLogRecord(value: object): boolean {
  try {
    const prototype: unknown = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const sanitizeName = (name: string) => {
  const normalized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

  return normalized === "" ? "handler" : normalized
}

export const createHandlerLogger = (name: string): ConsolaInstance => {
  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(sanitizedName)
  if (state.verbose) instance.level = 5
  instance.setReporters([createHandlerLogReporter(sanitizedName)])
  return instance
}

export function formatHandlerLogLine(options: {
  args: Array<unknown>
  date: Date
  name: string
  tag?: string
  type: string
}): string {
  const timestamp = options.date.toLocaleString("sv-SE", { hour12: false })
  const message = formatArgs(options.args)
  return `[${timestamp}] [${options.type}] [${options.tag || options.name}]${
    message ? ` ${message}` : ""
  }`
}

function createHandlerLogReporter(name: string) {
  return {
    log(logObj: {
      args: Array<unknown>
      date: Date
      tag?: string
      type: string
    }) {
      const line = formatHandlerLogLine({ ...logObj, name, tag: name })
      const output =
        (
          logObj.type === "error"
          || logObj.type === "fatal"
          || logObj.type === "warn"
        ) ?
          process.stderr
        : process.stdout
      output.write(`${line}\n`)
    },
  }
}
