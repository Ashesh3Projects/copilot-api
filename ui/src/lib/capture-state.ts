export interface CaptureState {
  redacted?: boolean
  omittedReason?: string
}
export function canReplayCapture(detail: {
  replayable: boolean
  request: { method: string; path: string; body: string | null }
}): boolean {
  return (
    detail.replayable
    && detail.request.body !== null
    && detail.request.method.toUpperCase() === "POST"
    && ["/chat/completions", "/responses"].includes(detail.request.path)
  )
}
export function captureOmissionMessage(
  capture: CaptureState,
  status: string,
): string | undefined {
  if (capture.omittedReason === "size-limit")
    return "Body omitted because it exceeded the diagnostic capture limit. Client traffic was not limited."
  if (capture.omittedReason)
    return (
      "Body unavailable ("
      + capture.omittedReason
      + "). Client traffic was not limited."
    )
  if (capture.redacted)
    return "Sensitive values were redacted from this capture. Replay is unavailable."
  if (status === "interrupted")
    return "Capture was interrupted by shutdown or collection limits; history may be incomplete."
  return undefined
}
