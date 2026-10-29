/**
 * Canary probing: how a host is classified as rate limited.
 *
 * There is no hardcoded list of walled gardens. Instead every host is probed
 * by trial: the FIRST link seen for a host is the canary. It is processed
 * alone. When it succeeds the host is marked `open` and the remaining links
 * of that host run under the ordinary limits. When the canary is rate
 * limited or blocked (HTTP 429, a 403 challenge, LinkedIn 999, a login wall
 * or a breaker trip) the host is marked `flagged`: the strict walled-garden
 * limits apply and the remaining links of that host are deferred instead of
 * hammering it.
 *
 * The trial state lives in the `host_state` table, so it survives restarts.
 * A flagged host expires with the breaker reopen time: when the flag is
 * older than the cooldown the host is re-trialed.
 */
import { type Clock, type HostState, type HostTrialState } from './types.js'
import { emptyHostState } from './types.js'
import { cooldownForLevel, type BreakerProfile } from './breaker.js'

/** How long a flag survives before the host is re-trialed. */
export const DEFAULT_FLAG_TTL_MS = 24 * 60 * 60 * 1000

/** The persisted per-host trial state, derived from the host_state row. */
export interface HostTrial {
  host: string
  state: HostTrialState
  /** Why the host was flagged, e.g. `http_429` or `login_wall`. */
  reason: string | null
  /** When the trial was recorded (ms epoch). */
  at: number | null
  /** True when the host answered with a login wall. */
  loginGated: boolean
  /** True while the flag is still valid and the host must not be hammered. */
  active: boolean
}

/** Read the trial state of a host from its host_state row. */
export function trialOf(state: HostState | null, now: number, ttlMs = DEFAULT_FLAG_TTL_MS): HostTrial {
  if (!state) {
    return {
      host: '',
      state: 'unknown',
      reason: null,
      at: null,
      loginGated: false,
      active: false,
    }
  }
  const expired =
    state.trialState === 'flagged' &&
    state.trialAt !== null &&
    now - state.trialAt >= ttlMs
  return {
    host: state.key,
    state: expired ? 'unknown' : state.trialState,
    reason: expired ? null : state.trialReason,
    at: expired ? null : state.trialAt,
    loginGated: state.loginGated,
    active: !expired && state.trialState === 'flagged',
  }
}

/** The trial state of a host, honouring the flag expiry. */
export function trialStateOf(
  state: HostState | null,
  now: number,
  ttlMs = DEFAULT_FLAG_TTL_MS,
): HostTrialState {
  return trialOf(state, now, ttlMs).state
}

/**
 * Record a successful canary: the host behaves normally.
 */
export function markOpen(state: HostState, now: number): HostState {
  return {
    ...state,
    trialState: 'open',
    trialReason: null,
    trialAt: now,
  }
}

/**
 * Record a flagged canary: the host is rate limited or blocked. The flag
 * expires after `ttlMs`, so the host is re-trialed later.
 */
export function markFlagged(
  state: HostState,
  now: number,
  reason: string,
  options: { loginGated?: boolean; ttlMs?: number } = {},
): HostState {
  const ttlMs = options.ttlMs ?? DEFAULT_FLAG_TTL_MS
  void ttlMs
  return {
    ...state,
    trialState: 'flagged',
    trialReason: reason,
    trialAt: now,
    loginGated: options.loginGated === true || state.loginGated,
  }
}

/**
 * True when the host must be probed with the canary: the trial state is
 * unknown (never probed) or the flag expired.
 */
export function needsCanary(state: HostState | null, now: number, ttlMs = DEFAULT_FLAG_TTL_MS): boolean {
  return trialStateOf(state, now, ttlMs) === 'unknown'
}

/**
 * The moment a flagged host may be re-trialed: the later of the flag expiry
 * and the breaker reopen time.
 */
export function retrialAt(
  state: HostState | null,
  now: number,
  ttlMs = DEFAULT_FLAG_TTL_MS,
): number | null {
  if (!state || state.trialState !== 'flagged' || state.trialAt === null) return null
  const flagExpiry = state.trialAt + ttlMs
  const breakerReopen = state.openedUntil ?? 0
  return Math.max(flagExpiry, breakerReopen)
}

/**
 * The cooldown used for a flagged host. Reuses the walled-garden breaker
 * profile so the reopen time matches the strict limits.
 */
export function flagCooldownMs(profile: BreakerProfile, level: number): number {
  return cooldownForLevel(profile, level)
}

export { emptyHostState }
