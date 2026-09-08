import { expect, test } from "bun:test"

import { createRuntimeStorage } from "./helpers/runtime-storage"

test("a backup snapshot stays consistent while another connection writes", async () => {
  const fixture = await createRuntimeStorage()
  try {
    const { LocalSqliteStorage } = await import("~/lib/storage/local-sqlite")
    const database = new LocalSqliteStorage(fixture.config.path)
    await database.atomicBatch([
      { sql: "CREATE TABLE backup_probe (id INTEGER)", args: [] },
      { sql: "INSERT INTO backup_probe VALUES(1)", args: [] },
    ])
    try {
      const held = Promise.withResolvers<undefined>(),
        release = Promise.withResolvers<undefined>()
      const backup = database.readSnapshot(async (session) => {
        expect(
          await session.query({
            sql: "SELECT count(*) AS n FROM backup_probe",
            args: [],
          }),
        ).toEqual([{ n: 1 }])
        held.resolve(undefined)
        await release.promise
        return session.query({
          sql: "SELECT count(*) AS n FROM backup_probe",
          args: [],
        })
      })
      await held.promise
      await database.atomicBatch([
        { sql: "INSERT INTO backup_probe VALUES(2)", args: [] },
      ])
      release.resolve(undefined)
      expect(await backup).toEqual([{ n: 1 }])
    } finally {
      await database.close()
    }
  } finally {
    await fixture.close()
  }
})
