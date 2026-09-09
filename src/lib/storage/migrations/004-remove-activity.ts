/** Activity history was removed; usage, routing, debug and their losses remain. */
export const removeActivityMigration = {
  version: 4,
  name: "remove-activity",
  statements: [
    "DROP TABLE capi_activity",
    "DELETE FROM capi_metadata WHERE key IN ('history_activity_generation', 'history_activity_cleared_at')",
    "DELETE FROM capi_collection_gaps WHERE json_extract(payload_json, '$.historyKind') = 'activity'",
    "UPDATE capi_process_runs SET payload_json = json_remove(payload_json, '$.activityGeneration') WHERE json_type(payload_json, '$.activityGeneration') IS NOT NULL",
    "UPDATE capi_collection_gaps SET payload_json = json_remove(payload_json, '$.activityGeneration') WHERE json_type(payload_json, '$.activityGeneration') IS NOT NULL",
  ],
} as const
