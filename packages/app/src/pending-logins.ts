/**
 * Pending logins: the hosts that still need a browser login before their
 * links can be extracted.
 *
 * The data source is `listHostsNeedingLogin(store)` in packages/core,
 * injected through `loadPendingLogins` so tests can substitute a fake.
 *
 * A host needs a login when it has links parked on a login wall:
 *   - links in the `needs_browser` state (extraction needs the browser), or
 *   - deferred links whose reason says the host blocked the request.
 * A host with a saved profile does not need a login, so it is not pending.
 */
import {
  countReviewOnlyLinks,
  listHostsNeedingLogin,
  type LimitsConfig,
  type Store,
} from '@linkinbox/core'

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
  /**
   * How many parked links are review-only: never fetched, the owner reads
   * them by hand. Reported so the exclusion is visible.
   */
  reviewOnly: number
}

/**
 * Load the pending logins. The injected dependency keeps the command body
 * free of storage details and makes the core swap trivial.
 */
export type LoadPendingLogins = (
  store: Store,
  policy?: PendingLoginPolicy,
) => Promise<PendingLogins>

/**
 * The host policy the pending list honours: the skip list, the review list
 * and the `[login] allow` list. Hosts the policy excludes are not pending.
 */
export interface PendingLoginPolicy {
  /** The config limits (skip list, review list). */
  limits?: LimitsConfig
  /** The `[login] allow` patterns. */
  loginAllow?: string[]
}

/**
 * Pending logins from the core source of truth: hosts with links parked on a
 * login wall plus flagged hosts without a profile, minus hosts that already
 * have a saved profile and minus the hosts the policy excludes on purpose.
 */
export async function queryPendingLogins(
  store: Store,
  policy: PendingLoginPolicy = {},
): Promise<PendingLogins> {
  const profiles = await store.listProfiles()
  const profileHosts = new Set(profiles.map((p) => p.host))

  const pending: PendingLogin[] = (await listHostsNeedingLogin(store, {
    limits: policy.limits,
    loginAllow: policy.loginAllow,
  }))
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

  const reviewOnly = await countReviewOnlyLinks(store, {
    limits: policy.limits,
    loginAllow: policy.loginAllow,
  })

  return { pending, done, reviewOnly }
}

/** Age of a profile in whole days, never negative. */
export function profileAgeDays(updatedAt: Date, now: Date = new Date()): number {
  const days = (now.getTime() - updatedAt.getTime()) / 86_400_000
  return Math.max(0, Math.floor(days))
}

/**
 * The default dependency, backed by `listHostsNeedingLogin` in packages/core.
 */
export const loadPendingLogins: LoadPendingLogins = async (store, policy) =>
  queryPendingLogins(store, policy)

/**
 * The report shape shared by the CLI and the MCP tool: pending hosts with
 * their waiting link counts, the hosts that already have a profile, and the
 * count of review-only links that are deliberately not fetched.
 */
export interface LoginReport {
  pending: { host: string; links: number; reason: string }[]
  done: { host: string; profileAgeDays: number }[]
  /**
   * Parked links the pipeline never fetches (the owner reviews them by
   * hand). Optional so older readers keep working; the CLI and the MCP
   * tool always report it.
   */
  reviewOnly?: number
}

/** Build the report from the loaded logins. */
export function buildLoginReport(logins: PendingLogins): LoginReport {
  return {
    pending: logins.pending.map((p) => ({ host: p.host, links: p.linkCount, reason: p.reason })),
    done: logins.done.map((d) => ({ host: d.host, profileAgeDays: d.profileAgeDays })),
    reviewOnly: logins.reviewOnly,
  }
}

/** Load the logins and project them onto the report shape. */
export async function loadLoginReport(
  store: Store,
  policy: PendingLoginPolicy = {},
): Promise<LoginReport> {
  return buildLoginReport(await loadPendingLogins(store, policy))
}
