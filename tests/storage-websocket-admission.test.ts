import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

import {
  credentialDigest,
  insertGatewayCredential,
} from "~/lib/storage/credentials-repository"
import { initializeStorageRuntime } from "~/lib/storage/runtime"
import { admitWebSocketTurn } from "~/lib/storage/websocket-admission"

import { createRuntimeStorage } from "./helpers/runtime-storage"

test("existing socket cannot admit a new turn after revocation or storage outage", async () => {
  const fixture = await createRuntimeStorage()
  try {
    const runtime = await initializeStorageRuntime(fixture)
    const key = "fixture-websocket-key"
    await runtime.storage.transaction((s) =>
      insertGatewayCredential(s, {
        id: randomUUID(),
        credential: key,
        label: "test",
        createdAt: Date.now(),
      }),
    )
    const request = new Request("http://localhost/responses", {
      headers: { authorization: "Bearer " + key },
    })
    expect((await admitWebSocketTurn(request)).status).toBe("authorized")
    await runtime.storage.transaction((s) =>
      s.execute({
        sql: "UPDATE capi_gateway_credentials SET revoked_at = ? WHERE digest = ?",
        args: [Date.now(), credentialDigest(key)],
      }),
    )
    expect((await admitWebSocketTurn(request)).status).toBe("unauthorized")
    await runtime.storage.close()
    expect((await admitWebSocketTurn(request)).status).toBe("unavailable")
  } finally {
    await fixture.close()
  }
})
