import { expect, test } from "bun:test"
import { runCommand } from "citty"

import { storage } from "../src/storage"
test("owner CLI exposes explicit import, backup, replacement restore and exact incomplete cleanup", () => {
  expect(Object.keys(storage.subCommands ?? {}).sort()).toEqual([
    "backup",
    "discard-incomplete",
    "import-legacy",
    "restore",
  ])
})
test("backup requires manual password entry and rejects noninteractive secret input", async () => {
  const commands = await storage.subCommands
  if (!commands || typeof commands === "function")
    throw new Error("Missing storage commands")
  const backup = await commands.backup
  if (typeof backup === "function") throw new Error("Missing backup command")
  let message = ""
  try {
    await runCommand(backup, { rawArgs: [] })
  } catch (error) {
    message = error instanceof Error ? error.message : "unknown"
  }
  expect(message).toMatch(/interactive terminal|Redirect stdout/)
})
