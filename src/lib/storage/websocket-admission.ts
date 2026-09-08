import type { RuntimeSnapshot } from "~/lib/storage/types"

import { getAccountsService } from "~/lib/accounts-service"
import { resolveRequestCredential } from "~/lib/credential-resolver"
import { getStorageRuntime } from "~/lib/storage/runtime"

export type WebSocketAdmission =
  | { status: "authorized"; snapshot: RuntimeSnapshot }
  | { status: "unauthorized" | "unavailable" }

/** Recheck original connection authority for every new inference turn. */
export async function admitWebSocketTurn(
  request: Request,
): Promise<WebSocketAdmission> {
  try {
    const runtime = getStorageRuntime()
    await runtime.snapshot.refreshIfChanged()
    await getAccountsService().refreshRuntime()
    if (!(await resolveRequestCredential(request, ["user:inference"]))) {
      return { status: "unauthorized" }
    }
    return { status: "authorized", snapshot: runtime.snapshot.get() }
  } catch {
    return { status: "unavailable" }
  }
}
