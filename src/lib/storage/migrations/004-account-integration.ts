import { initialTables } from "./001-initial"

const integrationColumn =
  "integration_id TEXT CHECK (integration_id IS NULL OR (length(integration_id) BETWEEN 1 AND 128 AND trim(integration_id) = integration_id))"

export const accountIntegrationTables = {
  capi_accounts: `${initialTables.capi_accounts},\n    ${integrationColumn}`,
} as const

export const accountIntegrationMigration = {
  version: 4,
  name: "account-integration",
  statements: [`ALTER TABLE capi_accounts ADD COLUMN ${integrationColumn}`],
} as const
