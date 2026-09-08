import { expect, test } from "bun:test"

import {
  canReplayCapture,
  captureOmissionMessage,
} from "../ui/src/lib/capture-state"

test("replay requires an intact captured body and supported endpoint", () => {
  const detail = {
    replayable: true,
    request: { method: "POST", path: "/responses", body: "{}" },
  }
  expect(canReplayCapture(detail)).toBe(true)
  expect(canReplayCapture({ ...detail, replayable: false })).toBe(false)
  expect(
    canReplayCapture({ ...detail, request: { ...detail.request, body: null } }),
  ).toBe(false)
  expect(
    canReplayCapture({
      ...detail,
      request: { ...detail.request, path: "/embeddings" },
    }),
  ).toBe(false)
})

test("capture omissions distinguish redaction, size limits and interruption", () => {
  expect(captureOmissionMessage({ redacted: true }, "complete")).toContain(
    "redacted",
  )
  expect(
    captureOmissionMessage({ omittedReason: "size-limit" }, "complete"),
  ).toContain("capture limit")
  expect(captureOmissionMessage({}, "interrupted")).toContain("interrupted")
  expect(captureOmissionMessage({}, "complete")).toBeUndefined()
})

test("redacted and omitted captures remain editable but require a deliberate replacement body", async () => {
  const { canEditReplayCapture, hasReplacementReplayBody } = await import(
    "../ui/src/lib/capture-state"
  )
  const detail = {
    replayable: false,
    request: { method: "POST", path: "/responses", body: null },
  }
  expect(canEditReplayCapture(detail)).toBe(true)
  expect(
    canEditReplayCapture({
      ...detail,
      request: { ...detail.request, path: "/embeddings" },
    }),
  ).toBe(false)
  expect(
    hasReplacementReplayBody(
      '{"input":"[REDACTED]"}',
      '{"input":"[REDACTED]"}',
    ),
  ).toBe(false)
  expect(
    hasReplacementReplayBody(
      '{"input":"[REDACTED]"}',
      '{"input":"[REDACTED]","model":"other"}',
    ),
  ).toBe(false)
  expect(
    hasReplacementReplayBody(
      '{"input":"[REDACTED]"}',
      '{"input":"replacement"}',
    ),
  ).toBe(true)
  expect(hasReplacementReplayBody("", "")).toBe(false)
})
