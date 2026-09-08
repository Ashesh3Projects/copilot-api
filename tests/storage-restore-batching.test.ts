import { expect, test } from "bun:test"

import type { SqlSession, Storage } from "~/lib/storage/types"

import { createBackupStream } from "~/lib/config-backup"
import { restoreBackup } from "~/lib/storage/restore"

import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

test("restore writes retained history in bounded multi-row batches", async () => {
  await withTransferStorage(async (source) => {
    await source.transaction(async (session) => {
      for (let index = 0; index < 1000; index++)
        await session.execute({
          sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(?,?,1,2,1)",
          args: [index * 60000, "fixture"],
        })
    })
    const backup = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      let inserts = 0
      let maxArguments = 0
      const wrap = (session: SqlSession): SqlSession => ({
        query: (statement) => session.query(statement),
        execute: (statement) => {
          if (/INSERT .*INTO capi_usage_minutes/.test(statement.sql)) inserts++
          maxArguments = Math.max(maxArguments, statement.args.length)
          return session.execute(statement)
        },
      })
      const counted: Storage = {
        read: (work) => target.read((session) => work(wrap(session))),
        transaction: (work) =>
          target.transaction((session) => work(wrap(session))),
        atomicBatch: (statements) => target.atomicBatch(statements),
        close: () => Promise.resolve(),
      }
      await restoreBackup(
        bytesStream(backup, 64000),
        "fixture-password",
        counted,
      )
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT COUNT(*) AS count,SUM(input_tokens) AS tokens FROM capi_usage_minutes",
            args: [],
          }),
        ),
      ).toEqual([{ count: 1000, tokens: 1000 }])
      expect(inserts).toBeLessThan(50)
      expect(maxArguments).toBeLessThanOrEqual(900)
    })
  })
}, 20000)
