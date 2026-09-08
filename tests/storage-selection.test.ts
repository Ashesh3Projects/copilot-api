import { expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"

import { resolveStorageConfig } from "~/lib/storage/config"

test.each([{}, { TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "  " }])(
  "absent Turso pair selects fixed local filename",
  (env) => {
    expect(resolveStorageConfig(env)).toEqual({
      kind: "sqlite",
      path: join(
        homedir(),
        ".local",
        "share",
        "copilot-api",
        "copilot-api.sqlite",
      ),
    })
    expect(Object.isFrozen(resolveStorageConfig(env))).toBe(true)
  },
)

test("DATA_DIR controls only local storage", () => {
  expect(resolveStorageConfig({ DATA_DIR: "./fixture" })).toEqual({
    kind: "sqlite",
    path: join(process.cwd(), "fixture", "copilot-api.sqlite"),
  })
  expect(
    resolveStorageConfig({
      DATA_DIR: "ignored",
      TURSO_DATABASE_URL: " turso://unit.example/ ",
      TURSO_AUTH_TOKEN: " test-only ",
    }),
  ).toEqual({
    kind: "turso",
    url: "turso://unit.example",
    authToken: "test-only",
  })
})

test.each([
  { TURSO_DATABASE_URL: "turso://unit.example" },
  { TURSO_AUTH_TOKEN: "test-only" },
  { TURSO_DATABASE_URL: " ", TURSO_AUTH_TOKEN: "test-only" },
])("partial configuration fails without exposing values", (env) => {
  expect(() => resolveStorageConfig(env)).toThrow("configured together")
})

test.each([
  "file:test.sqlite",
  ":memory:",
  "libsql://unit.example",
  "http://unit.example",
  "bad-url",
  "turso://user:password@unit.example",
  "https://unit.example/?token=secret",
  "https://unit.example/path",
])("reject invalid remote endpoint %s", (url) => {
  expect(() =>
    resolveStorageConfig({
      TURSO_DATABASE_URL: url,
      TURSO_AUTH_TOKEN: "test-only",
    }),
  ).toThrow("Invalid Turso")
})
