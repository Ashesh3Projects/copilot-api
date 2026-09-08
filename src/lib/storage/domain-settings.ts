import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

import type { StorageRuntime } from "~/lib/storage/runtime"
import type {
  JsonValue,
  MutationContext,
  SettingsNamespace,
} from "~/lib/storage/types"

import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import {
  deadlinePromise,
  getStorageDeadline,
  remainingStorageMs,
  withStorageDeadline,
} from "~/lib/storage/operation-budget"
import {
  getCurrentSnapshot,
  getRequestSnapshot,
} from "~/lib/storage/request-snapshot"
import { getStorageRuntime } from "~/lib/storage/runtime"
import {
  normalizeSettingsJson,
  settingsInputDigest,
} from "~/lib/storage/settings-repository"
import { replaceSnapshotDocument } from "~/lib/storage/snapshot"

const actors = new AsyncLocalStorage<string>()

export function getSettingsActorId(): string | undefined {
  return actors.getStore()
}
const writes = new WeakMap<StorageRuntime, Promise<void>>()
interface PendingSetting {
  namespace: SettingsNamespace
  value: JsonValue
  context: MutationContext
}
const pending = new WeakMap<StorageRuntime, PendingSetting>()

/** The caller supplies an actor obtained from verified server-side authority. */
export function withSettingsActor<T>(actorId: string, work: () => T): T {
  if (!actorId.trim())
    throw new StorageConflictError("A verified settings actor is required")
  return actors.run(actorId, work)
}

export function getLoadedSetting(
  namespace: SettingsNamespace,
): JsonValue | undefined {
  return getCurrentSnapshot(getStorageRuntime().snapshot).documents.get(
    namespace,
  )?.value
}

export function getLoadedSettingRevision(namespace: SettingsNamespace): number {
  return (
    getCurrentSnapshot(getStorageRuntime().snapshot).documents.get(namespace)
      ?.revision ?? 0
  )
}

/** Cache publication must consult live state, even within a captured request. */
export function getLiveSettingRevision(namespace: SettingsNamespace): number {
  return (
    getStorageRuntime().snapshot.get().documents.get(namespace)?.revision ?? 0
  )
}

export async function readSetting(
  namespace: SettingsNamespace,
): Promise<JsonValue | undefined> {
  const { snapshot } = getStorageRuntime()
  await snapshot.refreshIfChanged()
  return snapshot.get().documents.get(namespace)?.value
}

export function writeSetting(
  namespace: SettingsNamespace,
  value: JsonValue,
): Promise<JsonValue> {
  const detached = normalizeSettingsJson(value)
  return updateSetting(namespace, () => detached)
}

export async function updateSetting(
  namespace: SettingsNamespace,
  updater: (current: JsonValue | undefined) => JsonValue,
): Promise<JsonValue> {
  const runtime = getStorageRuntime()
  const actorId =
    actors.getStore()
    ?? (getRequestSnapshot() ? undefined : "system:startup-cli")
  if (!actorId)
    throw new StorageConflictError("A verified settings actor is required")
  return serializeSettingMutation(runtime, async () => {
    await reconcilePending(runtime)
    await runtime.snapshot.refreshIfChanged()
    const before = runtime.snapshot.get()
    const previous = before.documents.get(namespace)?.value
    const value = normalizeSettingsJson(
      updater(
        previous === undefined ? undefined : normalizeSettingsJson(previous),
      ),
    )
    if (
      previous !== undefined
      && JSON.stringify(previous) === JSON.stringify(value)
    )
      return value
    const mutation: PendingSetting = {
      namespace,
      value,
      context: {
        operationId: randomUUID(),
        expectedRevision: before.revision,
        actorId,
        kind: "settings.replace",
        inputDigest: settingsInputDigest(namespace, value),
      },
    }
    return commitSetting(runtime, mutation)
  })
}

async function commitSetting(
  runtime: StorageRuntime,
  mutation: PendingSetting,
): Promise<JsonValue> {
  try {
    const committed = await replaceSnapshotDocument(
      runtime.settings,
      runtime.snapshot,
      mutation.namespace,
      mutation.value,
      mutation.context,
    )
    return committed.value.value
  } catch (error) {
    if (
      error instanceof StorageCommitUnknownError
      && error.operationId === mutation.context.operationId
    )
      pending.set(runtime, mutation)
    throw error
  }
}

async function reconcilePending(runtime: StorageRuntime): Promise<void> {
  const mutation = pending.get(runtime)
  if (!mutation) return
  // runMutation recognizes this ID as pending and only looks up its marker.
  // It never executes the write again while its earlier outcome is unknown.
  await commitSetting(runtime, mutation)
  pending.delete(runtime)
}

export function reconcilePendingSettingsMutation(): Promise<void> {
  const runtime = getStorageRuntime()
  return serializeSettingMutation(runtime, () => reconcilePending(runtime))
}

function serializeSettingMutation<T>(
  runtime: StorageRuntime,
  work: () => Promise<T>,
): Promise<T> {
  return withStorageDeadline(Date.now() + 30_000, async () => {
    const deadline = getStorageDeadline()
    if (deadline === undefined) throw new StorageUnavailableError("timeout")
    const previous = writes.get(runtime) ?? Promise.resolve()
    const slot = Promise.withResolvers<undefined>()
    writes.set(runtime, slot.promise)
    let admitted = false
    try {
      await deadlinePromise(previous, deadline)
      if (remainingStorageMs() <= 0)
        throw new StorageUnavailableError("timeout")
      admitted = true
      return await work()
    } finally {
      if (admitted) slot.resolve(undefined)
      else
        void previous.then(
          () => slot.resolve(undefined),
          () => slot.resolve(undefined),
        )
    }
  })
}
