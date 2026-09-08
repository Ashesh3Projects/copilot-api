import { randomUUID } from "node:crypto"
import { join, resolve, sep } from "node:path"

import type { AccountValidator } from "~/lib/accounts-service"

/** Explicit fixture-only provisioning: never reads a user's saved account or runtime token files. */
export async function prepareSmokeDatabase(input: {
  directory: string
  githubToken: string
  gatewayKey: string
  validate?: AccountValidator
}): Promise<void> {
  const root = resolve(import.meta.dir, "../../.superpowers/test-data")
  const directory = resolve(input.directory)
  if (
    !directory.startsWith(`${root}${sep}`)
    || !input.githubToken.trim()
    || !input.gatewayKey.trim()
  )
    throw new Error(
      "Smoke database requires isolated test data and explicit credentials",
    )
  const { initializeStorageRuntime, closeStorageRuntime } = await import(
    "~/lib/storage/runtime"
  )
  const { AccountsService, createAccountMutationContext } = await import(
    "~/lib/accounts-service"
  )
  const { mergeConfigWithDefaults } = await import("~/lib/config")
  const { TokenPool } = await import("~/lib/token-pool")
  const { credentialDigest, insertGatewayCredential } = await import(
    "~/lib/storage/credentials-repository"
  )
  const runtime = await initializeStorageRuntime({
    config: { kind: "sqlite", path: join(directory, "copilot-api.sqlite") },
  })
  const pool = new TokenPool()
  try {
    await mergeConfigWithDefaults()
    const service = new AccountsService(runtime.storage, {
      pool,
      validate: input.validate,
    })
    await service.create(
      {
        token: input.githubToken,
        instanceDomain: "github.com",
        label: "Nightly smoke",
      },
      await createAccountMutationContext(
        runtime.storage,
        "account.create",
        { label: "Nightly smoke" },
        "test:nightly",
      ),
    )
    await runtime.storage.transaction((session) =>
      insertGatewayCredential(session, {
        id: randomUUID(),
        digest: credentialDigest(input.gatewayKey),
        label: "Nightly smoke",
        createdAt: Date.now(),
      }),
    )
    await service.whenIdle()
  } finally {
    pool.dispose()
    await closeStorageRuntime()
  }
}

if (import.meta.main) {
  await prepareSmokeDatabase({
    directory: process.env.DATA_DIR ?? "",
    githubToken: process.env.GH_TOKEN ?? "",
    gatewayKey: process.env.SMOKE_GATEWAY_KEY ?? "",
  }).catch(() => {
    process.stderr.write(
      "Smoke database preparation failed. Check the explicit test credentials and Copilot access.\n",
    )
    process.exitCode = 1
  })
}
