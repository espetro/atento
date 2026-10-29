/**
 * Circuit breaker: closed, open, half-open, one breaker per key (host or
 * `llm`). The breaker is pure: all state lives in a HostState record loaded
 * from and saved to the Store, so budget survives across CLI runs and shared
 * server/MCP processes.
 *
 * Open triggers: N consecutive failures, or any hard block signal (429, 403,
 * 999, captcha, login wall, "unusual activity"). Cooldown grows
 * exponentially: base * factor^level, capped. The default profile is
 * configured for walled gardens (6 hours doubling to 48 hours).
 */
import { type Clock, type ErrorSignal, type HostState, emptyHostState } from './types.js'

export interface BreakerProfile {
  /** Consecutive failures that trip the breaker. Default 5. */
  failureThreshold: number
  /** Base cooldown in ms. */
  baseCooldownMs: number
  /** Cooldown multiplier per level. */
  factor: number
  /** Hard cap for a single cooldown. */
  maxCooldownMs: number
  /** Maximum accumulated cooldown level (keeps openedUntil sane). */
  maxLevel: number
}

export const WALLED_GARDEN_BREAKER: BreakerProfile = {
  failureThreshold: 3,
  baseCooldownMs: 6 * 60 * 60 * 1000,
  factor: 2,
  maxCooldownMs: 48 * 60 * 60 * 1000,
  maxLevel: 12,
}

export const LLM_BREAKER: BreakerProfile = {
  failureThreshold: 3,
  baseCooldownMs: 30 * 1000,
  factor: 2,
  maxCooldownMs: 10 * 60 * 1000,
  maxLevel: 8,
}

export const DEFAULT_BREAKER: BreakerProfile = {
  failureThreshold: 5,
  baseCooldownMs: 60 * 1000,
  factor: 2,
  maxCooldownMs: 30 * 60 * 1000,
  maxLevel: 10,
}

/** The cooldown for the current level, capped. */
export function cooldownForLevel(profile: BreakerProfile, level: number): number {
  const clamped = Math.min(Math.max(0, level), profile.maxLevel)
  return Math.min(profile.maxCooldownMs, profile.baseCooldownMs * Math.pow(profile.factor, clamped))
}

/**
 * True when the breaker is open and not yet allowed to probe. The state may
 * flip to half-open inside the breaker when `now` has passed `openedUntil`,
 * and the caller persists the flipped state.
 */
export function isBlocked(state: HostState, profile: BreakerProfile, now: number): boolean {
  if (state.breakerState !== 'open') return false
  if (state.openedUntil !== null && now >= state.openedUntil) {
    // Probe window: the caller marks the state half-open and runs one call.
    return false
  }
  void profile
  return true
}

/** When the breaker opened, in ms, or the probe deadline. */
export function reopensAt(state: HostState): number | null {
  return state.openedUntil
}

/**
 * Record an outcome on the breaker. Returns a possibly-mutated state (the
 * input is copied) and `tripped` when the breaker opened with this outcome.
 */
export function recordOutcome(
  state: HostState,
  outcome: 'success' | 'failure',
  signal: ErrorSignal | null,
  profile: BreakerProfile,
  now: number,
): { state: HostState; tripped: boolean } {
  const next = { ...state }
  let tripped = false

  if (state.breakerState === 'half_open') {
    if (outcome === 'success') {
      // Probe succeeded: close the breaker and reset the cooldown level.
      next.breakerState = 'closed'
      next.consecutiveFailures = 0
      next.cooldownLevel = 0
      next.openedUntil = null
      next.lastError = null
    } else {
      // Probe failed: reopen, one level deeper.
      next.breakerState = 'open'
      next.cooldownLevel = Math.min(state.cooldownLevel + 1, profile.maxLevel)
      next.openedUntil = now + cooldownForLevel(profile, next.cooldownLevel)
      next.lastError = signal?.reason ?? 'probe_failed'
      tripped = true
    }
    return { state: next, tripped }
  }

  if (outcome === 'success') {
    next.consecutiveFailures = 0
    next.lastError = null
    if (state.breakerState === 'open') {
      // Should not happen: an open breaker admits no calls. Close defensively.
      next.breakerState = 'closed'
      next.openedUntil = null
    }
    return { state: next, tripped }
  }

  next.consecutiveFailures = state.consecutiveFailures + 1
  next.lastError = signal?.reason ?? 'failure'

  // A hard block opens immediately, even below the failure threshold.
  if (signal?.block === true || next.consecutiveFailures >= profile.failureThreshold) {
    const level = signal?.block === true
      ? Math.min(state.cooldownLevel + 1, profile.maxLevel)
      : state.cooldownLevel
    next.breakerState = 'open'
    next.cooldownLevel = level
    next.openedUntil = now + cooldownForLevel(profile, level)
    next.consecutiveFailures = signal?.block === true ? 0 : next.consecutiveFailures
    tripped = true
  }
  return { state: next, tripped }
}

/**
 * Move an open breaker whose cooldown has elapsed into half_open so exactly
 * one probe may run. No-op when the breaker is not open or the cooldown has
 * not elapsed.
 */
export function maybeHalfOpen(state: HostState, now: number): HostState {
  if (state.breakerState !== 'open') return state
  if (state.openedUntil === null || now < state.openedUntil) return state
  return { ...state, breakerState: 'half_open' }
}

export interface BreakerDeps {
  load(key: string): Promise<HostState | null>
  save(state: HostState): Promise<void>
  clock: Clock
  profile: BreakerProfile
}

export interface BreakerCheck {
  /** True when the breaker is open. */
  blocked: boolean
  /** When the breaker reopens for probes (ms). */
  reopensAt: number | null
  /** When blocked, how long to wait before the next probe (ms). */
  waitMs: number
}

/** Check whether the breaker currently admits a call for `key`. */
export async function breakerCheck(deps: BreakerDeps, key: string): Promise<BreakerCheck> {
  const now = deps.clock()
  let state = (await deps.load(key)) ?? emptyHostState(key)
  state = maybeHalfOpen(state, now)
  if (state.breakerState !== (await deps.load(key))?.breakerState) {
    await deps.save(state)
  }
  if (state.breakerState === 'open') {
    const until = state.openedUntil ?? now
    return { blocked: true, reopensAt: state.openedUntil, waitMs: Math.max(0, until - now) }
  }
  return { blocked: false, reopensAt: null, waitMs: 0 }
}

export interface BreakerReportOutcome {
  /** True when this outcome tripped (or re-tripped) the breaker. */
  tripped: boolean
  state: HostState
}

/** Record a success or a classified failure for `key` and persist it. */
export async function breakerReport(
  deps: BreakerDeps,
  key: string,
  outcome: 'success' | 'failure',
  signal: ErrorSignal | null,
): Promise<BreakerReportOutcome> {
  const now = deps.clock()
  const current = (await deps.load(key)) ?? emptyHostState(key)
  const { state, tripped } = recordOutcome(current, outcome, signal, deps.profile, now)
  await deps.save(state)
  return { tripped, state }
}

/** Force-close a breaker (CLI `breaker reset`). */
export async function breakerReset(deps: BreakerDeps, key: string): Promise<HostState> {
  const now = deps.clock()
  const current = (await deps.load(key)) ?? emptyHostState(key)
  const state: HostState = {
    ...current,
    breakerState: 'closed',
    consecutiveFailures: 0,
    openedUntil: null,
    cooldownLevel: 0,
    lastError: null,
    lastRequestAt: current.lastRequestAt ?? now,
  }
  await deps.save(state)
  return state
}
