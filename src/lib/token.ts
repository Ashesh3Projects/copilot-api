import { getAccountsService } from "~/lib/accounts-service"
import { state } from "~/lib/state"

/** Compatibility initialization only; the database registry owns credentials. */
export async function setupGitHubToken(_options?: {
  force?: boolean
}): Promise<void> {
  await getAccountsService().refreshRuntime()
}

export async function setupCopilotToken(): Promise<void> {
  const service = getAccountsService()
  await service.refreshRuntime()
  const account = service.pool.getFirstHealthyAccount()
  state.models = service.pool.getAllModels()
  state.copilotApiBaseUrl = account?.copilotApiBaseUrl
}
