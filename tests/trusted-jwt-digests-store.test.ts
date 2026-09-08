/* eslint-disable require-atomic-updates -- serial test hooks own the fixture storage. */
/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun async matchers have void types but must be awaited. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

import type { Storage } from "~/lib/storage/types"

import { createStorage } from "~/lib/storage/client"
import { withSettingsActor } from "~/lib/storage/domain-settings"
import {
  StorageCommitUnknownError,
  StorageUnavailableError,
  StorageSchemaError,
} from "~/lib/storage/errors"
import { migrateStorage } from "~/lib/storage/migrations"
import { withStorageDeadline } from "~/lib/storage/operation-budget"
import { getStoreRevision } from "~/lib/storage/operations"
import {
  createTrustedJwtDigestStore,
  TrustedJwtDigestConflictError,
  TrustedJwtDigestValidationError,
} from "~/lib/trusted-jwt-digests"

import { faultStorage } from "./helpers/storage-schema"

let storage: Storage
let directory: string
let databasePath: string
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex")
const act = <T>(work: () => T): T =>
  withSettingsActor("admin:policy-test", work)

beforeEach(async () => {
  directory = resolve(".superpowers/test-data", `policy-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  databasePath = resolve(directory, "copilot-api.sqlite")
  storage = createStorage({ kind: "sqlite", path: databasePath })
  await migrateStorage(storage)
})
afterEach(async () => {
  await storage.close()
  await rm(directory, { recursive: true, force: true })
})

test("trusted credentials persist normalized digest-only records across reopen", async () => {
  const store = createTrustedJwtDigestStore(storage)
  expect(await store.list()).toEqual([])
  const added = await act(() =>
    store.add({
      label: "  Office  ",
      digest: sha256("device-secret").toUpperCase(),
    }),
  )
  expect(added).toMatchObject({
    label: "Office",
    digest: sha256("device-secret"),
    enabled: true,
  })
  const rows = await storage.read((session) =>
    session.query({
      sql: "SELECT * FROM capi_inference_credentials",
      args: [],
    }),
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    kind: "managed",
    principal_id: `inference-managed:${added.id}`,
    scopes_json: '["user:inference"]',
    created_at: Date.parse(added.createdAt),
  })
  expect(JSON.stringify(rows)).not.toContain("device-secret")
  await storage.close()
  storage = createStorage({ kind: "sqlite", path: databasePath })
  expect(await createTrustedJwtDigestStore(storage).list()).toEqual([added])
})

test("fresh authorization rejects digest literals and immediately observes disable and revoke", async () => {
  const store = createTrustedJwtDigestStore(storage)
  const raw = "header.payload.signature"
  const added = await act(() =>
    store.add({ label: "Desktop", digest: sha256(raw) }),
  )
  expect((await store.findEnabledCredential(` ${raw} `))?.id).toBe(added.id)
  expect(
    await store.containsDigestLiteral(` ${added.digest.toUpperCase()} `),
  ).toBe(true)
  expect(await store.findEnabledCredential(added.digest)).toBeNull()
  await act(() =>
    createTrustedJwtDigestStore(storage).setEnabled(added.id, false),
  )
  expect(await store.findEnabledCredential(raw)).toBeNull()
  expect(await store.matchesCredentialDigest(raw)).toBe(true)
  await act(() => store.setEnabled(added.id, true))
  await storage.transaction((session) =>
    session.execute({
      sql: "UPDATE capi_inference_credentials SET revoked_at = ? WHERE id = ?",
      args: [Date.now(), added.id],
    }),
  )
  expect(await store.findEnabledCredential(raw)).toBeNull()
  await act(() => store.remove(added.id))
  expect(await store.matchesCredentialDigest(raw)).toBe(false)
})

test("digest literal remains rejected when another record hashes that literal", async () => {
  const store = createTrustedJwtDigestStore(storage)
  const literal = sha256("original")
  await act(() => store.add({ label: "Original", digest: literal }))
  await act(() =>
    store.add({ label: "Hash of literal", digest: sha256(literal) }),
  )
  expect(await store.findEnabledCredential(literal)).toBeNull()
})

test("failed security writes preserve data and revision without publishing a result", async () => {
  const store = createTrustedJwtDigestStore(storage)
  const added = await act(() =>
    store.add({ label: "Before", digest: sha256("before") }),
  )
  const revision = await getStoreRevision(storage)
  const failing = createTrustedJwtDigestStore(
    faultStorage(storage, {
      beforeCommit() {
        throw new StorageUnavailableError()
      },
    }),
  )
  await expect(
    act(() => failing.setEnabled(added.id, false)),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  await expect(act(() => failing.remove(added.id))).rejects.toBeInstanceOf(
    StorageUnavailableError,
  )
  await expect(
    act(() => failing.add({ label: "After", digest: sha256("after") })),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  expect(await store.list()).toEqual([added])
  expect(await getStoreRevision(storage)).toBe(revision)
})

test("validates labels and digests, reports duplicate conflict, and clones results", async () => {
  const store = createTrustedJwtDigestStore(storage)
  for (const label of [
    "",
    " \t ",
    "x".repeat(81),
    "bad\nlabel",
    "bad\u0000label",
  ]) {
    await expect(
      act(() => store.add({ label, digest: sha256("invalid") })),
    ).rejects.toBeInstanceOf(TrustedJwtDigestValidationError)
  }
  for (const digest of [
    "",
    "a".repeat(63),
    "g".repeat(64),
    ` ${"a".repeat(64)}`,
  ]) {
    await expect(
      act(() => store.add({ label: "Device", digest })),
    ).rejects.toBeInstanceOf(TrustedJwtDigestValidationError)
  }
  const added = await act(() =>
    store.add({ label: "Original", digest: sha256("original") }),
  )
  await expect(
    act(() =>
      store.add({ label: "Duplicate", digest: added.digest.toUpperCase() }),
    ),
  ).rejects.toBeInstanceOf(TrustedJwtDigestConflictError)
  added.label = "Mutated"
  expect((await store.list())[0]?.label).toBe("Original")
  expect(await act(() => store.setEnabled(randomUUID(), false))).toBeNull()
  expect(await act(() => store.remove(randomUUID()))).toBe(false)
  await expect(
    act(() => store.setEnabled(added.id, "false" as unknown as boolean)),
  ).rejects.toBeInstanceOf(TrustedJwtDigestValidationError)
})

test("explicit test override is isolated and reset returns to the selected database", async () => {
  const store = createTrustedJwtDigestStore(storage)
  const durable = await act(() =>
    store.add({ label: "Durable", digest: sha256("durable") }),
  )
  store.replaceForTest([])
  await store.add({ label: "Test-only", digest: sha256("test") })
  expect(await createTrustedJwtDigestStore(storage).list()).toEqual([durable])
  store.resetAfterTest()
  expect(await store.list()).toEqual([durable])
})

test("policy mutation queue times out before admission without releasing its predecessor", async () => {
  const store = createTrustedJwtDigestStore(storage)
  const added = await act(() =>
    store.add({ label: "Queued", digest: sha256("queue") }),
  )
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let hold = true
  const slow = createTrustedJwtDigestStore(
    faultStorage(storage, {
      async beforeCommit() {
        if (hold) {
          entered.resolve(undefined)
          await release.promise
        }
      },
    }),
  )
  const first = act(() => slow.setEnabled(added.id, false))
  await entered.promise
  const second = withStorageDeadline(Date.now() + 10, () =>
    act(() => slow.setEnabled(added.id, true)),
  ).catch((error: unknown) => error)
  const result = await Promise.race([
    second,
    Bun.sleep(100).then(() => "queue did not honor deadline"),
  ])
  hold = false
  release.resolve(undefined)
  await first
  await second
  expect(result).toBeInstanceOf(StorageUnavailableError)
  expect((await store.list())[0]?.enabled).toBe(false)
})

test("lost commit response is reconciled once and does not duplicate a trusted entry", async () => {
  let loseResponse = true
  const uncertain = faultStorage(storage, {
    afterCommit() {
      if (loseResponse) {
        loseResponse = false
        throw new StorageCommitUnknownError()
      }
    },
  })
  const store = createTrustedJwtDigestStore(uncertain)
  const entry = await act(() =>
    store.add({ label: "Reconciled", digest: sha256("reconciled") }),
  )
  expect(await store.list()).toEqual([entry])
  expect(await getStoreRevision(storage)).toBe(1)
})

test("corrupt stored credential metadata fails closed instead of becoming an empty registry", async () => {
  const store = createTrustedJwtDigestStore(storage)
  const entry = await act(() =>
    store.add({ label: "Valid", digest: sha256("metadata") }),
  )
  await storage.transaction((session) =>
    session.execute({
      sql: "UPDATE capi_inference_credentials SET label = ? WHERE id = ?",
      args: ["bad\nlabel", entry.id],
    }),
  )
  await expect(store.list()).rejects.toBeInstanceOf(StorageSchemaError)
  await expect(store.findEnabledCredential("metadata")).rejects.toBeInstanceOf(
    StorageSchemaError,
  )
})
