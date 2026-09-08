import { Hono } from "hono"

import {
  leaseAccount,
  unavailableAccount,
  withAccountLeaseScope,
} from "~/lib/account-lease-context"
import { forwardError } from "~/lib/error"
import { getClientSessionId } from "~/lib/request-session"
import { tokenPool } from "~/lib/token-pool"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    const usage = await withAccountLeaseScope(c.req.raw.signal, async () => {
      const selected =
        tokenPool.getHealthyAccountBySession(getClientSessionId())
      if (!selected) throw unavailableAccount()
      const account = leaseAccount(selected)
      return getCopilotUsage(account.githubToken, account.githubInstanceDomain)
    })
    return c.json(usage)
  } catch (error) {
    return forwardError(c, error)
  }
})
