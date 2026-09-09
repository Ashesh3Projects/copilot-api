import { StorageSchemaError } from "~/lib/storage/errors"
import {
  initialIndexes,
  initialMigration,
  initialTables,
} from "~/lib/storage/migrations/001-initial"
import {
  gatewaySecretsMigration,
  gatewaySecretTables,
} from "~/lib/storage/migrations/002-gateway-secrets"
import { memoryOnlyDebugMigration } from "~/lib/storage/migrations/003-memory-only-debug"

export const storageMigrations = [
  initialMigration,
  gatewaySecretsMigration,
  memoryOnlyDebugMigration,
] as const

export const currentSchemaVersion = memoryOnlyDebugMigration.version
const versionTwoTables = { ...initialTables, ...gatewaySecretTables }
export const currentTables = Object.fromEntries(
  Object.entries(versionTwoTables).filter(([name]) => name !== "capi_debug"),
)
export const currentIndexes = Object.fromEntries(
  Object.entries(initialIndexes).filter(
    ([, target]) => !target.startsWith("capi_debug("),
  ),
)
export const currentCounterKeys = [
  "config_revision",
  "history_activity_generation",
] as const

/** Preflight validates the applied schema before any destructive migration. */
export function storageSchema(version: number) {
  switch (version) {
    case 1:
    case 2: {
      return {
        tables: version === 1 ? initialTables : versionTwoTables,
        indexes: initialIndexes,
        counterKeys: [...currentCounterKeys, "history_debug_generation"],
      }
    }
    case currentSchemaVersion: {
      return {
        tables: currentTables,
        indexes: currentIndexes,
        counterKeys: currentCounterKeys,
      }
    }
    default: {
      throw new StorageSchemaError("Unsupported schema version")
    }
  }
}
