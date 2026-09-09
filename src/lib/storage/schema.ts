import {
  initialMigration,
  initialTables,
} from "~/lib/storage/migrations/001-initial"
import {
  gatewaySecretsMigration,
  gatewaySecretTables,
} from "~/lib/storage/migrations/002-gateway-secrets"

export const storageMigrations = [
  initialMigration,
  gatewaySecretsMigration,
] as const

export const currentSchemaVersion = gatewaySecretsMigration.version
export const currentTables = { ...initialTables, ...gatewaySecretTables }

export { initialIndexes as currentIndexes } from "~/lib/storage/migrations/001-initial"
