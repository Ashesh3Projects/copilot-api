/* eslint-disable max-lines-per-function, complexity, max-depth -- This fixture keeps the small Hrana response state machine together. */
import { Database } from "bun:sqlite"
import { spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface WireValue {
  type: string
  value?: string | number
  base64?: string
}
interface Condition {
  type: string
  step?: number
  cond?: Condition
  conds?: Array<Condition>
}
interface Step {
  stmt: { sql: string; args: Array<WireValue> }
  condition?: Condition
}
interface RequestBody {
  baton: string | null
  batch?: { steps: Array<Step> }
  requests?: Array<{ type: string; sql?: string }>
}

export interface FakeTursoOptions {
  loseFirstCommitResponse?: boolean
  status?: number
  hangSql?: string
  truncateSql?: string
  truncateCommitResponse?: boolean
}

function decode(value: WireValue) {
  if (value.type === "null") return null
  if (value.type === "blob") return Buffer.from(value.base64 ?? "", "base64")
  if (value.type === "integer") return BigInt(value.value ?? "0")
  return value.value ?? null
}
function encode(value: unknown): WireValue {
  if (value === null) return { type: "null" }
  if (typeof value === "bigint")
    return { type: "integer", value: String(value) }
  if (typeof value === "number") return { type: "float", value }
  if (value instanceof Uint8Array)
    return { type: "blob", base64: Buffer.from(value).toString("base64") }
  if (typeof value !== "string") throw new Error("Invalid test cell")
  return { type: "text", value }
}
function matches(
  condition: Condition | undefined,
  done: Set<number>,
  db: Database,
): boolean {
  if (!condition) return true
  if (condition.type === "ok") return done.has(condition.step ?? -1)
  if (condition.type === "not") return !matches(condition.cond, done, db)
  if (condition.type === "and")
    return (condition.conds ?? []).every((c) => matches(c, done, db))
  return condition.type === "is_autocommit" && !db.inTransaction
}
export function createFakeTursoFetch(options: FakeTursoOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capi-hrana-"))
  const connections = new Map<string, Database>()
  const requests: Array<{ url: string; body: RequestBody; session: string }> =
    []
  let lost = false
  let next = 0
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (options.status) return new Response("", { status: options.status })
    if (typeof init?.body !== "string")
      throw new Error("Expected JSON test request")
    const body = JSON.parse(init.body) as RequestBody
    const session = body.baton ?? `session-${++next}`
    let db = connections.get(session)
    if (!db) {
      db = new Database(join(dir, "transport.sqlite"), {
        create: true,
        safeIntegers: true,
      })
      db.run("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1")
      connections.set(session, db)
    }
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      body,
      session,
    })
    if (body.requests) {
      const results = body.requests.map((r) => {
        if (r.type === "sequence" && r.sql) {
          db.run(r.sql)
          if (r.sql === "COMMIT" && options.loseFirstCommitResponse && !lost) {
            lost = true
            throw new TypeError("test lost response")
          }
        }
        if (r.type === "close") {
          db.close()
          connections.delete(session)
        }
        return {
          type: "ok",
          response: {
            type: r.type,
            is_autocommit: r.type === "close" || !db.inTransaction,
          },
        }
      })
      if (
        options.truncateCommitResponse
        && body.requests.some((r) => r.sql === "COMMIT")
      )
        return new Response('{"baton":')
      return Response.json({ baton: session, base_url: null, results })
    }
    const entries: Array<unknown> = [{ baton: session, base_url: null }]
    const done = new Set<number>()
    for (const [index, step] of (body.batch?.steps ?? []).entries()) {
      if (!matches(step.condition, done, db)) continue
      const sql = step.stmt.sql
      if (options.hangSql && sql.includes(options.hangSql)) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal
          const abort = () =>
            reject(new DOMException("test timeout", "AbortError"))
          if (signal?.aborted) abort()
          else signal?.addEventListener("abort", abort, { once: true })
        })
      }
      try {
        if (/turso_version\(\)/i.test(sql)) {
          entries.push(
            {
              type: "step_begin",
              step: index,
              cols: [
                {
                  name: /AS version/i.test(sql) ? "version" : "turso_version()",
                  decltype: "TEXT",
                },
              ],
            },
            { type: "row", row: [{ type: "text", value: "test-turso" }] },
          )
        } else {
          const statement = db.query(sql)
          const cols = statement.columnNames.map((name) => ({
            name,
            decltype: "",
          }))
          entries.push({ type: "step_begin", step: index, cols })
          if (cols.length > 0) {
            for (const row of statement.values(
              ...step.stmt.args.map((value) => decode(value)),
            ))
              entries.push({
                type: "row",
                row: row.map((value) => encode(value)),
              })
          } else statement.run(...step.stmt.args.map((value) => decode(value)))
        }
        done.add(index)
        if (options.truncateSql && sql.includes(options.truncateSql))
          return new Response(
            entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
          )
        entries.push({
          type: "step_end",
          step: index,
          affected_row_count: /^(?:INSERT|UPDATE|DELETE)/i.test(sql) ? 1 : 0,
        })
        if (sql === "COMMIT" && options.loseFirstCommitResponse && !lost) {
          lost = true
          throw new TypeError("test lost response")
        }
      } catch (error) {
        if (error instanceof TypeError && lost) throw error
        entries.push({
          type: "step_error",
          step: index,
          error: {
            code:
              error && typeof error === "object" && "code" in error ?
                error.code
              : "SQLITE_ERROR",
            message: "test SQL failure",
          },
        })
      }
    }
    return new Response(
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    )
  }
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    fakeFetch as typeof fetch,
  )
  return {
    requests,
    committedWritesFor(id: string) {
      const db = new Database(join(dir, "transport.sqlite"), { readonly: true })
      try {
        return (
          db
            .query("SELECT COUNT(*) AS n FROM capi_probe WHERE id = ?")
            .get(id) as { n: number }
        ).n
      } finally {
        db.close()
      }
    },
    close() {
      spy.mockRestore()
      for (const db of connections.values()) db.close()
      connections.clear()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function testConfig() {
  return {
    kind: "turso" as const,
    url: "turso://storage-test.example",
    authToken: "test-only-never-a-credential",
  }
}
