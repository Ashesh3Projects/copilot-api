/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun asynchronous rejection matchers are awaited at runtime. */
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import {
  applyLegacyImport,
  previewLegacyImport,
} from "../src/lib/storage/legacy-import"
import { withTransferStorage } from "./helpers/transfer-storage"
test("legacy preview/apply preserves positional IDs and old usage, is idempotent and never edits input", async () => {
  await withTransferStorage(async (target, directory) => {
    const fixtures = {
      "github_tokens.json": [
        { token: "fixture-one" },
        { token: "fixture-two" },
      ],
      "model_routing.json": { "fixture-model": { "1": true } },
      "usage.json": {
        records: [
          {
            timestamp: 0,
            inputTokens: 12,
            outputTokens: 7,
            model: "old-model",
          },
        ],
      },
      "config.json": { auth: { apiKeys: ["fixture-gateway"] } },
    }
    for (const [name, value] of Object.entries(fixtures))
      await fs.writeFile(path.join(directory, name), JSON.stringify(value))
    const input = { directory, includeEnvironment: false }
    const preview = await previewLegacyImport(input, target)
    const applied = await applyLegacyImport(input, preview, target)
    expect((await applyLegacyImport(input, preview, target)).operationId).toBe(
      applied.operationId,
    )
    expect(
      await target.read((session) =>
        session.query({
          sql: "SELECT id FROM capi_accounts ORDER BY id",
          args: [],
        }),
      ),
    ).toEqual([{ id: 0 }, { id: 1 }])
    expect(
      await target.read((session) =>
        session.query({
          sql: "SELECT input_tokens,request_count FROM capi_usage_lifetime",
          args: [],
        }),
      ),
    ).toEqual([{ input_tokens: 12, request_count: 1 }])
    for (const [name, value] of Object.entries(fixtures))
      expect(await fs.readFile(path.join(directory, name), "utf8")).toBe(
        JSON.stringify(value),
      )
    await fs.writeFile(
      path.join(directory, "github_tokens.json"),
      JSON.stringify([{ token: "changed" }]),
    )
    await expect(applyLegacyImport(input, preview, target)).rejects.toThrow()
  })
})
test("source digest and target revision cannot be bypassed", async () => {
  await withTransferStorage(async (target, directory) => {
    await fs.writeFile(path.join(directory, "github_token"), "fixture-token")
    const input = { directory, includeEnvironment: false }
    const preview = await previewLegacyImport(input, target)
    await expect(
      applyLegacyImport(
        input,
        { ...preview, expectedTargetRevision: 1 },
        target,
      ),
    ).rejects.toThrow()
    await fs.writeFile(path.join(directory, "github_token"), "fixture-changed")
    await expect(applyLegacyImport(input, preview, target)).rejects.toThrow(
      "changed",
    )
  })
})
test("missing account references fail before any target writes", async () => {
  await withTransferStorage(async (target, directory) => {
    await fs.writeFile(
      path.join(directory, "model_routing.json"),
      '{"model":{"9":true}}',
    )
    await expect(
      previewLegacyImport({ directory, includeEnvironment: false }, target),
    ).rejects.toThrow("missing account")
    expect(
      await target.read((session) =>
        session.query({ sql: "SELECT * FROM capi_settings", args: [] }),
      ),
    ).toEqual([])
  })
})

/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejection matchers are asynchronous at runtime. */
test("a failed legacy batch remains unready and leaves every input untouched", async () => {
  await withTransferStorage(async (target, directory) => {
    const fixture = JSON.stringify(
      Array.from({ length: 30 }, (_, id) => ({ token: `fixture-${id}` })),
    )
    await fs.writeFile(path.join(directory, "github_tokens.json"), fixture)
    const input = { directory, includeEnvironment: false }
    const preview = await previewLegacyImport(input, target)
    let transactions = 0
    const faulted: import("../src/lib/storage/types").Storage = {
      read: (work) => target.read(work),
      close: () => Promise.resolve(),
      atomicBatch: (statements) => target.atomicBatch(statements),
      transaction: (work) => {
        if (++transactions === 3)
          return Promise.reject(new Error("injected failure"))
        return target.transaction(work)
      },
    }
    await expect(applyLegacyImport(input, preview, faulted)).rejects.toThrow(
      "injected failure",
    )
    expect(
      await target.read((session) =>
        session.query({
          sql: "SELECT value FROM capi_metadata WHERE key='transfer_incomplete'",
          args: [],
        }),
      ),
    ).toHaveLength(1)
    expect(
      await target.read((session) =>
        session.query({ sql: "SELECT id FROM capi_imports", args: [] }),
      ),
    ).toHaveLength(0)
    expect(
      await fs.readFile(path.join(directory, "github_tokens.json"), "utf8"),
    ).toBe(fixture)
  })
})
