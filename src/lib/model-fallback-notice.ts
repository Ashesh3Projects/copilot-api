import type { getModelFallbackNotice } from "~/lib/model-fallback"

type FallbackNotice = ReturnType<typeof getModelFallbackNotice>
type NoticeSource = FallbackNotice | (() => FallbackNotice)
const resolveNotice = (source: NoticeSource): FallbackNotice =>
  typeof source === "function" ? source() : source
interface NoticeRequest {
  payload: unknown
  headers: Headers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function supportsMessagesFallback(request: NoticeRequest): boolean {
  if (!isRecord(request.payload)) return false
  const fallbacks = request.payload.fallbacks
  const requested =
    fallbacks === "default"
    || (Array.isArray(fallbacks)
      && fallbacks.length > 0
      && fallbacks.every(
        (entry) =>
          isRecord(entry)
          && typeof entry.model === "string"
          && entry.model.trim().length > 0,
      ))
  const betas =
    request.headers
      .get("anthropic-beta")
      ?.split(",")
      .map((value) => value.trim()) ?? []
  return (
    requested
    && betas.some(
      (beta) =>
        beta === "server-side-fallback-2026-06-01"
        || beta === "server-side-fallback-2026-07-01",
    )
  )
}

function hasFallback(content: unknown): boolean {
  return (
    Array.isArray(content)
    && content.some((block) => isRecord(block) && block.type === "fallback")
  )
}

function fallbackBlock(notice: NonNullable<FallbackNotice>) {
  return {
    type: "fallback",
    from: { model: notice.sourceModel },
    to: { model: notice.targetModel },
  }
}

/** Claude's server fallback lane is explicitly advertised by field and beta. */
export async function applyMessagesModelFallbackNotice(
  response: Response,
  request: NoticeRequest,
  source: NoticeSource,
): Promise<Response> {
  const notice = resolveNotice(source)
  if (
    !response.ok
    || !response.body
    || !noticeMayBeEnabled(source)
    || !supportsMessagesFallback(request)
  )
    return response
  const headers = new Headers(response.headers)
  const contentType = headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    headers.delete("content-length")
    return new Response(
      response.body.pipeThrough(createNoticeTransform(source)),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    )
  }
  if (!notice?.nativeClientNotice) return response
  if (!contentType.includes("application/json")) return response
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined)
  if (
    !isRecord(body)
    || body.type !== "message"
    || !Array.isArray(body.content)
    || body.stop_reason === "refusal"
    || hasFallback(body.content)
  )
    return response
  headers.delete("content-length")
  return new Response(
    JSON.stringify({
      ...body,
      content: [fallbackBlock(notice), ...(body.content as Array<unknown>)],
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  )
}

function createNoticeTransform(
  source: NoticeSource,
): TransformStream<Uint8Array, Uint8Array> {
  let started = false
  let decided = false
  let shift = false

  function transformFrame(frame: string): string {
    const lines = frame.split(/\r?\n/u)
    const json = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    let event: unknown
    try {
      event = JSON.parse(json)
    } catch {
      return `${frame}\n\n`
    }
    if (!isRecord(event)) return `${frame}\n\n`
    const type = event.type
    if (type === "message_start") {
      started = true
      decided = hasMessageFallback(event.message)
    }
    if (type === "error") decided = true
    let prefix = ""
    if (started && !decided && type === "content_block_start") {
      decided = true
      const notice = resolveNotice(source)
      if (notice?.nativeClientNotice && !hasFallback([event.content_block])) {
        shift = true
        prefix =
          encodeEvent({
            type: "content_block_start",
            index: 0,
            content_block: fallbackBlock(notice),
          }) + encodeEvent({ type: "content_block_stop", index: 0 })
      }
    }
    if (shift && hasContentIndex(event)) {
      return prefix + encodeEvent({ ...event, index: event.index + 1 })
    }
    return prefix + `${frame}\n\n`
  }

  return createSseFrameTransform(transformFrame)
}

export function applyResponsesModelFallbackNotice(
  response: Response,
  source: NoticeSource,
): Response {
  if (
    !response.ok
    || !response.body
    || !noticeMayBeEnabled(source)
    || !response.headers.get("content-type")?.includes("text/event-stream")
  )
    return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(
    response.body.pipeThrough(
      createSseFrameTransform((frame) => {
        const notice = resolveNotice(source)
        if (!notice?.nativeClientNotice) return `${frame}\n\n`
        const event = parseSseRecord(frame)
        if (
          !event
          || (event.type !== "response.created"
            && event.type !== "response.completed")
        )
          return `${frame}\n\n`
        if (isRecord(event.response) && event.response.status === "failed")
          return `${frame}\n\n`
        return encodeEvent({
          ...event,
          headers: noticeHeaders(event.headers, notice.targetModel),
          ...(isRecord(event.response) ?
            {
              response: {
                ...event.response,
                headers: noticeHeaders(
                  event.response.headers,
                  notice.targetModel,
                ),
              },
            }
          : {}),
        })
      }),
    ),
    { status: response.status, statusText: response.statusText, headers },
  )
}

const SAFE_NOTICE_HEADERS = new Set([
  "x-copilot-api-exp-assignment-context",
  "x-copilot-service-request-id",
  "x-github-copilot-request-te",
  "x-github-request-id",
  "x-copilot-api-fallback-from",
  "x-copilot-api-fallback-to",
  "x-copilot-api-fallback-reason",
  "x-copilot-api-fallback-cached",
])

function noticeHeaders(value: unknown, model: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (isRecord(value))
    for (const [key, entry] of Object.entries(value)) {
      const name = key.toLowerCase()
      if (
        typeof entry === "string"
        && (SAFE_NOTICE_HEADERS.has(name)
          || name.startsWith("x-quota-snapshot-"))
      )
        headers[name] = entry
    }
  headers["openai-model"] = model
  return headers
}

function parseSseRecord(frame: string): Record<string, unknown> | undefined {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  try {
    const parsed: unknown = JSON.parse(data)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function createSseFrameTransform(
  transformFrame: (frame: string) => string,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  function flushFrames(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/u.exec(pending))) {
      const frame = pending.slice(0, boundary.index)
      pending = pending.slice(boundary.index + boundary[0].length)
      controller.enqueue(encoder.encode(transformFrame(frame)))
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      flushFrames(controller)
    },
    flush(controller) {
      pending += decoder.decode()
      flushFrames(controller)
      if (pending) controller.enqueue(encoder.encode(pending))
    },
  })
}

function encodeEvent(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
}

function hasMessageFallback(message: unknown): boolean {
  return isRecord(message) && hasFallback(message.content)
}

function noticeMayBeEnabled(source: NoticeSource): boolean {
  return typeof source === "function" || source?.nativeClientNotice === true
}

function hasContentIndex(
  event: Record<string, unknown>,
): event is Record<string, unknown> & { index: number } {
  return (
    typeof event.type === "string"
    && event.type.startsWith("content_block_")
    && typeof event.index === "number"
    && Number.isInteger(event.index)
  )
}
