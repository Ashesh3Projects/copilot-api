export const gatewaySecretTables = {
  capi_gateway_secrets: `
    credential_id TEXT PRIMARY KEY NOT NULL REFERENCES capi_gateway_credentials(id) ON DELETE CASCADE,
    secret_value TEXT NOT NULL CHECK (length(secret_value) > 0),
    updated_at INTEGER NOT NULL`,
} as const

export const gatewaySecretsMigration = {
  version: 2,
  name: "gateway-secrets",
  statements: [
    `CREATE TABLE capi_gateway_secrets (${gatewaySecretTables.capi_gateway_secrets}\n)`,
    "UPDATE capi_metadata SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='config_revision' AND EXISTS (SELECT 1 FROM capi_gateway_credentials)",
    "DELETE FROM capi_gateway_credentials",
  ],
} as const
