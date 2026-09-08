import type { SnapshotRepository } from "~/lib/storage/settings-repository"
import type {
  Committed,
  JsonValue,
  MutationContext,
  RuntimeSnapshot,
  SettingsDocument,
  SettingsNamespace,
  SnapshotManager,
} from "~/lib/storage/types"

import { StorageSchemaError } from "~/lib/storage/errors"
import { normalizeSettingsJson } from "~/lib/storage/settings-repository"

function freezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

/** ReadonlyMap at runtime too: freezing a native Map does not disable its setters. */
class SnapshotDocuments
  implements ReadonlyMap<SettingsNamespace, SettingsDocument>
{
  readonly #documents: Map<SettingsNamespace, SettingsDocument>

  constructor(documents: ReadonlyMap<SettingsNamespace, SettingsDocument>) {
    this.#documents = new Map(documents)
    Object.freeze(this)
  }

  get size() {
    return this.#documents.size
  }
  get(key: SettingsNamespace) {
    return this.#documents.get(key)
  }
  has(key: SettingsNamespace) {
    return this.#documents.has(key)
  }
  entries() {
    return this.#documents.entries()
  }
  keys() {
    return this.#documents.keys()
  }
  values() {
    return this.#documents.values()
  }
  [Symbol.iterator]() {
    return this.#documents[Symbol.iterator]()
  }
  forEach(
    callback: (
      value: SettingsDocument,
      key: SettingsNamespace,
      map: ReadonlyMap<SettingsNamespace, SettingsDocument>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#documents.entries())
      callback.call(thisArg, value, key, this)
  }
}

function immutableSnapshot(source: RuntimeSnapshot): RuntimeSnapshot {
  if (!Number.isSafeInteger(source.revision) || source.revision < 0)
    throw new StorageSchemaError("Invalid settings snapshot revision")
  const documents = new Map<SettingsNamespace, SettingsDocument>()
  for (const [namespace, document] of source.documents) {
    if (
      document.namespace !== namespace
      || !Number.isSafeInteger(document.revision)
      || document.revision < 0
      || document.revision > source.revision
    )
      throw new StorageSchemaError("Invalid settings snapshot document")
    documents.set(
      namespace,
      Object.freeze({
        namespace,
        revision: document.revision,
        value: freezeJson(normalizeSettingsJson(document.value)),
      }),
    )
  }
  return Object.freeze({
    revision: source.revision,
    documents: new SnapshotDocuments(documents),
  })
}

export async function initializeSnapshot(
  repository: SnapshotRepository,
): Promise<SnapshotManager> {
  let current = immutableSnapshot(await repository.loadSnapshot())
  const publish = (snapshot: RuntimeSnapshot): void => {
    if (snapshot.revision > current.revision)
      current = immutableSnapshot(snapshot)
  }
  return {
    get: () => current,
    publish,
    async refreshIfChanged() {
      // Each admission needs a read begun after it arrived. Reusing an earlier
      // request's pending read could miss an external commit made in between.
      const beforeRead = current.revision
      const revision = await repository.getRevision()
      if (revision < beforeRead)
        throw new StorageSchemaError("Settings revision moved backwards")
      if (revision > current.revision) {
        const snapshot = await repository.loadSnapshot()
        if (snapshot.revision < revision)
          throw new StorageSchemaError(
            "Settings snapshot is behind its metadata revision",
          )
        publish(snapshot)
      }
    },
  }
}

/** Publish only a whole committed snapshot; concurrent commits cannot overwrite newer data. */
// eslint-disable-next-line max-params -- Explicit repository, publication target and the shared three-argument replace contract.
export async function replaceSnapshotDocument(
  repository: SnapshotRepository,
  manager: SnapshotManager,
  namespace: SettingsNamespace,
  value: JsonValue,
  context: MutationContext,
): Promise<Committed<SettingsDocument>> {
  const committed = await repository.replace(namespace, value, context)
  const snapshot = await repository.loadSnapshot()
  if (snapshot.revision < committed.revision)
    throw new StorageSchemaError("Committed settings revision is unavailable")
  manager.publish(snapshot)
  return committed
}
