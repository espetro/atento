/**
 * Fair batch selection: pick links round-robin across hosts so one host with
 * many links cannot fill every batch and starve the others.
 *
 * Rules: hosts are ordered by their oldest `created` link; within a host the
 * oldest links come first; the batch is filled round-robin, one link per host
 * per round, so every host gets a slot before any host gets a second. Hosts whose persisted limiter state says they are inside a spacing
 * wait, rate limited until a future time, or past their daily cap are skipped
 * when that is cheaply readable from `host_state` (no fetch, pure check).
 */
import type { Link, Store } from '../store.js'
import { hostOf } from './resilience.js'
import type { HostState, HostLimit } from '../resilience/index.js'
/** Milliseconds in a day, matching the limiter's daily window. */
const DAY_MS = 24 * 60 * 60 * 1000

export interface HostEligibility {
  /** True when the host may be contacted now. */
  eligible: boolean
  /**
   * Why the host is not eligible. `daily_cap` and `rate_limited` are hard
   * blocks for the whole window: the host can make no progress today, so its
   * links are skipped. `spacing` is a transient wait: the host comes back
   * soon, so its links are only skipped when the host has more queued links
   * than its share of the batch.
   */
  reason: 'daily_cap' | 'rate_limited' | 'breaker' | 'spacing' | null
}

/**
 * Cheap eligibility check from the persisted host state. Conservative: only
 * skips when the state clearly says "not now". A missing state is eligible.
 */
export function hostEligible(
  state: HostState | null | undefined,
  limit: Pick<HostLimit, 'dailyCap' | 'intervalMs'> | undefined,
  now: number,
): HostEligibility {
  if (!state) return { eligible: true, reason: null }
  // An upstream Retry-After: the host told us to back off, skip it.
  if (state.rateLimitedUntil !== null && state.rateLimitedUntil > now) {
    return { eligible: false, reason: 'rate_limited' }
  }
  if (state.breakerState === 'open' && state.openedUntil !== null && state.openedUntil > now) {
    return { eligible: false, reason: 'breaker' }
  }
  if (limit !== undefined) {
    // Daily cap: only when the window is current and full.
    if (
      Number.isFinite(limit.dailyCap) &&
      state.windowStart !== null &&
      now - state.windowStart < DAY_MS &&
      state.windowCount >= limit.dailyCap
    ) {
      return { eligible: false, reason: 'daily_cap' }
    }
  }
  return { eligible: true, reason: null }
}

/**
 * The transient spacing wait: the host was contacted too recently. Only
 * checked when a limit is known.
 */
export function hostInSpacingWait(
  state: HostState | null | undefined,
  limit: Pick<HostLimit, 'intervalMs'> | undefined,
  now: number,
): boolean {
  if (!state || !limit) return false
  if (limit.intervalMs <= 0) return false
  if (state.lastRequestAt === null) return false
  return now - state.lastRequestAt < limit.intervalMs
}

/**
 * Select a fair batch from the queued `created` links. Order is stable: the
 * input must already be oldest-first (the store guarantees that).
 *
 * `blocked` hosts are hard blocks (daily cap, upstream rate limit, open
 * breaker): their links are never selected. `waiting` hosts are inside a
 * spacing wait: they are only used when no other host has a pending link, so
 * a busy host cannot fill the batch with links the limiter will defer.
 */
export function selectFairBatch(
  queued: Link[],
  maxBatch: number,
  options: { blocked?: Set<string>; waiting?: Set<string> } = {},
): Link[] {
  const blocked = options.blocked ?? new Set<string>()
  const waiting = options.waiting ?? new Set<string>()
  // Group by host preserving the input order (oldest first within a host).
  const byHost = new Map<string, Link[]>()
  for (const link of queued) {
    const host = hostOf(link.url)
    if (blocked.has(host)) continue
    const list = byHost.get(host)
    if (list) list.push(link)
    else byHost.set(host, [link])
  }
  // Round-robin: hosts ordered by their oldest created link (insertion order
  // of the map is already that order); take one link per host per round until
  // the batch is full. Every host gets a slot before any host gets a second
  // one, and the batch is never left under-filled.
  const share = maxBatch
  const take = (hosts: Map<string, Link[]>): Link[] => {
    const picked: Link[] = []
    for (let round = 0; round < share && picked.length < maxBatch; round += 1) {
      for (const list of hosts.values()) {
        if (picked.length >= maxBatch) break
        const link = list[round]
        if (link) picked.push(link)
      }
    }
    return picked
  }
  const ready = new Map<string, Link[]>()
  const spaced = new Map<string, Link[]>()
  for (const [host, list] of byHost) {
    if (waiting.has(host)) spaced.set(host, list)
    else ready.set(host, list)
  }
  const batch = take(ready)
  // The hosts inside a spacing wait only get the batch when nothing else is
  // pending: their links would be deferred by the limiter anyway.
  if (batch.length === 0 && spaced.size > 0) return take(spaced).slice(0, maxBatch)
  return batch.slice(0, maxBatch)
}

/** Load the persisted host states once and check host eligibility. */
export async function eligibleHosts(
  store: Store,
  hosts: string[],
  now: number,
  limitFor: (host: string) => Pick<HostLimit, 'dailyCap' | 'intervalMs'> | undefined,
): Promise<Set<string>> {
  const eligible = new Set<string>()
  for (const host of hosts) {
    const state = await store.getHostState(host)
    if (hostEligible(state, limitFor(host), now).eligible) eligible.add(host)
  }
  return eligible
}
