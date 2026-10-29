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
import { WALLED_GARDENS, type Store } from '@linkinbox/core'

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

/** The reason recorded for a host that is behind a login wall. */
export const LOGIN_WALL_REASON = 'login_wall'

/** The reason recorded for a host that merely needs the browser renderer. */
export const NEEDS_BROWSER_REASON = 'needs_browser'

/**
 * Temporary query: group the links parked on a login wall by host and count
 * them. Replaced by `listHostsNeedingLogin` from packages/core once it
 * lands.
 */
export async function queryPendingLogins(store: Store): Promise<PendingLogins> {
  const parked = await store.listByStates(['needs_browser', 'deferred'])
  const profileHosts = new Set((await store.listProfiles()).map((p) => p.host))

  const grouped = new Map<string, { links: number; lastSeenAt: Date; reason: string }>()
  for (const link of parked) {
    const reason = reasonOf(link.state, link.stateData, hostOfLink(link.url, link.stateData))
    if (reason === null) continue
    const host = hostOfLink(link.url, link.stateData)
    if (!host) continue
    const seen = link.updatedAt ?? link.createdAt
    const current = grouped.get(host)
    if (!current) {
      grouped.set(host, { links: 1, lastSeenAt: seen, reason })
      continue
    }
    current.links += 1
    if (seen > current.lastSeenAt) current.lastSeenAt = seen
    // A login wall is the stronger signal: keep it over the plain
    // needs_browser reason.
    if (reason === LOGIN_WALL_REASON) current.reason = LOGIN_WALL_REASON
  }

  const pending: PendingLogin[] = []
  for (const [host, info] of grouped) {
    // A host with a saved profile is done: the user already logged in.
    if (profileHosts.has(host)) continue
    pending.push({
      host,
      linkCount: info.links,
      lastSeenAt: info.lastSeenAt,
      reason: info.reason,
    })
  }

  // Ordered by the number of waiting links, descending; the host name breaks
  // ties so the order is stable.
  pending.sort((a, b) => b.linkCount - a.linkCount || a.host.localeCompare(b.host))

  const done: DoneLogin[] = []
  for (const profile of await store.listProfiles()) {
    done.push({
      host: profile.host,
      profileAgeDays: profileAgeDays(profile.updatedAt),
    })
  }
  done.sort((a, b) => a.host.localeCompare(b.host))

  return { pending, done }
}

/** Age of a profile in whole days, never negative. */
export function profileAgeDays(updatedAt: Date, now: Date = new Date()): number {
  const days = (now.getTime() - updatedAt.getTime()) / 86_400_000
  return Math.max(0, Math.floor(days))
}

/**
 * The reason a parked link needs a login, or null when the link is waiting
 * for something else (a rate limit, a backoff) and no login is involved.
 */
function reasonOf(
  state: string,
  stateData: Record<string, unknown> | null,
  host: string,
): string | null {
  if (state === 'needs_browser') {
    return isWalledGarden(host) ? LOGIN_WALL_REASON : NEEDS_BROWSER_REASON
  }
  if (state === 'deferred') {
    const raw = stateData?.['reason']
    if (typeof raw !== 'string') return null
    if (!raw.startsWith('blocked:')) return null
    const detail = raw.slice('blocked:'.length).trim()
    return detail === '' ? LOGIN_WALL_REASON : detail
  }
  return null
}

/** True when the host is one of the walled gardens with a login wall. */
function isWalledGarden(host: string): boolean {
  const bare = host.replace(/^www\./, '')
  return WALLED_GARDENS.some((g) => g.replace(/^www\./, '') === bare)
}

/** The host of a parked link: the state payload first, then the url. */
function hostOfLink(url: string, stateData: Record<string, unknown> | null): string {
  const fromState = stateData?.['host']
  if (typeof fromState === 'string' && fromState.trim() !== '') return fromState.trim().toLowerCase()
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The default dependency: the temporary query. Replace the body with
 * `listHostsNeedingLogin(store)` from packages/core when it lands.
 */
export const loadPendingLogins: LoadPendingLogins = async (store) => queryPendingLogins(store)
