/**
 * Rate limiter: per-host token-bucket spacing with jitter, a daily cap and a
 * concurrency ceiling. The limiter is pure: all state lives in HostState
 * records persisted through the Store, so budget is shared across CLI runs,
 * the server and MCP.
 *
 * Spacing rule: consecutive requests to the same host are at least
 * `intervalMs` apart, where the effective interval is the configured value
 * jittered by up to +/- 30 percent. On top of spacing, a host may admit at
 * most `dailyCap` requests per rolling calendar day. A host whose saved
 * browser profile exists or which matches the walled-garden list gets the
 * conservative profile by default.
 */
import {
  type Clock,
  type HostState,
  type Random,
  LLM_KEY,
  WALLED_GARDENS,
  emptyHostState,
  mathRandom,
  systemClock,
} from './types.js'

export interface HostLimit {
  /** Minimum ms between requests to this host. */
  intervalMs: number
  /** Maximum requests per rolling calendar day. */
  dailyCap: number
  /** Max in-flight requests to this host. */
  concurrency: number
}

export const WALLED_GARDEN_LIMIT: HostLimit = {
  intervalMs: 45_000,
  dailyCap: 40,
  concurrency: 1,
}

export const ORDINARY_LIMIT: HostLimit = {
  intervalMs: 2_000,
  dailyCap: Number.POSITIVE_INFINITY,
  concurrency: 4,
}

export const LLM_LIMIT: HostLimit = {
  intervalMs: 0,
  dailyCap: Number.POSITIVE_INFINITY,
  concurrency: 3,
}

/** Default global cap on in-flight requests across all hosts. */
export const GLOBAL_CONCURRENCY = 8

/** Default cap on how many links one extract/enrich call processes. */
export const DEFAULT_MAX_BATCH = 20

export interface LimitsConfig {
  /** Global in-flight cap. */
  globalConcurrency: number
  /** Cap on links per extract/enrich call. */
  maxBatch: number
  /** Concurrency override for the llm key. */
  llmConcurrency: number
  /** Hosts treated as walled gardens (config and defaults merged). */
  walledGardens: string[]
  /** Per-host overrides keyed by host, e.g. from `[limits.hosts."x.com"]`. */
  hosts: Record<string, Partial<HostLimit>>
}

export const DEFAULT_LIMITS: LimitsConfig = {
  globalConcurrency: GLOBAL_CONCURRENCY,
  maxBatch: DEFAULT_MAX_BATCH,
  llmConcurrency: LLM_LIMIT.concurrency,
  walledGardens: [...WALLED_GARDENS],
  hosts: {},
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Jitter band applied to the spacing interval, as a fraction. */
const JITTER_FRACTION = 0.3

export function isWalledGarden(config: LimitsConfig, host: string, hasProfile: boolean): boolean {
  return hasProfile || config.walledGardens.includes(host)
}

/** The effective limit for a host after config merges. */
export function limitForHost(
  config: LimitsConfig,
  host: string,
  hasProfile: boolean,
): HostLimit {
  if (host === LLM_KEY) {
    return { ...LLM_LIMIT, concurrency: config.llmConcurrency }
  }
  const base = isWalledGarden(config, host, hasProfile) ? WALLED_GARDEN_LIMIT : ORDINARY_LIMIT
  const override = config.hosts[host]
  if (override === undefined) return base
  return {
    intervalMs: override.intervalMs ?? base.intervalMs,
    dailyCap: override.dailyCap ?? base.dailyCap,
    concurrency: override.concurrency ?? base.concurrency,
  }
}

/**
 * The jittered interval: uniform in [interval * 0.7, interval * 1.3]. The
 * limiter recomputes this per check with the injected random, which spreads
 * request times without ever dropping below the safe minimum for hard
 * minimums the caller passes through `minIntervalMs`.
 */
export function jitteredInterval(intervalMs: number, random: Random): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0
  const spread = intervalMs * JITTER_FRACTION
  return Math.max(0, intervalMs - spread + random() * spread * 2)
}

/**
 * The deterministic floor: the smallest interval the limiter will ever
 * enforce for a request.
 */
export function minIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0
  return intervalMs * (1 - JITTER_FRACTION)
}

export type GateVerdict =
  | {
      admitted: true
      /** The updated state to persist. */
      state: HostState
    }
  | {
      admitted: false
      /** How long to wait before the next allowed request (ms). */
      waitMs: number
      reason: 'spacing' | 'daily_cap' | 'concurrency'
      /** When the daily window resets (daily_cap only). */
      windowResetsAt?: number
      state: HostState
    }

/**
 * Decide whether a request to `host` may go out now. Pure: takes a HostState
 * and returns the verdict plus the state to persist. `inFlight` is the
 * number of requests to this host currently running.
 */
export function gateHost(
  state: HostState,
  limit: HostLimit,
  now: number,
  inFlight: number,
  random: Random = mathRandom,
  keyOverride?: string,
): GateVerdict {
  const key = keyOverride ?? state.key
  const next: HostState = { ...state, key }

  // Concurrency: never exceed the per-host in-flight cap.
  if (inFlight >= limit.concurrency) {
    return { admitted: false, waitMs: retrySpacing(state, limit, now, random).waitMs, reason: 'concurrency', state: next }
  }

  // Daily cap on a rolling calendar day window.
  const windowStart = state.windowStart
  if (windowStart === null || now - windowStart >= DAY_MS) {
    next.windowStart = now
    next.windowCount = 0
  }
  if (Number.isFinite(limit.dailyCap) && next.windowCount >= limit.dailyCap) {
    const resetsAt = (next.windowStart ?? now) + DAY_MS
    return {
      admitted: false,
      waitMs: Math.max(0, resetsAt - now),
      reason: 'daily_cap',
      windowResetsAt: resetsAt,
      state: next,
    }
  }

  // Spacing: jittered minimum interval between requests.
  const spacing = retrySpacing(state, limit, now, random)
  if (spacing.waitMs > 0) {
    return { admitted: false, waitMs: spacing.waitMs, reason: 'spacing', state: next }
  }

  next.lastRequestAt = now
  next.windowCount = next.windowCount + 1
  return { admitted: true, state: next }
}

/** How long to wait before the spacing rule admits another request. */
function retrySpacing(
  state: HostState,
  limit: HostLimit,
  now: number,
  random: Random,
): { waitMs: number } {
  if (state.lastRequestAt === null || limit.intervalMs <= 0) return { waitMs: 0 }
  const interval = jitteredInterval(limit.intervalMs, random)
  return { waitMs: Math.max(0, state.lastRequestAt + interval - now) }
}

export interface LimiterDeps {
  load(key: string): Promise<HostState | null>
  save(state: HostState): Promise<void>
  clock: Clock
  random: Random
  config: LimitsConfig
  /** True when the host has a saved browser profile (walled garden). */
  hasProfile(host: string): Promise<boolean>
}

export interface LimiterGate {
  admitted: boolean
  waitMs: number
  reason?: 'spacing' | 'daily_cap' | 'concurrency'
  windowResetsAt?: number
  state?: HostState
}

/**
 * Gate a request through the limiter, persisting the admitted state. This
 * runs the gate once: it never sleeps. When not admitted, the caller defers
 * the work by `waitMs`.
 */
export async function limiterGate(deps: LimiterDeps, key: string): Promise<LimiterGate> {
  const now = deps.clock()
  const hasProfile = key !== LLM_KEY ? await deps.hasProfile(key) : false
  const limit = limitForHost(deps.config, key, hasProfile)
  const state = (await deps.load(key)) ?? emptyHostState(key)
  const verdict = gateHost(state, limit, now, 0, deps.random)
  if (verdict.admitted) {
    await deps.save(verdict.state)
    return { admitted: true, waitMs: 0, state: verdict.state }
  }
  return {
    admitted: false,
    waitMs: verdict.waitMs,
    reason: verdict.reason,
    windowResetsAt: verdict.windowResetsAt,
  }
}

/** Remaining daily budget for a key, for `linkinbox status`. */
export function remainingBudget(state: HostState, limit: HostLimit, now: number): number {
  if (!Number.isFinite(limit.dailyCap)) return Number.POSITIVE_INFINITY
  if (state.windowStart === null || now - state.windowStart >= DAY_MS) return limit.dailyCap
  return Math.max(0, limit.dailyCap - state.windowCount)
}
