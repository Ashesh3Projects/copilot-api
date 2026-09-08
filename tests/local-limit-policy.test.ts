import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")

function readFiles(
  directory: string,
  extensions: ReadonlySet<string>,
  excludedRelativePaths: ReadonlySet<string> = new Set(),
): string {
  const contents: Array<string> = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      contents.push(readFiles(fullPath, extensions, excludedRelativePaths))
    } else if (
      entry.name !== "page-generated.ts"
      && !excludedRelativePaths.has(path.relative(root, fullPath))
      && extensions.has(path.extname(entry.name))
    ) {
      contents.push(
        `\n// ${path.relative(root, fullPath)}\n`,
        fs.readFileSync(fullPath, "utf8"),
      )
    }
  }
  return contents.join("")
}

test("application source contains no local traffic or resource limits", () => {
  expect(fs.existsSync(path.join(root, "src", "lib", "rate-limit.ts"))).toBe(
    false,
  )
  expect(fs.existsSync(path.join(root, "tests", "rate-limit.test.ts"))).toBe(
    false,
  )

  const source = readFiles(
    path.join(root, "src"),
    new Set([".ts", ".tsx"]),
    new Set([path.join("src", "lib", "attachments.ts")]),
  )
  for (const forbidden of [
    "checkRateLimit",
    "rateLimitSeconds",
    "rateLimitWait",
    "limit_reached",
    "maxPayloadLength",
    "backpressureLimit",
    "closeOnBackpressureLimit",
    "AbortSignal.timeout",
    "hono/body-limit",
    "COPILOT_VOICE_BUDGET_BYTES_PER_HOUR",
    "REPLACEMENT_LIMITS",
    "LLM_DEBUG_LOG_RETENTION_MS",
    "LOG_RETENTION",
    "MAX_MODEL_LENGTH",
  ]) {
    expect(source).not.toContain(forbidden)
  }

  // Database snapshot and shutdown deadlines bound infrastructure lifetime, not inference traffic.
  const inferenceTimeoutSource = readFiles(
    path.join(root, "src"),
    new Set([".ts", ".tsx"]),
    new Set([
      path.join("src", "lib", "attachments.ts"),
      path.join("src", "lib", "shutdown.ts"),
      path.join("src", "lib", "storage", "local-sqlite.ts"),
      path.join("src", "lib", "storage", "turso.ts"),
      path.join("src", "lib", "storage", "types.ts"),
      path.join("src", "lib", "storage", "transfer-records.ts"),
    ]),
  )
  expect(inferenceTimeoutSource).not.toContain("timeoutMs")

  expect(source).not.toMatch(
    /\b(?:RESPONSES_WS|VOICE|REMOTE|DIRECT_CONNECT|CODE_SESSION|SESSION_COMPAT|SESSION_EVENT_HISTORY)_MAX_/,
  )
  expect(source).not.toMatch(
    /\bMAX_(?:PASSWORD_LENGTH|ADMIN_SESSIONS|ATTACHMENT_BYTES|WORKER_CAPABILITIES|ENVIRONMENT_CAPABILITIES|CREDENTIAL_LENGTH|FLAG_NAME_LENGTH|FLAG_COUNT|SERIALIZED_VALUE_LENGTH|WEB_SEARCH_ITERATIONS|OAUTH_QUERY_LENGTH|OAUTH_BODY_BYTES|OAUTH_FIELD_LENGTH|AUTHORIZATION_CODES|TOKEN_FAMILIES|REFRESH_TOKENS_PER_FAMILY|INFERENCE_CREDENTIALS|STORE_FILE_BYTES|CONSECUTIVE_FUNCTION_CALL_WHITESPACE)\b/,
  )
  expect(source).not.toContain("DEFAULT_MAX_TOKENS")

  const attachmentSource = fs.readFileSync(
    path.join(root, "src", "lib", "attachments.ts"),
    "utf8",
  )
  expect(attachmentSource).toContain("ATTACHMENT_FETCH_MAX_BYTES")
  expect(attachmentSource).toContain("ATTACHMENT_FETCH_MAX_REDIRECTS")
  expect(attachmentSource).toContain("ATTACHMENT_FETCH_TIMEOUT_MS")
  expect(attachmentSource).not.toContain("AbortSignal.timeout")
  expect(attachmentSource).not.toContain("MAX_ATTACHMENT_BYTES")

  const startSource = fs.readFileSync(
    path.join(root, "src", "start.ts"),
    "utf8",
  )
  expect(startSource).not.toMatch(/\b429\b|Too Many Requests/)
  expect(startSource).toMatch(/Bun\.serve\(\{[\s\S]*?idleTimeout:\s*0,/)
  const routeSource = readFiles(
    path.join(root, "src", "routes"),
    new Set([".ts", ".tsx"]),
  )
  expect(routeSource.match(/\b429\b/g) ?? []).toHaveLength(1)
  expect(routeSource).toContain("case 429")

  const dashboardPage = fs.readFileSync(
    path.join(root, "src", "routes", "dashboard", "page-generated.ts"),
    "utf8",
  )
  expect(dashboardPage).not.toMatch(
    /rateLimitSeconds|Rate Limit|Timeout \(ms\)/,
  )

  const uiSource = readFiles(
    path.join(root, "ui", "src"),
    new Set([".ts", ".tsx"]),
  )
  expect(uiSource).not.toMatch(
    /rateLimitSeconds|timeoutMs|JSON_TREE_AUTO_EXPAND_LIMIT|JSON_TREE_CHILD_CHUNK/,
  )
})

test("nginx templates are unlimited and contain no pacing or timeout policy", () => {
  const nginxRoot = path.join(root, "nginx")
  expect(
    fs.existsSync(
      path.join(nginxRoot, "snippets", "proxy-limits.conf.template"),
    ),
  ).toBe(false)

  const templates = readFiles(
    path.join(nginxRoot, "sites-available"),
    new Set([".template"]),
  )
  for (const forbidden of [
    "limit_req",
    "limit_conn",
    "RATE_LIMIT",
    "PROXY_LIMITS",
    "PROXY_CONNECT_TIMEOUT",
  ]) {
    expect(templates).not.toContain(forbidden)
  }
  expect(templates).not.toMatch(/client_max_body_size\s+(?!0;)/)
  for (const directive of [
    "client_header_timeout 2147483647s;",
    "client_body_timeout 2147483647s;",
    "proxy_connect_timeout 75s;",
    "proxy_send_timeout 2147483647s;",
    "proxy_read_timeout 2147483647s;",
    "send_timeout 2147483647s;",
  ]) {
    expect(templates).toContain(directive)
  }
})

test("active documentation exposes no local limit configuration", () => {
  const documentation = [
    "README.md",
    "SECURITY.md",
    path.join("nginx", "README.md"),
    ".env.schema",
    "env.d.ts",
  ]
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n")

  for (const forbidden of [
    "--rate-limit",
    "--wait",
    "COPILOT_VOICE_BUDGET_BYTES_PER_HOUR",
    "proxy-limits.conf",
    "RATE_LIMIT_ZONE",
    "RATE_LIMIT_BURST",
    "PROXY_CONNECT_TIMEOUT",
  ]) {
    expect(documentation).not.toContain(forbidden)
  }
})
