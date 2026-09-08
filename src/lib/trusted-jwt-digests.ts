import { createHash, randomUUID } from "node:crypto"

import type { Storage } from "~/lib/storage/types"

import { StorageConflictError } from "~/lib/storage/errors"
import { withStorageDeadline } from "~/lib/storage/operation-budget"
import { createPolicyRepository } from "~/lib/storage/policy-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"

export interface TrustedJwtDigestEntry {
  id: string
  label: string
  digest: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export class TrustedJwtDigestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TrustedJwtDigestValidationError"
  }
}

export class TrustedJwtDigestConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TrustedJwtDigestConflictError"
  }
}

export interface TrustedJwtDigestStore {
  list(): Promise<Array<TrustedJwtDigestEntry>>
  add(input: { label: string; digest: string }): Promise<TrustedJwtDigestEntry>
  setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<TrustedJwtDigestEntry | null>
  remove(id: string): Promise<boolean>
  findEnabledCredential(
    rawCredential: string,
  ): Promise<TrustedJwtDigestEntry | null>
  /** Match a raw credential against all records, including disabled entries. */
  matchesCredentialDigest(rawCredential: string): Promise<boolean>
  containsDigestLiteral(value: string): Promise<boolean>
  replaceForTest(entries: ReadonlyArray<TrustedJwtDigestEntry>): void
  resetAfterTest(): void
}

const DIGEST_PATTERN = /^[a-f\d]{64}$/i
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex -- labels must reject ASCII controls
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const MAX_LABEL_LENGTH = 80
const ENTRY_FIELDS = new Set([
  "createdAt",
  "digest",
  "enabled",
  "id",
  "label",
  "updatedAt",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validationError(message: string): never {
  throw new TrustedJwtDigestValidationError(message)
}

function hasOnlyFields(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") {
    return validationError("label must be a string")
  }
  const label = value.trim()
  if (!label) return validationError("label is required")
  if (label.length > MAX_LABEL_LENGTH) {
    return validationError("label must not exceed 80 characters")
  }
  if (CONTROL_CHARACTER_PATTERN.test(label)) {
    return validationError("label must not contain control characters")
  }
  return label
}

function normalizeDigest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    return validationError("digest must be 64 hexadecimal characters")
  }
  return value.toLowerCase()
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return validationError("id must be a UUID")
  }
  return value.toLowerCase()
}

function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    return validationError(`${field} must be an ISO timestamp`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return validationError(`${field} must be an ISO timestamp`)
  }
  return value
}

function validateEntry(value: unknown): TrustedJwtDigestEntry {
  if (!isRecord(value)) return validationError("entry must be an object")
  if (!hasOnlyFields(value, ENTRY_FIELDS)) {
    return validationError("entry has invalid fields")
  }
  if (typeof value.enabled !== "boolean") {
    return validationError("enabled must be a boolean")
  }
  return {
    id: validateId(value.id),
    label: normalizeLabel(value.label),
    digest: normalizeDigest(value.digest),
    enabled: value.enabled,
    createdAt: validateTimestamp(value.createdAt, "createdAt"),
    updatedAt: validateTimestamp(value.updatedAt, "updatedAt"),
  }
}

function validateEntries(
  values: ReadonlyArray<unknown>,
): Array<TrustedJwtDigestEntry> {
  const entries: Array<TrustedJwtDigestEntry> = []
  const ids = new Set<string>()
  const digests = new Set<string>()
  for (const value of values) {
    const entry = validateEntry(value)
    if (ids.has(entry.id)) return validationError("duplicate entry id")
    if (digests.has(entry.digest)) {
      return validationError("duplicate entry digest")
    }
    ids.add(entry.id)
    digests.add(entry.digest)
    entries.push(entry)
  }
  return entries
}

function digestCredential(rawCredential: string): string {
  // Random bearer/JWT lookup contract, not human-password verification.
  // lgtm [js/insufficient-password-hash]
  return createHash("sha256").update(rawCredential.trim(), "utf8").digest("hex")
}

export function createTrustedJwtDigestStore(
  storage?: Storage,
): TrustedJwtDigestStore {
  let testEntries: Array<TrustedJwtDigestEntry> | undefined
  const repository = () =>
    createPolicyRepository(storage ?? getStorageRuntime().storage)
  async function findDigest(
    digest: string,
  ): Promise<TrustedJwtDigestEntry | null> {
    if (testEntries !== undefined) {
      const entry = testEntries.find((item) => item.digest === digest)
      return entry ? { ...entry } : null
    }
    return repository().findDigest(digest)
  }
  return {
    async list() {
      return testEntries === undefined ?
          repository().listDigests()
        : testEntries.map((entry) => ({ ...entry }))
    },
    async add(input) {
      return withStorageDeadline(Date.now() + 30_000, async () => {
        const label = normalizeLabel(input.label)
        const digest = normalizeDigest(input.digest)
        if (await findDigest(digest))
          throw new TrustedJwtDigestConflictError(
            "digest is already registered",
          )
        const timestamp = new Date().toISOString()
        const entry: TrustedJwtDigestEntry = {
          id: randomUUID(),
          label,
          digest,
          enabled: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        if (testEntries !== undefined) testEntries = [...testEntries, entry]
        else {
          try {
            await repository().addDigest(entry)
          } catch (error) {
            if (
              error instanceof StorageConflictError
              && (await findDigest(digest))
            )
              throw new TrustedJwtDigestConflictError(
                "digest is already registered",
              )
            throw error
          }
        }
        return { ...entry }
      })
    },
    async setEnabled(id, enabled) {
      if (typeof enabled !== "boolean")
        return validationError("enabled must be a boolean")
      if (testEntries === undefined)
        return repository().setDigestEnabled(id, enabled)
      const entry = testEntries.find((item) => item.id === id)
      if (!entry) return null
      const updated = { ...entry, enabled, updatedAt: new Date().toISOString() }
      testEntries = testEntries.map((item) => (item.id === id ? updated : item))
      return { ...updated }
    },
    async remove(id) {
      if (testEntries === undefined) return repository().removeDigest(id)
      const before = testEntries.length
      testEntries = testEntries.filter((entry) => entry.id !== id)
      return before !== testEntries.length
    },
    async findEnabledCredential(rawCredential) {
      const candidate = rawCredential.trim().toLowerCase()
      if (DIGEST_PATTERN.test(candidate) && (await findDigest(candidate)))
        return null
      const match = await findDigest(digestCredential(rawCredential))
      return match?.enabled ? match : null
    },
    async matchesCredentialDigest(rawCredential) {
      return (await findDigest(digestCredential(rawCredential))) !== null
    },
    async containsDigestLiteral(value) {
      const candidate = value.trim().toLowerCase()
      return (
        DIGEST_PATTERN.test(candidate) && (await findDigest(candidate)) !== null
      )
    },
    replaceForTest(entries) {
      testEntries = validateEntries(entries)
    },
    resetAfterTest() {
      testEntries = undefined
    },
  }
}

export const trustedJwtDigestStore: TrustedJwtDigestStore =
  createTrustedJwtDigestStore()
