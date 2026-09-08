import { createHash } from "node:crypto"

import type {
  Committed,
  JsonValue,
  MutationContext,
  RuntimeSnapshot,
  SettingsDocument,
  SettingsNamespace,
  SettingsRepository,
  SqlSession,
  Storage,
} from "~/lib/storage/types"

import { StorageConflictError, StorageSchemaError } from "~/lib/storage/errors"
import {
  getStoreRevision,
  readStoreRevision,
  runMutation,
} from "~/lib/storage/operations"

const namespaces: ReadonlySet<string> = new Set([
  "app",
  "replacements",
  "model_redirects",
  "model_settings",
  "model_routing",
  "model_fallbacks",
  "feature_flags",
  "statsig_overrides",
])

export interface SettingsRepositoryOptions {
  validators?: Partial<
    Record<SettingsNamespace, (value: JsonValue) => JsonValue>
  >
}

export interface SnapshotRepository extends SettingsRepository {
  getRevision(): Promise<number>
  loadSnapshot(): Promise<RuntimeSnapshot>
}

function invalidDocument(): StorageSchemaError {
  return new StorageSchemaError("Invalid settings document")
}

function copyJson(value: unknown, parents = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || parents.has(value)) throw invalidDocument()
  parents.add(value)
  try {
    if (Array.isArray(value))
      return Array.from(value, (item: unknown) => copyJson(item, parents))
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw invalidDocument()
    const entries = new Map(Object.entries(value))
    return Object.fromEntries(
      [...entries.keys()]
        .sort()
        .map((key) => [key, copyJson(entries.get(key), parents)]),
    )
  } finally {
    parents.delete(value)
  }
}

/** Detached, finite JSON with stable object key ordering; never stringify unvalidated input. */
export function normalizeSettingsJson(value: unknown): JsonValue {
  try {
    return copyJson(value)
  } catch {
    throw invalidDocument()
  }
}

function assertNamespace(
  namespace: unknown,
): asserts namespace is SettingsNamespace {
  if (typeof namespace !== "string" || !namespaces.has(namespace))
    throw invalidDocument()
}

/** The digest binds the normalized document and namespace, without storing its content. */
export function settingsInputDigest(
  namespace: SettingsNamespace,
  value: JsonValue,
): string {
  assertNamespace(namespace)
  return createHash("sha256")
    .update(JSON.stringify([namespace, normalizeSettingsJson(value)]))
    .digest("hex")
}

function validateValue(
  namespace: SettingsNamespace,
  value: unknown,
  options: SettingsRepositoryOptions,
): JsonValue {
  const detached = normalizeSettingsJson(value)
  const validator = options.validators?.[namespace]
  if (!validator) return detached
  try {
    return normalizeSettingsJson(validator(detached))
  } catch {
    // Validators may include sensitive values in their diagnostics.
    throw invalidDocument()
  }
}

function decodeDocument(
  row: Record<string, unknown>,
  options: SettingsRepositoryOptions,
): SettingsDocument {
  assertNamespace(row.namespace)
  if (
    typeof row.value_json !== "string"
    || typeof row.revision !== "number"
    || !Number.isSafeInteger(row.revision)
    || row.revision < 0
  )
    throw invalidDocument()
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value_json)
  } catch {
    throw invalidDocument()
  }
  return {
    namespace: row.namespace,
    value: validateValue(row.namespace, parsed, options),
    revision: row.revision,
  }
}

async function loadDocuments(
  session: SqlSession,
  options: SettingsRepositoryOptions,
): Promise<Array<SettingsDocument>> {
  const rows = await session.query({
    sql: "SELECT namespace, value_json, revision FROM capi_settings ORDER BY namespace",
    args: [],
  })
  return rows.map((row) => decodeDocument(row, options))
}

interface SettingsMarker {
  namespace: SettingsNamespace
  documentRevision: number
}

async function replaceDocument(
  session: SqlSession,
  document: { namespace: SettingsNamespace; value: JsonValue },
  options: SettingsRepositoryOptions,
): Promise<SettingsMarker> {
  const { namespace, value } = document
  const rows = await session.query({
    sql: "SELECT namespace, value_json, revision FROM capi_settings WHERE namespace = ?",
    args: [namespace],
  })
  const previous = rows[0] ? decodeDocument(rows[0], options) : undefined
  const storedValue = rows[0] ? decodeDocument(rows[0], {}).value : undefined
  if (previous && JSON.stringify(storedValue) === JSON.stringify(value))
    return { namespace, documentRevision: previous.revision }
  const documentRevision = (previous?.revision ?? 0) + 1
  if (!Number.isSafeInteger(documentRevision)) throw invalidDocument()
  await session.execute({
    sql: "INSERT INTO capi_settings (namespace, value_json, revision) VALUES (?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET value_json = excluded.value_json, revision = excluded.revision",
    args: [namespace, JSON.stringify(value), documentRevision],
  })
  return { namespace, documentRevision }
}

export function createSettingsRepository(
  storage: Storage,
  options: SettingsRepositoryOptions = {},
): SnapshotRepository {
  const loadSnapshot = () =>
    storage.read(async (session) => {
      const revision = await readStoreRevision(session)
      const documents = await loadDocuments(session, options)
      for (const document of documents) {
        if (document.revision > revision) throw invalidDocument()
      }
      return {
        revision,
        documents: new Map(
          documents.map((document) => [document.namespace, document]),
        ),
      }
    })

  return {
    getRevision: () => getStoreRevision(storage),
    loadSnapshot,
    async loadAll() {
      return [...(await loadSnapshot()).documents.values()]
    },
    async replace(
      namespace: SettingsNamespace,
      submitted: JsonValue,
      context: MutationContext,
    ): Promise<Committed<SettingsDocument>> {
      assertNamespace(namespace)
      const value = validateValue(namespace, submitted, options)
      if (context.inputDigest !== settingsInputDigest(namespace, value))
        throw new StorageConflictError(
          "Settings input does not match its operation digest",
        )
      const committed = await runMutation(storage, context, (session) =>
        replaceDocument(session, { namespace, value }, options),
      )
      const marker = committed.value
      if (
        marker.namespace !== namespace
        || !Number.isSafeInteger(marker.documentRevision)
        || marker.documentRevision < 0
        || marker.documentRevision > committed.revision
      )
        throw invalidDocument()
      // Reconciliation proves the caller's input was committed. The operation marker
      // deliberately contains no document value (it may contain sensitive settings).
      return {
        revision: committed.revision,
        value: { namespace, value, revision: marker.documentRevision },
      }
    },
  }
}
