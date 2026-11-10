/**
 * The host guard: one object per host (or `llm`) that composes the rate
 * limiter, the circuit breaker and retry. Pipeline stages route every fetch
 * through it. A blocked or throttled call never throws: it comes back as a
 * defer decision with a retryAfterMs the stage turns into a DEFER event.
 */
import type { Clock, ErrorSignal, HostState, Random } from './types.js'
import { LLM_KEY, emptyHostState } from './types.js'
import {
  DEFAULT_BREAKER,
  breakerCheck,
  breakerReport,
  breakerReset,
  maybeHalfOpen,
  type BreakerCheck,
  type BreakerDeps,
  type BreakerProfile,
} from './breaker.js'
import {
  DEFAULT_LIMITS,
  DEFAULT_LOGIN_CONFIG,
  hostPolicy,
  limitForHost,
  limiterGate,
  remainingBudget,
  type HostPolicy,
  type LimitsConfig,
  type LimiterDeps,
  type LimiterGate,
  type LoginConfig,
} from './limiter.js'
import { retry, type RetryPolicy, type Sleep } from './retry.js'
import {
  DEFAULT_PACING,
  pacingGate,
  type PacingConfig,
} from './human-pacing.js'

/** The persistence surface the guard needs from the Store. */
export interface HostStateStore {
  getHostState(key: string): Promise<HostState | null>
  saveHostState(state: HostState): Promise<void>
}

export interface GuardConfig {
  limits: LimitsConfig
  breaker: BreakerProfile
  retry: RetryPolicy
  /** Human pacing profile for strict (walled-garden) hosts. */
  pacing?: PacingConfig
  /** Which hosts may be logged in to. Absent means no restriction. */
  login?: LoginConfig
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  limits: DEFAULT_LIMITS,
  breaker: DEFAULT_BREAKER,
  pacing: DEFAULT_PACING,
  login: DEFAULT_LOGIN_CONFIG,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
    factor: 2,
  },
}

export interface GuardDeps extends HostStateStore {
  clock: Clock
  random: Random
  sleep: Sleep
  config: GuardConfig
  /** True when the host has a saved browser profile. */
  hasProfile(host: string): Promise<boolean>
  /** Current in-flight count for a key (per-host concurrency). */
  inFlight?(key: string): number
}

export type GuardOutcome<T> =
  | {
      kind: 'ok'
      value: T
      /** Attempts the retry wrapper made. */
      attempts: number
    }
  | {
      kind: 'defer'
      /** Why the call was not made or failed permanently for now. */
      reason: string
      /** Suggested wait in ms; the stage puts this into nextAttemptAt. */
      retryAfterMs: number
      /** True when the breaker opened (or was open) for this key. */
      breakerOpen: boolean
      attempts: number
    }
  | {
      kind: 'error'
      reason: string
      retryable: boolean
      attempts: number
    }

/** Check whether the key is currently callable (breaker only). */
export async function guardCheck(deps: GuardDeps, key: string): Promise<BreakerCheck> {
  return breakerCheck(breakerDepsOf(deps), key)
}

/**
 * Run one guarded call. The function may throw; throws are classified.
 *
 * Order of checks:
 *  1. breaker open -> defer with the cooldown wait
 *  2. limiter (spacing, daily cap, concurrency) -> defer with the wait
 *  3. run with retry; classified failures feed the breaker, limiter failures
 *     do not (a 429 is a block signal, a full bucket is our own budget)
 */
export async function guardRun<T>(
  deps: GuardDeps,
  key: string,
  fn: () => Promise<T>,
  hooks: { onRetry?: (attempt: number) => void } = {},
): Promise<GuardOutcome<T>> {
  const now = deps.clock()

  // Breaker gate. Half-open transitions are persisted so other processes see
  // the probe window.
  const bDeps = breakerDepsOf(deps)
  let state = (await bDeps.load(key)) ?? emptyHostState(key)
  const flipped = maybeHalfOpen(state, now)
  if (flipped !== state) {
    state = flipped
    await bDeps.save(state)
  }
  if (state.breakerState === 'open') {
    const until = state.openedUntil ?? now
    return {
      kind: 'defer',
      reason: 'breaker_open',
      retryAfterMs: Math.max(0, until - now),
      breakerOpen: true,
      attempts: 0,
    }
  }

  // Limiter gate.
  const gate = await limiterGate(limiterDepsOf(deps), key)
  if (!gate.admitted) {
    return {
      kind: 'defer',
      reason: gate.reason ?? 'throttled',
      retryAfterMs: gate.waitMs,
      breakerOpen: false,
      attempts: 0,
    }
  }

  // Run with retry. Every failed attempt is reported to the breaker right
  // away, so a hard block opens it on the first failure and the rest of the
  // batch stops hammering the upstream. Retry-After from a 429 flows through
  // the classifier into the backoff.
  const outcome = await retry(fn, {
    ...deps.config.retry,
    clock: deps.clock,
    random: deps.random,
    sleep: deps.sleep,
    onRetry: ({ attempt, signal }) => {
      hooks.onRetry?.(attempt)
      if (signal.block) void breakerReport(bDeps, key, 'failure', signal)
    },
  })

  if (outcome.ok) {
    await breakerReport(bDeps, key, 'success', null)
    return { kind: 'ok', value: outcome.value as T, attempts: outcome.attempts }
  }

  const signal = outcome.error as ErrorSignal
  const report = await breakerReport(bDeps, key, 'failure', signal)
  if (signal.block || report.tripped) {
    return {
      kind: 'defer',
      reason: signal.block ? `blocked:${signal.reason}` : `breaker_open:${signal.reason}`,
      retryAfterMs: Math.max(signal.retryAfterMs ?? 0, report.state.openedUntil !== null ? Math.max(0, report.state.openedUntil - now) : 0),
      breakerOpen: true,
      attempts: outcome.attempts,
    }
  }
  return {
    kind: 'error',
    reason: signal.reason,
    retryable: signal.retryable,
    attempts: outcome.attempts,
  }
}

/** Force-close the breaker for a key (CLI `breaker reset`). */
export function guardReset(deps: GuardDeps, key: string): Promise<HostState> {
  return breakerReset(breakerDepsOf(deps), key)
}

/** Per-key status row for `atento status` and the limits_status tool. */
export interface GuardStatus {
  key: string
  breakerState: HostState['breakerState']
  reopensAt: string | null
  dailyCap: number | 'unlimited'
  remainingToday: number
  lastRequestAt: string | null
  consecutiveFailures: number
  lastError: string | null
  /** Canary trial outcome for this host. */
  trialState: HostState['trialState']
  /** Why the host was flagged. */
  trialReason: string | null
  /** When the upstream "slow down" signal expires. */
  rateLimitedUntil: string | null
  /** The shared host policy (skip, strict, browser routing). */
  policy: HostPolicy
}

/** Build the status row for every tracked key. */
export async function guardStatuses(
  deps: GuardDeps,
  keys: string[],
): Promise<GuardStatus[]> {
  const now = deps.clock()
  const out: GuardStatus[] = []
  for (const key of keys) {
    const hasProfile = key !== LLM_KEY ? await deps.hasProfile(key) : false
    const state = (await deps.getHostState(key)) ?? emptyHostState(key)
    const limit = limitForHost(deps.config.limits, key, hasProfile, state.trialState, state.loginGated)
  const remaining = remainingBudget(state, limit, now)
  const policy = key !== LLM_KEY
    ? hostPolicy(deps.config.limits, key, { hasProfile, trialState: state.trialState, loginGated: state.loginGated })
    : { strict: false, browser: false, skipped: false, reviewOnly: false, reason: null }
  out.push({
    key,
    breakerState: state.breakerState,
    reopensAt: state.breakerState === 'open' && state.openedUntil !== null
      ? new Date(state.openedUntil).toISOString()
      : null,
    dailyCap: Number.isFinite(limit.dailyCap) ? limit.dailyCap : 'unlimited',
    remainingToday: remaining === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : remaining,
    lastRequestAt: state.lastRequestAt !== null ? new Date(state.lastRequestAt).toISOString() : null,
    consecutiveFailures: state.consecutiveFailures,
    lastError: state.lastError,
    trialState: state.trialState,
    trialReason: state.trialReason,
    rateLimitedUntil: state.rateLimitedUntil !== null ? new Date(state.rateLimitedUntil).toISOString() : null,
    policy,
  })
  }
  return out
}

function breakerDepsOf(deps: GuardDeps): BreakerDeps {
  return {
    load: (key) => deps.getHostState(key),
    save: (state) => deps.saveHostState(state),
    clock: deps.clock,
    profile: deps.config.breaker,
  }
}

function limiterDepsOf(deps: GuardDeps): Parameters<typeof limiterGate>[0] {
  return {
    load: (key) => deps.getHostState(key),
    save: (state) => deps.saveHostState(state),
    clock: deps.clock,
    random: deps.random,
    config: deps.config.limits,
    hasProfile: (host) => deps.hasProfile(host),
    pacing: deps.config.pacing,
  }
}

export { hostPolicy, isWalledGarden } from './limiter.js'

/** Convenience re-exports for surfaces. */
export type { ErrorSignal, HostState, LimiterGate }
