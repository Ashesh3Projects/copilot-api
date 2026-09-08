import { randomUUID } from "node:crypto"

import type { AccountValidation, AccountsService } from "~/lib/accounts-service"
import type { DeviceLoginIntent } from "~/lib/storage/device-login-repository"
import type { MutationContext } from "~/lib/storage/types"

import {
  createAccountMutationContext,
  getAccountsService,
} from "~/lib/accounts-service"
import { normalizeGitHubDomain } from "~/lib/github-instance"
import {
  DeviceLoginRepository,
  deviceLoginStatus,
} from "~/lib/storage/device-login-repository"
import {
  StorageCommitUnknownError,
  StorageConflictError,
} from "~/lib/storage/errors"
import {
  getDeviceCode,
  type DeviceCodeResponse,
} from "~/services/github/get-device-code"
import { pollAccessTokenOnce } from "~/services/github/poll-access-token"

function publicIntent(intent: DeviceLoginIntent, now: number) {
  const status = deviceLoginStatus(intent, now)
  return {
    id: intent.id,
    instanceDomain: intent.instanceDomain,
    status,
    expiresAt: intent.expiresAt,
    intervalSeconds: intent.intervalSeconds,
    accountId: intent.accountId,
    ...(status === "pending" ?
      { userCode: intent.userCode, verificationUri: intent.verificationUri }
    : {}),
  }
}

function assertDeviceCode(
  code: DeviceCodeResponse,
  instanceDomain: string,
): void {
  const verification = new URL(code.verification_uri)
  if (
    verification.protocol !== "https:"
    || verification.hostname !== instanceDomain
    || verification.username
    || verification.password
    || !code.device_code
    || !code.user_code
    || !Number.isFinite(code.interval)
    || code.interval <= 0
    || !Number.isFinite(code.expires_in)
    || code.expires_in <= 0
  )
    throw new TypeError("Invalid GitHub device authorization response")
}

export class GitHubDeviceLoginService {
  readonly repository: DeviceLoginRepository
  private readonly accounts: AccountsService
  private readonly now: () => number
  private readonly getCode: typeof getDeviceCode
  private readonly pollToken: typeof pollAccessTokenOnce
  private pendingCompletions = new Map<
    string,
    {
      intent: DeviceLoginIntent
      validated: AccountValidation
      context: MutationContext
    }
  >()

  constructor(
    accounts: AccountsService,
    options: {
      now?: () => number
      getCode?: typeof getDeviceCode
      pollToken?: typeof pollAccessTokenOnce
    } = {},
  ) {
    this.accounts = accounts
    this.repository = new DeviceLoginRepository(accounts.repository.storage)
    this.now = options.now ?? Date.now
    this.getCode = options.getCode ?? getDeviceCode
    this.pollToken = options.pollToken ?? pollAccessTokenOnce
  }

  async start(
    input: { instanceDomain: string; label?: string; accountType?: string },
    owner: string,
    context: MutationContext,
  ) {
    const instanceDomain = normalizeGitHubDomain(input.instanceDomain)
    const replay = await this.repository.replayStart(
      {
        owner,
        instanceDomain,
        label: input.label?.trim() || null,
        accountType: input.accountType ?? "individual",
      },
      context,
    )
    if (replay)
      return {
        ...publicIntent(
          await this.repository.get(replay.value.id, owner),
          this.now(),
        ),
        revision: replay.revision,
      }
    const code = await this.getCode(instanceDomain)
    assertDeviceCode(code, instanceDomain)
    const id = randomUUID()
    const committed = await this.repository.create(
      {
        id,
        owner,
        instanceDomain,
        label: input.label?.trim() || null,
        accountType: input.accountType ?? "individual",
        code,
        now: this.now(),
      },
      context,
    )
    return {
      ...publicIntent(
        await this.repository.get(committed.value.id, owner),
        this.now(),
      ),
      revision: committed.revision,
    }
  }

  async poll(id: string, owner: string) {
    const pending = this.pendingCompletions.get(id)
    if (pending) {
      await this.repository.get(id, owner)
      await this.completeValidated(pending)
      return publicIntent(await this.repository.get(id, owner), this.now())
    }
    const intent = await this.repository.claim(id, owner, this.now())
    if (!intent)
      return publicIntent(await this.repository.get(id, owner), this.now())
    try {
      const result = await this.pollToken(
        intent.deviceCode,
        intent.instanceDomain,
      )
      if (result.access_token) {
        const validated = await this.accounts.validateInput({
          token: result.access_token,
          instanceDomain: intent.instanceDomain,
          label: intent.payload.label,
          accountType: intent.payload.accountType,
        })
        const context = await createAccountMutationContext(
          this.repository.storage,
          "account.device-complete",
          { id },
          owner,
        )
        context.operationId = `device-complete:${id}`
        await this.completeValidated({ intent, validated, context })
      } else {
        const failed =
          result.error !== undefined
          && !["authorization_pending", "slow_down"].includes(result.error)
        await this.repository.release(intent, this.now(), {
          slowDown:
            result.error === "slow_down" ?
              (result.interval ?? intent.intervalSeconds + 5)
            : undefined,
          failed,
        })
      }
    } catch (error) {
      // Preserve the reconciliation barrier; a later read can observe completion.
      if (error instanceof StorageCommitUnknownError) throw error
      await this.repository.release(intent, this.now())
      if (!(error instanceof StorageConflictError)) throw error
    }
    return publicIntent(await this.repository.get(id, owner), this.now())
  }

  private async completeValidated(pending: {
    intent: DeviceLoginIntent
    validated: AccountValidation
    context: MutationContext
  }): Promise<void> {
    try {
      const committed = await this.repository.complete(
        pending.intent,
        pending.validated.persisted,
        this.now,
        pending.context,
      )
      this.pendingCompletions.delete(pending.intent.id)
      await this.accounts.publishValidated(committed.value, pending.validated)
    } catch (error) {
      if (error instanceof StorageCommitUnknownError)
        this.pendingCompletions.set(pending.intent.id, pending)
      throw error
    }
  }

  async cancel(id: string, owner: string, context: MutationContext) {
    const result = await this.repository.cancel(id, owner, this.now(), context)
    return {
      ...publicIntent(await this.repository.get(id, owner), this.now()),
      revision: result.revision,
    }
  }
}

let singleton:
  | { accounts: AccountsService; service: GitHubDeviceLoginService }
  | undefined
export function getGitHubDeviceLoginService(): GitHubDeviceLoginService {
  const accounts = getAccountsService()
  if (singleton?.accounts !== accounts)
    singleton = { accounts, service: new GitHubDeviceLoginService(accounts) }
  return singleton.service
}
