export interface CaptureState {
  redacted?: boolean
  omittedReason?: string
  truncated?: boolean
  bodyBytesComplete?: boolean
}
export function canEditReplayCapture(detail: {
  request: { method: string; path: string }
}): boolean {
  return (
    detail.request.method.toUpperCase() === "POST"
    && ["/chat/completions", "/responses"].includes(detail.request.path)
  )
}
export function hasReplacementReplayBody(
  original: string,
  edited: string,
): boolean {
  return edited.trim().length > 0 && edited !== original
}
export function canReplayCapture(detail: {
  replayable: boolean
  request: CaptureState & { method: string; path: string; body: string | null }
}): boolean {
  return (
    detail.request.body !== null
    && !detail.request.redacted
    && !detail.request.omittedReason
    && !detail.request.truncated
    && detail.request.bodyBytesComplete !== false
    && canEditReplayCapture(detail)
  )
}
export function captureOmissionMessage(
  capture: CaptureState,
  status: string,
): string | undefined {
  if (capture.redacted)
    return "This capture was filtered by an older version. Its original values are unavailable; edit the request before replaying. New captures retain raw values."
  if (capture.omittedReason === "size-limit")
    return "Body omitted because it exceeded the diagnostic capture limit. Client traffic was not limited."
  if (capture.omittedReason)
    return (
      "Body unavailable ("
      + capture.omittedReason
      + "). Client traffic was not limited."
    )
  if (capture.truncated || capture.bodyBytesComplete === false)
    return "Only part of the body was captured; the recorded byte count may be a lower bound."
  if (status === "interrupted")
    return "Capture was interrupted by shutdown or collection limits; history may be incomplete."
  return undefined
}
