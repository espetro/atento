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
import { DEFAULT_LIMITS, hostPolicy, type LimitsConfig } from '../resilience/index.js'
import { REVIEW_ONLY_REASON } from './extract.js'
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

/** Options for the pending-login listing. */
export interface ListHostsNeedingLoginOptions {
  /**
   * The current limits: the skip list, the review list and (through the
   * policy) the built-in loopback rule. Hosts covered by either are never
   * listed: they are not pending, they are excluded on purpose.
   */
  limits?: LimitsConfig
  /**
   * The `[login] allow` patterns. When set, a login-walled host that is
   * neither allowed nor backed by a saved profile is review-only: it is not
   * pending, the owner reviews it by hand.
   */
  loginAllow?: string[]
}

/**
 * True when the host is deliberately not pending: skip-listed, review-only
 * or (with an allow list set) not allowed to be logged in to. A saved
 * profile always keeps the host listed as allowed.
 */
async function isDeliberatelyExcluded(
  store: Store,
  host: string,
  options: ListHostsNeedingLoginOptions,
): Promise<boolean> {
  const limits = options.limits ?? DEFAULT_LIMITS
  const state = await store.getHostState(host)
  const hasProfile = (await store.getProfile(host)) !== null
  const policy = hostPolicy(limits, host, {
    hasProfile,
    trialState: state?.trialState ?? 'unknown',
    loginGated: state?.loginGated ?? false,
    loginAllow: options.loginAllow,
  })
  return policy.skipped || policy.reviewOnly
}

/**
 * List the hosts that need a login, with the number of parked links and the
 * reason. Hosts the policy excludes on purpose (skip list, review list,
 * a `[login] allow` list that does not cover them) are left out: they are
 * not pending, so nothing is silently hidden as a login task.
 */
export async function listHostsNeedingLogin(
  store: Store,
  options: ListHostsNeedingLoginOptions = {},
): Promise<HostNeedingLogin[]> {
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
    if (await isDeliberatelyExcluded(store, host, options)) continue
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
    if (await isDeliberatelyExcluded(store, state.key, options)) continue
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

/**
 * How many parked links are review-only, per host. These are the links
 * nothing in the pipeline will ever fetch: the owner reads them by hand.
 * The count is reported next to the pending list so the exclusion is
 * visible, never silent.
 */
export async function countReviewOnlyLinks(
  store: Store,
  options: ListHostsNeedingLoginOptions = {},
): Promise<number> {
  const parked = await store.listByStates(['needs_browser'])
  let count = 0
  for (const link of parked) {
    const reason = link.stateData?.['reason']
    if (reason === REVIEW_ONLY_REASON) {
      count += 1
      continue
    }
    // A parked link whose host the policy now marks review-only counts too,
    // even before the next extract run reconciled its reason.
    const host = hostOf(link.url)
    if (host === '' || host === 'unknown') continue
    const limits = options.limits ?? DEFAULT_LIMITS
    const state = await store.getHostState(host)
    const hasProfile = (await store.getProfile(host)) !== null
    const policy = hostPolicy(limits, host, {
      hasProfile,
      trialState: state?.trialState ?? 'unknown',
      loginGated: state?.loginGated ?? false,
      loginAllow: options.loginAllow,
    })
    if (policy.reviewOnly) count += 1
  }
  return count
}
