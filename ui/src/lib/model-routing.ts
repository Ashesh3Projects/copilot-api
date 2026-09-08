import type { ModelRoutingAccount } from "./types"

export function formatModelRoutingAccountDetails(
  account: ModelRoutingAccount,
): string {
  const models = `${account.modelsCount} models`
  return account.githubUsername ?
      `@${account.githubUsername} · ${models}`
    : models
}

export function formatModelRoutingAccountSummary(
  account: ModelRoutingAccount,
): string {
  const username = account.githubUsername ? `, @${account.githubUsername}` : ""
  const health = modelRoutingAccountStatus(account)
  return `Account #${account.id}${username}, ${account.accountType}, ${health}`
}

export function modelRoutingAccountStatus(
  account: ModelRoutingAccount,
): string {
  if (account.deleting) return "Removing"
  if (account.enabled === false) return "Disabled"
  return account.healthy ? "Healthy" : "Unhealthy"
}

export function modelRoutingAccountDisabledReason(
  account: ModelRoutingAccount,
): string | undefined {
  if (account.deleting)
    return "This account is being removed. Model routing cannot be changed."
  if (account.enabled === false)
    return "Enable this account in GitHub accounts before changing model routing."
  return undefined
}
