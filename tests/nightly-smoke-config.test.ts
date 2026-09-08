import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const repositoryRoot = path.join(import.meta.dir, "..")

async function read(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(repositoryRoot, relativePath), "utf8")
}

test("nightly smoke clients use explicit proxy and output contracts", async () => {
  const [script, geminiSettings] = await Promise.all([
    read("tests/smoke/run-smoke-tests.sh"),
    read("tests/smoke/gemini-system-settings.json"),
  ])

  expect(script).toContain(String.raw`openai_base_url=\"$SERVER_URL/v1\"`)
  expect(script).toContain("--output-last-message")
  expect(script).not.toContain('export OPENAI_BASE_URL="$SERVER_URL/v1"')

  expect(script).toContain("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
  expect(script).toContain("--skip-trust")
  expect(JSON.parse(geminiSettings)).toEqual({
    security: { auth: { selectedType: "gemini-api-key" } },
  })
})

test("nightly smoke uses a supported Gemini model for both probes", async () => {
  const script = await read("tests/smoke/run-smoke-tests.sh")

  expect(script).not.toContain("--model gemini-2.5-pro")
  expect(script.match(/--model gemini-3\.1-pro-preview/g)).toHaveLength(2)
})

test("nightly smoke generation assertions cannot pass on echoed prompts", async () => {
  const script = await read("tests/smoke/run-smoke-tests.sh")

  expect(script).not.toContain(
    'output=$(codex exec "Reply with exactly: SMOKE_TEST_OK"',
  )
  expect(script).not.toContain(
    'output=$(gemini --model gemini-2.5-pro -p "Reply with exactly: SMOKE_TEST_OK"',
  )
  expect(script).not.toContain(
    'output=$(claude -p "Reply with exactly: SMOKE_TEST_OK"',
  )
  expect(script).toContain(
    String.raw`test "$(tr -d "\r\n" < "$output_file")" = "SMOKE_TEST_OK"`,
  )
  expect(script).toContain("--output-format json")
  expect(script.match(/test "\$status" -eq 0/g)).toHaveLength(7)
})

test("nightly smoke provisions database credentials before protected startup", async () => {
  const workflow = await read(".github/workflows/nightly-smoke.yml")
  const script = await read("tests/smoke/run-smoke-tests.sh")
  expect(workflow).not.toContain('start -g "$GH_TOKEN"')
  expect(workflow).toContain("tests/smoke/prepare-database.ts")
  expect(workflow).toContain("/health/ready")
  expect(workflow).toContain("Authorization: Bearer $SMOKE_GATEWAY_KEY")
  expect(workflow).not.toContain("--debug")
  expect(script).not.toContain('TOKEN="dummy"')
  expect(script).not.toContain('KEY="dummy"')
  expect(script).toContain("x-api-key: $SMOKE_GATEWAY_KEY")
  expect(script).toContain("SMOKE_GATEWAY_KEY:?")
})

test("nightly CI cannot silently skip every client after installation failure", async () => {
  const workflow = await read(".github/workflows/nightly-smoke.yml")
  expect(workflow).not.toContain("npm i -g @anthropic-ai/claude-code@latest &")
  expect(workflow).not.toContain('claude --version || echo "claude not found"')
  expect(workflow).toContain('SMOKE_REQUIRE_CLIENTS: "1"')
  expect(await read("tests/smoke/run-smoke-tests.sh")).toContain(
    "SMOKE_REQUIRE_CLIENTS",
  )
})
