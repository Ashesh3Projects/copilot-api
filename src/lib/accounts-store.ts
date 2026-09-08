import type { GitHubCredential } from "~/lib/github-instance"

import {
  createAccountMutationContext,
  getAccountsService,
} from "~/lib/accounts-service"
import { DEFAULT_GITHUB_DOMAIN } from "~/lib/github-instance"

/** Internal credential view for owner CLI callers; never a dashboard DTO. */
export interface StoredAccount {
  id: number
  token: string
  instanceDomain: string
  label?: string
}

export async function loadAccounts(): Promise<Array<StoredAccount>> {
  const service = getAccountsService()
  const snapshot = await service.repository.snapshot()
  return snapshot.accounts.flatMap(({ record, token }) =>
    record.removedAt === null && !record.deleting && token !== null ?
      [
        {
          id: record.id,
          token,
          instanceDomain: record.instanceDomain,
          ...(record.label ? { label: record.label } : {}),
        },
      ]
    : [],
  )
}

export async function addAccount(
  token: string,
  label?: string,
  instanceDomain = DEFAULT_GITHUB_DOMAIN,
): Promise<Array<StoredAccount>> {
  const service = getAccountsService()
  const input = { token, label, instanceDomain }
  const context = await createAccountMutationContext(
    service.repository.storage,
    "account.create",
    input,
    "owner:cli",
  )
  await service.create(input, context)
  return loadAccounts()
}

/** The identifier is the durable account ID, never an array position. */
export async function removeAccount(id: number): Promise<Array<StoredAccount>> {
  const service = getAccountsService()
  const context = await createAccountMutationContext(
    service.repository.storage,
    "account.remove",
    { id },
    "owner:cli",
  )
  await service.remove(id, context)
  await service.whenIdle()
  return loadAccounts()
}

export async function getStoredCredentials(): Promise<Array<GitHubCredential>> {
  return (await loadAccounts()).map((account) => ({
    instanceDomain: account.instanceDomain,
    token: account.token,
  }))
}
