/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun asynchronous rejection matchers are awaited at runtime. */
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import {
  applyLegacyImport,
  previewLegacyImport,
} from "../src/lib/storage/legacy-import"
import { OAuthRepository } from "../src/lib/storage/oauth-repository"
import { withTransferStorage } from "./helpers/transfer-storage"
const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64url")
test("environment administrator marker requires its actual hash and invalidates sessions", async () => {
  const passwordHash = await Bun.password.hash("fixture-admin-password", {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  })
  await withTransferStorage(async (target, directory) => {
    await fs.writeFile(
      path.join(directory, "admin_auth.json"),
      JSON.stringify({
        source: "environment",
        credentialFingerprint: hash(passwordHash),
        sessionVersion: 3,
        createdAt: 1,
        updatedAt: 2,
      }),
    )
    const input = { directory, includeEnvironment: false }
    await expect(previewLegacyImport(input, target)).rejects.toThrow("actual")
    const selected = {
      ...input,
      includeEnvironment: true,
      environment: { COPILOT_ADMIN_PASSWORD_HASH: passwordHash },
    }
    const preview = await previewLegacyImport(selected, target)
    await applyLegacyImport(selected, preview, target)
    const rows = await target.read((session) =>
      session.query({
        sql: "SELECT password_hash,session_version FROM capi_admin",
        args: [],
      }),
    )
    expect(rows).toEqual([{ password_hash: passwordHash, session_version: 3 }])
    expect(JSON.stringify(preview)).not.toContain(passwordHash)
  })
})
test("legacy OAuth preserves digests, principals and reusable refresh families", async () => {
  await withTransferStorage(async (target, directory) => {
    const access = "fixture-access",
      refresh = "fixture-refresh"
    const grant = {
      principalId: "fixture-principal",
      familyId: "fixture-family",
      clientId: "fixture-client",
      scopes: ["user:inference"],
      createdAt: 1,
      expiresAt: 2,
    }
    await fs.writeFile(
      path.join(directory, "oauth_tokens.json"),
      JSON.stringify({
        version: 1,
        authorizationCodes: {},
        accessTokens: { [hash(access)]: grant },
        refreshTokens: { [hash(refresh)]: grant },
        inferenceCredentials: {},
        tokenFamilies: { "fixture-family": { createdAt: 1, expiresAt: 2 } },
      }),
    )
    const input = { directory, includeEnvironment: false }
    await applyLegacyImport(
      input,
      await previewLegacyImport(input, target),
      target,
    )
    const repository = new OAuthRepository(target)
    expect(await repository.resolveAccessToken(access)).toEqual({
      principalId: "fixture-principal",
      scopes: ["user:inference"],
    })
    expect(
      (
        await repository.refreshAccessToken({
          refreshToken: refresh,
          clientId: "fixture-client",
        })
      ).status,
    ).toBe("ok")
    expect(
      (
        await repository.refreshAccessToken({
          refreshToken: refresh,
          clientId: "fixture-client",
        })
      ).status,
    ).toBe("ok")
  })
})
test("selected environment tokens and provider secrets migrate once and preserve account zero", async () => {
  await withTransferStorage(async (target, directory) => {
    await fs.writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({
        customProviders: [
          {
            id: "fixture",
            name: "Fixture",
            type: "openai-compatible",
            baseUrl: "https://example.test/v1",
            apiKeyEnv: "FIXTURE_PROVIDER_KEY",
            models: [{ id: "model", kind: "chat" }],
          },
        ],
      }),
    )
    const input = {
      directory,
      includeEnvironment: true,
      environment: {
        GITHUB_TOKENS: "token-one,token-two",
        FIXTURE_PROVIDER_KEY: "fixture-provider-secret",
      },
    }
    const preview = await previewLegacyImport(input, target)
    await applyLegacyImport(input, preview, target)
    expect(
      await target.read((session) =>
        session.query({
          sql: "SELECT id FROM capi_accounts ORDER BY id",
          args: [],
        }),
      ),
    ).toEqual([{ id: 0 }, { id: 1 }])
    expect(
      await target.read((session) =>
        session.query({
          sql: "SELECT api_key FROM capi_provider_secrets",
          args: [],
        }),
      ),
    ).toEqual([{ api_key: "fixture-provider-secret" }])
    expect(JSON.stringify(preview)).not.toContain("fixture-provider-secret")
  })
})
