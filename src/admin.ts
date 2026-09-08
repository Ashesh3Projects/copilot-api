import { defineCommand } from "citty"
import consola from "consola"

import {
  ADMIN_PASSWORD_MIN_LENGTH,
  issueAdminSetupCode,
  resetAdminPassword,
  validateAdminPasswordHash,
} from "~/lib/admin-auth"
import {
  closeStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"

export const admin = defineCommand({
  meta: {
    name: "admin",
    description: "Manage administrator authentication",
  },
  args: {
    "hash-password": {
      type: "boolean",
      description:
        "Prompt for and hash a password as Argon2id for explicit legacy import",
    },
    "setup-code": {
      type: "boolean",
      description:
        "Issue a one-use, 15-minute setup code for an unconfigured database",
    },
    reset: {
      type: "boolean",
      description:
        "Reset the admin password and revoke every dashboard session",
    },
  },
  async run({ args }) {
    if (args["hash-password"]) {
      if (!process.stdin.isTTY) {
        throw new Error("--hash-password requires an interactive terminal")
      }
      const password = await readHiddenPassword("New administrator password: ")
      const confirmation = await readHiddenPassword(
        "Confirm administrator password: ",
      )
      if (password !== confirmation) {
        throw new Error("Administrator passwords do not match")
      }
      if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
        throw new Error(
          `Admin password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`,
        )
      }
      const hash = await Bun.password.hash(password, {
        algorithm: "argon2id",
        memoryCost: 65_536,
        timeCost: 3,
      })
      process.stdout.write(`${validateAdminPasswordHash(hash)}\n`)
      return
    }
    if (!args.reset && !args["setup-code"]) {
      consola.info(
        "Use --setup-code for initial setup or --reset to replace the administrator password.",
      )
      return
    }
    if (args.reset && args["setup-code"])
      throw new Error("Use either --setup-code or --reset")
    await initializeStorageRuntime()
    try {
      if (args["setup-code"]) {
        const { code, expiresAt } = await issueAdminSetupCode()
        process.stdout.write(`${code}\n`)
        consola.info(
          `Setup code expires at ${new Date(expiresAt).toISOString()}`,
        )
        return
      }
      if (!process.stdin.isTTY)
        throw new Error("--reset requires an interactive terminal")
      const password = await readHiddenPassword("New administrator password: ")
      const confirmation = await readHiddenPassword(
        "Confirm administrator password: ",
      )
      if (password !== confirmation)
        throw new Error("Administrator passwords do not match")
      await resetAdminPassword(password)
      consola.success(
        "Administrator password replaced and all dashboard sessions revoked.",
      )
    } finally {
      await closeStorageRuntime()
    }
  },
})

async function readHiddenPassword(message: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    process.stderr.write(message)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    let value = ""

    const cleanup = (): void => {
      process.stdin.off("data", onData)
      process.stdin.off("end", onEnd)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    const finish = (): void => {
      cleanup()
      process.stderr.write("\n")
      resolve(value)
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error("Password input closed"))
    }
    const onData = (rawChunk: string | Buffer): void => {
      for (const character of String(rawChunk)) {
        if (character === "\u0003") {
          cleanup()
          reject(new Error("Password input cancelled"))
          return
        }
        if (character === "\r" || character === "\n") {
          finish()
          return
        }
        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1)
          continue
        }
        if (character >= " ") value += character
      }
    }

    process.stdin.on("data", onData)
    process.stdin.once("end", onEnd)
  })
}
