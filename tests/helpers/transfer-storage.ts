import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Storage } from "../../src/lib/storage/types"

import { LocalSqliteStorage } from "../../src/lib/storage/local-sqlite"
import { migrateStorage } from "../../src/lib/storage/migrations"
export async function withTransferStorage<T>(
  work: (storage: Storage, directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "capi-transfer-test-"),
  )
  const storage = new LocalSqliteStorage(path.join(directory, "fixture.sqlite"))
  try {
    await migrateStorage(storage)
    return await work(storage, directory)
  } finally {
    await storage.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
}
export function bytesStream(
  bytes: Uint8Array,
  chunkSize = 101,
): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) controller.close()
      else {
        controller.enqueue(bytes.subarray(offset, offset + chunkSize))
        offset += chunkSize
      }
    },
  })
}
export async function streamBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
export async function settingsFixture(
  storage: Storage,
  value: unknown = { smallModel: "fixture-model" },
): Promise<void> {
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app',?,1)",
      args: [JSON.stringify(value)],
    },
  ])
}
