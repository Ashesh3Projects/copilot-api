import { YAML } from "bun"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { resolveApiKeyAuth } from "~/lib/api-key-auth-config"

const repositoryRoot = path.join(import.meta.dir, "..")

async function readRepositoryFile(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(repositoryRoot, relativePath), "utf8")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, description: string) {
  if (!isRecord(value)) {
    throw new TypeError(`${description} must be a mapping`)
  }

  return value
}

function requireStringArray(
  value: unknown,
  description: string,
): Array<string> {
  if (
    !Array.isArray(value)
    || !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError(`${description} must be a string array`)
  }

  return value
}

test("repository configuration does not support a gateway key file", async () => {
  for (const relativePath of [
    "src/start.ts",
    "docker-compose.yml",
    ".env.schema",
    "README.md",
  ]) {
    expect(await readRepositoryFile(relativePath)).not.toContain(
      "COPILOT_API_KEY_AUTH_FILE",
    )
  }
})

test("Docker Compose preserves automatic secret-management integration", async () => {
  const compose = YAML.parse(await readRepositoryFile("docker-compose.yml"))
  const root = requireRecord(compose, "Docker Compose document")
  const services = requireRecord(root.services, "services")
  const copilotApi = requireRecord(
    services["copilot-api"],
    "services.copilot-api",
  )
  const environment = requireStringArray(
    copilotApi.environment,
    "services.copilot-api.environment",
  )
  expect(copilotApi.env_file).toEqual([{ path: ".env", required: false }])
  expect(environment).toContain("OP_TOKEN=${OP_TOKEN:-}")
  expect(environment).toContain("OP_ENV_ID=${OP_ENV_ID:-}")
})

test("deployment defaults remain portable and omit obsolete setup guidance", async () => {
  const [
    compose,
    schema,
    readme,
    security,
    nginxReadme,
    updater,
    startSource,
    windowsLauncher,
    generatedEnvTypes,
  ] = await Promise.all([
    readRepositoryFile("docker-compose.yml"),
    readRepositoryFile(".env.schema"),
    readRepositoryFile("README.md"),
    readRepositoryFile("SECURITY.md"),
    readRepositoryFile("nginx/README.md"),
    readRepositoryFile("update.sh"),
    readRepositoryFile("src/start.ts"),
    readRepositoryFile("start.bat"),
    readRepositoryFile("env.d.ts"),
  ])

  expect(compose).not.toContain("172.19.0.1")
  expect(compose).not.toContain("setup.md")
  expect(compose).toContain("COPILOT_ADMIN_ORIGIN=${COPILOT_ADMIN_ORIGIN:-}")
  expect(schema).not.toContain("COPILOT_PORT")
  expect(schema).toContain("TURSO_DATABASE_URL")
  expect(schema).not.toContain("COPILOT_ADMIN_PASSWORD_HASH=")
  expect(generatedEnvTypes).toContain("TURSO_AUTH_TOKEN?: string")
  expect(readme).not.toContain("recent password reauthentication")
  expect(security).toContain("2026 public-exposure remediation")
  expect(nginxReadme).toContain("Upgrade: websocket")
  expect(updater).toContain("git pull --ff-only")
  expect(updater).toContain("Refusing to update outside the master branch")
  expect(updater).toContain(
    "Refusing to update a checkout with tracked changes",
  )
  expect(updater).toContain("docker compose config --quiet")
  expect(updater).toContain("preserve_running_setting COPILOT_ADMIN_ORIGIN")
  expect(updater).toContain(
    "preserve_running_setting COPILOT_TRUSTED_PROXY_CIDRS",
  )
  expect(updater).toContain('if [ "${health:-none}" != "healthy" ]')
  expect(startSource).not.toContain("ericc-ch.github.io")
  expect(startSource).toContain("Operator Dashboard")
  expect(windowsLauncher).toContain("bun run dev start --host 127.0.0.1")
  expect(windowsLauncher).not.toContain("if not defined COPILOT_API_KEY_AUTH")
  expect(windowsLauncher).not.toContain("ericc-ch.github.io")
})

test("package support links point to this fork", async () => {
  const packageJson = JSON.parse(await readRepositoryFile("package.json")) as {
    bugs?: string
    homepage?: string
    repository?: { url?: string }
  }

  expect(packageJson.homepage).toBe(
    "https://github.com/Ashesh3/copilot-api#readme",
  )
  expect(packageJson.bugs).toBe("https://github.com/Ashesh3/copilot-api/issues")
  expect(packageJson.repository?.url).toBe(
    "git+https://github.com/Ashesh3/copilot-api.git",
  )
})

test("leaves API key authentication disabled when the CLI flag is omitted", () => {
  expect(resolveApiKeyAuth(undefined, "environment-secret")).toBeUndefined()
})

test.each(["cli-secret", "", "true"])(
  "rejects deprecated CLI auth source %s",
  (value) => {
    expect(() => resolveApiKeyAuth(value, "environment-secret")).toThrow(
      "no longer configures",
    )
  },
)
