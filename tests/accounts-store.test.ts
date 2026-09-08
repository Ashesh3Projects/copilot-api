import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(
  import.meta.dir,
  "../.superpowers/test-data/accounts-store",
)
const repositoryRoot = path.resolve(import.meta.dir, "..")

async function runStore() {
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(path.join(root, "store-"))
  await writeFile(path.join(directory, "github_token"), "legacy-secret")
  await writeFile(
    path.join(directory, "github_tokens.json"),
    JSON.stringify([{ token: "file-secret" }]),
  )
  const source = String.raw`
const { initializeStorageRuntime, closeStorageRuntime } = await import("./src/lib/storage/runtime.ts")
const { storage } = await initializeStorageRuntime()
const store = await import("./src/lib/accounts-store.ts")
const before = await store.loadAccounts()
await storage.transaction(async session => {
  await session.execute({sql:"INSERT INTO capi_accounts (id,domain,upstream_user_id,login,label,created_at,updated_at) VALUES (42,'msft.ghe.com','123','fixture','Work',0,0)",args:[]})
  await session.execute({sql:"INSERT INTO capi_account_credentials (account_id,oauth_value,updated_at) VALUES (42,'database-secret',0)",args:[]})
})
const after = await store.loadAccounts()
const credentials = await store.getStoredCredentials()
await closeStorageRuntime()
await initializeStorageRuntime()
const restarted = await store.loadAccounts()
await closeStorageRuntime()
process.stdout.write(JSON.stringify({before,after,credentials,restarted}))
`
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DATA_DIR: directory,
      GH_TOKEN: "env-secret",
      GITHUB_TOKENS: "env-secret2",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`Account-store subprocess failed: ${stderr}`)
  return JSON.parse(stdout) as {
    before: unknown
    after: Array<{
      id: number
      token: string
      instanceDomain: string
      label: string
    }>
    credentials: unknown
    restarted: unknown
  }
}

test("account store ignores legacy files/environment and reloads durable IDs and credentials", async () => {
  const result = await runStore()
  expect(result.before).toEqual([])
  expect(result.after).toEqual([
    {
      id: 42,
      token: "database-secret",
      instanceDomain: "msft.ghe.com",
      label: "Work",
    },
  ])
  expect(result.credentials).toEqual([
    { instanceDomain: "msft.ghe.com", token: "database-secret" },
  ])
  expect(result.restarted).toEqual(result.after)
})
