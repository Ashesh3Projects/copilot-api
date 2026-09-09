import type { SqlSession } from "~/lib/storage/types"

export const HISTORY_RUN_LEASE_MS = 300_000

export async function interruptRunCaptures(session: SqlSession): Promise<void> {
  await session.execute({
    sql: "UPDATE capi_debug SET status = 'interrupted', replayable = 0, payload_json = json_set(payload_json, '$.status', 'interrupted', '$.replayable', json('false')) WHERE status IN ('pending', 'streaming') AND json_extract(payload_json, '$._historyRunId') IN (SELECT id FROM capi_process_runs WHERE ended_at IS NOT NULL)",
    args: [],
  })
}

export async function reconcileRuns(
  session: SqlSession,
  id: string,
  now: number,
): Promise<void> {
  // Older versions inferred loss from every open run. A confirmed clean close
  // disproves that legacy inference, but does not erase real recorded losses.
  await session.execute({
    sql: "DELETE FROM capi_collection_gaps WHERE id = 'unclean-' || process_run_id AND kind = 'unknown' AND json_extract(payload_json, '$.reason') IS NULL AND process_run_id IN (SELECT id FROM capi_process_runs WHERE clean = 1)",
    args: [],
  })
  await session.execute({
    sql: "INSERT INTO capi_collection_gaps (id, process_run_id, started_at, ended_at, kind, payload_json) SELECT 'unclean-' || id, id, COALESCE(last_flush_at, started_at), COALESCE(json_extract(payload_json, '$.heartbeatAt'), last_flush_at, started_at) + ?, 'unknown', json_object('reason', 'expired-run-lease', 'debugGeneration', json_extract(payload_json, '$.debugGeneration')) FROM capi_process_runs WHERE clean = 0 AND ended_at IS NULL AND id <> ? AND COALESCE(json_extract(payload_json, '$.heartbeatAt'), last_flush_at, started_at) < ? ON CONFLICT(id) DO NOTHING",
    args: [HISTORY_RUN_LEASE_MS, id, now - HISTORY_RUN_LEASE_MS],
  })
  await session.execute({
    sql: "UPDATE capi_process_runs SET ended_at = COALESCE(json_extract(payload_json, '$.heartbeatAt'), last_flush_at, started_at) + ? WHERE clean = 0 AND ended_at IS NULL AND id <> ? AND COALESCE(json_extract(payload_json, '$.heartbeatAt'), last_flush_at, started_at) < ?",
    args: [HISTORY_RUN_LEASE_MS, id, now - HISTORY_RUN_LEASE_MS],
  })
  await interruptRunCaptures(session)
}

export async function renewRun(
  session: SqlSession,
  id: string,
  now: number,
): Promise<void> {
  await session.execute({
    sql: "UPDATE capi_process_runs SET ended_at = NULL, payload_json = json_set(payload_json, '$.heartbeatAt', ?, '$.debugGeneration', CAST((SELECT value FROM capi_metadata WHERE key = 'history_debug_generation') AS INTEGER)) WHERE id = ? AND clean = 0",
    args: [now, id],
  })
}
