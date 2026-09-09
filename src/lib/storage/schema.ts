import {
  initialMigration,
  initialIndexes,
  initialTables,
} from "~/lib/storage/migrations/001-initial"
import {
  gatewaySecretsMigration,
  gatewaySecretTables,
} from "~/lib/storage/migrations/002-gateway-secrets"
import {
  accountIntegrationMigration,
  accountIntegrationTables,
} from "~/lib/storage/migrations/003-account-integration"
import { removeActivityMigration } from "~/lib/storage/migrations/004-remove-activity"

export const storageMigrations = [
  initialMigration,
  gatewaySecretsMigration,
  accountIntegrationMigration,
  removeActivityMigration,
] as const

export const currentSchemaVersion = removeActivityMigration.version
export const schemaThreeTables = {
  ...initialTables,
  ...gatewaySecretTables,
  ...accountIntegrationTables,
}
export const currentTables = Object.fromEntries(
  Object.entries(schemaThreeTables).filter(
    ([name]) => name !== "capi_activity",
  ),
) as Omit<typeof schemaThreeTables, "capi_activity">
export const currentIndexes = Object.fromEntries(
  Object.entries(initialIndexes).filter(
    ([name]) => !name.startsWith("capi_activity_"),
  ),
)
