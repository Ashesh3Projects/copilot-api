import consola from "consola"
import { createHash } from "node:crypto"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"
import type { ResolvedCopilotOAuth } from "~/services/github/resolve-copilot-oauth"

import {
  DEFAULT_GITHUB_DOMAIN,
  normalizeGitHubDomain,
  resolveCopilotApiBaseUrl,
} from "~/lib/github-instance"
import {
  getLiveModelRoutingPolicy,
  hasModelRoutingOverride,
  isModelEnabledForAccount,
} from "~/lib/model-routing"
import { state } from "~/lib/state"
import { resolveCopilotOAuth } from "~/services/github/resolve-copilot-oauth"

// --- Account ---

export interface Account {
  id: number
  githubToken: string
  githubInstanceDomain: string
  githubUsername?: string
  copilotToken?: string
  copilotAccountSubject?: string
  copilotTokenExpiry?: number
  copilotApiBaseUrl?: string
  models: Set<string>
  modelsData: Array<Model>
  accountType: string
  integrationId?: string | null
  healthy: boolean
  enabled?: boolean
  deleting?: boolean
  credentialRevision?: number
}

export interface AccountLease {
  account: Account
  accountId: number
  credentialRevision: number
  release(): void
}

interface AddAccountOptions {
  accountType: string
  integrationId?: string | null
  githubInstanceDomain?: string
  id: number
}

type ModelsSnapshotListener = (models: ModelsResponse) => void

export function maskTokenForLog(token: string): string {
  if (token.length <= 8) {
    return token
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

// --- TokenPool ---

export class TokenPool {
  private leases = new Map<number, number>()
  private drains = new Map<number, Array<() => void>>()
  private accountReinitializations: Map<string, Promise<ResolvedCopilotOAuth>> =
    new Map()
  private accounts: Map<number, Account> = new Map()
  private modelIndex: Map<string, Array<Account>> = new Map()
  private readonly onModelsChanged: ModelsSnapshotListener | undefined
  private roundRobinIndex = 0

  constructor(onModelsChanged?: ModelsSnapshotListener) {
    this.onModelsChanged = onModelsChanged
  }

  /**
   * Create and store a new Account.
   */
  addAccount(
    githubToken: string,
    accountTypeOrOptions: string | AddAccountOptions,
    id?: number,
  ): Account {
    const options: AddAccountOptions =
      typeof accountTypeOrOptions === "string" ?
        {
          accountType: accountTypeOrOptions,
          id: id ?? this.accounts.size,
        }
      : accountTypeOrOptions
    const account: Account = {
      id: options.id,
      githubToken,
      githubInstanceDomain: normalizeGitHubDomain(
        options.githubInstanceDomain ?? DEFAULT_GITHUB_DOMAIN,
      ),
      accountType: options.accountType,
      integrationId: options.integrationId ?? null,
      models: new Set(),
      modelsData: [],
      healthy: false,
    }
    this.accounts.set(options.id, account)
    return account
  }

  /** Publish only committed registry state; callers keep detached old snapshots. */
  publishAccount(account: Account): void {
    this.accounts.set(account.id, account)
    this.rebuildModelIndex()
    this.onModelsChanged?.(this.getAllModels())
  }

  deleteAccount(accountId: number): void {
    this.accounts.delete(accountId)
    this.rebuildModelIndex()
    this.onModelsChanged?.(this.getAllModels())
  }

  acquireLease(account: Account): AccountLease | undefined {
    const current = this.accounts.get(account.id)
    if (
      !current
      || current.enabled === false
      || current.deleting
      || !current.healthy
      || current.credentialRevision !== account.credentialRevision
      || (current.integrationId ?? null) !== (account.integrationId ?? null)
    )
      return undefined
    const snapshot = {
      ...current,
      models: new Set(current.models),
      modelsData: structuredClone(current.modelsData),
    }
    this.leases.set(account.id, (this.leases.get(account.id) ?? 0) + 1)
    let released = false
    return {
      account: snapshot,
      accountId: account.id,
      credentialRevision: current.credentialRevision ?? 0,
      release: () => {
        if (released) return
        released = true
        const count = (this.leases.get(account.id) ?? 1) - 1
        if (count > 0) this.leases.set(account.id, count)
        else {
          this.leases.delete(account.id)
          const callbacks = this.drains.get(account.id) ?? []
          this.drains.delete(account.id)
          for (const callback of callbacks) callback()
        }
      },
    }
  }

  waitForDrain(accountId: number): Promise<void> {
    if (!this.leases.has(accountId)) return Promise.resolve()
    return new Promise((resolve) => {
      const callbacks = this.drains.get(accountId) ?? []
      callbacks.push(resolve)
      this.drains.set(accountId, callbacks)
    })
  }

  /** Resolve a GitHub OAuth credential and fetch its available models. */
  async initializeAccount(account: Account, showToken = false): Promise<void> {
    await this.initializeOAuthAccount(account, false, showToken)
  }

  /**
   * Re-resolve credentials and refresh model eligibility as one atomic update.
   * Concurrent callers for the same account share the same control-plane work.
   */
  async reinitializeAccount(
    account: Account,
    showToken = false,
  ): Promise<void> {
    const credentialRevision = account.credentialRevision
    const githubToken = account.githubToken
    const instanceDomain = account.githubInstanceDomain
    const integrationId = account.integrationId ?? null
    const stillMatches = () =>
      account.credentialRevision === credentialRevision
      && account.githubToken === githubToken
      && account.githubInstanceDomain === instanceDomain
      && (account.integrationId ?? null) === integrationId
    const key = `${account.id}:${account.credentialRevision ?? 0}:${createHash(
      "sha256",
    )
      .update(JSON.stringify([githubToken, instanceDomain, integrationId]))
      .digest("hex")}`
    const existing = this.accountReinitializations.get(key)
    if (existing) {
      const resolved = await existing
      if (stillMatches())
        this.applyOAuthAccount(account, resolved, false, showToken)
      return
    }

    const current = resolveCopilotOAuth({
      accountType: account.accountType,
      githubToken: account.githubToken,
      instanceDomain: account.githubInstanceDomain,
      integrationId,
    })
    this.accountReinitializations.set(key, current)
    try {
      const resolved = await current
      if (stillMatches())
        this.applyOAuthAccount(account, resolved, true, showToken)
    } finally {
      if (this.accountReinitializations.get(key) === current) {
        this.accountReinitializations.delete(key)
      }
    }
  }

  /**
   * Rebuild the model-to-accounts index from all healthy accounts.
   */
  rebuildModelIndex(): void {
    this.modelIndex.clear()
    let enabled: ReturnType<typeof getLiveModelRoutingPolicy> | undefined

    for (const account of this.accounts.values()) {
      if (!this.isSelectable(account)) continue

      for (const modelId of account.models) {
        enabled ??= getLiveModelRoutingPolicy()
        if (!enabled(modelId, account.id)) continue

        let list = this.modelIndex.get(modelId)
        if (!list) {
          list = []
          this.modelIndex.set(modelId, list)
        }
        list.push(account)
      }
    }

    consola.debug(
      `Model index rebuilt: ${this.modelIndex.size} models across ${this.getHealthyCount()} healthy accounts`,
    )
  }

  /**
   * Round-robin selection of an account that has the given model.
   * Returns undefined if no healthy account has the model.
   */
  getAccountForModel(modelId: string): Account | undefined {
    const eligible = this.modelIndex.get(modelId)
    if (!eligible || eligible.length === 0) return undefined

    const index = this.roundRobinIndex % eligible.length
    this.roundRobinIndex++
    return eligible[index]
  }

  /**
   * Session-affinity selection of an account for a given model.
   *
   * When a clientSessionId is provided, rendezvous-hashes it against eligible
   * account IDs to deterministically pick one account. This prevents
   * mid-conversation account switches that break cryptographic signatures
   * on thinking/memory blocks.
   *
   * When no clientSessionId is provided, always returns the first eligible
   * account (stable default).
   */
  getAccountForModelBySession(
    modelId: string,
    clientSessionId?: string,
  ): Account | undefined {
    const eligible = this.modelIndex.get(modelId)
    if (!eligible || eligible.length === 0) return undefined

    return this.selectAccountBySession(eligible, clientSessionId)
  }

  /** Return a detached view of the healthy, enabled accounts for a model. */
  getEligibleAccountsForModel(modelId: string): Array<Account> {
    return [...(this.modelIndex.get(modelId) ?? [])]
  }

  /** Select deterministically from an explicit request-local candidate set. */
  selectAccountBySession(
    accounts: ReadonlyArray<Account>,
    clientSessionId?: string,
  ): Account | undefined {
    const first = accounts.at(0)
    if (!first || !clientSessionId) return first

    let winner = first
    let winnerScore = this.rendezvousScore(clientSessionId, winner.id)
    for (const candidate of accounts.slice(1)) {
      const candidateScore = this.rendezvousScore(clientSessionId, candidate.id)
      if (candidateScore > winnerScore) {
        winner = candidate
        winnerScore = candidateScore
      }
    }
    return winner
  }

  /**
   * Select a healthy account for a control-plane request.
   *
   * This is deterministic for identified sessions and does not retain a
   * session-to-account mapping.
   */
  getHealthyAccountBySession(clientSessionId?: string): Account | undefined {
    const healthy = this.getAllAccounts().filter((account) =>
      this.isSelectable(account),
    )
    return this.selectAccountBySession(healthy, clientSessionId)
  }

  /**
   * Select a healthy account whose raw catalog advertises the model.
   *
   * Policy calls deliberately ignore inference routing overrides and the
   * derived model index because they are used to enable catalog models.
   */
  getAccountAdvertisingModelBySession(
    modelId: string,
    clientSessionId?: string,
  ): Account | undefined {
    const advertising = this.getAllAccounts().filter(
      (account) => this.isSelectable(account) && account.models.has(modelId),
    )
    return this.selectAccountBySession(advertising, clientSessionId)
  }

  /**
   * Mark an account as unhealthy and rebuild the model index.
   */
  markUnhealthy(account: Account): void {
    account.healthy = false
    const current = this.accounts.get(account.id)
    if (
      current
      && current.githubToken === account.githubToken
      && current.credentialRevision === account.credentialRevision
    )
      current.healthy = false
    consola.warn(`Account #${account.id} marked unhealthy`)
    this.rebuildModelIndex()
  }

  /**
   * Return a merged, deduplicated ModelsResponse across all healthy accounts.
   * Deduplication is by model ID, keeping the first occurrence.
   */
  getAllModels(): ModelsResponse {
    const seen = new Set<string>()
    const mergedData: Array<Model> = []

    for (const account of this.accounts.values()) {
      if (!this.isSelectable(account)) continue

      for (const model of account.modelsData) {
        if (!seen.has(model.id)) {
          seen.add(model.id)
          mergedData.push(model)
        }
      }
    }

    return {
      data: mergedData,
      object: "list",
    }
  }

  /**
   * Return the correct Copilot API base URL for an account's type.
   */
  getBaseUrl(account: Account): string {
    return resolveCopilotApiBaseUrl(
      account.githubInstanceDomain,
      account.copilotApiBaseUrl,
      account.accountType,
    )
  }

  publishRecoveredBaseUrl(snapshot: Account, baseUrl: string): void {
    snapshot.copilotApiBaseUrl = baseUrl
    const current = this.accounts.get(snapshot.id)
    if (
      current
      && current.githubToken === snapshot.githubToken
      && current.credentialRevision === snapshot.credentialRevision
    ) {
      current.copilotApiBaseUrl = baseUrl
    }
  }

  /** Clear pending account reinitializations. */
  dispose(): void {
    this.accountReinitializations.clear()
    consola.debug("TokenPool disposed")
  }

  /**
   * Get the number of registered accounts.
   */
  get size(): number {
    return this.accounts.size
  }

  /**
   * Get all registered accounts.
   */
  getAllAccounts(): Array<Account> {
    return [...this.accounts.values()]
  }

  removeAccountForTest(accountId: number): void {
    this.accounts.delete(accountId)
    this.rebuildModelIndex()
  }

  getEligibleAccountIdsForModel(modelId: string): Array<number> {
    return (this.modelIndex.get(modelId) ?? [])
      .map((account) => account.id)
      .sort((left, right) => left - right)
  }

  getEligibleAccountForModel(
    modelId: string,
    accountId: number,
  ): Account | undefined {
    return (this.modelIndex.get(modelId) ?? []).find(
      (account) => account.id === accountId,
    )
  }

  getModelForAccount(modelId: string, accountId: number): Model | undefined {
    return this.accounts
      .get(accountId)
      ?.modelsData.find((model) => model.id === modelId)
  }

  accountAdvertisesModelEndpoint(
    account: Account,
    modelId: string,
    endpoint: string,
  ): boolean {
    const model = account.modelsData.find(
      (candidate) => candidate.id === modelId,
    )
    if (!model) return false
    return model.supported_endpoints ?
        model.supported_endpoints.includes(endpoint)
      : endpoint === "/chat/completions"
  }

  getHealthyAccountIds(): Array<number> {
    return this.getAllAccounts()
      .filter((account) => this.isSelectable(account))
      .map((account) => account.id)
      .sort((left, right) => left - right)
  }

  getFirstHealthyAccount(): Account | undefined {
    return this.getAllAccounts().find((account) => this.isSelectable(account))
  }

  hasKnownModel(modelId: string): boolean {
    for (const account of this.accounts.values()) {
      if (account.models.has(modelId)) return true
    }
    return false
  }

  hasEnabledAccountForKnownModel(modelId: string): boolean | undefined {
    const eligible = this.modelIndex.get(modelId)
    if (eligible && eligible.length > 0) return true
    return this.hasKnownModel(modelId) ? false : undefined
  }

  getModelAccountAvailability(): Array<{
    model: Model
    accounts: Array<{
      accountId: number
      accountType: string
      enabled: boolean
      healthy: boolean
      overridden: boolean
    }>
  }> {
    const models = new Map<
      string,
      {
        model: Model
        accounts: Array<{
          accountId: number
          accountType: string
          enabled: boolean
          healthy: boolean
          overridden: boolean
        }>
      }
    >()

    for (const account of this.accounts.values()) {
      for (const model of account.modelsData) {
        let entry = models.get(model.id)
        if (!entry) {
          entry = { model, accounts: [] }
          models.set(model.id, entry)
        }

        const enabled =
          account.enabled !== false
          && !account.deleting
          && isModelEnabledForAccount(model.id, account.id)
        entry.accounts.push({
          accountId: account.id,
          accountType: account.accountType,
          enabled,
          healthy: account.healthy,
          overridden: hasModelRoutingOverride(model.id, account.id),
        })
      }
    }

    return [...models.values()].sort((a, b) =>
      a.model.id.localeCompare(b.model.id),
    )
  }

  // --- Private helpers ---

  private isSelectable(account: Account): boolean {
    return account.healthy && account.enabled !== false && !account.deleting
  }

  private rendezvousScore(affinityKey: string, accountId: number): string {
    return createHash("sha256")
      .update(`${affinityKey}\0${accountId}`)
      .digest("hex")
  }

  private getHealthyCount(): number {
    let count = 0
    for (const account of this.accounts.values()) {
      if (account.healthy) count++
    }
    return count
  }

  private async initializeOAuthAccount(
    account: Account,
    publishModels = false,
    showToken = false,
  ): Promise<void> {
    const resolved = await resolveCopilotOAuth({
      accountType: account.accountType,
      githubToken: account.githubToken,
      instanceDomain: account.githubInstanceDomain,
      integrationId: account.integrationId ?? null,
    })
    this.applyOAuthAccount(account, resolved, publishModels, showToken)
  }

  // eslint-disable-next-line max-params -- Every waiting snapshot applies shared discovery with caller publication/logging policy.
  private applyOAuthAccount(
    account: Account,
    resolved: ResolvedCopilotOAuth,
    publishModels: boolean,
    showToken: boolean,
  ): void {
    const modelsData = structuredClone(resolved.models.data)

    // Commit only after both control-plane requests succeed.

    Object.assign(account, {
      copilotApiBaseUrl: resolved.baseUrl,
      copilotToken: resolved.token,
      copilotAccountSubject: resolved.accountSubject,
      copilotTokenExpiry: undefined,
      githubUsername: resolved.login ?? account.githubUsername,
      healthy: true,
      models: new Set(modelsData.map((model) => model.id)),
      modelsData,
    })

    // Request snapshots may refresh after disable/remove/reconnect. Only update
    // the still-current credential and preserve registry eligibility controls.
    const current = this.accounts.get(account.id)
    if (
      current
      && current !== account
      && current.githubToken === account.githubToken
      && current.credentialRevision === account.credentialRevision
      && current.githubInstanceDomain === account.githubInstanceDomain
      && (current.integrationId ?? null) === (account.integrationId ?? null)
    ) {
      Object.assign(current, {
        ...account,
        enabled: current.enabled,
        deleting: current.deleting,
      })
    }

    this.rebuildModelIndex()
    if (publishModels) this.onModelsChanged?.(this.getAllModels())
    if (showToken) {
      consola.info(
        `Account #${account.id} Copilot token: ${maskTokenForLog(resolved.token)}`,
      )
    }
    consola.info(
      `Account #${account.id} (${account.accountType}): ${account.models.size} models available`,
    )
  }
}

// --- Module-level singleton ---

export const tokenPool = new TokenPool((models) => {
  state.models = models
})
