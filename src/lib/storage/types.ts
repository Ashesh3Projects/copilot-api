export type SqlValue = null | string | number | bigint | Uint8Array

export interface SqlStatement {
  sql: string
  args: ReadonlyArray<SqlValue>
}

export interface SqlSession {
  query(
    statement: SqlStatement,
  ): Promise<ReadonlyArray<Record<string, unknown>>>
  execute(statement: SqlStatement): Promise<{ rowsAffected: number }>
}

export interface Storage {
  read<T>(work: (session: SqlSession) => Promise<T>): Promise<T>
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T>
  atomicBatch(statements: ReadonlyArray<SqlStatement>): Promise<void>
  close(): Promise<void>
}

export interface MutationContext {
  operationId: string
  expectedRevision: number
  actorId: string
  kind: string
  inputDigest: string
}

export interface Committed<T> {
  value: T
  revision: number
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | Array<JsonValue>
  | { [key: string]: JsonValue }

export type SettingsNamespace =
  | "app"
  | "replacements"
  | "model_redirects"
  | "model_settings"
  | "model_routing"
  | "model_fallbacks"
  | "feature_flags"
  | "statsig_overrides"

export interface SettingsDocument {
  namespace: SettingsNamespace
  value: JsonValue
  revision: number
}

export interface SettingsRepository {
  loadAll(): Promise<ReadonlyArray<SettingsDocument>>
  replace(
    namespace: SettingsNamespace,
    value: JsonValue,
    context: MutationContext,
  ): Promise<Committed<SettingsDocument>>
}

export interface RuntimeSnapshot {
  revision: number
  documents: ReadonlyMap<SettingsNamespace, SettingsDocument>
}

export interface SnapshotManager {
  get(): RuntimeSnapshot
  refreshIfChanged(): Promise<void>
  publish(snapshot: RuntimeSnapshot): void
}
