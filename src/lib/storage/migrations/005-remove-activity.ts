/** Retire Activity storage; raw LLM debug remains process memory only. */
export const removeActivityMigration = {
  version: 5,
  name: "remove-activity",
  statements: [
    "DROP TABLE capi_activity",
    "DELETE FROM capi_metadata WHERE key IN ('history_activity_generation', 'history_activity_cleared_at')",
    "DELETE FROM capi_collection_gaps WHERE json_extract(payload_json, '$.historyKind') = 'activity'",
    "DELETE FROM capi_collection_gaps WHERE json_extract(payload_json, '$.historyKind') = 'debug'",
    "UPDATE capi_process_runs SET payload_json = json_remove(payload_json, '$.activityGeneration') WHERE json_type(payload_json, '$.activityGeneration') IS NOT NULL",
    "UPDATE capi_collection_gaps SET payload_json = json_remove(payload_json, '$.activityGeneration') WHERE json_type(payload_json, '$.activityGeneration') IS NOT NULL",
    "UPDATE capi_process_runs SET payload_json = json_remove(payload_json, '$.debugGeneration') WHERE json_type(payload_json, '$.debugGeneration') IS NOT NULL",
    "UPDATE capi_collection_gaps SET payload_json = json_remove(payload_json, '$.debugGeneration') WHERE json_type(payload_json, '$.debugGeneration') IS NOT NULL",
  ],
} as const
