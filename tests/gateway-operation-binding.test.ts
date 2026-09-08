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
    const first = await repository.create("one", context)
    expect(first.value.credential).toBeString()
    let rejected = false
    try {
      await repository.create("different-label", context)
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  } finally {
    await fixture.close()
  }
})
