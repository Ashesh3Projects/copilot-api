import type { SqlSession, Storage } from "~/lib/storage/types"

export async function hasStoredAccounts(storage: Storage): Promise<boolean> {
  return storage.read(
    async (session) =>
      (
        await session.query({
          sql: "SELECT id FROM capi_accounts WHERE deleted_at IS NULL LIMIT 1",
          args: [],
        })
      ).length > 0,
  )
}

export async function hasIncompleteTransfer(
  storage: Storage,
): Promise<boolean> {
  return storage.read(
    async (session) =>
      (
        await session.query({
          sql: "SELECT value FROM capi_metadata WHERE key IN ('transfer_incomplete', 'restore_incomplete')",
          args: [],
        })
      ).length > 0,
  )
}

/** Called inside the caller's transfer snapshot, never through a second read. */
export async function readBackupManifestMetadata(session: SqlSession) {
  const metadata = await session.query({
    sql: "SELECT key,value FROM capi_metadata WHERE key IN ('store_id','schema_version')",
    args: [],
  })
  const values = new Map(metadata.map((row) => [row.key, row.value]))
  return {
    schemaVersion: Number(values.get("schema_version")),
    sourceStoreId: values.get("store_id"),
  }
}
