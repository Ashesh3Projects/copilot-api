import { describe, expect, test } from "bun:test"

import type { DownloadEnvironment } from "../ui/src/lib/http-export"
import type { ParsedResponsesBody } from "../ui/src/lib/responses-body"
import type { LlmDebugLogRequest } from "../ui/src/lib/types"

import {
  REQUEST_EXPORT_MEDIA_TYPES,
  RESPONSE_EXPORT_MEDIA_TYPES,
  buildAssistantOutputMarkdown,
  buildCurlRequest,
  buildRawHttpRequest,
  buildRawHttpResponse,
  buildResponseJson,
  downloadTextFileWithEnvironment,
  exportErrorMessage,
  formatRequestJson,
  quotePosixShell,
  reportExportError,
} from "../ui/src/lib/http-export"

const requestBody = JSON.stringify({ model: "gpt-test", input: "Hello" })
const request: LlmDebugLogRequest = {
  body: requestBody,
  bodyBytes: requestBody.length,
  headers: {
    "content-type": "application/json",
    "x-debug": "true",
  },
  method: "POST",
  path: "/responses",
  url: "https://example.test/responses?mode=debug",
}

const parsed: ParsedResponsesBody = {
  assistantText: "Final answer",
  copilotUsage: { total_nano_aiu: 3 },
  errorMessage: null,
  events: [
    {
      data: { sequence_number: 3, type: "response.completed" },
      rawData: '{"type":"response.completed","sequence_number":3}',
      sequenceNumber: 3,
      type: "response.completed",
    },
  ],
  isPartial: false,
  reasoningText: "Private reasoning",
  response: { id: "resp_1", object: "response", status: "completed" },
  status: "completed",
  toolCalls: [
    {
      arguments: '{"id":7}',
      argumentsJson: { id: 7 },
      callId: "call_1",
      id: "item_1",
      name: "lookup",
      outputIndex: 0,
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
}

describe("HTTP artifact formatting", () => {
  test("defines exact request and response export media types", () => {
    expect(REQUEST_EXPORT_MEDIA_TYPES).toEqual({
      curl: "text/plain;charset=utf-8",
      http: "message/http;charset=utf-8",
      json: "application/json;charset=utf-8",
    })
    expect(RESPONSE_EXPORT_MEDIA_TYPES).toEqual({
      http: "message/http;charset=utf-8",
      json: "application/json;charset=utf-8",
      markdown: "text/markdown;charset=utf-8",
    })
  })

  test("builds a POSIX shell-safe cURL request", () => {
    expect(buildCurlRequest(request)).toBe(
      [
        "curl --request 'POST'",
        "  --url 'https://example.test/responses?mode=debug'",
        "  --header 'content-type: application/json'",
        "  --header 'x-debug: true'",
        `  --data-raw '${requestBody}'`,
      ].join(" \\\n"),
    )
  })

  test("preserves an at-prefixed request body as literal cURL data", () => {
    const command = buildCurlRequest({
      ...request,
      body: "@payload.json",
    })

    expect(command).toContain("--data-raw '@payload.json'")
    expect(command).not.toContain("--data-binary")
  })

  test("quotes adversarial cURL values without allowing shell expansion", () => {
    const adversarialRequest: LlmDebugLogRequest = {
      ...request,
      body: "line 1\n$HOME `whoami` $(id) O'Reilly",
      headers: {
        "x-attack": "$(touch /tmp/pwned) `$HOME` O'Reilly",
      },
      url: "https://example.test/$(id)?value=$HOME&owner=O'Reilly`uname`",
    }
    const command = buildCurlRequest(adversarialRequest)

    expect(quotePosixShell("O'Reilly")).toBe(`'O'"'"'Reilly'`)
    expect(command).toContain(`owner=O'"'"'Reilly\`uname\`'`)
    expect(command).toContain(`\`$HOME\` O'"'"'Reilly'`)
    expect(command).toContain(`$(id) O'"'"'Reilly'`)
    expect(command).not.toContain('"https://')
    expect(command).not.toContain('"x-attack:')
    expect(command).not.toContain('"line 1')
  })

  test("formats request JSON and rejects malformed bodies", () => {
    expect(formatRequestJson(requestBody)).toBe(
      '{\n  "model": "gpt-test",\n  "input": "Hello"\n}\n',
    )
    expect(formatRequestJson('{"model":')).toBeNull()
  })

  test("builds a raw HTTP request with CRLF framing", () => {
    expect(buildRawHttpRequest(request)).toBe(
      [
        "POST /responses?mode=debug HTTP/1.1",
        "Host: example.test",
        "content-type: application/json",
        "x-debug: true",
        "",
        requestBody,
      ].join("\r\n"),
    )
  })

  test("exports the captured headers verbatim alongside the exact Unicode body", () => {
    const body = "Hello, 世界 🌍"
    const exported = buildRawHttpRequest({
      ...request,
      body,
      headers: {
        "X-Before": "one",
        "cOnTeNt-LeNgTh": "999",
        "Content-Encoding": "gzip",
        "TRANSFER-ENCODING": "chunked",
        "content-md5": "stale",
        Digest: "sha-256=stale",
        "X-After": "two",
      },
    })

    expect(exported).toBe(
      [
        "POST /responses?mode=debug HTTP/1.1",
        "Host: example.test",
        "X-Before: one",
        "cOnTeNt-LeNgTh: 999",
        "Content-Encoding: gzip",
        "TRANSFER-ENCODING: chunked",
        "content-md5: stale",
        "Digest: sha-256=stale",
        "X-After: two",
        "",
        body,
      ].join("\r\n"),
    )
  })

  test("preserves captured content length even when the body is empty", () => {
    const exported = buildRawHttpRequest({
      ...request,
      body: "",
      headers: {
        "Content-Length": "999",
        "X-Debug": "true",
      },
    })

    expect(exported).toBe(
      [
        "POST /responses?mode=debug HTTP/1.1",
        "Host: example.test",
        "Content-Length: 999",
        "X-Debug: true",
        "",
        "",
      ].join("\r\n"),
    )
    expect(exported).toContain("Content-Length: 999")
  })
})

describe("Assistant and response formatting", () => {
  test("builds assistant Markdown with formatted tool calls but no reasoning", () => {
    const markdown = buildAssistantOutputMarkdown(parsed)

    expect(markdown).toContain("# Assistant output\n\nFinal answer")
    expect(markdown).toContain("## Tool calls\n\n### Tool call 1")
    expect(markdown).toContain("Name: lookup")
    expect(markdown).toContain('```json\n{\n  "id": 7\n}\n```')
    expect(markdown).not.toContain("Private reasoning")
    expect(markdown?.endsWith("\n")).toBe(true)
  })

  test("describes tool-only output and includes the tool name", () => {
    const markdown = buildAssistantOutputMarkdown({
      ...parsed,
      assistantText: "",
      toolCalls: parsed.toolCalls.slice(0, 1),
    })

    expect(markdown).toContain(
      "The model returned 1 tool call and no assistant message.",
    )
    expect(markdown).toContain("Name: lookup")
  })

  test("keeps hostile tool metadata and backticks inside adaptive fences", () => {
    const markdown = buildAssistantOutputMarkdown({
      ...parsed,
      toolCalls: [
        {
          ...parsed.toolCalls[0],
          arguments: "before ``` middle `````` after",
          argumentsJson: null,
          callId: "call </script>\n# injected",
          id: "item **bold**\n<div>bad</div>",
          name: "lookup\n# injected `heading`",
        },
      ],
    })

    expect(markdown).toContain("### Tool call 1")
    expect(markdown).not.toContain("### lookup")
    expect(markdown).toContain("Name: lookup\n# injected `heading`")
    expect(markdown).toContain("Call ID: call </script>\n# injected")
    expect(markdown).toContain("Item ID: item **bold**\n<div>bad</div>")
    expect(markdown).toContain(
      "```````text\nbefore ``` middle `````` after\n```````",
    )
  })

  test("formats an ordinary direct JSON response without normalizing it", () => {
    expect(
      buildResponseJson(
        {
          body: '{"ok":true,"result":"hello"}',
          headers: { "content-type": "application/json" },
          status: 200,
          statusText: "OK",
        },
        null,
      ),
    ).toBe('{\n  "ok": true,\n  "result": "hello"\n}\n')
  })

  test("normalizes a streamed response into stable response JSON", () => {
    const exported = buildResponseJson(
      {
        body: 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        headers: { "content-type": "text/event-stream" },
        status: 200,
        statusText: "OK",
      },
      parsed,
    )

    expect(exported).not.toBeNull()
    if (exported === null) throw new Error("Expected normalized JSON")
    expect(JSON.parse(exported)).toEqual({
      status: parsed.status,
      assistantText: parsed.assistantText,
      toolCalls: parsed.toolCalls,
      reasoningText: parsed.reasoningText,
      errorMessage: parsed.errorMessage,
      usage: parsed.usage,
      copilotUsage: parsed.copilotUsage,
      response: parsed.response,
      events: parsed.events,
    })
  })

  test("builds a raw HTTP response while preserving the exact LF body", () => {
    const body = "first line\nsecond line\n"
    expect(
      buildRawHttpResponse({
        body,
        headers: {
          "content-type": "text/event-stream",
          "Content-Length": "999",
          "Content-Encoding": "gzip",
          "Transfer-Encoding": "chunked",
          Digest: "stale",
          "x-request-id": "req_1",
        },
        status: 200,
        statusText: "OK   ",
      }),
    ).toBe(
      "HTTP/1.1 200 OK   \r\ncontent-type: text/event-stream\r\nContent-Length: 999\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\nDigest: stale\r\nx-request-id: req_1\r\n\r\n"
        + body,
    )
  })

  test("preserves response headers and Unicode body without synthesizing framing", () => {
    const body = "Result 🌍\n"

    expect(
      buildRawHttpResponse({
        body,
        headers: {
          "X-Before": "one",
          "CONTENT-MD5": "stale",
          "content-length": "1",
          "X-After": "two",
        },
        status: 201,
        statusText: "Created",
      }),
    ).toBe(
      [
        "HTTP/1.1 201 Created",
        "X-Before: one",
        "CONTENT-MD5: stale",
        "content-length: 1",
        "X-After: two",
        "",
        body,
      ].join("\r\n"),
    )
  })
})

describe("HTTP export delivery", () => {
  test("reports an export error message through the supplied callback", () => {
    let reported = ""

    reportExportError((message) => {
      reported = message
    }, new Error("Download blocked"))

    expect(reported).toBe("Download blocked")
  })

  test("normalizes export errors for local and callback feedback", () => {
    expect(exportErrorMessage(new Error("Download blocked"))).toBe(
      "Download blocked",
    )
    expect(exportErrorMessage(new Error(""))).toBe("Export failed")
    expect(exportErrorMessage("blocked")).toBe("Export failed")
  })

  test("downloads through an injected environment and revokes the object URL", () => {
    const actions: Array<string> = []
    const anchor = {
      click: () => actions.push("click"),
      download: "",
      href: "",
      remove: () => actions.push("remove"),
    }
    const environment: DownloadEnvironment = {
      createObjectURL: (blob) => {
        actions.push(`${blob.type}:${blob.size}`)
        return "blob:download"
      },
      document: {
        body: { append: () => actions.push("append") },
        createElement: () => anchor,
      },
      revokeObjectURL: (url) => actions.push(`revoke:${url}`),
    }

    downloadTextFileWithEnvironment(
      {
        contents: "{}",
        filename: "response.json",
        type: "application/json;charset=utf-8",
      },
      environment,
    )

    expect(anchor).toMatchObject({
      download: "response.json",
      href: "blob:download",
    })
    expect(actions).toEqual([
      "application/json;charset=utf-8:2",
      "append",
      "click",
      "remove",
      "revoke:blob:download",
    ])
  })

  test("removes the anchor and revokes the object URL when click throws", () => {
    const actions: Array<string> = []
    const environment: DownloadEnvironment = {
      createObjectURL: () => "blob:failed-download",
      document: {
        body: { append: () => actions.push("append") },
        createElement: () => ({
          click: () => {
            actions.push("click")
            throw new Error("Download blocked")
          },
          download: "",
          href: "",
          remove: () => actions.push("remove"),
        }),
      },
      revokeObjectURL: (url) => actions.push(`revoke:${url}`),
    }

    expect(() =>
      downloadTextFileWithEnvironment(
        {
          contents: "{}",
          filename: "response.json",
          type: "application/json",
        },
        environment,
      ),
    ).toThrow("Download blocked")
    expect(actions).toEqual([
      "append",
      "click",
      "remove",
      "revoke:blob:failed-download",
    ])
  })
})
