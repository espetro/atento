/**
 * Pending logins: the hosts that still need a browser login before their
 * links can be extracted.
 *
 * The canonical data source is `listHostsNeedingLogin(store)` in
 * packages/core (the canary slice). That function does not exist on this
 * branch yet, so this module ships a temporary query against the same
 * tables and keeps the shape identical. The dependency is injected through
 * `loadPendingLogins`, so swapping the core function in is a one line
 * change at the call site and nothing else.
 *
 * A host needs a login when it has links parked on a login wall:
 *   - links in the `needs_browser` state (extraction needs the browser), or
 *   - deferred links whose reason says the host blocked the request.
 * A host with a saved profile does not need a login, so it is not pending.
 */
import { listHostsNeedingLogin, type Store } from '@linkinbox/core'

/** One host that still needs a login. */
export interface PendingLogin {
  /** Host name, e.g. `x.com`. */
  host: string
  /** How many links are waiting on this host. */
  linkCount: number
  /** When the host was last seen among the waiting links. */
  lastSeenAt: Date
  /** Why the login is needed, e.g. `login_wall`. */
  reason: string
}

/** A host that already has a saved browser profile. */
export interface DoneLogin {
  host: string
  /** How old the saved profile is, in days. */
  profileAgeDays: number
}

/** The full picture: what is pending and what is already done. */
export interface PendingLogins {
  pending: PendingLogin[]
  done: DoneLogin[]
}

/**
 * Load the pending logins. The injected dependency keeps the command body
 * free of storage details and makes the core swap trivial.
 */
export type LoadPendingLogins = (store: Store) => Promise<PendingLogins>

/**
 * Pending logins from the core source of truth: hosts with links parked on a
 * login wall plus flagged hosts without a profile, minus hosts that already
 * have a saved profile.
 */
export async function queryPendingLogins(store: Store): Promise<PendingLogins> {
  const profiles = await store.listProfiles()
  const profileHosts = new Set(profiles.map((p) => p.host))

  const pending: PendingLogin[] = (await listHostsNeedingLogin(store))
    .filter((h) => !profileHosts.has(h.host))
    .map((h) => ({
      host: h.host,
      linkCount: h.linkCount,
      lastSeenAt: new Date(h.lastSeenAt ?? 0),
      reason: h.reason,
    }))
  // Most waiting links first; the host name breaks ties so the order is stable.
  pending.sort((a, b) => b.linkCount - a.linkCount || a.host.localeCompare(b.host))

  const done: DoneLogin[] = profiles
    .map((p) => ({ host: p.host, profileAgeDays: profileAgeDays(p.updatedAt) }))
    .sort((a, b) => a.host.localeCompare(b.host))

  return { pending, done }
}

/** Age of a profile in whole days, never negative. */
export function profileAgeDays(updatedAt: Date, now: Date = new Date()): number {
  const days = (now.getTime() - updatedAt.getTime()) / 86_400_000
  return Math.max(0, Math.floor(days))
}

/**
 * The default dependency, backed by `listHostsNeedingLogin` in packages/core.
 */
export const loadPendingLogins: LoadPendingLogins = async (store) => queryPendingLogins(store)

/**
 * The report shape shared by the CLI and the MCP tool: pending hosts with
 * their waiting link counts, and the hosts that already have a profile.
 */
export interface LoginReport {
  pending: { host: string; links: number; reason: string }[]
  done: { host: string; profileAgeDays: number }[]
}

/** Build the report from the loaded logins. */
export function buildLoginReport(logins: PendingLogins): LoginReport {
  return {
    pending: logins.pending.map((p) => ({ host: p.host, links: p.linkCount, reason: p.reason })),
    done: logins.done.map((d) => ({ host: d.host, profileAgeDays: d.profileAgeDays })),
  }
}

/** Load the logins and project them onto the report shape. */
export async function loadLoginReport(store: Store): Promise<LoginReport> {
  return buildLoginReport(await loadPendingLogins(store))
}
