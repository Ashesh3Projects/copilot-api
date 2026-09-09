import { expect, test, spyOn } from "bun:test"
import fs from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createHandlerLogger } from "~/lib/logger"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import { createHistoryRuntime } from "~/lib/telemetry-writer"

test("handler logging has no file writes, signal hooks, or stored activity and keeps sanitized output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capi-logger-"))
  const storage = new LocalSqliteStorage(join(directory, "fixture.sqlite"))
  await migrateStorage(storage)
  const runtime = await createHistoryRuntime(storage, { autoFlush: false })
  const signals = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ]
  const mkdir = spyOn(fs, "mkdirSync").mockImplementation(() => {
    throw new Error("filesystem tripwire")
  })
  const stream = spyOn(fs, "createWriteStream").mockImplementation(() => {
    throw new Error("filesystem tripwire")
  })
  const write = spyOn(fs, "writeFileSync").mockImplementation(() => {
    throw new Error("filesystem tripwire")
  })
  const output: Array<string> = []
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk))
    return true
  })
  try {
    const logger = createHandlerLogger("fixture")
    logger.level = 5
    logger.info("Prepared request", {
      secret: "credential-value",
      payload: { authorization: "Bearer private", count: 3 },
    })
    await runtime.writer.flush()
    expect(mkdir).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(signals)
    expect(runtime.writer.status().pendingRecords).toBe(0)
    expect((await runtime.repository.list("debug")).records).toHaveLength(0)
    expect(output.join("")).not.toContain("credential-value")
    expect(output.join("")).not.toContain("Bearer private")
    expect(output.join("")).toContain("Prepared request")
  } finally {
    mkdir.mockRestore()
    stream.mockRestore()
    write.mockRestore()
    stdout.mockRestore()
    await runtime.close(500)
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  }
})
