/** Debug payloads are process memory only; retire the earlier SQL collection. */
export const memoryOnlyDebugMigration = {
  version: 3,
  name: "memory-only-debug",
  statements: [
    "DROP TABLE capi_debug",
    "DELETE FROM capi_metadata WHERE key='history_debug_generation'",
  ],
} as const
