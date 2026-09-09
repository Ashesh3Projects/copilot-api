import consola from "consola"
import { createHash, randomUUID } from "node:crypto"

import type {
  AccountRecord,
  AccountUpdate,
  ValidatedAccount,
} from "~/lib/storage/accounts-repository"
import type { Committed, MutationContext, Storage } from "~/lib/storage/types"
import type { Account } from "~/lib/token-pool"
import type { ResolvedCopilotOAuth } from "~/services/github/resolve-copilot-oauth"

import {
  DEFAULT_GITHUB_DOMAIN,
  normalizeGitHubDomain,
} from "~/lib/github-instance"
import {
  accountMutationDigest,
  bindAccountMutation,
} from "~/lib/storage/account-mutation"
import {
  AccountsRepository,
  listRefreshableAccountIds,
} from "~/lib/storage/accounts-repository"
import { getSettingsActorId } from "~/lib/storage/domain-settings"
import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageSchemaError,
} from "~/lib/storage/errors"
import {
  deadlinePromise,
  getStorageDeadline,
  withStorageDeadline,
} from "~/lib/storage/operation-budget"
import {
  getStoreRevision,
  readCommittedMutation,
  runMutation,
} from "~/lib/storage/operations"
import { getStorageRuntime, peekStorageRuntime } from "~/lib/storage/runtime"
import { TokenPool, tokenPool } from "~/lib/token-pool"
import {
  DEFAULT_COPILOT_INTEGRATION_ID,
  normalizeAccountIntegrationId,
} from "~/services/copilot/copilot-contract"
import { getGitHubUser } from "~/services/github/get-user"
import { resolveCopilotOAuth } from "~/services/github/resolve-copilot-oauth"

export interface CreateAccountInput {
  token: string
  instanceDomain?: string
  label?: string | null
  accountType?: string
  integrationId?: string | null
}

export interface AccountValidation {
  persisted: ValidatedAccount
  resolved: ResolvedCopilotOAuth
}

export type AccountValidator = (
  input: CreateAccountInput,
) => Promise<AccountValidation>

export type AccountModelRefreshResult =
  | { id: number; status: "refreshed"; modelCount: number }
  | { id: number; status: "failed"; error: string; code: string }

export async function validateAccount(
  input: CreateAccountInput,
): Promise<AccountValidation> {
  const token = input.token.trim()
  if (!token) throw new TypeError("A GitHub OAuth credential is required")
  const instanceDomain = normalizeGitHubDomain(
    input.instanceDomain ?? DEFAULT_GITHUB_DOMAIN,
  )
  const accountType = input.accountType ?? "individual"
  const integrationId = normalizeAccountIntegrationId(input.integrationId)
  // GET /user.id is immutable; Copilot analytics_tracking_id is a different identity.
  const [user, resolved] = await Promise.all([
    getGitHubUser(token, instanceDomain),
    resolveCopilotOAuth({
      githubToken: token,
      instanceDomain,
      accountType,
      integrationId,
    }),
  ])
  if (
    !Number.isSafeInteger(user.id)
    || user.id <= 0
    || typeof user.login !== "string"
    || !user.login.trim()
  )
    throw new TypeError("GitHub did not return a valid immutable user identity")
  return {
    persisted: {
      token,
      instanceDomain,
      accountType,
      integrationId,
      upstreamUserId: String(user.id),
      login: user.login,
      label: input.label?.trim() || null,
      modelCount: resolved.models.data.length,
    },
    resolved,
  }
}

// eslint-disable-next-line max-params -- Mutation identity includes the verified actor as an explicit independent argument.
export async function createAccountMutationContext(
  storage: Storage,
  kind: string,
  input: unknown,
  actorId = getSettingsActorId(),
): Promise<MutationContext> {
  if (!actorId)
    throw new StorageConflictError(
      "A verified account-management actor is required",
    )
  return {
    operationId: randomUUID(),
    expectedRevision: await getStoreRevision(storage),
    actorId,
    kind,
    inputDigest: createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex"),
  }
}

export class AccountsService {
  readonly repository: AccountsRepository
  readonly pool: TokenPool
  private readonly validate: AccountValidator
  private revision = -1
  private refreshing?: Promise<void>
  private background = new Set<Promise<void>>()
  private validating = new Set<string>()
  private removing = new Set<number>()
  private modelRefreshes = new Map<
    string,
    { digest: string; result: Promise<AccountRecord> }
  >()
  private pendingMutations = new Map<
    string,
    { digest: string; commit: () => Promise<Committed<AccountRecord>> }
  >()

  constructor(
    storage: Storage,
    options: { pool?: TokenPool; validate?: AccountValidator } = {},
  ) {
    this.repository = new AccountsRepository(storage)
    this.pool = options.pool ?? new TokenPool()
    this.validate = options.validate ?? validateAccount
  }

  async list(): Promise<
    ReadonlyArray<AccountRecord & { healthy: boolean; modelCount: number }>
  > {
    return (await this.listWithRevision()).accounts
  }

  async listWithRevision() {
    await this.refreshRuntime()
    const runtime = new Map(
      this.pool.getAllAccounts().map((account) => [account.id, account]),
    )
    const page = await this.repository.listWithRevision()
    const accounts = page.accounts
      .filter((record) => record.removedAt === null)
      .map((record) => {
        const account = runtime.get(record.id)
        const matches =
          account?.credentialRevision === record.credentialRevision
          && (account.integrationId ?? null) === record.integrationId
        return {
          ...record,
          healthy: matches ? account.healthy : false,
          modelCount: matches ? account.models.size : 0,
        }
      })
    return {
      revision: page.revision,
      accounts,
      defaultIntegrationId: DEFAULT_COPILOT_INTEGRATION_ID,
    }
  }

  async create(
    input: CreateAccountInput,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    const integrationId = normalizeAccountIntegrationId(input.integrationId)
    const replay = await this.repository.replayCreate(
      {
        token: input.token.trim(),
        instanceDomain: normalizeGitHubDomain(
          input.instanceDomain ?? DEFAULT_GITHUB_DOMAIN,
        ),
        label: input.label?.trim() || null,
        accountType: input.accountType ?? "individual",
        ...(integrationId ? { integrationId } : {}),
      },
      context,
    )
    if (replay) {
      await this.refreshRuntime()
      return replay
    }
    return this.commitPrepared(
      context,
      { method: "create", input },
      async () => {
        const validated = await this.validate(input)
        return async () => {
          const committed = await this.repository.create(
            validated.persisted,
            context,
          )
          await this.publishValidated(committed.value, validated)
          return committed
        }
      },
    )
  }

  add(
    input: CreateAccountInput,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    return this.create(input, context)
  }

  validateInput(input: CreateAccountInput): Promise<AccountValidation> {
    return this.validate(input)
  }

  async setEnabled(
    id: number,
    enabled: boolean,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    return this.update(id, { enabled }, context)
  }

  async update(
    id: number,
    input: AccountUpdate,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    const committed = await this.repository.update(id, input, context)
    await this.refreshRuntime()
    return committed
  }

  async replaceCredential(
    id: number,
    token: string,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    return this.commitPrepared(
      context,
      { method: "replace", id, token },
      async () => {
        const before = await this.repository.get(id)
        const replay = await this.repository.replayReplace(
          id,
          token.trim(),
          before.record.instanceDomain,
          context,
        )
        if (replay) return () => Promise.resolve(replay)
        if (!before.record.upstreamUserId)
          throw new StorageConflictError(
            "Revalidate this imported account before reconnecting",
          )
        const validated = await this.validate({
          token,
          instanceDomain: before.record.instanceDomain,
          label: before.record.label,
          accountType: before.record.accountType,
          integrationId: before.record.integrationId,
        })
        return async () => {
          const committed = await this.repository.replace(
            id,
            validated.persisted,
            before.record.credentialRevision,
            context,
          )
          await this.publishValidated(committed.value, validated)
          return committed
        }
      },
    )
  }

  reconnect(
    id: number,
    token: string,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    return this.replaceCredential(id, token, context)
  }

  async revalidate(
    id: number,
    context?: MutationContext,
  ): Promise<AccountRecord> {
    const mutation =
      context
      ?? (await createAccountMutationContext(
        this.repository.storage,
        "account.revalidate",
        { id },
      ))
    const digest = accountMutationDigest({
      id,
      actorId: mutation.actorId,
      kind: mutation.kind,
      inputDigest: mutation.inputDigest,
    })
    const existing = this.modelRefreshes.get(mutation.operationId)
    if (existing) {
      if (existing.digest !== digest)
        throw new StorageConflictError("Account refresh operation conflicts")
      return existing.result
    }
    const result = withStorageDeadline(Date.now() + 30_000, () =>
      this.revalidateOnce(id, mutation),
    ).finally(() => this.modelRefreshes.delete(mutation.operationId))
    this.modelRefreshes.set(mutation.operationId, { digest, result })
    return result
  }

  async refreshModels(id: number, context: MutationContext) {
    const account = await this.revalidate(id, context)
    const current = this.pool.getAllAccounts().find((item) => item.id === id)
    return { account, modelCount: current?.models.size ?? 0 }
  }

  /** Each account has its own deadline and revision; one failure cannot stop later accounts. */
  async refreshAllModels(context: MutationContext): Promise<{
    results: Array<AccountModelRefreshResult>
    refreshed: number
    failed: number
    revision: number
  }> {
    const receiptContext = bindAccountMutation(
      context,
      "account.refresh-models.batch",
      {},
    )
    const receipt =
      (await readCommittedMutation<{ ids: Array<number> }>(
        this.repository.storage,
        receiptContext,
      ))
      ?? (await runMutation(
        this.repository.storage,
        receiptContext,
        async (session) => {
          return { ids: await listRefreshableAccountIds(session) }
        },
      ))
    const results: Array<AccountModelRefreshResult> = []
    for (const id of receipt.value.ids) {
      try {
        const child = await createAccountMutationContext(
          this.repository.storage,
          "account.refresh-models",
          { id },
          context.actorId,
        )
        child.operationId = accountMutationDigest({
          operationId: context.operationId,
          actorId: context.actorId,
          id,
        })
        const refreshed = await this.refreshModels(id, child)
        results.push({
          id,
          status: "refreshed",
          modelCount: refreshed.modelCount,
        })
      } catch (error) {
        results.push({
          id,
          status: "failed",
          error: "Could not refresh models; the previous catalog was retained",
          code:
            (
              error instanceof StorageCommitUnknownError
              || error instanceof StorageConflictError
            ) ?
              error.code
            : "model_refresh_failed",
        })
      }
    }
    return {
      results,
      refreshed: results.filter((result) => result.status === "refreshed")
        .length,
      failed: results.filter((result) => result.status === "failed").length,
      revision: await getStoreRevision(this.repository.storage),
    }
  }

  private async revalidateOnce(
    id: number,
    mutation: MutationContext,
  ): Promise<AccountRecord> {
    const result = await this.commitPrepared(
      mutation,
      { method: "revalidate", id },
      async () => {
        const before = await this.repository.get(id)
        if (
          !before.token
          || before.record.deleting
          || before.record.removedAt !== null
        )
          throw new StorageConflictError("Account cannot be validated")
        const replay = await this.repository.replayReplace(
          id,
          before.token,
          before.record.instanceDomain,
          mutation,
        )
        if (replay) return () => Promise.resolve(replay)
        const validated = await deadlinePromise(
          this.validate({
            token: before.token,
            instanceDomain: before.record.instanceDomain,
            label: before.record.label,
            accountType: before.record.accountType,
            integrationId: before.record.integrationId,
          }),
          getStorageDeadline() ?? Date.now() + 30_000,
        )
        return async () => {
          const committed = await this.repository.replace(
            id,
            validated.persisted,
            before.record.credentialRevision,
            mutation,
          )
          await this.publishValidated(committed.value, validated)
          return committed
        }
      },
    )
    return result.value
  }

  async remove(
    id: number,
    context: MutationContext,
  ): Promise<Committed<AccountRecord>> {
    const committed = await this.repository.beginRemoval(id, context)
    await this.refreshRuntime()
    this.scheduleRemoval(id)
    return committed
  }

  /** Read durable revision and metadata only; upstream work runs in the background. */
  async refreshRuntime(): Promise<void> {
    const observedRevision = await getStoreRevision(this.repository.storage)
    do {
      this.refreshing ??= this.loadRuntime().finally(() => {
        this.refreshing = undefined
      })
      await this.refreshing
    } while (this.revision < observedRevision)
  }

  async whenIdle(): Promise<void> {
    while (this.background.size > 0) await Promise.all(this.background)
  }

  async publishValidated(
    record: AccountRecord,
    validated: AccountValidation,
  ): Promise<void> {
    // A concurrent disable/remove/reconnect wins over delayed network work.
    const current = await this.repository.get(record.id)
    if (
      current.record.credentialRevision !== record.credentialRevision
      || current.record.integrationId !== record.integrationId
      || current.token !== validated.persisted.token
      || current.record.removedAt !== null
    )
      return
    this.pool.publishAccount(
      this.runtimeAccount(
        current.record,
        validated.persisted.token,
        validated.resolved,
      ),
    )
    this.revision = -1
  }

  private runtimeAccount(
    record: AccountRecord,
    token: string,
    resolved?: ResolvedCopilotOAuth,
  ): Account {
    return {
      id: record.id,
      githubToken: token,
      githubInstanceDomain: record.instanceDomain,
      githubUsername: record.login ?? undefined,
      accountType: record.accountType,
      integrationId: record.integrationId,
      credentialRevision: record.credentialRevision,
      enabled: record.enabled,
      deleting: record.deleting,
      healthy: resolved !== undefined,
      models: new Set(resolved?.models.data.map((model) => model.id) ?? []),
      modelsData: resolved?.models.data ?? [],
      copilotToken: resolved?.token,
      copilotApiBaseUrl: resolved?.baseUrl,
      copilotAccountSubject: resolved?.accountSubject,
    }
  }

  private async commitPrepared(
    context: MutationContext,
    request: unknown,
    prepare: () => Promise<() => Promise<Committed<AccountRecord>>>,
  ): Promise<Committed<AccountRecord>> {
    const digest = accountMutationDigest({
      actorId: context.actorId,
      kind: context.kind,
      inputDigest: context.inputDigest,
      request,
    })
    const pending = this.pendingMutations.get(context.operationId)
    if (pending && pending.digest !== digest)
      throw new StorageConflictError(
        "Account operation conflicts with its pending mutation",
      )
    const commit = pending?.commit ?? (await prepare())
    try {
      const committed = await commit()
      this.pendingMutations.delete(context.operationId)
      return committed
    } catch (error) {
      if (error instanceof StorageCommitUnknownError)
        this.pendingMutations.set(context.operationId, { digest, commit })
      throw error
    }
  }

  private matchesRuntimeAccount(
    previous: Account | undefined,
    record: AccountRecord,
    token: string,
  ): previous is Account {
    return (
      previous !== undefined
      && previous.credentialRevision === record.credentialRevision
      && previous.githubToken === token
      && previous.githubInstanceDomain === record.instanceDomain
      && (previous.integrationId ?? null) === record.integrationId
    )
  }

  private async loadRuntime(): Promise<void> {
    if ((await getStoreRevision(this.repository.storage)) === this.revision)
      return
    const snapshot = await this.repository.snapshot()
    const runtime = peekStorageRuntime()
    if (runtime?.storage === this.repository.storage)
      await runtime.snapshot.refreshIfChanged()
    const ids = new Set<number>()
    for (const { record, token } of snapshot.accounts) {
      if (record.removedAt !== null) continue
      ids.add(record.id)
      if (record.deleting) {
        this.pool.deleteAccount(record.id)
        this.scheduleRemoval(record.id)
        continue
      }
      if (!token)
        throw new StorageSchemaError("Stored account credential is missing")
      const previous = this.pool
        .getAllAccounts()
        .find((account) => account.id === record.id)
      const unchanged = this.matchesRuntimeAccount(previous, record, token)
      this.pool.publishAccount(
        unchanged ?
          {
            ...previous,
            enabled: record.enabled,
            deleting: false,
            githubUsername: record.login ?? undefined,
          }
        : this.runtimeAccount(record, token),
      )
      if (!unchanged) this.scheduleValidation(record, token)
    }
    for (const account of this.pool.getAllAccounts())
      if (!ids.has(account.id)) this.pool.deleteAccount(account.id)
    this.revision = snapshot.revision
  }

  private track(work: Promise<void>): void {
    const handled = work
      .catch(() => {
        consola.warn(
          "Background account maintenance failed; account remains available for repair",
        )
      })
      .finally(() => {
        this.background.delete(handled)
      })
    this.background.add(handled)
  }

  private scheduleValidation(record: AccountRecord, token: string): void {
    const key = `${record.id}:${record.credentialRevision}`
    if (this.validating.has(key)) return
    this.validating.add(key)
    this.track(
      (async () => {
        const validated = await this.validate({
          token,
          instanceDomain: record.instanceDomain,
          label: record.label,
          accountType: record.accountType,
          integrationId: record.integrationId,
        })
        if (
          record.upstreamUserId !== null
          && record.upstreamUserId !== validated.persisted.upstreamUserId
        )
          throw new StorageConflictError("Stored account identity changed")
        if (record.upstreamUserId === null) {
          const context = await createAccountMutationContext(
            this.repository.storage,
            "account.validate-import",
            { id: record.id, credentialRevision: record.credentialRevision },
            "system:accounts",
          )
          const committed = await this.repository.replace(
            record.id,
            validated.persisted,
            record.credentialRevision,
            context,
          )
          await this.publishValidated(committed.value, validated)
        } else await this.publishValidated(record, validated)
      })().finally(() => {
        this.validating.delete(key)
      }),
    )
  }

  private scheduleRemoval(id: number): void {
    if (this.removing.has(id)) return
    this.removing.add(id)
    this.track(
      (async () => {
        await this.pool.waitForDrain(id)
        for (let attempt = 0; ; attempt++) {
          const context = await createAccountMutationContext(
            this.repository.storage,
            "account.finalize-removal",
            { id },
            "system:accounts",
          )
          try {
            await this.repository.finalizeRemoval(id, context)
            break
          } catch (error) {
            if (!(error instanceof StorageConflictError) || attempt >= 2)
              throw error
          }
        }
        this.pool.deleteAccount(id)
        this.revision = -1
      })().finally(() => {
        this.removing.delete(id)
      }),
    )
  }
}

const services = new WeakMap<Storage, AccountsService>()
export function getAccountsService(): AccountsService {
  const { storage } = getStorageRuntime()
  let service = services.get(storage)
  if (!service) {
    service = new AccountsService(storage, { pool: tokenPool })
    services.set(storage, service)
  }
  return service
}
