/**
 * Hosts that need a login.
 *
 * The `login` command uses this to tell the user which hosts still need a
 * browser session. A host needs a login when:
 *   - links of that host sit in `needs_browser` with the reason
 *     `login_wall`, or
 *   - the host is flagged (its canary was refused) and has no saved profile.
 */
import type { Store } from '../store.js'
import { hostOf } from './resilience.js'

/** One host that needs a browser login. */
export interface HostNeedingLogin {
  host: string
  /** How many links of this host are parked behind the login wall. */
  linkCount: number
  /** When the host was last seen (ms epoch). */
  lastSeenAt: number | null
  /** Why the host needs a login, e.g. `login_wall` or `canary_flagged`. */
  reason: string
}

/**
 * The reasons that mean "this host wants a session": a login wall and the
 * private-page 404 a gated host answers with.
 */
const LOGIN_WALL_REASONS = new Set(['login_wall', 'private_404', 'private_410'])

function isLoginWallReason(reason: string): boolean {
  return LOGIN_WALL_REASONS.has(reason)
}

/**
 * List the hosts that need a login, with the number of parked links and the
 * reason.
 */
export async function listHostsNeedingLogin(store: Store): Promise<HostNeedingLogin[]> {
  const rows = new Map<string, HostNeedingLogin>()

  // Links parked behind a login wall.
  const parked = await store.listByStates(['needs_browser'])
  for (const link of parked) {
    const host = hostOf(link.url)
    if (host === '' || host === 'unknown') continue
    const reason = typeof link.stateData?.['reason'] === 'string'
      ? (link.stateData['reason'] as string)
      : 'login_wall'
    if (!isLoginWallReason(reason)) continue
    const existing = rows.get(host)
    const seen = link.updatedAt.getTime()
    if (existing) {
      existing.linkCount += 1
      existing.lastSeenAt = existing.lastSeenAt === null ? seen : Math.max(existing.lastSeenAt, seen)
    } else {
      rows.set(host, { host, linkCount: 1, lastSeenAt: seen, reason })
    }
  }

  // Flagged hosts without a saved profile: the canary was refused, so the
  // host needs a session before it can be read.
  for (const state of await store.listHostStates()) {
    if (state.trialState !== 'flagged') continue
    if (state.loginGated !== true) continue
    if ((await store.getProfile(state.key)) !== null) continue
    const existing = rows.get(state.key)
    if (existing) continue
    rows.set(state.key, {
      host: state.key,
      linkCount: 0,
      lastSeenAt: state.trialAt,
      reason: state.trialReason ?? 'login_wall',
    })
  }

  return [...rows.values()].sort((a, b) => a.host.localeCompare(b.host))
}
