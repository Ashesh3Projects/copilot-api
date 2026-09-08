import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

test("dashboard favicon reuses the Copilot mark inline with adaptive tab contrast", () => {
  const html = readFileSync(join(import.meta.dir, "../ui/index.html"), "utf8")
  const icons = readFileSync(
    join(import.meta.dir, "../ui/src/icons.tsx"),
    "utf8",
  )
  const favicon = html.match(
    /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]+)"/,
  )?.[1]
  expect(favicon).toBeDefined()
  const svg = decodeURIComponent(favicon ?? "")
  const mark = icons
    .slice(icons.indexOf("export const CopilotIcon"))
    .match(/<path d="([^"]+)"/)?.[1]
  expect(svg).toContain(`d="${mark}"`)
  expect(svg).toContain("prefers-color-scheme: dark")
  expect(svg).toContain('viewBox="0 0 24 24"')
  expect(svg).not.toContain("<script")
})
