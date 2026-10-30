/**
 * Pipeline resilience wiring: builds a GuardDeps over the Store, releases
 * due deferred links back to their queues, and applies DEFER outcomes as FSM
 * events. Stages never touch links.state directly; everything goes through
 * applyEvent.
 */
import type { Link, Store } from '../store.js'
import type { LinkStateName } from '../fsm/index.js'
import {
  type Clock,
  type GuardDeps,
  type GuardStatus,
  type HostState,
  type Random,
  type Sleep,
  LLM_KEY,
  emptyHostState,
  guardCheck,
  guardReset,
  guardRun,
  guardStatuses,
  mathRandom,
  realSleep,
  systemClock,
} from '../resilience/index.js'
import { DEFAULT_GUARD_CONFIG, type GuardConfig } from '../resilience/guard.js'
import type { Stage } from './types.js'

export { DEFAULT_GUARD_CONFIG, LLM_KEY }
export type { GuardConfig, GuardDeps, GuardStatus, HostState }

/** True when the host has a saved browser profile (walled garden rules). */
async function hasProfileIn(store: Store, host: string): Promise<boolean> {
  return (await store.getProfile(host)) !== null
}

/** Build GuardDeps over a Store with injectable clock/random/sleep. */
export function guardDepsFromStore(
  store: Store,
  options: {
    config?: Partial<GuardConfig>
    clock?: Clock
    random?: Random
    sleep?: Sleep
  } = {},
): GuardDeps {
  return {
    getHostState: (key) => store.getHostState(key),
    saveHostState: (state) => store.saveHostState(state),
    clock: options.clock ?? systemClock,
    random: options.random ?? mathRandom,
    sleep: options.sleep ?? realSleep,
    config: { ...DEFAULT_GUARD_CONFIG, ...options.config },
    hasProfile: (host) => hasProfileIn(store, host),
  }
}

/** The guard key for a link URL: its host, or `llm` for the enrich stage. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return 'unknown'
  }
}

/**
 * Release deferred links whose nextAttemptAt has passed back to their queue
 * with a RETRY event. Returns the number released. Stages call this before
 * selecting their batch, so a deferred link re-enters exactly on time.
 */
export async function releaseDueDeferred(
  store: Store,
  stage: 'extract' | 'enrich',
  now: Date = new Date(),
): Promise<number> {
  const deferred = await store.listByStates(['deferred'])
  let released = 0
  for (const link of deferred) {
    const state = await store.getState(link.id)
    if (state?.state !== 'deferred') continue
    if (state.stage !== stage) continue
    if (new Date(state.nextAttemptAt).getTime() > now.getTime()) continue
    const outcome = await store.applyEvent(link.id, { type: 'RETRY', stage, at: now.toISOString() })
    if (outcome.ok) released += 1
  }
  return released
}

/**
 * How many attempts a link has already burned.
 *
 * The count lives in the FSM: the `deferred` state carries `attempts`, and
 * every DEFER event is recorded in the link history. The history is the
 * source of truth because a RETRY round trip (deferred -> created) drops the
 * deferred payload, while the events keep the count.
 */
export async function attemptsOf(store: Store, linkId: number): Promise<number> {
  const history = await store.getHistory(linkId)
  let max = 0
  for (const entry of history) {
    if (entry.event !== 'DEFER') continue
    const attempts = Number(entry.data?.['attempts'] ?? 0)
    if (Number.isFinite(attempts) && attempts > max) max = attempts
  }
  return max
}

/**
 * Defer reasons that are pure throttling: the link was never tried, so the
 * deferral must not consume a retry attempt or push the link to errored.
 */
const THROTTLE_REASONS = new Set([
  'spacing',
  'daily_cap',
  'concurrency',
  'rate_limited',
  'human_break',
  'outside_hours',
  'throttled',
])

/** True when the reason is a pure throttle and not a failed attempt. */
export function isThrottleReason(reason: string): boolean {
  return THROTTLE_REASONS.has(reason)
}

export interface DeferDecision {
  /** True when the link was moved to errored (max attempts exhausted). */
  errored: boolean
  nextAttemptAt: string
  attempts: number
}

/**
 * Apply a DEFER to a leased link (extracting/enriching). When the new attempt
 * count reaches maxAttempts the link moves to errored through the FSM:
 * RETRY back to the queue, then EXTRACT_STARTED/ENRICH_STARTED, then the
 * failed event. Returns what happened so the stage can count it.
 */
export async function deferOrError(
  store: Store,
  link: Link,
  stage: 'extract' | 'enrich',
  reason: string,
  retryAfterMs: number,
  maxAttempts: number,
  now: Date,
): Promise<DeferDecision> {
  const at = now.toISOString()
  const prior = await attemptsOf(store, link.id)
  const throttled = isThrottleReason(reason)
  const attempts = throttled ? prior : prior + 1

  // Park the link in deferred first (legal from extracting/enriching).
  await store.applyEvent(link.id, {
    type: 'DEFER',
    stage,
    nextAttemptAt: new Date(now.getTime() + Math.max(0, retryAfterMs)).toISOString(),
    attempts,
    reason,
    at,
  })

  if (!throttled && attempts >= maxAttempts) {
    // Exhausted: walk back to the leased state and fail for good.
    const retryOutcome = await store.applyEvent(link.id, { type: 'RETRY', stage, at })
    if (retryOutcome.ok) {
      const startType = stage === 'extract' ? 'EXTRACT_STARTED' : 'ENRICH_STARTED'
      const failType = stage === 'extract' ? 'EXTRACT_FAILED' : 'ENRICH_FAILED'
      await store.applyEvent(link.id, { type: startType, attempt: attempts, at })
      await store.applyEvent(link.id, {
        type: failType,
        error: `${reason} (max attempts exhausted)`,
        retryable: false,
        attempts,
        at,
      })
      return { errored: true, nextAttemptAt: at, attempts }
    }
  }
  return {
    errored: false,
    nextAttemptAt: new Date(now.getTime() + Math.max(0, retryAfterMs)).toISOString(),
    attempts,
  }
}

export {
  emptyHostState,
  guardCheck,
  guardReset,
  guardRun,
  guardStatuses,
  systemClock,
  mathRandom,
  realSleep,
}
