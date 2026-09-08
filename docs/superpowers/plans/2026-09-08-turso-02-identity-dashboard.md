# Turso Identity and Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move durable credentials/authentication to the selected SQLite or Turso database and provide live account, provider and administrator management.
**Architecture:** Database repositories own credential checks and atomic mutations. One account service hydrates the existing runtime pool; dashboard and CLI share it, with no single-account/env/file authority.
**Tech Stack:** Bun/TypeScript, Hono, pinned Turso adapter from Plan 1, existing Astryx React dashboard, Bun tests.
**Spec:** ../specs/2026-09-08-database-persistence-design.md
**Prerequisite:** Plan 1 reviewed and committed.
**Status:** Implemented and reviewed. Final evidence and operational limits: [acceptance record](2026-09-08-database-persistence-acceptance.md).

## Global Constraints

- Local SQLite is the default durable store; both optional TURSO_DATABASE_URL and TURSO_AUTH_TOKEN select remote Turso. One variable alone is an error; a configured remote failure never switches to local.
- Store recoverable upstream credentials in isolated sensitive tables under the approved two-variable design; never return them in metadata responses or log them.
- Retain Argon2id password hashes and SHA-256 bearer/session digests.
- No runtime GH_TOKEN/GITHUB_TOKENS, --github-token, COPILOT_API_KEY_AUTH, COPILOT_ADMIN_PASSWORD_HASH, GROQ_API_KEY, COPILOT_INFERENCE_CREDENTIAL_SHA256S or provider apiKeyEnv overrides after cutover.
- Storage errors are 503/unavailable, never incorrect-credential strikes, anonymous access or empty stores.
- No smarter routing. Preserve current explicit pins, ordinary rendezvous semantics and upstream instance boundaries.
- Use existing UI/component system, strict TypeScript, ~/* imports and approved package registry.
- Coordinator owns src/start.ts, src/server.ts, schema and dashboard route registration. Assign nonoverlapping files to concurrent workers.

## Shared account and credential contracts

Create src/lib/storage/{accounts-repository,credentials-repository,admin-repository,oauth-repository}.ts and src/lib/accounts-service.ts.

```ts
export interface AccountRecord {
  id: number
  instanceDomain: string
  upstreamUserId: string
  login: string
  label: string | null
  enabled: boolean
  removedAt: number | null
  deleting: boolean
  credentialRevision: number
}
export interface ValidatedAccount {
  instanceDomain: string; upstreamUserId: string; login: string
  token: string; label: string | null
}
export interface AccountLease {
  accountId: number; credentialRevision: number
  release(): void
}
export interface AccountsService {
  list(): Promise<ReadonlyArray<AccountRecord>>
  add(input: ValidatedAccount, context: MutationContext):
    Promise<Committed<AccountRecord>>
  setEnabled(id: number, enabled: boolean, context: MutationContext):
    Promise<Committed<AccountRecord>>
  replaceCredential(id: number, token: string, context: MutationContext):
    Promise<Committed<AccountRecord>>
  remove(id: number, context: MutationContext):
    Promise<Committed<AccountRecord>>
  revalidate(id: number): Promise<AccountRecord>
  refreshRuntime(): Promise<void>
}
export interface GatewayCredentialSummary {
  id: string; label: string; createdAt: number; revokedAt: number | null
}
```

MutationContext/Committed are from Plan 1. Account leases retain actual request-local credential/catalog snapshots internally; public objects never expose secret material. List responses may add sanitized health/model counts without adding secrets or changing the immutable ID.

### Task 1: Database gateway and inference credential checks

**Files:** Create storage/credentials-repository.ts; modify src/lib/credential-resolver.ts, request-auth.ts, protected-credential.ts, api-key-auth-config.ts, state.ts, trusted-jwt-digests.ts and all synchronous resolver call sites. Tests/credential-resolver.test.ts, admin-inference-credential-boundary.test.ts, transcribe-auth.test.ts, codex-desktop-refresh-route.test.ts; add tests/storage-auth-failure.test.ts.
**Consumes:** Storage, policy repository, typed storage errors.
**Produces:** asynchronous existing credential resolvers; digest-based gateway/inference matching and no environment fallback.

- [ ] Write tests for digest lookup, raw digest text rejection, revoked credentials, scope separation, existing OAuth/native compatibility, and database failure without IP strike.
```ts
test("storage outage is not an invalid-credential attempt", async () => {
  const app = await createAuthenticatedGatewayFixture()
  app.storage.failReads()
  const response = await app.fetch("/v1/models", {
    headers: { authorization: "Bearer fixture-gateway" },
  })
  expect(response.status).toBe(503)
  expect(app.failedAttemptsFor("127.0.0.1")).toBe(0)
})
```
createAuthenticatedGatewayFixture in tests/helpers/storage-gateway.ts assembles the real Hono server with injected repositories and test clock/upstream.
- [ ] Run failing focused tests; migrate configured gateway keys to hash lookup and remove unsafe no-keys=>anonymous path for production runtime. Unconfigured setup must not open inference.
- [ ] Propagate StorageUnavailableError through HTTP and pre-WebSocket-upgrade paths to bounded no-store 503. Reauthorize each NEW inference turn on an existing socket against selected DB; revocation/outage blocks new work with existing protocol error envelope. Already admitted turns preserve their streams.
- [ ] Preserve credential principal IDs where externally observable; import legacy digests with compatible principal metadata. Do not broaden inference-only authority.
- [ ] Run existing credential/CSRF/voice/transcription/refresh route suites, typecheck, review and commit.

### Task 2: Durable OAuth store without token lifecycle changes

**Files:** Create storage/oauth-repository.ts; modify src/lib/oauth-store.ts and dependency wiring; tests/oauth-store.test.ts, oauth-api-route.test.ts, credential-resolver.test.ts; add tests/oauth-storage-concurrency.test.ts.
**Consumes:** Storage and runMutation; existing OAuthStore input/output types.
**Produces:** existing OAuthStore public behavior over relational code/family/access/refresh tables.

- [ ] Port existing file fixture helpers to injected repositories and add fresh-service restart assertions.
- [ ] Add race tests: concurrent authorization-code exchange yields one success; valid refreshes reuse the same refresh token and principal/family; revocation serialized with refresh prevents resurrection.
```ts
test("concurrent refresh preserves the reusable refresh credential", async () => {
  const fixture = await createOAuthStorageFixture()
  const issued = await fixture.issue()
  const [a, b] = await Promise.all([
    fixture.refresh(issued.refreshToken),
    fixture.refresh(issued.refreshToken),
  ])
  expect(a.refreshToken).toBe(issued.refreshToken)
  expect(b.refreshToken).toBe(issued.refreshToken)
  expect(a.principalId).toBe(b.principalId)
})
```
createOAuthStorageFixture wraps the actual store API and exposes principal lookup for assertions.
- [ ] Retain existing TTL/PKCE/code consumption, stable family/principal, scopes, deliberately reusable refresh and long client-advertised expiry. Use indexed reads and transaction-scoped revocation/issuance.
- [ ] Store only existing digests for generated values. Operation markers retain nonsecret identity/status; a raw issuance result lost after commit is not reconstructible from storage.
- [ ] Test unavailable versus invalid_grant, same/fresh-connection visibility and remote concurrency. Run focused tests/typecheck, review and commit.

### Task 3: Administrator setup, sessions, password change and owner reset

**Files:** Create storage/admin-repository.ts; modify src/lib/admin-auth.ts, src/admin.ts, routes/dashboard/auth-route.ts, ui/src/AuthGate.tsx, ui/src/screens/Settings.tsx, ui/src/lib/api.ts; tests/admin-auth.test.ts; add tests/admin-setup-code.test.ts, admin-recovery.test.ts, dashboard-password.test.ts.
**Consumes:** Storage and gateway credential repository.
**Produces:** issueAdminSetupCode(): Promise<{code:string;expiresAt:number}>; setupAdminAuth using one-use setup input; resetAdminPassword(password): Promise<void>; existing login/session/password API compatibility after setup.

- [ ] Write tests for zero accounts, exactly-one concurrent setup, expired/reused setup code, setup code not a gateway credential, DB failure leaves no partial admin/gateway/session.
```ts
test("setup code can establish one administrator only", async () => {
  const fixture = await createAdminStorageFixture()
  const { code } = await fixture.issueSetupCode()
  const outcomes = await Promise.all([
    fixture.setup({ code, gatewayKey: "first-key", password: "first-password" }),
    fixture.setup({ code, gatewayKey: "second-key", password: "second-password" }),
  ])
  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
  expect(await fixture.adminCount()).toBe(1)
})
```
- [ ] Implement explicit admin --setup-code only for unconfigured store: generate 32 random bytes, hash, 15-minute expiry, invalidate earlier unused code, output only when command requested. Do not auto-print secrets during startup.
- [ ] Browser setup atomically consumes code and creates hash/digest records plus initial session. Existing login continues gateway key plus password. First setup requires exact allowed Origin and valid one-use code, not a preexisting administrator/CSRF cookie; success issues initial session/CSRF values. Never expose DB token to browser.
- [ ] Preserve Argon2id 65,536 memoryCost/3 timeCost, existing cookie flags, CSRF checks, session version and 30-day sliding expiry. Session refresh updates at existing cadence, not every polling request.
- [ ] Implement browser password controls requiring current password; replace/revoke/issue atomically. Owner CLI --reset prompts for new password and revokes admin sessions without deleting admin, gateway or OAuth credentials.
- [ ] AuthGate distinguishes unavailable from unconfigured; display setup code only in setup form and retain password/gateway login fields afterward. Never write secrets to browser localStorage.
- [ ] Run admin/auth boundary tests and UI typecheck, review and commit.

### Task 4: Stable account repository and one runtime registry

**Files:** Create accounts-service.ts and storage/accounts-repository.ts; modify accounts-store.ts, token-pool.ts, token.ts, account-routing-selection.ts, account-router.ts, copilot-request-context.ts, src/start.ts, src/config.ts, src/auth.ts, src/check-usage.ts. Tests/accounts-store.test.ts, token-pool.test.ts, account-router.test.ts; add tests/accounts-lifecycle.test.ts, startup-zero-accounts.test.ts.
**Consumes:** Storage, MutationContext, existing OAuth validation/discovery helpers.
**Produces:** AccountsService and unified zero/one/many-account runtime initialization.

- [ ] Test stable never-reused numeric IDs, migration ID zero, zero/one/many startup, unhealthy accounts visible, credential replacement rejects a different upstream user/domain and failed validation leaves old state.
```ts
test("deletion never transfers a routing ID to another account", async () => {
  const fixture = await createAccountStorageFixture()
  const a = await fixture.addIdentity("a")
  const b = await fixture.addIdentity("b")
  await fixture.remove(a.id)
  await fixture.restartRuntime()
  const c = await fixture.addIdentity("c")
  expect(b.id).not.toBe(c.id)
  expect(c.id).toBeGreaterThan(b.id)
})
```
- [ ] Validate upstream outside write transaction; persist credential/domain/identity/catalog metadata atomically, then publish runtime. Persisted catalog metadata is diagnostic; live availability still follows fresh upstream discovery.
- [ ] Remove two-account threshold and global single-account credential authority. Preserve one-account behavior for unknown/disabled models, endpoint authority, session tokens, 421 recovery and authentication rejection; retain a behavior compatibility branch if needed rather than blindly using the old multi-account path.
- [ ] Add request-local leases around upstream request/stream completion in central call sites; release on success, failure, abort and consumer disconnect. Disable retains secret and stops new selection. Remove marks deleting, stops new selection, drains in-flight leases, then deletes secret/tombstones; next startup finalizes interrupted removal.
- [ ] Preserve explicit pin rejection and ordinary rendezvous behavior. Do not introduce account-binding tables, weights or cooldown algorithm. Test adding/removing may remap an ordinary key while in-flight snapshots stay intact.
- [ ] Run full account-aware endpoint/HTTP/WS/fallback suites, review and commit. Coordinator integrates src/start.ts after auth task is ready.

### Task 5: Dashboard account lifecycle and durable device-login intents

**Files:** Create routes/dashboard/accounts.ts, lib/github-device-login.ts, storage/device-login-repository.ts, ui/src/screens/Accounts.tsx; modify dashboard/route.ts, ui/src/screens/registry.tsx, Shell.tsx, icons.tsx, lib/types.ts. Create tests/dashboard-accounts.test.ts, dashboard-account-login.test.ts.
**Consumes:** AccountsService, admin session+CSRF, existing GitHub device-code polling helpers.
**Produces:** /dashboard/api/accounts GET/POST; /accounts/:id PATCH/DELETE; /accounts/:id/revalidate POST; /accounts/:id/credential PUT; /accounts/device-login POST; /accounts/device-login/:id GET/DELETE.

- [ ] Write route tests for admin/CSRF, no token in list/detail/status, revision conflict, supported domains, device pending/slow-down/expiry/cancel and late completion after cancel.
```ts
test("cancelled device login cannot add an account later", async () => {
  const app = await createAccountDashboardFixture()
  const intent = await app.startDeviceLogin("github.com")
  await app.cancelDeviceLogin(intent.id)
  await app.github.complete(intent.id, "fixture-oauth-token")
  expect(await app.accounts.list()).toEqual([])
})
```
- [ ] Store intent ID, admin owner, normalized domain, secret device code, user verification code/URL, expiry, poll interval, status and lease until completion/cancel. Intent secrets excluded from every export/history response; response exposes only fields needed by administrator.
- [ ] Poll within upstream timing limits; ownership/current admin session required. Browser reload can resume an unexpired intent; crash cannot create duplicate accounts due unique intent-result operation and commit checks. No automatic credential persistence after canceled/expired intent.
- [ ] Build Accounts view from existing components with healthy/unhealthy/deleting statuses, retained-secret edit convention and actionable validation errors. Explain ordinary conversation remapping when eligibility changes. Confirmation describes actual disable versus removal effects.
- [ ] Run route/device tests, UI typecheck/build and real browser flow with mocked GitHub upstream; verify keyboard forms/errors/loading. Review and commit source; generated page is rebuilt once by coordinator after all UI slices.

### Task 6: Provider, Groq and gateway credential dashboard management

**Files:** Create storage/providers-repository.ts, routes/dashboard/credentials.ts; modify lib/config.ts, custom-providers.ts, routes/dashboard/api.ts, voice/groq-stt.ts, audio-transcriptions/route.ts, ui/src/screens/CustomProviders.tsx, Settings.tsx, lib/types.ts, src/config.ts. Tests/custom-providers.test.ts, audio-transcriptions-route.test.ts; add tests/dashboard-credentials.test.ts, provider-credential-storage.test.ts.
**Consumes:** Credentials/settings repositories and mutation context.
**Produces:** DB-backed provider/Groq secret retrieval, existing provider DTOs, named gateway create/list/revoke endpoints.

- [ ] Test provider secret omitted=>retain, explicit clear, no apiKeyEnv runtime fallback, custom secret headers never exposed, Groq source parity, gateway list digest/secret omission and last gateway revoke rejection.
```ts
test("editing metadata cannot erase an omitted provider secret", async () => {
  const fixture = await createProviderStorageFixture()
  await fixture.create({ id: "p", apiKey: "fixture-secret" })
  await fixture.update("p", { name: "Renamed" })
  expect(await fixture.forwardedAuthorization("p")).toBe("Bearer fixture-secret")
  expect(JSON.stringify(await fixture.list())).not.toContain("fixture-secret")
})
```
- [ ] Split provider metadata and secret storage; preserve current request/response/model/embedding/alias behavior. Resolve secrets only internally. Update dashboard and CLI to await commits.
- [ ] Add gateway credential creation with crypto-random bytes, show once and store digest; label/list/revoke. Require admin session/current password for high-authority credential issuance/revocation if matching existing protection policy; do not change client inference scopes.
- [ ] Add Groq stored-key controls and both route readers. Update status from DB rather than env.
- [ ] Replace normal credential env flags/help with migration guidance; legacy import handles their values in Plan 4. Optional deployment/instrumentation variables remain.
- [ ] Run provider/credential/transcription/security tests, UI typecheck/build, review and commit.

## Stage acceptance

R05-R10 and identity portions of R03/R04/R07 pass. Bootstrap -> zero-account dashboard -> add -> infer -> rotate -> restart -> old client OAuth remains valid -> password change/reset -> disable/enable -> remove succeed against real local SQLite and opt-in Turso fixtures. Neither DB failure nor unconfigured gateway opens inference. Continue history/cutover before claiming JSON-free persistence.
