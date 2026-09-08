import { defineCommand } from "citty"
import path from "node:path"

import { createBackupStream } from "~/lib/config-backup"
import { createStorage } from "~/lib/storage/client"
import { resolveStorageConfig } from "~/lib/storage/config"
import {
  applyLegacyImport,
  previewLegacyImport,
} from "~/lib/storage/legacy-import"
import { migrateStorage } from "~/lib/storage/migrations"
import { discardIncompleteTransfer, restoreBackup } from "~/lib/storage/restore"

async function hiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      "Backup passwords require an interactive terminal; do not use environment variables or command-line passwords",
    )
  process.stderr.write("Backup password: ")
  return new Promise((resolve, reject) => {
    let value = ""
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    const finish = (error?: Error) => {
      process.stdin.off("data", receive)
      process.stdin.off("end", ended)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stderr.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const ended = () => finish(new Error("Password input closed"))
    const receive = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          finish(new Error("Password input cancelled"))
          return
        }
        if (character === "\n" || character === "\r") {
          finish()
          return
        }
        if (character === "\b" || character === "\u007f")
          value = value.slice(0, -1)
        else if (character >= " ") value += character
      }
    }
    process.stdin.on("data", receive)
    process.stdin.once("end", ended)
  })
}
export const storage = defineCommand({
  meta: {
    name: "storage",
    description:
      "Explicit read-only legacy import and encrypted logical backup/restore; database selection never transfers data",
  },
  subCommands: {
    "discard-incomplete": defineCommand({
      meta: {
        name: "discard-incomplete",
        description:
          "Discard only the selected empty-target transfer's records using its exact incomplete restore/import ID",
      },
      args: { "restore-id": { type: "string", required: true } },
      async run({ args }) {
        const target = createStorage(resolveStorageConfig())
        try {
          await migrateStorage(target)
          await discardIncompleteTransfer(target, String(args["restore-id"]))
          process.stdout.write('{"phase":"complete"}\n')
        } finally {
          await target.close()
        }
      },
    }),
    "import-legacy": defineCommand({
      meta: {
        name: "import-legacy",
        description:
          "Preview legacy inputs, then explicitly apply the digest to an empty target",
      },
      args: {
        from: { type: "string", required: true },
        "from-env": { type: "boolean", default: false },
        apply: { type: "boolean", default: false },
        "source-digest": { type: "string" },
        "expected-revision": { type: "string" },
      },
      async run({ args }) {
        const target = createStorage(resolveStorageConfig())
        try {
          await migrateStorage(target)
          const input = {
            directory: path.resolve(String(args.from)),
            includeEnvironment: args["from-env"] === true,
          }
          const preview = await previewLegacyImport(input, target)
          if (!args.apply) {
            process.stdout.write(`${JSON.stringify(preview)}\n`)
            return
          }
          if (
            !args["source-digest"]
            || !/^(?:0|[1-9]\d*)$/.test(String(args["expected-revision"] ?? ""))
          )
            throw new Error(
              "--apply requires --source-digest and --expected-revision from preview",
            )
          const progress = await applyLegacyImport(
            input,
            {
              ...preview,
              sourceDigest: String(args["source-digest"]),
              expectedTargetRevision: Number(args["expected-revision"]),
            },
            target,
          )
          process.stdout.write(`${JSON.stringify(progress)}\n`)
        } finally {
          await target.close()
        }
      },
    }),
    backup: defineCommand({
      meta: {
        name: "backup",
        description:
          "Stream encrypted backup to stdout; password is entered interactively",
      },
      async run() {
        if (process.stdout.isTTY)
          throw new Error(
            "Redirect stdout to an operator-owned backup destination",
          )
        const password = await hiddenPassword()
        const source = createStorage(resolveStorageConfig())
        try {
          await migrateStorage(source)
          for await (const chunk of createBackupStream(
            password,
            undefined,
            source,
          ))
            if (!process.stdout.write(chunk))
              await new Promise<void>((resolve) =>
                process.stdout.once("drain", resolve),
              )
        } finally {
          await source.close()
        }
      },
    }),
    restore: defineCommand({
      meta: {
        name: "restore",
        description:
          "Restore to the explicitly configured empty replacement DATA_DIR or Turso database; serving database is retained for rollback",
      },
      args: { input: { type: "string", required: true } },
      async run({ args }) {
        const password = await hiddenPassword()
        const target = createStorage(resolveStorageConfig())
        try {
          await migrateStorage(target)
          const result = await restoreBackup(
            Bun.file(path.resolve(String(args.input))).stream(),
            password,
            target,
          )
          process.stdout.write(`${JSON.stringify(result)}\n`)
        } finally {
          await target.close()
        }
      },
    }),
  },
})
