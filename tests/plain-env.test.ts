import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import packageJson from "../package.json"

const root = path.resolve(import.meta.dir, "..")

test("runtime and dependency manifests contain no secret-manager integration", async () => {
  expect(
    Object.keys(packageJson.dependencies).some((name) =>
      /varlock|1password/i.test(name),
    ),
  ).toBe(false)
  const lock = await Bun.file(path.join(root, "bun.lock")).text()
  expect(lock).not.toMatch(/varlock|1password/i)
  for (const name of ["entrypoint.sh", "Dockerfile", "docker-compose.yml"]) {
    const contents = await Bun.file(path.join(root, name)).text()
    expect(contents).not.toMatch(
      /varlock|1password|OP_TOKEN|OP_ENV_ID|CAPI_ENV_RESOLVED/i,
    )
  }
  expect(await Bun.file(path.join(root, ".env.schema")).exists()).toBe(false)
  expect(await Bun.file(path.join(root, "env.d.ts")).exists()).toBe(false)
})

test("the plain environment example documents deployment inputs without schema decorators", async () => {
  const example = await Bun.file(path.join(root, ".env.example")).text()
  for (const key of [
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
    "COPILOT_INTEGRATION_ID",
    "COPILOT_HOST",
    "COPILOT_ADMIN_ORIGIN",
    "COPILOT_TRUSTED_PROXY_CIDRS",
  ])
    expect(example).toContain(`${key}=`)
  expect(example).not.toMatch(/varlock|1password|^# @/im)
})

test.each([undefined, "shell-value"])(
  "Bun loads ordinary .env values and preserves explicit environment precedence (%s)",
  async (override) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "capi-dotenv-"))
    try {
      await fs.writeFile(
        path.join(directory, ".env"),
        "TURSO_DATABASE_URL=turso://fixture.example\nTURSO_AUTH_TOKEN=fixture-token\nCOPILOT_INTEGRATION_ID=dotenv-value\n",
      )
      const env = { ...process.env }
      delete env.TURSO_DATABASE_URL
      delete env.TURSO_AUTH_TOKEN
      delete env.COPILOT_INTEGRATION_ID
      if (override) env.COPILOT_INTEGRATION_ID = override
      const moduleUrl = pathToFileURL(
        path.join(root, "src", "lib", "storage", "config.ts"),
      ).href
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { resolveStorageConfig } from ${JSON.stringify(moduleUrl)};
         const c = resolveStorageConfig();
         console.log(JSON.stringify({kind:c.kind, integration:process.env.COPILOT_INTEGRATION_ID,
           paired:c.kind==="turso" && c.authToken==="fixture-token"}));`,
        ],
        { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(JSON.parse(stdout)).toEqual({
        kind: "turso",
        integration: override ?? "dotenv-value",
        paired: true,
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
)
