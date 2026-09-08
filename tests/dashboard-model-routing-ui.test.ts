// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- UI has a separate JSX TS project.
// @ts-nocheck -- Runtime coverage imports the separately configured UI project.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { expect, mock, test } from "bun:test"

import { renderToStaticMarkup } from "../ui/node_modules/react-dom/server.bun.js"
import { createElement } from "../ui/node_modules/react/index.js"

const accounts = [
  {
    id: 1,
    accountType: "individual",
    healthy: true,
    modelsCount: 1,
    enabled: false,
  },
  {
    id: 2,
    accountType: "individual",
    healthy: true,
    modelsCount: 1,
    enabled: true,
    deleting: true,
  },
  { id: 3, accountType: "individual", healthy: true, modelsCount: 1 },
]
await mock.module("../ui/src/lib/usePolling", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix
  useAsyncData: () => ({
    data: {
      multiToken: true,
      accounts,
      models: [
        {
          id: "fixture-model",
          name: "Fixture Model",
          vendor: "fixture",
          preview: false,
          accounts: accounts.map((account) => ({
            accountId: account.id,
            enabled: true,
          })),
        },
      ],
    },
    loading: false,
    error: undefined,
    reload: () => {},
  }),
}))
await mock.module("../ui/src/lib/toast", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix
  useToast: () => ({ success: () => {}, error: () => {} }),
}))
const { default: ModelRoutingScreen } = await import(
  "../ui/src/screens/ModelRouting"
)

test("disabled and removing accounts have clear labels and disabled model toggles", () => {
  const markup: string = renderToStaticMarkup(createElement(ModelRoutingScreen))
  expect(markup).toContain("Account #1, individual, Disabled")
  expect(markup).toContain("Account #2, individual, Removing")
  expect(markup).toContain("Account #3, individual, Healthy")
  const switches = [
    ...markup.matchAll(/<[^>]*(?:role="switch"|type="checkbox")[^>]*>/g),
  ].map((match) => match[0])
  expect(switches).toHaveLength(3)
  expect(switches[0]).toMatch(/disabled|aria-disabled="true"/)
  expect(switches[1]).toMatch(/disabled|aria-disabled="true"/)
  expect(switches[2]).not.toMatch(/disabled|aria-disabled="true"/)
})
