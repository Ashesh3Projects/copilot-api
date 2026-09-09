export type StorageFailureReason =
  | "unavailable"
  | "authentication"
  | "quota"
  | "timeout"
  | "unsupported_engine"

export class StorageUnavailableError extends Error {
  readonly code = "storage_unavailable"
  readonly reason: StorageFailureReason
  constructor(reason: StorageFailureReason = "unavailable") {
    super("Database storage is unavailable")
    this.name = "StorageUnavailableError"
    this.reason = reason
  }
}

export class StorageConflictError extends Error {
  readonly code = "storage_conflict"
  readonly retryable: boolean
  readonly contention: boolean
  constructor(
    message = "Database operation conflicts with stored state",
    options: { retryable?: boolean; contention?: boolean } = {},
  ) {
    super(message)
    this.name = "StorageConflictError"
    this.retryable = options.retryable ?? false
    this.contention = options.contention ?? false
  }
}

export class StorageSchemaError extends Error {
  readonly code = "storage_schema"
  constructor(message = "Database schema is incompatible") {
    super(message)
    this.name = "StorageSchemaError"
  }
}

export class StorageNotFoundError extends Error {
  readonly code = "storage_not_found"
  constructor(message = "Requested record does not exist") {
    super(message)
    this.name = "StorageNotFoundError"
  }
}

export class StorageCommitUnknownError extends Error {
  readonly code = "storage_commit_unknown"
  readonly operationId?: string
  constructor(operationId?: string) {
    super("Database commit outcome is unknown")
    this.name = "StorageCommitUnknownError"
    this.operationId = operationId
  }
}

export function storageError(error: unknown, rolledBack = false): Error {
  if (error instanceof StorageConflictError && error.contention && rolledBack)
    return new StorageConflictError("Database is busy", {
      retryable: true,
      contention: true,
    })
  if (
    error instanceof StorageUnavailableError
    || error instanceof StorageConflictError
    || error instanceof StorageSchemaError
    || error instanceof StorageNotFoundError
    || error instanceof StorageCommitUnknownError
  )
    return error
  const code =
    typeof error === "object" && error !== null && "code" in error ?
      String(error.code)
    : ""
  if (/^SQLITE_(?:BUSY|LOCKED)/.test(code))
    return new StorageConflictError("Database is busy", {
      retryable: rolledBack,
      contention: true,
    })
  if (code.startsWith("SQLITE_CONSTRAINT")) return new StorageConflictError()
  return diagnosticError(error, code)
}

function diagnosticError(error: unknown, code: string): Error {
  const message = error instanceof Error ? error.message : ""
  if (/no such (?:table|column|function)|schema|syntax error/i.test(message))
    return new StorageSchemaError()
  if (
    code === "TIMEOUT"
    || (error instanceof Error
      && /^(?:AbortError|TimeoutError)$/.test(error.name))
  )
    return new StorageUnavailableError("timeout")
  if (/status: (?:401|403)\b/.test(message))
    return new StorageUnavailableError("authentication")
  if (/status: (?:429|402)\b/.test(message))
    return new StorageUnavailableError("quota")
  return new StorageUnavailableError()
}
