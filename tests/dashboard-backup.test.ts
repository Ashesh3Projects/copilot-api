import { expect, test } from "bun:test"
import { Hono } from "hono"

import { createBackupSettingsHandler } from "../src/routes/dashboard/settings-backup"
import { withTransferStorage } from "./helpers/transfer-storage"
test("dashboard backup checks session with CSRF before reading request credentials", async () => {
  await withTransferStorage(async (storage) => {
    let required = false
    const app = new Hono()
    app.post(
      "/backup",
      createBackupSettingsHandler({
        storage,
        authenticate: (_request, options) => {
          required = options?.requireCsrf === true
          return Promise.resolve(null)
        },
      }),
    )
    const response = await app.request("/backup", { method: "POST" })
    expect(response.status).toBe(401)
    expect(required).toBe(true)
  })
})
test("dashboard backup requires current admin password and streams a no-store attachment", async () => {
  await withTransferStorage(async (storage) => {
    const hash = await Bun.password.hash("fixture-admin-password", {
      algorithm: "argon2id",
      memoryCost: 65_536,
      timeCost: 3,
    })
    await storage.atomicBatch([
      {
        sql: "INSERT INTO capi_admin(id,password_hash,session_version,created_at,updated_at) VALUES(1,?,1,0,0)",
        args: [hash],
      },
    ])
    const app = new Hono()
    app.post(
      "/backup",
      createBackupSettingsHandler({
        storage,
        authenticate: () =>
          Promise.resolve({
            tokenHash: "fixture",
            csrfToken: "fixture",
            expiresAt: Date.now() + 60_000,
          }),
      }),
    )
    const request = (currentPassword: string) =>
      app.request("/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          backupPassword: "fixture-backup-password",
        }),
      })
    expect((await request("wrong-password")).status).toBe(401)
    const response = await request("fixture-admin-password")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-disposition")).toContain(".capi")
    expect(
      new TextDecoder().decode((await response.arrayBuffer()).slice(0, 11)),
    ).toBe("CAPI-BACKUP")
  })
})
