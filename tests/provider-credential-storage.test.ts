/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression, require-atomic-updates -- Bun assertions are awaited; isolated fixtures run sequentially. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"

process.env.DATA_DIR = path.resolve(
  import.meta.dir,
  "../.superpowers/test-data/provider-credentials",
)
const { createAuthStorageFixture } = await import("./helpers/auth-storage")
const { setConfigForTest, mergeConfigWithDefaults } = await import(
  "../src/lib/config"
)
const { getCustomProviders, upsertCustomProvider } = await import(
  "../src/lib/custom-providers"
)
const { getStorageRuntime } = await import("../src/lib/storage/runtime")
const { withRequestSnapshot } = await import(
  "../src/lib/storage/request-snapshot"
)
const { transcribe } = await import("../src/routes/voice/groq-stt")
const { audioTranscriptionRoutes } = await import(
  "../src/routes/audio-transcriptions/route"
)
const {
  createProvidersRepository,
  createProviderMutationContext,
  loadCustomProviderSnapshot,
} = await import("../src/lib/storage/providers-repository")

let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let repository: ReturnType<typeof createProvidersRepository>
const provider = {
  id: "p",
  name: "Provider",
  type: "openai-compatible" as const,
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-provider-secret",
  headers: { "X-Private": "fixture-header-secret" },
  models: [{ id: "chat", kind: "chat" as const, aliases: ["alias"] }],
}
const context = (input: unknown, kind = "provider.upsert") =>
  createProviderMutationContext(fixture.storage, kind, input, "admin:test")
beforeEach(async () => {
  setConfigForTest(null)
  fixture = await createAuthStorageFixture()
  repository = createProvidersRepository(fixture.storage)
})
afterEach(async () => {
  await fixture.close()
})

test("provider metadata edits retain omitted and blank secrets across restart", async () => {
  await repository.upsert(provider, await context(provider))
  const edit = {
    ...provider,
    name: "Renamed",
    apiKey: "",
    headers: { "X-Private": "" },
  }
  await repository.upsert(edit, await context(edit))
  await fixture.restart()
  const snapshot = await loadCustomProviderSnapshot(fixture.storage)
  expect(snapshot.providers[0]?.apiKey).toBe(provider.apiKey)
  expect(snapshot.providers[0]?.headers).toEqual(provider.headers)
  expect(snapshot.providers[0]?.name).toBe("Renamed")
  expect(Object.isFrozen(snapshot.providers[0]?.models)).toBe(true)
  const metadata = JSON.stringify(await repository.list())
  expect(metadata).not.toContain(provider.apiKey)
  expect(metadata).not.toContain("fixture-header-secret")
  expect(metadata).toContain("X-Private")
})

test("header rotation replaces case-insensitive names and blank edits retain the current value", async () => {
  const original = {
    ...provider,
    headers: { "X-Api-Key": "old-key", "X-Other": "retained" },
  }
  await repository.upsert(original, await context(original))
  const replacement = { ...provider, headers: { "x-api-key": "new-key" } }
  await repository.upsert(replacement, await context(replacement))
  const blank = { ...provider, headers: { "X-API-KEY": " " } }
  await repository.upsert(blank, await context(blank))
  const saved = (await loadCustomProviderSnapshot(fixture.storage)).providers[0]
  expect(new Headers(saved.headers).get("x-api-key")).toBe("new-key")
  expect(saved.headers).toEqual({
    "x-api-key": "new-key",
    "X-Other": "retained",
  })
  expect(
    (await repository.list())[0]?.headerNames.filter(
      (name) => name.toLowerCase() === "x-api-key",
    ),
  ).toHaveLength(1)
})

test("explicit clear deletes provider secrets without removing models", async () => {
  await repository.upsert(provider, await context(provider))
  const edit = {
    ...provider,
    apiKey: undefined,
    headers: undefined,
    clearApiKey: true,
    clearHeaders: true,
  }
  await repository.upsert(edit, await context(edit))
  const snapshot = await loadCustomProviderSnapshot(fixture.storage)
  expect(snapshot.providers[0]?.apiKey).toBeUndefined()
  expect(snapshot.providers[0]?.headers).toBeUndefined()
  expect(snapshot.providers[0]?.models[0]?.aliases).toEqual(["alias"])
})

test("explicit header replacement removes absent rows and permits empty stored values", async () => {
  await repository.upsert(provider, await context(provider))
  const replacement = {
    ...provider,
    apiKey: undefined,
    replaceHeaders: true,
    headers: { "X-New": "new-secret", "X-Empty": "" },
  }
  await repository.upsert(replacement, await context(replacement))
  expect(
    (await loadCustomProviderSnapshot(fixture.storage)).providers[0]?.headers,
  ).toEqual(replacement.headers)
  const cleared = { ...replacement, headers: {} }
  await repository.upsert(cleared, await context(cleared))
  expect(
    (await loadCustomProviderSnapshot(fixture.storage)).providers[0]?.headers,
  ).toBeUndefined()
})

test("explicit provider reveal returns stored secrets and one revision without changing metadata", async () => {
  await repository.upsert(provider, await context(provider))
  const before = await repository.listPage()
  expect(await repository.reveal(provider.id)).toEqual({
    id: provider.id,
    apiKey: provider.apiKey,
    headers: provider.headers,
    revision: before.revision,
  })
  expect(await repository.listPage()).toEqual(before)
  const disabled = { ...provider, enabled: false }
  await repository.upsert(disabled, await context(disabled))
  expect(await repository.reveal(provider.id)).toMatchObject({
    apiKey: provider.apiKey,
    headers: provider.headers,
  })
  await repository.remove(
    provider.id,
    await context(provider.id, "provider.remove"),
  )
  expect(await repository.reveal(provider.id)).toBeNull()
  expect(await repository.reveal("missing-provider")).toBeNull()
})

test("invalid inputs and failed commits preserve metadata and secret", async () => {
  await repository.upsert(provider, await context(provider))
  const bad = { ...provider, apiKeyEnv: "FIXTURE_PROVIDER_ENV" }
  await expect(repository.upsert(bad, await context(bad))).rejects.toThrow()
  const invalid = { ...provider, models: [] }
  await expect(
    repository.upsert(invalid, await context(invalid)),
  ).rejects.toThrow()
  fixture.failWrites()
  const edit = { ...provider, apiKey: "replacement", name: "Wrong" }
  await expect(repository.upsert(edit, await context(edit))).rejects.toThrow()
  fixture.failWrites(false)
  expect(
    (await loadCustomProviderSnapshot(fixture.storage)).providers[0],
  ).toMatchObject(provider)
  const rows = await fixture.storage.read((s) =>
    s.query({
      sql: "SELECT result_json FROM capi_applied_operations",
      args: [],
    }),
  )
  expect(JSON.stringify(rows)).not.toContain(provider.apiKey)
  expect(JSON.stringify(rows)).not.toContain("fixture-header-secret")
})

test("Groq stores, retains and explicitly clears its secret", async () => {
  await repository.setGroqSecret(
    { apiKey: "fixture-groq" },
    await context("groq", "groq.update"),
  )
  await repository.setGroqSecret(
    { apiKey: "" },
    await context("retain", "groq.update"),
  )
  expect((await loadCustomProviderSnapshot(fixture.storage)).groqApiKey).toBe(
    "fixture-groq",
  )
  await repository.setGroqSecret(
    { clearApiKey: true },
    await context("clear", "groq.update"),
  )
  expect(
    (await loadCustomProviderSnapshot(fixture.storage)).groqApiKey,
  ).toBeUndefined()
})

test("provider requests retain one immutable revision through rotation and failed writes", async () => {
  await upsertCustomProvider(provider, await context(provider))
  const captured = getStorageRuntime().snapshot.get()
  const replacement = { ...provider, apiKey: "rotated-secret" }
  await withRequestSnapshot(captured, async () => {
    await upsertCustomProvider(replacement, await context(replacement))
    expect(getCustomProviders()[0]?.apiKey).toBe(provider.apiKey)
    expect(Object.isFrozen(getCustomProviders()[0]?.headers)).toBe(true)
  })
  expect(getCustomProviders()[0]?.apiKey).toBe("rotated-secret")
  fixture.failWrites()
  await expect(
    upsertCustomProvider(provider, await context(provider)),
  ).rejects.toThrow()
  fixture.failWrites(false)
  expect(getCustomProviders()[0]?.apiKey).toBe("rotated-secret")
})

test("disabled providers retain secrets, removed providers reject ID reuse", async () => {
  await repository.upsert(provider, await context(provider))
  const disabled = {
    ...provider,
    apiKey: undefined,
    headers: undefined,
    enabled: false,
  }
  await repository.upsert(disabled, await context(disabled))
  expect((await loadCustomProviderSnapshot(fixture.storage)).providers).toEqual(
    [],
  )
  expect((await repository.list())[0]).toMatchObject({
    enabled: false,
    apiKeyConfigured: true,
  })
  const enabled = { ...disabled, enabled: true }
  await repository.upsert(enabled, await context(enabled))
  expect(
    (await loadCustomProviderSnapshot(fixture.storage)).providers[0]?.apiKey,
  ).toBe(provider.apiKey)
  await repository.remove(
    provider.id,
    await context(provider.id, "provider.remove"),
  )
  await expect(
    repository.upsert(provider, await context(provider)),
  ).rejects.toThrow()
})

test("both transcription readers use the database Groq key and ignore the environment", async () => {
  await mergeConfigWithDefaults()
  const originalFetch = globalThis.fetch
  const originalKey = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = "environment-must-not-win"
  const keys: Array<string | null> = []
  globalThis.fetch = Object.assign(
    (_input: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("authorization"))
      return Promise.resolve(Response.json({ text: "fixture transcription" }))
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  try {
    await expect(transcribe(new Uint8Array([1]))).rejects.toThrow(
      "not configured",
    )
    await repository.setGroqSecret(
      { apiKey: "database-groq-key" },
      await context("groq-parity", "groq.update"),
    )
    await getStorageRuntime().snapshot.refreshIfChanged()
    expect(await transcribe(new Uint8Array([1]))).toEqual({
      text: "fixture transcription",
    })
    const form = new FormData()
    form.set("file", new Blob([new Uint8Array([1])]), "audio.wav")
    form.set("model", "whisper-1")
    const response = await audioTranscriptionRoutes.request("/", {
      method: "POST",
      body: form,
    })
    expect(response.status).toBe(200)
    expect(keys).toEqual([
      "Bearer database-groq-key",
      "Bearer database-groq-key",
    ])
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
  }
})

test("an uncertain provider commit reconciles once without publishing unconfirmed credentials", async () => {
  await upsertCustomProvider(provider, await context(provider))
  const input = { ...provider, apiKey: "uncertain-rotated" }
  const mutation = await context(input)
  fixture.loseNextCommitResponse({ failReads: true })
  await expect(upsertCustomProvider(input, mutation)).rejects.toThrow("unknown")
  expect(getCustomProviders()[0]?.apiKey).toBe(provider.apiKey)
  fixture.failReads(false)
  await upsertCustomProvider(input, mutation)
  expect(getCustomProviders()[0]?.apiKey).toBe("uncertain-rotated")
  const rows = await fixture.storage.read((session) =>
    session.query({
      sql: "SELECT COUNT(*) AS count FROM capi_applied_operations WHERE id=?",
      args: [mutation.operationId],
    }),
  )
  expect(rows[0]?.count).toBe(1)
})

test("corrupt provider metadata fails closed instead of silently dropping the provider", async () => {
  await repository.upsert(provider, await context(provider))
  await fixture.storage.atomicBatch([
    {
      sql: "UPDATE capi_providers SET payload_json='{}' WHERE id=?",
      args: [provider.id],
    },
  ])
  await expect(loadCustomProviderSnapshot(fixture.storage)).rejects.toThrow(
    "Invalid provider record",
  )
})

test("copied mutation identities cannot replay against another provider or secret", async () => {
  await repository.upsert(provider, await context(provider))
  const removeContext = await context(provider.id, "provider.remove")
  await repository.remove(provider.id, removeContext)
  await expect(
    repository.remove("different-id", removeContext),
  ).rejects.toThrow("identity")
  const groqContext = await context("groq-binding", "groq.update")
  await repository.setGroqSecret({ apiKey: "first" }, groqContext)
  await expect(
    repository.setGroqSecret({ apiKey: "different" }, groqContext),
  ).rejects.toThrow("identity")
  const upsertContext = await context("new", "provider.upsert")
  await repository.upsert({ ...provider, id: "new" }, upsertContext)
  await expect(
    repository.upsert(
      { ...provider, id: "new", apiKey: "different" },
      upsertContext,
    ),
  ).rejects.toThrow("identity")
})

test("provider editing page revision includes unrelated commits without changing provider metadata", async () => {
  await repository.upsert(provider, await context(provider))
  const before = (await repository.list())[0]
  await fixture.storage.atomicBatch([
    {
      sql: "UPDATE capi_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='config_revision'",
      args: [],
    },
  ])
  const page = await repository.listPage()
  expect(page.revision).toBe(before.revision + 1)
  expect(page.providers).toEqual([before])
})
