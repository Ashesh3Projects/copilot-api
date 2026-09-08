/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matcher typings return void; await still orders rejection assertions. */
import { describe, expect, test } from "bun:test"

import type { RuntimeSnapshot, SettingsDocument } from "~/lib/storage/types"

import {
  getCurrentSnapshot,
  getRequestSnapshot,
  withRequestSnapshot,
} from "~/lib/storage/request-snapshot"
import { initializeSnapshot } from "~/lib/storage/snapshot"

function snapshot(revision: number, fallbackRevision = 1): RuntimeSnapshot {
  const documents: Array<SettingsDocument> = [
    { namespace: "app", value: { smallModel: `model-${revision}` }, revision },
    {
      namespace: "model_fallbacks",
      value: { enabled: true },
      revision: fallbackRevision,
    },
  ]
  return {
    revision,
    documents: new Map(documents.map((doc) => [doc.namespace, doc])),
  }
}

function repository(initial: RuntimeSnapshot) {
  let current = initial
  let failure: Error | undefined
  return {
    getRevision: () =>
      failure ? Promise.reject(failure) : Promise.resolve(current.revision),
    loadSnapshot: () =>
      failure ? Promise.reject(failure) : Promise.resolve(current),
    loadAll: () => Promise.resolve([...current.documents.values()]),
    replace: () => Promise.reject(new Error("Unused by snapshot reader")),
    advance: (next: RuntimeSnapshot) => {
      current = next
    },
    fail: () => {
      failure = new Error("unavailable")
    },
  }
}

describe("settings snapshots", () => {
  test("published snapshots cannot be changed through their source or getter", async () => {
    const source = snapshot(1)
    const manager = await initializeSnapshot(repository(source))
    const app = source.documents.get("app")
    if (!app) throw new Error("Missing fixture document")
    app.value = { smallModel: "tampered" }
    expect(manager.get().documents.get("app")?.value).toEqual({
      smallModel: "model-1",
    })
    const captured = manager.get()
    expect(() => {
      const capturedApp = captured.documents.get("app")
      if (!capturedApp) throw new Error("Missing snapshot document")
      capturedApp.value = null
    }).toThrow()
    expect("set" in captured.documents).toBe(false)
    expect(manager.get().revision).toBe(1)
  })

  test("refresh advances the live snapshot without changing captured values", async () => {
    const source = repository(snapshot(1))
    const manager = await initializeSnapshot(source)
    const captured = manager.get()
    source.advance(snapshot(2))
    await manager.refreshIfChanged()
    expect(manager.get().revision).toBe(2)
    expect(captured.revision).toBe(1)
    expect(manager.get().documents.get("model_fallbacks")?.revision).toBe(1)
    manager.publish(snapshot(1))
    expect(manager.get().revision).toBe(2)
  })

  test("failed refresh rejects and leaves the last committed snapshot intact", async () => {
    const source = repository(snapshot(1))
    const manager = await initializeSnapshot(source)
    source.fail()
    await expect(manager.refreshIfChanged()).rejects.toThrow("unavailable")
    expect(manager.get().revision).toBe(1)
  })

  test("an admitted async request keeps its snapshot while the live guard advances", async () => {
    const manager = await initializeSnapshot(repository(snapshot(1)))
    expect(getRequestSnapshot()).toBeUndefined()
    await withRequestSnapshot(manager.get(), async () => {
      manager.publish(snapshot(2, 2))
      await Promise.resolve()
      expect(getCurrentSnapshot(manager).revision).toBe(1)
      expect(manager.get().documents.get("model_fallbacks")?.revision).toBe(2)
      await withRequestSnapshot(manager.get(), async () => {
        await Promise.resolve()
        expect(getRequestSnapshot()?.revision).toBe(2)
      })
      expect(getRequestSnapshot()?.revision).toBe(1)
    })
    expect(getRequestSnapshot()).toBeUndefined()
    expect(getCurrentSnapshot(manager).revision).toBe(2)
  })

  test("a revision read racing a local publication does not report rollback", async () => {
    const source = repository(snapshot(1))
    const pending = Promise.withResolvers<number>()
    const manager = await initializeSnapshot({
      ...source,
      getRevision: () => pending.promise,
    })
    const refresh = manager.refreshIfChanged()
    manager.publish(snapshot(2))
    pending.resolve(1)
    await refresh
    expect(manager.get().revision).toBe(2)
  })

  test("refresh rejects a stale document read behind its metadata revision", async () => {
    const source = repository(snapshot(1))
    let revision = 1
    const manager = await initializeSnapshot({
      ...source,
      getRevision: () => Promise.resolve(revision),
    })
    revision = 2
    await expect(manager.refreshIfChanged()).rejects.toThrow()
    expect(manager.get().revision).toBe(1)
  })

  test("a later admission observes an external commit while an older metadata response is delayed", async () => {
    const source = repository(snapshot(1))
    const delayed = Promise.withResolvers<number>()
    const firstReadStarted = Promise.withResolvers<boolean>()
    let firstRead = true
    const manager = await initializeSnapshot({
      ...source,
      getRevision: () => {
        if (!firstRead) return source.getRevision()
        firstRead = false
        firstReadStarted.resolve(true)
        return delayed.promise
      },
    })
    const captured = manager.get()
    const earlierAdmission = manager.refreshIfChanged()
    await firstReadStarted.promise
    source.advance(snapshot(2, 2))
    const laterAdmission = manager.refreshIfChanged()
    delayed.resolve(1)
    await Promise.all([earlierAdmission, laterAdmission])
    expect(manager.get().revision).toBe(2)
    expect(manager.get().documents.get("app")?.value).toEqual({
      smallModel: "model-2",
    })
    expect(captured.revision).toBe(1)
  })
})
