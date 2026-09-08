export interface AccountModelRefreshResult {
  id: number
  status: "refreshed" | "failed"
  modelCount?: number
  error?: string
  code?: string
}
export interface AccountModelRefreshBatch {
  results: Array<AccountModelRefreshResult>
  refreshed: number
  failed: number
  revision: number
}
export function refreshModelsSummary(result: {
  refreshed: number
  failed: number
}): string {
  if (!result.refreshed && !result.failed)
    return "No connected accounts to refresh."
  const completed = `Models refreshed for ${result.refreshed} ${result.refreshed === 1 ? "account" : "accounts"}`
  return result.failed ?
      `${completed}; ${result.failed} ${result.failed === 1 ? "account" : "accounts"} failed.`
    : `${completed}.`
}
