import { expect, test } from "bun:test"
import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageUnavailableError,
} from "~/lib/storage/errors"

test.each([
  [new StorageUnavailableError("timeout"), 503, "storage_unavailable"],
  [
    new StorageCommitUnknownError("fixture-operation"),
    503,
    "storage_commit_unknown",
  ],
  [
    new StorageConflictError("private database constraint"),
    409,
    "storage_conflict",
  ],
] as const)(
  "database errors preserve unavailable/conflict distinctions without internals",
  async (error, status, code) => {
    const app = new Hono()
    app.get("/", () => {
      throw error
    })
    app.onError((caught, context) => forwardError(context, caught))
    const response = await app.request("/")
    expect(response.status).toBe(status)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.text()
    expect(body).toContain(code)
    expect(body).not.toContain("private database constraint")
    expect(body).not.toContain("fixture-operation")
  },
)
