import { randomInt } from "node:crypto"

import { revokeSessionCapabilities } from "~/lib/bridge-capabilities"

import type {
  ClientEvent,
  CodeSession,
  InternalEvent,
  RequiresActionDetails,
  SessionState,
} from "./types"

const sessions = new Map<string, CodeSession>()
const clientEvents = new Map<string, Array<ClientEvent>>()
const internalEvents = new Map<string, Array<InternalEvent>>()

let globalSeqNum = 0

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let result = ""
  for (let i = 0; i < 24; i++) {
    result += chars[randomInt(chars.length)]
  }
  return `cse_${result}`
}

export function createSession(title: string, tags: Array<string>): CodeSession {
  const session: CodeSession = {
    id: generateId(),
    title,
    state: "idle",
    tags,
    workerEpoch: 0,
    workerStatus: "idle",
    workerRegistered: false,
    externalMetadata: null,
    requiresActionDetails: null,
    createdAt: Date.now(),
    lastHeartbeat: Date.now(),
    archived: false,
  }
  sessions.set(session.id, session)
  clientEvents.set(session.id, [])
  internalEvents.set(session.id, [])
  return session
}

export function getSession(id: string): CodeSession | undefined {
  return sessions.get(id)
}

export function listSessions(): Array<CodeSession> {
  return Array.from(sessions.values())
}

export function archiveSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session || session.archived) return false
  session.archived = true
  revokeSessionCapabilities(id)
  return true
}

export function updateSessionTitle(id: string, title: string): void {
  const session = sessions.get(id)
  if (session) {
    session.title = title
  }
}

export function bumpWorkerEpoch(id: string): number | undefined {
  const session = sessions.get(id)
  if (!session) return undefined
  session.workerEpoch += 1
  session.workerRegistered = true
  return session.workerEpoch
}

export function updateWorkerState(
  id: string,
  epoch: number,
  opts?: {
    status?: SessionState
    externalMetadata?: Record<string, unknown> | null
    requiresActionDetails?: RequiresActionDetails | null
  },
): boolean {
  const session = sessions.get(id)
  if (!session || session.workerEpoch !== epoch) return false
  if (opts?.status !== undefined) {
    session.workerStatus = opts.status
    session.state = opts.status
  }
  if (opts?.externalMetadata !== undefined) {
    session.externalMetadata = opts.externalMetadata
  }
  if (opts?.requiresActionDetails !== undefined) {
    session.requiresActionDetails = opts.requiresActionDetails
  }
  return true
}

export function heartbeat(id: string, epoch: number): boolean {
  const session = sessions.get(id)
  if (!session || session.workerEpoch !== epoch) return false
  session.lastHeartbeat = Date.now()
  return true
}

export function addClientEvents(
  id: string,
  events: Array<Omit<ClientEvent, "event_id" | "sequence_num">>,
): Array<ClientEvent> {
  const list = clientEvents.get(id)
  if (!list) return []
  const created: Array<ClientEvent> = []
  for (const ev of events) {
    globalSeqNum += 1
    const clientEvent: ClientEvent = {
      ...ev,
      event_id: crypto.randomUUID(),
      sequence_num: globalSeqNum,
    }
    list.push(clientEvent)
    created.push(clientEvent)
  }
  return created
}

export function getClientEvents(
  id: string,
  fromSeqNum: number,
): Array<ClientEvent> {
  const list = clientEvents.get(id)
  if (!list) return []
  return list.filter((e) => e.sequence_num > fromSeqNum)
}

export function addInternalEvents(
  id: string,
  events: Array<InternalEvent>,
): void {
  const list = internalEvents.get(id)
  if (!list) return
  list.push(...events)
}

export function getInternalEvents(
  id: string,
  opts?: { subagents?: boolean; agentId?: string },
): Array<InternalEvent> {
  const list = internalEvents.get(id)
  if (!list) return []

  if (opts?.subagents && opts.agentId) {
    return list.filter((e) => e.agent_id === opts.agentId)
  }

  // Return events from the last compaction boundary
  let lastCompactionIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].is_compaction) {
      lastCompactionIdx = i
      break
    }
  }
  if (lastCompactionIdx === -1) return [...list]
  return list.slice(lastCompactionIdx)
}

export function getWorkerState(
  id: string,
): { external_metadata: Record<string, unknown> | null } | null {
  const session = sessions.get(id)
  if (!session) return null
  return { external_metadata: session.externalMetadata }
}

export function nextSequenceNum(): number {
  return globalSeqNum
}
