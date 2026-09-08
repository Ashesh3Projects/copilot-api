import { createHash } from "node:crypto"

import type { Storage } from "~/lib/storage/types"

import { OAuthRepository } from "~/lib/storage/oauth-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"

export const OAUTH_AUTHORIZATION_CODE_TTL_MS = 2 * 60 * 1000
// The advertised finite lifetime is for client compatibility. Server tokens
// remain valid until explicit revocation, including imported expiry metadata.
export const OAUTH_CLIENT_TOKEN_LIFETIME_SECONDS = 100 * 365 * 24 * 60 * 60
export interface IssueAuthorizationCodeInput {
  clientId: string
  redirectUri: string
  scopes: ReadonlyArray<string>
  state: string
  codeChallenge: string
  now?: number
}

export interface ExchangeAuthorizationCodeInput {
  code: string
  clientId: string
  redirectUri: string
  state: string
  codeVerifier: string
  now?: number
}

export interface RefreshAccessTokenInput {
  refreshToken: string
  clientId: string
  scopes?: ReadonlyArray<string>
  now?: number
}

export interface IssuedOAuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  refreshTokenExpiresIn: number
  scopes: Array<string>
}

export type AuthorizationCodeExchangeResult =
  | { status: "ok"; tokens: IssuedOAuthTokens }
  | { status: "invalid_grant" }

export type RefreshAccessTokenResult =
  | { status: "ok"; tokens: IssuedOAuthTokens }
  | { status: "invalid_grant" | "invalid_scope" }

export interface StoredCredential {
  principalId: string
  scopes: ReadonlyArray<string>
}

export function hashOAuthSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("base64url")
}

export function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url")
}

export class OAuthStore {
  private readonly storage?: Storage

  constructor(options: { storage?: Storage } = {}) {
    this.storage = options.storage
  }

  private repository(): OAuthRepository {
    return new OAuthRepository(this.storage ?? getStorageRuntime().storage)
  }

  async issueAuthorizationCode(
    input: IssueAuthorizationCodeInput,
  ): Promise<string> {
    return await this.repository().issueAuthorizationCode(input)
  }

  async exchangeAuthorizationCode(
    input: ExchangeAuthorizationCodeInput,
  ): Promise<AuthorizationCodeExchangeResult> {
    return await this.repository().exchangeAuthorizationCode(input)
  }

  async refreshAccessToken(
    input: RefreshAccessTokenInput,
  ): Promise<RefreshAccessTokenResult> {
    return await this.repository().refreshAccessToken(input)
  }

  async mintInferenceCredential(now = Date.now()): Promise<string> {
    return await this.repository().mintInferenceCredential(now)
  }

  async resolveAccessToken(
    rawToken: string,
    _now = Date.now(),
  ): Promise<StoredCredential | null> {
    return await this.repository().resolveAccessToken(rawToken)
  }

  async resolveInferenceCredential(
    rawKey: string,
  ): Promise<StoredCredential | null> {
    return await this.repository().resolveInferenceCredential(rawKey)
  }

  async revokeToken(rawToken: string, now = Date.now()): Promise<void> {
    await this.repository().revokeToken(rawToken, now)
  }
}

let oauthStore = new OAuthStore()

export function getOAuthStore(): OAuthStore {
  return oauthStore
}

export function setOAuthStoreForTest(store: OAuthStore | null): void {
  oauthStore = store ?? new OAuthStore()
}
