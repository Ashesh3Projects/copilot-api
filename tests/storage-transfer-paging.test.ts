import { expect, test } from "bun:test"

import type { SqlSession } from "~/lib/storage/types"

import { transferRecords } from "~/lib/storage/transfer-records"

import { withTransferStorage } from "./helpers/transfer-storage"

test("backup pages retained history with sublinear SQL round trips", async () => {
  await withTransferStorage(async (storage) => {
    await storage.transaction(async (session) => {
      for (let i = 0; i < 1000; i++)
        await session.execute({
          sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(?,?,1,2,1)",
          args: [i * 60000, `model-${i % 3}`],
        })
    })
    let queries = 0
    await storage.read(async (session) => {
      const wrapped: SqlSession = {
        execute: (statement) => session.execute(statement),
        query: (statement) => {
          queries++
          return session.query(statement)
        },
      }
      let count = 0
      let lastMinute = -1
      for await (const record of transferRecords(wrapped))
        if (record.table === "capi_usage_minutes") {
          const value = record.value as { minute: number }
          expect(value.minute).toBeGreaterThan(lastMinute)
          lastMinute = value.minute
          count++
        }
      expect(count).toBe(1000)
    })
    expect(queries).toBeLessThan(100)
  })
})

test("backup payload pages avoid combining large fields and preserve continuation-sized records", async () => {
  await withTransferStorage(async (storage) => {
    const large = "🦉".repeat(2_200_000)
    await storage.atomicBatch([
      {
        sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app',?,1)",
        args: [JSON.stringify({ extraPrompts: { large } })],
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        sql: "INSERT INTO capi_collection_gaps(id,started_at,kind,lost_records,payload_json) VALUES(?,0,'known',1,?)",
        args: [`large-${i}`, JSON.stringify({ message: "x".repeat(600000) })],
      })),
    ])
    let payloadQueries = 0
    await storage.read(async (session) => {
      const wrapped: SqlSession = {
        execute: (statement) => session.execute(statement),
        query: async (statement) => {
          const rows = await session.query(statement)
          if (
            /SELECT (?:key,value|id,process_run_id|namespace,value_json)/.test(
              statement.sql,
            )
          ) {
            payloadQueries++
            const textBytes = rows.reduce(
              (sum, row) =>
                sum
                + Object.values(row).reduce<number>(
                  (bytes, value) =>
                    bytes
                    + (typeof value === "string" ?
                      Buffer.byteLength(value)
                    : 8),
                  0,
                ),
              0,
            )
            expect(textBytes <= 1024 * 1024 || rows.length === 1).toBe(true)
          }
          return rows
        },
      }
      const records = []
      for await (const record of transferRecords(wrapped)) records.push(record)
      const app = records.find((record) => record.table === "capi_settings")
        ?.value as { value_json: string }
      const restored = JSON.parse(app.value_json) as {
        extraPrompts: { large: string }
      }
      expect(restored.extraPrompts.large).toBe(large)
      expect(
        records.filter((record) => record.table === "capi_collection_gaps"),
      ).toHaveLength(6)
    })
    expect(payloadQueries).toBeGreaterThan(1)
  })
}, 15000)
