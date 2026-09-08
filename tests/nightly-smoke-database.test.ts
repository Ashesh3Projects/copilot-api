import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { AccountsRepository } from "~/lib/storage/accounts-repository"
import { createCredentialsRepository } from "~/lib/storage/credentials-repository"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"

import { prepareSmokeDatabase } from "./smoke/prepare-database"

test("smoke fixture persists a validated account and digested gateway key without legacy state", async () => {
  const root = join(import.meta.dir, "../.superpowers/test-data/nightly")
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, "fixture-"))
  const githubToken = "synthetic-nightly-github"
  const gatewayKey = "synthetic-nightly-gateway"
  try {
    await prepareSmokeDatabase({
      directory,
      githubToken,
      gatewayKey,
      validate: (input) =>
        Promise.resolve({
          persisted: {
            token: input.token,
            instanceDomain: "github.com",
            upstreamUserId: "123",
            login: "fixture",
            label: null,
            accountType: "individual",
            modelCount: 0,
          },
          resolved: {
            token: input.token,
            baseUrl: "https://api.githubcopilot.com",
            models: { object: "list", data: [] },
          },
        }),
    })
    const database = new LocalSqliteStorage(
      join(directory, "copilot-api.sqlite"),
    )
    try {
      expect(
        await createCredentialsRepository(database).gateway(gatewayKey),
      ).not.toBeNull()
      expect(
        (await new AccountsRepository(database).snapshot()).accounts[0]?.record
          .login,
      ).toBe("fixture")
      expect(
        await createCredentialsRepository(database).gateway("dummy"),
      ).toBeNull()
    } finally {
      await database.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
