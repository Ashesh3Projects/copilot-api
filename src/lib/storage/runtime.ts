import type { StorageConfig } from "~/lib/storage/config"
import type { SnapshotRepository } from "~/lib/storage/settings-repository"
import type { JsonValue, SnapshotManager, Storage } from "~/lib/storage/types"

import { validateStoredReplacements } from "~/lib/auto-replace"
import { validateAppConfigJson } from "~/lib/config"
import { validateModelFallbackConfig } from "~/lib/model-fallback-config"
import { validateStoredModelRedirects } from "~/lib/model-redirect"
import { validateStoredModelRouting } from "~/lib/model-routing"
import { validateStoredModelSettings } from "~/lib/model-settings"
import { createStorage } from "~/lib/storage/client"
import { resolveStorageConfig } from "~/lib/storage/config"
import {
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { migrateStorage } from "~/lib/storage/migrations"
import { probeStorage } from "~/lib/storage/readiness"
import { createSettingsRepository } from "~/lib/storage/settings-repository"
import { initializeSnapshot } from "~/lib/storage/snapshot"
import { validateStoredFeatureFlags } from "~/routes/feature-flags/store"
import { validateStatsigOverrides } from "~/routes/statsig-overrides/store"

export interface StorageRuntime {
  storage: Storage
  config:
    | { readonly kind: "sqlite"; readonly path: string }
    | { readonly kind: "turso"; readonly url: string }
  settings: SnapshotRepository
  snapshot: SnapshotManager
  close(): Promise<void>
}

let current: StorageRuntime | undefined
let initializing: Promise<StorageRuntime> | undefined

function preservingValidator(
  validate: (value: unknown) => unknown,
): (value: JsonValue) => JsonValue {
  return (value) => {
    validate(value)
    return value
  }
}

async function openRuntime(options: {
  storage?: Storage
  config?: StorageConfig
}): Promise<StorageRuntime> {
  const selected = options.config ?? resolveStorageConfig()
  const storage = options.storage ?? createStorage(selected)
  try {
    const readiness = await probeStorage(storage, {
      kind: selected.kind,
      requireSchema: false,
    })
    if (!readiness.ready) {
      if (
        readiness.reason === "schema_invalid"
        || readiness.reason === "schema_missing"
      )
        throw new StorageSchemaError()
      throw new StorageUnavailableError(readiness.reason)
    }
    await migrateStorage(storage)
    const incomplete = await storage.read((session) =>
      session.query({
        sql: "SELECT value FROM capi_metadata WHERE key IN ('transfer_incomplete', 'restore_incomplete')",
        args: [],
      }),
    )
    if (incomplete.length > 0)
      throw new StorageSchemaError("Database transfer is incomplete")
    const settings = createSettingsRepository(storage, {
      validators: {
        app: validateAppConfigJson,
        replacements: preservingValidator(validateStoredReplacements),
        model_redirects: preservingValidator(validateStoredModelRedirects),
        model_settings: preservingValidator(validateStoredModelSettings),
        model_routing: preservingValidator(validateStoredModelRouting),
        model_fallbacks: preservingValidator(validateModelFallbackConfig),
        feature_flags: preservingValidator(validateStoredFeatureFlags),
        statsig_overrides: preservingValidator(validateStatsigOverrides),
      },
    })
    const snapshot = await initializeSnapshot(settings)
    let closed = false
    const runtime: StorageRuntime = {
      storage,
      config: Object.freeze(
        selected.kind === "sqlite" ?
          { kind: "sqlite", path: selected.path }
        : { kind: "turso", url: selected.url },
      ),
      settings,
      snapshot,
      async close() {
        if (closed) return
        closed = true
        if (current === runtime) current = undefined
        await storage.close()
      },
    }
    current = runtime
    return runtime
  } catch (error) {
    await storage.close().catch(() => undefined)
    throw error
  }
}

export function initializeStorageRuntime(
  options: { storage?: Storage; config?: StorageConfig } = {},
): Promise<StorageRuntime> {
  if (current) return Promise.resolve(current)
  initializing ??= openRuntime(options).finally(() => {
    initializing = undefined
  })
  return initializing
}

export function peekStorageRuntime(): StorageRuntime | undefined {
  return current
}
export function getStorageRuntime(): StorageRuntime {
  if (!current) throw new StorageUnavailableError()
  return current
}
export async function closeStorageRuntime(): Promise<void> {
  if (initializing) await initializing.catch(() => undefined)
  await current?.close()
}
