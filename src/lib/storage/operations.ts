import { AsyncLocalStorage } from "node:async_hooks"

import type {
  Committed,
  MutationContext,
  SqlSession,
  Storage,
} from "~/lib/storage/types"

import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { parseStorageCounter } from "~/lib/storage/migrations"
import {
  deadlinePromise,
  getStorageDeadline,
  remainingStorageMs,
  withStorageDeadline,
} from "~/lib/storage/operation-budget"

interface MutationState {
  tail: Promise<void>
  pending?: MutationContext
}

const states = new WeakMap<Storage, MutationState>()
const mutationScope = new AsyncLocalStorage<Storage>()
const MAX_RESULT_BYTES = 64 * 1024
const sensitiveKeys = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "oauthtoken",
  "oauthvalue",
  "githubtoken",
  "providertoken",
  "databasetoken",
  "tursoauthtoken",
  "apikey",
  "password",
  "passwordhash",
  "secret",
  "secretvalue",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "csrftoken",
  "setupcode",
  "devicecode",
  "usercode",
  "headers",
])

export async function readStoreRevision(session: SqlSession): Promise<number> {
  const rows = await session.query({
    sql: "SELECT value FROM capi_metadata WHERE key = 'config_revision'",
    args: [],
  })
  if (rows.length !== 1) {
    throw new StorageSchemaError("Configuration revision is missing")
  }
  return parseStorageCounter(rows[0]?.value)
}

export function getStoreRevision(storage: Storage): Promise<number> {
  return storage.read(readStoreRevision)
}

function validateContext(context: MutationContext): void {
  if (
    !Number.isSafeInteger(context.expectedRevision)
    || context.expectedRevision < 0
    || context.expectedRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new StorageConflictError("Invalid expected revision")
  }
  for (const field of [
    context.operationId,
    context.actorId,
    context.kind,
    context.inputDigest,
  ]) {
    if (
      typeof field !== "string"
      || field.length === 0
      || field.length > 256
      || hasControlCharacters(field)
    ) {
      throw new StorageConflictError("Invalid mutation identity")
    }
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return true
  }
  return false
}

function validateObject(
  value: object,
  ancestors: Set<object>,
  depth: number,
): void {
  if (
    !Array.isArray(value)
    && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null
  ) {
    throw new StorageSchemaError(
      "Operation result must contain plain JSON objects",
    )
  }
  ancestors.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue
    if (
      typeof key !== "string"
      || sensitiveKeys.has(key.replaceAll(/[^a-z]/gi, "").toLowerCase())
    ) {
      throw new StorageSchemaError(
        "Operation result contains a prohibited field",
      )
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new StorageSchemaError(
        "Operation result must contain plain JSON values",
      )
    }
    validateResult(descriptor.value, ancestors, depth + 1)
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) {
    throw new StorageSchemaError(
      "Operation result must not contain sparse arrays",
    )
  }
  ancestors.delete(value)
}

/** Defense in depth. Callers must return identifiers/metadata, never secret values. */
function validateResult(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): void {
  if (depth > 32)
    throw new StorageSchemaError("Operation result is too deeply nested")
  if (value === null || typeof value === "boolean") return
  if (typeof value === "string") {
    if (/^(?:Bearer\s|gh[opusr]_|github_pat_|eyJ[\w-]+\.)/.test(value)) {
      throw new StorageSchemaError(
        "Operation results must not contain credentials",
      )
    }
    return
  }
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new StorageSchemaError(
      "Operation result must be lossless JSON metadata",
    )
  }
  validateObject(value, ancestors, depth)
}

function encodeResult(value: unknown): string {
  validateResult(value)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, "utf8") > MAX_RESULT_BYTES) {
    throw new StorageSchemaError("Operation result is too large")
  }
  return json
}

async function findOperation<T>(
  session: SqlSession,
  context: MutationContext,
): Promise<Committed<T> | undefined> {
  const rows = await session.query({
    sql: "SELECT kind, actor_id, input_digest, committed_revision, result_json FROM capi_applied_operations WHERE id = ?",
    args: [context.operationId],
  })
  if (rows.length === 0) return undefined
  const row = rows[0]
  if (
    row.kind !== context.kind
    || row.actor_id !== context.actorId
    || row.input_digest !== context.inputDigest
  ) {
    throw new StorageConflictError(
      "Operation identity conflicts with a committed operation",
    )
  }
  if (
    typeof row.committed_revision !== "number"
    || !Number.isSafeInteger(row.committed_revision)
    || row.committed_revision < 1
    || typeof row.result_json !== "string"
  ) {
    throw new StorageSchemaError("Invalid committed operation record")
  }
  let value: unknown
  try {
    value = JSON.parse(row.result_json)
  } catch {
    throw new StorageSchemaError("Invalid committed operation result")
  }
  encodeResult(value)
  // The recorded value passed runtime JSON/safety checks; repositories validate domain shape.
  return { value: value as T, revision: row.committed_revision }
}

/** Lookup/reconcile a known request identity without replaying its mutation body. */
export async function readCommittedMutation<T>(
  storage: Storage,
  context: MutationContext,
): Promise<Committed<T> | undefined> {
  validateContext(context)
  return withStorageDeadline(Date.now() + 30_000, async () => {
    const state = states.get(storage)
    if (state?.pending) {
      if (state.pending.operationId === context.operationId)
        return reconcile<T>(storage, context, state)
      // Confirm the older operation using its saved identity, without replaying it.
      await reconcile(storage, state.pending, state)
    }
    return storage.read((session) => findOperation<T>(session, context))
  })
}

async function reconcile<T>(
  storage: Storage,
  context: MutationContext,
  state: MutationState,
): Promise<Committed<T>> {
  const pending = state.pending
  try {
    assertBudgetRemaining()
    const result = await storage.read((session) =>
      findOperation<T>(session, context),
    )
    if (result) {
      // A concurrent lookup must not clear a newer mutation's unknown outcome.
      if (state.pending === pending) state.pending = undefined
      return result
    }
  } catch (error) {
    if (error instanceof StorageConflictError) throw error
  }
  throw new StorageCommitUnknownError(context.operationId)
}

async function executeMutation<T>(
  storage: Storage,
  mutation: { context: MutationContext; state: MutationState },
  work: (session: SqlSession, revision: number) => Promise<T>,
): Promise<Committed<T>> {
  const { context, state } = mutation
  if (state.pending) {
    if (state.pending.operationId === context.operationId)
      return reconcile(storage, context, state)
    // Clients may reload after an outage instead of resubmitting the old ID.
    await reconcile(storage, state.pending, state)
  }
  for (let attempt = 0; ; attempt++) {
    try {
      assertBudgetRemaining()
      return await storage.transaction(async (session) => {
        const existing = await findOperation<T>(session, context)
        if (existing) return existing
        const revision = await readStoreRevision(session)
        if (revision !== context.expectedRevision) {
          throw new StorageConflictError("Configuration revision changed")
        }
        const nextRevision = revision + 1
        const value = await work(session, nextRevision)
        assertBudgetRemaining()
        const resultJson = encodeResult(value)
        const updated = await session.execute({
          sql: "UPDATE capi_metadata SET value = ? WHERE key = 'config_revision' AND value = ?",
          args: [String(nextRevision), String(revision)],
        })
        if (updated.rowsAffected !== 1)
          throw new StorageConflictError("Configuration revision changed")
        await session.execute({
          sql: "INSERT INTO capi_applied_operations (id, kind, actor_id, input_digest, committed_revision, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [
            context.operationId,
            context.kind,
            context.actorId,
            context.inputDigest,
            nextRevision,
            resultJson,
            Date.now(),
          ],
        })
        return { value: JSON.parse(resultJson) as T, revision: nextRevision }
      })
    } catch (error) {
      if (error instanceof StorageCommitUnknownError) {
        state.pending = context
        return reconcile(storage, context, state)
      }
      if (
        !(error instanceof StorageConflictError)
        || !error.retryable
        || attempt >= 2
      )
        throw error
      const delay = 25 * (attempt + 1)
      if (remainingStorageMs() <= delay) {
        throw new StorageUnavailableError("timeout")
      }
      await deadlinePromise(Bun.sleep(delay), mutationDeadline())
    }
  }
}

/** Serialize mutations through reconciliation before any dependent work can begin. */
export async function runMutation<T>(
  storage: Storage,
  context: MutationContext,
  work: (session: SqlSession, revision: number) => Promise<T>,
): Promise<Committed<T>> {
  const ownedContext = { ...context }
  validateContext(ownedContext)
  if (mutationScope.getStore() === storage) {
    throw new StorageConflictError("Nested mutations are not supported")
  }
  return withStorageDeadline(Date.now() + 30_000, () =>
    queuedMutation(storage, ownedContext, work),
  )
}

async function queuedMutation<T>(
  storage: Storage,
  context: MutationContext,
  work: (session: SqlSession, revision: number) => Promise<T>,
): Promise<Committed<T>> {
  let state = states.get(storage)
  if (!state) {
    state = { tail: Promise.resolve() }
    states.set(storage, state)
  }
  const previous = state.tail
  let release = noop
  state.tail = new Promise<void>((resolve) => {
    release = resolve
  })
  let admitted = false
  try {
    await deadlinePromise(previous, mutationDeadline())
    assertBudgetRemaining()
    admitted = true
    return await mutationScope.run(storage, () =>
      executeMutation(storage, { context, state }, work),
    )
  } finally {
    if (admitted) release()
    // A timed-out waiter cannot unlock the still-running predecessor's work.
    else void previous.then(release, release)
  }
}

function noop(): void {}

function mutationDeadline(): number {
  const deadline = getStorageDeadline()
  if (deadline === undefined) throw new StorageUnavailableError("timeout")
  return deadline
}

function assertBudgetRemaining(): void {
  if (remainingStorageMs() <= 0) throw new StorageUnavailableError("timeout")
}
