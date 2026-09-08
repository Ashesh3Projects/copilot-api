import { expect, test } from "bun:test"

import { refreshModelsSummary } from "../ui/src/lib/account-model-refresh"

test("global model refresh reports every failure without hiding completed accounts", () => {
  expect(refreshModelsSummary({ refreshed: 2, failed: 1 })).toBe(
    "Models refreshed for 2 accounts; 1 account failed.",
  )
  expect(refreshModelsSummary({ refreshed: 1, failed: 0 })).toBe(
    "Models refreshed for 1 account.",
  )
  expect(refreshModelsSummary({ refreshed: 0, failed: 0 })).toBe(
    "No connected accounts to refresh.",
  )
})
