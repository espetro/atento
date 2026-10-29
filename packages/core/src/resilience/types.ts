/**
 * Resilience primitives: injected clock and random so tests use a fake clock
 * and never really sleep, plus the persisted host-state record shared by the
 * rate limiter and the circuit breaker across processes.
 */

/** Monotonic-ish wall clock in ms. Injected; tests pass a fake. */
export type Clock = () => number

/** Uniform [0, 1). Injected; tests pass a deterministic fake. */
export type Random = () => number

export const systemClock: Clock = () => Date.now()
export const mathRandom: Random = () => Math.random()

/** Breaker state as persisted per host. */
export type BreakerStateName = 'closed' | 'open' | 'half_open'

/**
 * The canary trial outcome for a host.
 *
 * `unknown`: the host was never probed. The first link of the host is the
 * canary and decides the outcome.
 * `open`: the canary succeeded, the host behaves normally.
 * `flagged`: the canary was rate limited or blocked, the host gets the
 * conservative (walled-garden) limits until the flag expires.
 */
export type HostTrialState = 'unknown' | 'open' | 'flagged'

/**
 * One row of the host_state table. Keyed by host or by the reserved key
 * `llm` for the enrichment gateway. The limiter and breaker load and save
 * through this record so CLI runs, the server and MCP share budget.
 */
export interface HostState {
  key: string
  /** Last admitted request (ms epoch). */
  lastRequestAt: number | null
  /** Start of the current daily window (ms epoch). */
  windowStart: number | null
  /** Requests admitted in the current daily window. */
  windowCount: number
  /** Consecutive failures feeding the breaker. */
  consecutiveFailures: number
  breakerState: BreakerStateName
  /** When an open breaker may admit a probe (ms epoch). */
  openedUntil: number | null
  /** Exponential cooldown level (0-based); grows per re-open. */
  cooldownLevel: number
  lastError: string | null
  /** Canary trial outcome for this host. */
  trialState: HostTrialState
  /** Why the host was flagged (rate limit, challenge, login wall). */
  trialReason: string | null
  /** When the trial was recorded (ms epoch). */
  trialAt: number | null
  /** True when the host answered with a login wall. */
  loginGated: boolean
  /** The upstream asked us to slow down until this time (ms epoch). */
  rateLimitedUntil: number | null
  /** Pages served since the last long human-pacing break. */
  pagesSinceBreak?: number
  /** Pages after which the next long human-pacing break is due. */
  breakEvery?: number
}

export function emptyHostState(key: string): HostState {
  return {
    key,
    lastRequestAt: null,
    windowStart: null,
    windowCount: 0,
    consecutiveFailures: 0,
    breakerState: 'closed',
    openedUntil: null,
    cooldownLevel: 0,
    lastError: null,
    trialState: 'unknown',
    trialReason: null,
    trialAt: null,
    loginGated: false,
    rateLimitedUntil: null,
  }
}

/** Classification of a failed upstream call. */
export interface ErrorSignal {
  /** True when the call may be retried with backoff. */
  retryable: boolean
  /** True when this is a hard block: the breaker must open immediately. */
  block: boolean
  /** Server-suggested wait in ms (Retry-After). */
  retryAfterMs?: number
  /** Short human-readable reason, persisted in host_state.last_error. */
  reason: string
}

/** Anything the classifier understands: a status code or an Error. */
export type UpstreamError = { status?: number; code?: string; message?: string } | Error

export const LLM_KEY = 'llm'
