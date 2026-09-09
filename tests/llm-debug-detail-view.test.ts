import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { requestPayloadView } from "../ui/src/lib/llm-debug-detail-view"

function screenSource(): string {
  return fs.readFileSync(
    path.join(import.meta.dir, "..", "ui", "src", "screens", "LlmDebug.tsx"),
    "utf8",
  )
}

test("selects request views from one already-parsed body", () => {
  const body = "exact request body"
  const parsed = {
    formatted: '{\n  "model": "gpt-test",\n  "input": "Hello"\n}',
    value: { input: "Hello", model: "gpt-test" },
  }

  expect(requestPayloadView(body, parsed, "pretty")).toEqual({
    formatted: parsed.formatted,
    kind: "tree",
    value: parsed.value,
  })
  expect(requestPayloadView(body, parsed, "raw")).toEqual({
    kind: "virtualized",
    language: "json",
    value: body,
  })
})

test("falls back to virtualized text when a request body is not JSON", () => {
  const pretty = requestPayloadView("not JSON", null, "pretty")
  const raw = requestPayloadView("not JSON", null, "raw")

  expect(pretty).toEqual({
    kind: "virtualized",
    language: "text",
    value: "not JSON",
  })
  expect(raw).toEqual(pretty)
})

test("keeps request mode local to the request payload", () => {
  const source = screenSource()
  const requestPayload = source.match(/<PayloadBlock[\s\S]*?\/>/)?.[0]
  const responseInspector = source.match(/<ResponseInspector[\s\S]*?\/>/)?.[0]

  expect(source.match(/<RequestExportMenu/g)).toHaveLength(1)
  expect(source.match(/<ResponseInspector/g)).toHaveLength(1)
  expect(requestPayload).toContain("viewMode={requestViewMode}")
  expect(responseInspector).toContain("responseIdentity={id}")
  expect(responseInspector).not.toContain("requestViewMode")
})

test("removes selectors owned by the retired response body viewer", () => {
  const css = fs.readFileSync(
    path.join(import.meta.dir, "..", "ui", "src", "global.css"),
    "utf8",
  )

  expect(css).not.toContain(".responses-pretty-view")
  expect(css).not.toContain(".responses-event-detail")
})

test("Refresh resets debug pagination and Latest is absent", () => {
  const source = screenSource()
  expect(source).not.toContain('label="Latest"')
  const refresh = source.match(
    /function refreshLatest\(\) \{([\s\S]*?)\n {2}\}/,
  )?.[1]
  expect(refresh).toContain("setCursor(undefined)")
  expect(refresh).toContain("reload()")
  expect(source).toContain("onRefresh={refreshLatest}")
})

test("replay screen has no gate or warning based solely on legacy redaction", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dir, "..", "ui", "src", "screens", "LlmReplay.tsx"),
    "utf8",
  )
  expect(source).not.toContain("data?.replayable")
  expect(source).not.toContain("!data.replayable")
  expect(source).not.toContain("replace any redacted values")
})
