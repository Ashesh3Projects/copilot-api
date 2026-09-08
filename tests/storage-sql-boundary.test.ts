import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

test("application SQL stays inside the storage repository boundary", async () => {
  const root = join(import.meta.dir, "../src")
  const violations: Array<string> = []
  for await (const filename of new Bun.Glob("**/*.ts").scan(root)) {
    if (filename.replaceAll("\\", "/").startsWith("lib/storage/")) continue
    if (/\bsql\s*:/.test(await readFile(join(root, filename), "utf8")))
      violations.push(filename.replaceAll("\\", "/"))
  }
  expect(violations.sort()).toEqual([])
})
