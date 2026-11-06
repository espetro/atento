/**
 * Reconcile the parked links with the current host policy.
 *
 * The config changes over time: a host that was parked behind a login wall
 * can end up on the skip list (it must be discarded), and a host that was
 * parked for a login can end up review-only (the owner reviews it by hand).
 * The sweep runs at the start of every extract run and moves the existing
 * rows to the state the current policy asks for.
 *
 * The sweep is idempotent: a link that is already in the right state is left
 * alone, so running it twice changes nothing.
 */
import type { Store } from '../store.js'
import type { Link } from '../types.js'
import { hostPolicy, type LimitsConfig } from '../resilience/index.js'
import { hostOf } from './resilience.js'
import { SKIP_HOST_REASON, REVIEW_ONLY_REASON } from './extract.js'

/** What the sweep changed. */
export interface ReconcileResult {
  /** Links moved to `discarded` because their host is now skip-listed. */
  discarded: number
  /** Links whose parked reason became `review_only`. */
  reviewOnly: number
}

export interface ReconcileOptions {
  /** The current limits: the skip list and the review list. */
  limits: LimitsConfig
  /** The `[login] allow` patterns. Empty means no restriction. */
  loginAllow?: string[]
  /** The clock. */
  now: Date
}

/**
 * Move the links parked in `needs_browser` to the state the current host
 * policy asks for.
 *
 * A skip-listed host is discarded through the same path the extract stage
 * uses for a skipped link (LEASE_EXPIRED then TRIAGE discard), so the row
 * looks exactly like a link that was skipped when it was first processed.
 * A review-only host keeps its link but the parked reason becomes
 * `review_only`.
 */
export async function reconcileParkedLinks(
  store: Store,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { discarded: 0, reviewOnly: 0 }
  const parked = await store.listByStates(['needs_browser'])
  for (const link of parked) {
    const host = hostOf(link.url)
    if (host === '' || host === 'unknown') continue
    const state = await store.getHostState(host)
    const hasProfile = (await store.getProfile(host)) !== null
    const policy = hostPolicy(options.limits, host, {
      hasProfile,
      trialState: state?.trialState ?? 'unknown',
      loginGated: state?.loginGated ?? false,
      loginAllow: options.loginAllow,
    })
    if (policy.skipped) {
      if (await discardParkedLink(store, link, options.now)) result.discarded += 1
      continue
    }
    if (policy.reviewOnly) {
      if (await markReviewOnly(store, link, options.now)) result.reviewOnly += 1
    }
  }
  return result
}

/**
 * Discard a parked link through the FSM: `needs_browser` goes back to the
 * queue with RETRY and then to `discarded` with a TRIAGE event. The outcome
 * is the same as a link the skip branch parks while leased (LEASE_EXPIRED
 * then TRIAGE): state `discarded`, expiry reason `skip_host`. Returns true
 * when the link moved.
 */
async function discardParkedLink(
  store: Store,
  link: Link,
  now: Date,
): Promise<boolean> {
  const at = now.toISOString()
  const requeued = await store.applyEvent(link.id, { type: 'RETRY', stage: 'extract', at })
  if (!requeued.ok) return false
  const discarded = await store.applyEvent(link.id, {
    type: 'TRIAGE',
    action: 'discard',
    at,
  })
  if (!discarded.ok) return false
  await store.setExpiry(link.id, null, SKIP_HOST_REASON, now)
  return true
}

/**
 * Mark a parked link as review-only: the reason in its state data becomes
 * `review_only`. Returns true when the reason changed.
 */
async function markReviewOnly(
  store: Store,
  link: Link,
  now: Date,
): Promise<boolean> {
  const reason = link.stateData?.['reason']
  if (reason === REVIEW_ONLY_REASON) return false
  const host = hostOf(link.url)
  // NEEDS_BROWSER is only legal from the leased states, so a parked link
  // gets its reason rewritten through the store's state payload instead.
  await store.setStateData(link.id, { host, reason: REVIEW_ONLY_REASON })
  await store.setExpiry(link.id, null, REVIEW_ONLY_REASON, now)
  return true
}
