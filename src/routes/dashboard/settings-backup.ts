import type { Context } from "hono"

import type { Storage } from "~/lib/storage/types"

import {
  authenticateAdminRequest,
  validateAdminPasswordHash,
} from "~/lib/admin-auth"
import { createBackupStream } from "~/lib/config-backup"
import { formatConfigExportTimestamp } from "~/lib/config-export"
import { createAdminRepository } from "~/lib/storage/admin-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"

export function createBackupSettingsHandler(
  dependencies: {
    storage?: Storage
    authenticate?: typeof authenticateAdminRequest
  } = {},
) {
  return async (context: Context): Promise<Response> => {
    if (
      !(await (dependencies.authenticate ?? authenticateAdminRequest)(
        context.req.raw,
        { requireCsrf: true },
      ))
    )
      return context.json({ error: "Unauthorized" }, 401)
    let body: unknown
    try {
      body = await context.req.json()
    } catch {
      return context.json({ error: "Invalid backup request" }, 400)
    }
    if (
      !body
      || typeof body !== "object"
      || !("currentPassword" in body)
      || typeof body.currentPassword !== "string"
      || !("backupPassword" in body)
      || typeof body.backupPassword !== "string"
      || body.backupPassword.length === 0
    )
      return context.json(
        { error: "Current administrator and backup passwords are required" },
        400,
      )
    const storage = dependencies.storage ?? getStorageRuntime().storage
    const admin = await createAdminRepository(storage).get()
    if (
      !admin
      || !(await Bun.password.verify(
        body.currentPassword,
        validateAdminPasswordHash(admin.passwordHash),
      ))
    )
      return context.json({ error: "Authentication failed" }, 401)
    const stream = createBackupStream(
      body.backupPassword,
      context.req.raw.signal,
      storage,
    )
    return new Response(stream, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="copilot-api-backup-${formatConfigExportTimestamp(new Date())}.capi"`,
      },
    })
  }
}
export const handleBackupSettings = createBackupSettingsHandler()
