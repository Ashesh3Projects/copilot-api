import { expect, test } from "bun:test"

import { createSentryInitOptions } from "../src/lib/sentry"

const FILTERED_VALUE = "[Filtered]"
const SAFE_HEADER_VALUE = "safe-visible-value"
const SENSITIVE_HEADERS = [
  "Copilot-Session-Token",
  "Anthropic-Beta",
  "anthropic-version",
  "X-Model-Provider-Preference",
  "Authorization",
  "Proxy-Authorization",
  "X-Api-Key",
  "X-Goog-Api-Key",
  "Cookie",
  "Set-Cookie",
  "X-Client-Session-Id",
  "X-Interaction-Id",
  "X-Agent-Task-Id",
  "X-Parent-Agent-Id",
] as const

type SendHook = (
  value: Record<string, unknown>,
) => Record<string, unknown> | null

const SPAN_STRUCTURAL_FIELDS = {
  data: {},
  op: "http.client",
  parent_span_id: "3333333333333333",
  span_id: "2222222222222222",
  start_timestamp: 1,
  status: "ok",
  timestamp: 2,
  trace_id: "11111111111111111111111111111111",
} as const

test("credential-control telemetry drops raw request and response context in every send hook", () => {
  for (const [name, hook] of sendHooks())
    for (const url of [
      "https://gateway.example/dashboard/api/credentials/gateway",
      "https://gateway.example/dashboard/api/credentials/gateway/fixture/reveal",
      "https://gateway.example/dashboard/api/custom-providers/fixture/reveal",
      "https://gateway.example/dashboard/auth/login",
    ])
      expectFailClosed(name, hook, {
        request: {
          url,
          data: JSON.stringify({
            credential: "gateway-secret-private",
            headers: { "X-Anything": "custom-header-private" },
          }),
        },
        contexts: { response: { apiKey: "provider-key-private" } },
      })
})

function sendHooks(): Array<[string, SendHook]> {
  const options = createSentryInitOptions(
    "https://public@example.ingest.sentry.io/1",
  )
  return [
    ["beforeSend", options.beforeSend as unknown as SendHook],
    [
      "beforeSendTransaction",
      options.beforeSendTransaction as unknown as SendHook,
    ],
    ["beforeSendSpan", options.beforeSendSpan as unknown as SendHook],
    ["beforeSendLog", options.beforeSendLog as unknown as SendHook],
  ]
}

function payloadForHook(
  hookName: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return hookName === "beforeSendSpan" ?
      { ...SPAN_STRUCTURAL_FIELDS, ...payload }
    : payload
}

function expectFailClosed(
  hookName: string,
  hook: SendHook,
  payload: Record<string, unknown>,
): void {
  const returned = hook(payloadForHook(hookName, payload))
  if (hookName !== "beforeSendSpan") {
    expect(returned).toBeNull()
    return
  }

  expect(returned).not.toBeNull()
  const safeSpan = returned as Record<string, unknown>
  expect(safeSpan.data).toEqual({})
  const structuralFields: Record<string, unknown> = SPAN_STRUCTURAL_FIELDS
  for (const key of [
    "op",
    "parent_span_id",
    "span_id",
    "start_timestamp",
    "status",
    "timestamp",
    "trace_id",
  ]) {
    expect([structuralFields[key], undefined]).toContain(safeSpan[key])
  }
  expect(Object.keys(safeSpan).sort()).toEqual(
    Object.keys(SPAN_STRUCTURAL_FIELDS)
      .filter((key) => safeSpan[key] !== undefined)
      .sort(),
  )
  expect(JSON.stringify(returned)).not.toContain("private")
}

function realHeadersRecord(prefix: string): Record<string, string> {
  return Object.fromEntries(
    new Headers({
      "Copilot-Session-Token": `${prefix}-session-private`,
      "Anthropic-Beta": `${prefix}-beta-private`,
      Authorization: `${prefix}-authorization-private`,
      "X-Safe-Header": SAFE_HEADER_VALUE,
    }).entries(),
  )
}

function sensitiveRecord(prefix: string): Record<string, string> {
  return Object.fromEntries(
    SENSITIVE_HEADERS.map((name, index) => [
      index % 2 === 0 ? name.toUpperCase() : name.toLowerCase(),
      `${prefix}-${index}-private`,
    ]),
  )
}

function makePayload(prefix: string): Record<string, unknown> {
  const topLevel = sensitiveRecord(`${prefix}-top`)
  const nested = sensitiveRecord(`${prefix}-nested`)
  const requestHeaders = sensitiveRecord(`${prefix}-request-headers`)
  const dottedHeaders = sensitiveRecord(`${prefix}-dotted`)
  const tuples = Object.entries(sensitiveRecord(`${prefix}-tuple`))

  return {
    request: {
      headers: { ...topLevel, "X-Safe-Header": SAFE_HEADER_VALUE },
      method: "POST",
      url: "https://gateway.example/v1/responses?visible=1",
    },
    contexts: {
      trace: {
        data: {
          headers: nested,
          request_headers: requestHeaders,
          "http.request.header": dottedHeaders,
          "http.request.header.authorization": `${prefix}-semantic-private`,
          "http.request.header.x-safe-header": SAFE_HEADER_VALUE,
          headerTuples: [...tuples, ["X-Safe-Header", SAFE_HEADER_VALUE]],
        },
      },
    },
    extra: {
      deeply: {
        nested: {
          headers: {
            ...sensitiveRecord(`${prefix}-deep`),
            "X-Safe-Header": SAFE_HEADER_VALUE,
          },
          headersLikeRecord: {
            headers: realHeadersRecord(`${prefix}-headers-like`),
          },
        },
      },
    },
    safeOrdinaryData: `${prefix}-ordinary-private`,
    status: 418,
  }
}

test("every Sentry send hook scrubs sensitive values from nested header shapes", () => {
  for (const [name, hook] of sendHooks()) {
    const prefix = `sentry-${name}`
    const payload = makePayload(prefix)

    expect(hook(payload)).toBe(payload)

    const serialized = JSON.stringify(payload)
    for (let index = 0; index < SENSITIVE_HEADERS.length; index += 1) {
      for (const location of [
        "top",
        "nested",
        "request-headers",
        "dotted",
        "tuple",
        "deep",
        "headers-like",
      ]) {
        expect(serialized).not.toContain(
          `${prefix}-${location}-${index}-private`,
        )
      }
    }
    expect(serialized).not.toContain(`${prefix}-semantic-private`)
    expect(serialized).toContain(FILTERED_VALUE)
    expect(serialized).toContain(SAFE_HEADER_VALUE)
    expect(payload.safeOrdinaryData).toBe(`${prefix}-ordinary-private`)
    expect(payload.status).toBe(418)
    expect((payload.request as { method: string; url: string }).method).toBe(
      "POST",
    )
    expect((payload.request as { method: string; url: string }).url).toBe(
      "https://gateway.example/v1/responses?visible=1",
    )
  }
})

test("Sentry header scrubbing handles cycles and never invokes hostile accessors", () => {
  for (const [, hook] of sendHooks()) {
    let getterCalls = 0
    const hostilePrototype = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostilePrototype, "headers", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error("hostile inherited getter")
      },
    })
    const payload = Object.create(hostilePrototype) as Record<string, unknown>
    Object.defineProperty(payload, "safe", {
      configurable: true,
      enumerable: true,
      value: SAFE_HEADER_VALUE,
      writable: true,
    })
    Object.defineProperty(payload, "hostile", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error("hostile own getter")
      },
    })
    payload.nested = {
      headers: {
        "Copilot-Session-Token": "cycle-session-private",
      },
    }
    payload.self = payload

    expect(() => hook(payload)).not.toThrow()
    expect(getterCalls).toBe(0)
    expect(
      (payload.nested as { headers: Record<string, string> }).headers[
        "Copilot-Session-Token"
      ],
    ).toBe(FILTERED_VALUE)
    expect(payload.safe).toBe(SAFE_HEADER_VALUE)
    expect(payload.self).toBe(payload)
  }
})

test("Sentry header scrubbing does not invoke Headers-like methods", () => {
  for (const [, hook] of sendHooks()) {
    let methodCalls = 0
    const headersLike = Object.create(null) as Record<string, unknown>
    Object.defineProperties(headersLike, {
      entries: {
        enumerable: false,
        value() {
          methodCalls += 1
          throw new Error("hostile entries method")
        },
      },
      get: {
        enumerable: false,
        value() {
          methodCalls += 1
          throw new Error("hostile get method")
        },
      },
    })
    const payload = { headers: headersLike, safe: SAFE_HEADER_VALUE }

    expect(() => hook(payload)).not.toThrow()
    expect(methodCalls).toBe(0)
    expect(payload.safe).toBe(SAFE_HEADER_VALUE)
  }
})

test("Sentry header scrubbing is bounded on pathologically deep telemetry", () => {
  for (const [, hook] of sendHooks()) {
    const payload: Record<string, unknown> = {}
    let cursor = payload
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    cursor.headers = {
      "Copilot-Session-Token": "too-deep-private-token",
    }

    expect(() => hook(payload)).not.toThrow()
  }
})

test("every Sentry send hook drops frozen sensitive header records", () => {
  for (const [name, hook] of sendHooks()) {
    const payload = {
      headers: Object.freeze({
        "Copilot-Session-Token": "frozen-private-token",
        "X-Safe-Header": SAFE_HEADER_VALUE,
      }),
      status: 429,
    }

    expectFailClosed(name, hook, payload)
  }
})

test("every Sentry send hook drops non-configurable sensitive headers", () => {
  for (const [name, hook] of sendHooks()) {
    const headers: Record<string, unknown> = {
      "X-Safe-Header": SAFE_HEADER_VALUE,
    }
    Object.defineProperty(headers, "Authorization", {
      configurable: false,
      enumerable: true,
      value: "non-configurable-private-token",
      writable: false,
    })
    const payload = { headers, status: 401 }

    expectFailClosed(name, hook, payload)
  }
})

test("every Sentry send hook drops telemetry with over-depth sensitive headers", () => {
  for (const [name, hook] of sendHooks()) {
    const payload: Record<string, unknown> = {}
    let cursor = payload
    for (let depth = 0; depth < 80; depth += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    cursor.headers = {
      "Copilot-Session-Token": "over-depth-private-token",
    }

    expectFailClosed(name, hook, payload)
  }
})

test("every Sentry send hook drops telemetry when descriptor inspection traps", () => {
  for (const [name, hook] of sendHooks()) {
    let ownKeysCalls = 0
    const ownKeysTrap = new Proxy(Object.create(null) as object, {
      ownKeys() {
        ownKeysCalls += 1
        throw new Error("hostile ownKeys trap")
      },
    })

    expectFailClosed(name, hook, { branch: ownKeysTrap })
    expect(ownKeysCalls).toBeGreaterThan(0)

    let descriptorCalls = 0
    const descriptorTrap = new Proxy(
      { headers: { Authorization: "descriptor-private-token" } },
      {
        getOwnPropertyDescriptor() {
          descriptorCalls += 1
          throw new Error("hostile descriptor trap")
        },
      },
    )

    expectFailClosed(name, hook, { branch: descriptorTrap })
    expect(descriptorCalls).toBeGreaterThan(0)
  }
})

test("every Sentry send hook scrubs inspectable siblings before failing closed", () => {
  for (const [name, hook] of sendHooks()) {
    const hostile = new Proxy(Object.create(null) as object, {
      ownKeys() {
        throw new Error("hostile sibling")
      },
    })
    const payload = payloadForHook(name, {
      first: hostile,
      headers: { Authorization: "sibling-private-token" },
    })

    const returned = hook(payload)
    expect((payload.headers as Record<string, string>).Authorization).toBe(
      FILTERED_VALUE,
    )
    if (name === "beforeSendSpan") {
      expect(returned).not.toBeNull()
      expect(JSON.stringify(returned)).not.toContain("sibling-private-token")
    } else {
      expect(returned).toBeNull()
    }
  }
})

test("every Sentry send hook scrubs later array siblings before failing closed", () => {
  for (const [name, hook] of sendHooks()) {
    const hostile = new Proxy(Object.create(null) as object, {
      ownKeys() {
        throw new Error("hostile array sibling")
      },
    })
    const headers = { Authorization: "array-sibling-private-token" }
    const payload = payloadForHook(name, {
      list: [hostile, { headers }],
    })

    const returned = hook(payload)
    expect(headers.Authorization).toBe(FILTERED_VALUE)
    if (name === "beforeSendSpan") {
      expect(returned).not.toBeNull()
      expect(JSON.stringify(returned)).not.toContain(
        "array-sibling-private-token",
      )
    } else {
      expect(returned).toBeNull()
    }
  }
})

test("Statsig context is revisited when a shared branch becomes sensitive", () => {
  for (const [, hook] of sendHooks()) {
    const shared = { query: "k=shared-private&visible=1" }
    const payload = {
      nonStatsig: shared,
      statsig: {
        host: "ab.chatgpt.com",
        shared,
      },
    }

    expect(hook(payload)).toBe(payload)
    expect(shared.query).toBe("k=[Filtered]&visible=1")
  }
})

test("every Sentry send hook ignores hostile accessors without invoking them", () => {
  for (const [, hook] of sendHooks()) {
    let getterCalls = 0
    const branch = Object.create(null) as Record<string, unknown>
    Object.defineProperty(branch, "headers", {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error("hostile headers getter")
      },
    })
    const payload = { branch, status: 202 }

    expect(() => hook(payload)).not.toThrow()
    expect(getterCalls).toBe(0)
  }
})

test("every Sentry send hook retains proven-safe immutable telemetry", () => {
  for (const [, hook] of sendHooks()) {
    const safePayload = Object.freeze({
      headers: Object.freeze({ "X-Safe-Header": SAFE_HEADER_VALUE }),
      method: "GET",
      status: 204,
    })

    expect(hook(safePayload)).toBe(safePayload)

    const mutablePayload = {
      headers: { Authorization: "mutable-private-token" },
      status: 200,
    }
    expect(hook(mutablePayload)).toBe(mutablePayload)
    expect(mutablePayload.headers.Authorization).toBe(FILTERED_VALUE)
  }
})

test("every Sentry send hook drops immutable sensitive Statsig telemetry", () => {
  for (const [name, hook] of sendHooks()) {
    const payload = Object.freeze({
      request: Object.freeze({
        url: "https://ab.chatgpt.com/v1/initialize?k=frozen-statsig-private",
      }),
    })

    expectFailClosed(name, hook, payload)
  }
})

test("every Sentry send hook drops immutable sensitive Google telemetry", () => {
  for (const [name, hook] of sendHooks()) {
    const payload = Object.freeze({
      request: Object.freeze({
        method: "POST",
        url: "https://gateway.example/v1beta/models/private-model:private-action?api_key=private-google-key&alt=sse",
      }),
    })

    expectFailClosed(name, hook, payload)
  }
})

test("nested header scrubbing composes with Google request diagnostics", () => {
  for (const [, hook] of sendHooks()) {
    const model = "private-google-model"
    const action = "private-google-action"
    const payload = {
      request: {
        headers: {
          "Copilot-Session-Token": "private-google-session-token",
          "X-Safe-Header": SAFE_HEADER_VALUE,
        },
        method: "POST",
        url: `https://gateway.example/v1beta/models/${model}:${action}?api_key=private-google-key&alt=sse`,
      },
      contexts: {
        response: { status_code: 404 },
        trace: {
          data: {
            headers: {
              "Anthropic-Beta": "private-google-beta",
            },
            "http.request.method": "POST",
            "http.route": `/v1beta/models/${model}:${action}`,
          },
        },
      },
    }

    hook(payload)

    const serialized = JSON.stringify(payload)
    for (const secret of [
      model,
      action,
      "private-google-key",
      "private-google-session-token",
      "private-google-beta",
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).toContain("/v1beta/models/:modelAction")
    expect(serialized).toContain("POST")
    expect(serialized).toContain("404")
    expect(serialized).toContain("alt=sse")
    expect(serialized).toContain(SAFE_HEADER_VALUE)
  }
})
