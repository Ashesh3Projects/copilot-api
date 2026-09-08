import { isIP } from "node:net"

import { createPolicyRepository } from "~/lib/storage/policy-repository"
import { getStorageRuntime } from "~/lib/storage/runtime"

export interface IpAllowlistEntry {
  ip: string
  enabled: boolean
  source: "authenticated" | "dashboard" | "manual"
  createdAt: string
  updatedAt: string
  lastSeenAt?: string
}

const IPV4_MAPPED_PREFIX = "::ffff:"

let testEntries: Array<IpAllowlistEntry> | undefined

/** Canonicalize a literal IPv4/IPv6 address. Hostnames and zone IDs are rejected. */
export function normalizeIpAddress(ip: string): string | null {
  let candidate = ip.trim()
  if (!candidate) return null

  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1)
  }
  if (candidate.includes("%")) return null

  const family = isIP(candidate)
  if (family === 4) return candidate
  if (family !== 6) return null

  if (candidate.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
    const mapped = candidate.slice(IPV4_MAPPED_PREFIX.length)
    if (isIP(mapped) === 4) return mapped
  }

  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname
    const normalized = hostname.slice(1, -1).toLowerCase()
    if (normalized.startsWith(IPV4_MAPPED_PREFIX)) {
      const mapped = normalized.slice(IPV4_MAPPED_PREFIX.length)
      if (isIP(mapped) === 4) return mapped
    }
    return normalized
  } catch {
    return null
  }
}

function normalizeEntry(raw: unknown): IpAllowlistEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined
  }

  const value = raw as Record<string, unknown>
  const ip = typeof value.ip === "string" ? normalizeIpAddress(value.ip) : null
  if (ip === null) return undefined

  let source: IpAllowlistEntry["source"] = "manual"
  if (value.source === "authenticated") source = "authenticated"
  else if (value.source === "dashboard") source = "dashboard"

  const now = new Date().toISOString()
  return {
    ip,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    source,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    lastSeenAt:
      typeof value.lastSeenAt === "string" ? value.lastSeenAt : undefined,
  }
}

function normalizeEntries(raw: unknown): Array<IpAllowlistEntry> {
  if (!Array.isArray(raw)) return []

  const byIp = new Map<string, IpAllowlistEntry>()
  for (const item of raw) {
    const entry = normalizeEntry(item)
    if (entry) byIp.set(entry.ip, entry)
  }
  return [...byIp.values()].sort((a, b) => a.ip.localeCompare(b.ip))
}

function repository() {
  return createPolicyRepository(getStorageRuntime().storage)
}

export function isValidIpAddress(ip: string): boolean {
  return normalizeIpAddress(ip) !== null
}

export async function listIpAllowlist(): Promise<Array<IpAllowlistEntry>> {
  return testEntries === undefined ?
      repository().listIps()
    : testEntries.map((entry) => ({ ...entry }))
}

export async function upsertIpAllowlistEntry(
  ip: string,
  options: {
    enabled?: boolean
    source?: IpAllowlistEntry["source"]
    seen?: boolean
  } = {},
): Promise<IpAllowlistEntry | null> {
  const normalized = normalizeIpAddress(ip)
  if (normalized === null) return null
  if (testEntries === undefined)
    return repository().upsertIp(normalized, options)
  const existing = testEntries.find((entry) => entry.ip === normalized)
  const now = new Date().toISOString()
  const lastSeenAt = options.seen ? now : existing?.lastSeenAt
  const entry: IpAllowlistEntry = {
    ip: normalized,
    enabled: options.enabled ?? existing?.enabled ?? true,
    source: options.source ?? existing?.source ?? "manual",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  }
  testEntries = [
    ...testEntries.filter((item) => item.ip !== normalized),
    entry,
  ].sort((left, right) => left.ip.localeCompare(right.ip))
  return { ...entry }
}

export async function promoteAuthenticatedIpAllowlistEntry(
  ip: string,
): Promise<IpAllowlistEntry | null> {
  const normalized = normalizeIpAddress(ip)
  if (normalized === null) return null
  if (testEntries === undefined)
    return repository().upsertIp(normalized, {}, true)
  const existing = testEntries.find((entry) => entry.ip === normalized)
  if (existing?.enabled && existing.lastSeenAt !== undefined)
    return { ...existing }
  return upsertIpAllowlistEntry(normalized, {
    enabled: true,
    seen: true,
    source: existing?.source ?? "authenticated",
  })
}

export async function removeIpAllowlistEntry(ip: string): Promise<boolean> {
  const normalized = normalizeIpAddress(ip)
  if (normalized === null) return false
  if (testEntries === undefined) return repository().removeIp(normalized)
  const count = testEntries.length
  testEntries = testEntries.filter((entry) => entry.ip !== normalized)
  return count !== testEntries.length
}

export async function clearIpAllowlist(): Promise<Array<IpAllowlistEntry>> {
  if (testEntries === undefined) return repository().clearIps()
  const removed = testEntries.map((entry) => ({ ...entry }))
  testEntries = []
  return removed
}

export async function setIpAllowlistEntryEnabled(
  ip: string,
  enabled: boolean,
): Promise<IpAllowlistEntry | null> {
  return upsertIpAllowlistEntry(ip, { enabled })
}

async function findEntry(ip: string): Promise<IpAllowlistEntry | null> {
  const normalized = normalizeIpAddress(ip)
  if (normalized === null) return null
  if (testEntries === undefined) return repository().findIp(normalized)
  return testEntries.find((entry) => entry.ip === normalized) ?? null
}

export async function isManagedIpAllowed(ip: string): Promise<boolean> {
  return (await findEntry(ip))?.enabled === true
}

export async function isManagedIpAllowedForTransparentProxy(
  ip: string,
): Promise<boolean> {
  const entry = await findEntry(ip)
  return entry?.enabled === true && entry.source !== "authenticated"
}

export async function isManagedIpDisabled(ip: string): Promise<boolean> {
  return (await findEntry(ip))?.enabled === false
}

export function setIpAllowlistForTest(rawEntries: Array<unknown>): void {
  testEntries = normalizeEntries(rawEntries)
}

export function resetIpAllowlistForTest(): void {
  testEntries = undefined
}
