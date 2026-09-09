import { expect, test } from "bun:test"

import {
  canReplayCapture,
  captureOmissionMessage,
} from "../ui/src/lib/capture-state"

test("replay uses the captured body state and supported endpoint", () => {
  const detail = {
    replayable: true,
    request: { method: "POST", path: "/responses", body: "{}" },
  }
  expect(canReplayCapture(detail)).toBe(true)
  expect(canReplayCapture({ ...detail, replayable: false })).toBe(true)
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

test("legacy redacted captures disclose missing originals while new raw captures are complete", () => {
  expect(captureOmissionMessage({ redacted: true }, "complete")).toContain(
    "older version",
  )
  expect(
    canReplayCapture({
      replayable: false,
      request: {
        method: "POST",
        path: "/responses",
        body: '{"token":"[REDACTED]"}',
        redacted: true,
      },
    }),
  ).toBe(false)
  expect(
    captureOmissionMessage({ omittedReason: "size-limit" }, "complete"),
  ).toContain("capture limit")
  expect(captureOmissionMessage({}, "interrupted")).toContain("interrupted")
  expect(captureOmissionMessage({}, "complete")).toBeUndefined()
})

test("replay does not treat a literal redaction marker as a prohibited value", async () => {
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
  ).toBe(true)
  expect(
    hasReplacementReplayBody(
      '{"input":"[REDACTED]"}',
      '{"input":"replacement"}',
    ),
  ).toBe(true)
  expect(hasReplacementReplayBody("", "")).toBe(false)
})
