import { expect, test } from "bun:test"

import { createCredentialsRepository } from "~/lib/storage/credentials-repository"
import { createProviderMutationContext } from "~/lib/storage/providers-repository"

import { createAuthStorageFixture } from "./helpers/auth-storage"

test("a copied gateway operation cannot report success for another credential", async () => {
  const fixture = await createAuthStorageFixture()
  try {
    const repository = createCredentialsRepository(fixture.storage)
    const context = await createProviderMutationContext(
      fixture.storage,
      "gateway.create",
      { label: "one" },
      "owner:test",
    )
    const input = { label: "one", credential: "fixture-one-secret" }
    const first = await repository.create(input, context)
    expect(first.value.maskedValue).toBe("fixtu...ecret")
    let rejected = false
    try {
      await repository.create(
        { ...input, credential: "fixture-different-secret" },
        context,
      )
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  } finally {
    await fixture.close()
  }
})
