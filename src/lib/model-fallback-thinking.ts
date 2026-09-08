import { createHash } from "node:crypto"

const MAX_FOREIGN_FINGERPRINTS = 4096
const CHAT_THINKING_KEYS = [
  "reasoning_text",
  "reasoning_opaque",
  "encrypted_content",
  "reasoning_content",
]
const SIGNATURE_KEYS = [
  "signature",
  "reasoning_opaque",
  "encrypted_content",
  "thoughtSignature",
  "thought_signature",
]
const THINKING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"])

export interface ForeignThinkingState {
  readonly fingerprints: Set<string>
  complete: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function digest(kind: string, value: unknown): string {
  return createHash("sha256")
    .update(`${kind}:${JSON.stringify(value)}`)
    .digest("hex")
}

function signatureFingerprints(block: Record<string, unknown>): Array<string> {
  const values = SIGNATURE_KEYS.flatMap((key) =>
    typeof block[key] === "string" && block[key] ? [block[key]] : [],
  )
  if (block.type === "redacted_thinking" && typeof block.data === "string")
    values.push(block.data)
  // The existing Chat bridge places reasoning_opaque in the Responses item ID.
  if (
    block.type === "reasoning"
    && typeof block.id === "string"
    && !block.id.startsWith("rs_")
    && block.id
  )
    values.push(block.id)
  return values.flatMap((value) => {
    const fingerprints = [digest("signature", value)]
    // The Messages-to-Responses bridge appends the item id to opaque signatures.
    if (typeof value === "string" && value.includes("@rs_"))
      fingerprints.push(
        digest("signature", value.slice(0, value.lastIndexOf("@rs_"))),
      )
    return fingerprints
  })
}

function thinkingFingerprints(
  block: Record<string, unknown>,
  chat: boolean,
): Array<string> {
  const signatures = signatureFingerprints(block)
  if (signatures.length > 0) return signatures
  if (chat) {
    const fields = Object.fromEntries(
      CHAT_THINKING_KEYS.filter((key) => Object.hasOwn(block, key)).map(
        (key) => [key, block[key]],
      ),
    )
    return Object.keys(fields).length > 0 ? [digest("chat", fields)] : []
  }
  const { id: _id, status: _status, ...content } = block
  return [digest("block", content)]
}

function remember(
  foreign: ForeignThinkingState,
  fingerprints: Array<string>,
): void {
  for (const fingerprint of fingerprints) {
    if (foreign.fingerprints.has(fingerprint)) continue
    if (foreign.fingerprints.size === MAX_FOREIGN_FINGERPRINTS) {
      foreign.complete = false
      return
    }
    foreign.fingerprints.add(fingerprint)
  }
}

function matches(
  foreign: ForeignThinkingState,
  block: Record<string, unknown>,
  chat = false,
): boolean {
  return thinkingFingerprints(block, chat).some((fingerprint) =>
    foreign.fingerprints.has(fingerprint),
  )
}

// eslint-disable-next-line complexity -- bounded traversal of four protocol history shapes
function visitThinking(
  payload: unknown,
  visit: (block: Record<string, unknown>, chat: boolean) => void,
): void {
  if (!record(payload)) return
  for (const message of Array.isArray(payload.messages) ?
    payload.messages
  : []) {
    if (!record(message) || message.role !== "assistant") continue
    if (CHAT_THINKING_KEYS.some((key) => Object.hasOwn(message, key)))
      visit(message, true)
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (record(block) && THINKING_TYPES.has(String(block.type)))
        visit(block, false)
    }
  }
  for (const item of Array.isArray(payload.input) ? payload.input : []) {
    if (!record(item)) continue
    if (item.type === "reasoning") visit(item, false)
    else visitThinking({ messages: [item] }, visit)
  }
  for (const content of Array.isArray(payload.contents) ?
    payload.contents
  : []) {
    if (!record(content) || content.role !== "model") continue
    for (const part of Array.isArray(content.parts) ? content.parts : []) {
      if (
        record(part)
        && (part.thought === true || signatureFingerprints(part).length > 0)
      )
        visit(part, false)
    }
  }
}

export function captureForeignThinking(
  payload: unknown,
  previous?: ForeignThinkingState,
): ForeignThinkingState {
  const foreign = previous ?? {
    fingerprints: new Set<string>(),
    complete: true,
  }
  visitThinking(payload, (block, chat) =>
    remember(foreign, thinkingFingerprints(block, chat)),
  )
  return foreign
}

export function mergeForeignThinking(
  left: ForeignThinkingState,
  right: ForeignThinkingState,
): ForeignThinkingState {
  const merged: ForeignThinkingState = {
    fingerprints: new Set(left.fingerprints),
    complete: left.complete && right.complete,
  }
  remember(merged, [...right.fingerprints])
  return merged
}

function filterMessage(
  message: Record<string, unknown>,
  foreign: ForeignThinkingState,
): boolean {
  if (message.role !== "assistant") return false
  let removed = false
  if (matches(foreign, message, true)) {
    for (const key of CHAT_THINKING_KEYS) Reflect.deleteProperty(message, key)
    removed = true
  }
  if (Array.isArray(message.content)) {
    const previousLength = message.content.length
    const retained = message.content.filter(
      (block) =>
        !record(block)
        || !THINKING_TYPES.has(String(block.type))
        || !matches(foreign, block),
    )
    message.content = retained
    removed ||= retained.length !== previousLength
  }
  return removed
}

export function hasRetainedAssistantContent(
  message: Record<string, unknown>,
): boolean {
  return (
    message.role !== "assistant"
    || (typeof message.content === "string" && message.content.length > 0)
    || (Array.isArray(message.content) && message.content.length > 0)
    || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
  )
}

export function filterForeignThinking(
  payload: unknown,
  foreign: ForeignThinkingState,
): void {
  if (!record(payload) || foreign.fingerprints.size === 0) return
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.filter(
      (message) =>
        !record(message)
        || !filterMessage(message, foreign)
        || hasRetainedAssistantContent(message),
    )
  }
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.filter(
      (item) =>
        !record(item) || item.type !== "reasoning" || !matches(foreign, item),
    )
    payload.input = (payload.input as Array<unknown>).filter(
      (item) =>
        !record(item)
        || !filterMessage(item, foreign)
        || hasRetainedAssistantContent(item),
    )
  }
  for (const content of Array.isArray(payload.contents) ?
    payload.contents
  : []) {
    if (
      !record(content)
      || content.role !== "model"
      || !Array.isArray(content.parts)
    )
      continue
    content.parts = content.parts.filter(
      (part) =>
        !record(part) || part.thought !== true || !matches(foreign, part),
    )
    for (const part of content.parts as Array<unknown>) {
      if (!record(part) || !matches(foreign, part)) continue
      Reflect.deleteProperty(part, "thoughtSignature")
      Reflect.deleteProperty(part, "thought_signature")
    }
  }
}
