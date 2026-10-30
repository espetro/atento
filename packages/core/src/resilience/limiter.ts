/**
 * Rate limiter: per-host token-bucket spacing with jitter, a daily cap and a
 * concurrency ceiling. The limiter is pure: all state lives in HostState
 * records persisted through the Store, so budget is shared across CLI runs,
 * the server and MCP.
 *
 * Spacing rule: consecutive requests to the same host are at least
 * `intervalMs` apart, where the effective interval is the configured value
 * jittered by up to +/- 30 percent. On top of spacing, a host may admit at
 * most `dailyCap` requests per rolling calendar day.
 *
 * There is no hardcoded list of walled gardens. A host gets the strict
 * profile when the config lists it, when the canary probe flagged it, when
 * it is login gated, or when it has a saved browser profile. The policy is
 * decided by `hostPolicy`, the single source of truth shared with the router.
 */
import {
  type Clock,
  type HostState,
  type Random,
  LLM_KEY,
  emptyHostState,
  mathRandom,
  systemClock,
} from './types.js'
import {
  DEFAULT_PACING,
  OUTSIDE_HOURS_REASON,
  pacingGate,
  type PacingConfig,
} from './human-pacing.js'

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
  /**
   * Manual walled-garden override: listed hosts are FORCED onto the strict
   * limits and browser routing. Ships empty by default; walled gardens are
   * discovered by canary probing, not hardcoded.
   */
  walledGardens: string[]
  /**
   * Hosts that are never fetched. Exact host (`gemini.google.com`) or a
   * `*.suffix` wildcard (`*.duckduckgo.com` matches every subdomain too when
   * the bare suffix is listed? No: the bare suffix must be listed itself).
   *
   * The match runs against the hostname without the port, so `localhost`
   * matches `http://localhost:3000/x`. Loopback hosts are skipped by
   * default anyway (see `isLoopbackHost`).
   */
  skipHosts: string[]
  /**
   * Hosts that are never fetched either, but whose links stay VISIBLE: the
   * extract stage parks them in `needs_browser` with the reason
   * `review_only`, so the owner reviews them by hand. Same pattern syntax as
   * `skipHosts`. Ships empty.
   */
  reviewHosts: string[]
  /** Per-host overrides keyed by host, e.g. from `[limits.hosts."x.com"]`. */
  hosts: Record<string, Partial<HostLimit>>
  /** When true, the pipeline skips the limiter and the breaker entirely. */
  disabled?: boolean
}

/**
 * The `[login]` table: which hosts the pipeline may log in to.
 *
 * `allow` holds host patterns with the same syntax as `skip_hosts` (exact
 * host or `*.suffix`). When it is empty or absent every login-walled host
 * behaves as before. When it is set, a login-walled host that is neither
 * allowed nor backed by a saved profile is REVIEW-ONLY: no browser is ever
 * attempted for it and its links stay visible for the owner to read.
 */
export interface LoginConfig {
  /** Host patterns the pipeline may log in to. Empty means "no restriction". */
  allow: string[]
}

export const DEFAULT_LOGIN_CONFIG: LoginConfig = {
  allow: [],
}

export const DEFAULT_LIMITS: LimitsConfig = {
  globalConcurrency: GLOBAL_CONCURRENCY,
  maxBatch: DEFAULT_MAX_BATCH,
  llmConcurrency: LLM_LIMIT.concurrency,
  walledGardens: [],
  skipHosts: [],
  reviewHosts: [],
  hosts: {},
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Jitter band applied to the spacing interval, as a fraction. */
const JITTER_FRACTION = 0.3

/** How a host is policed. One shared decision for the router and the limiter. */
export type HostPolicy = {
  /** True when the host gets the strict (walled-garden) limits. */
  strict: boolean
  /** True when the host must be routed to the browser extractor. */
  browser: boolean
  /** True when links on this host are never fetched (skip-listed). */
  skipped: boolean
  /**
   * True when the host must not be fetched either, but its links stay
   * visible for the owner to review by hand (`needs_browser`, reason
   * `review_only`).
   */
  reviewOnly: boolean
  /** Why the policy applies (skip-list, config override, canary flag, profile). */
  reason: string | null
}

/**
 * The single source of truth for a host's policy. The router injects this
 * (via the pipeline) and the limiter calls it, so both surfaces agree.
 *
 * `trial` is the persisted canary outcome, `hasProfile` whether a browser
 * login profile exists.
 */
export function hostPolicy(
  config: LimitsConfig,
  host: string,
  options: {
    hasProfile?: boolean
    trialState?: HostState['trialState']
    loginGated?: boolean
    /**
     * The `[login] allow` patterns. When they are set, a login-walled host
     * that is neither allowed nor backed by a saved profile is review-only.
     */
    loginAllow?: string[]
  } = {},
): HostPolicy {
  if (matchesPattern(config.skipHosts, host) || isLoopbackHost(host)) {
    return { strict: false, browser: false, skipped: true, reviewOnly: false, reason: 'skip_list' }
  }
  if (matchesPattern(config.reviewHosts, host)) {
    return { strict: false, browser: false, skipped: false, reviewOnly: true, reason: 'review_only' }
  }
  if (config.walledGardens.includes(host)) {
    return { strict: true, browser: true, skipped: false, reviewOnly: false, reason: 'config_override' }
  }
  if (options.trialState === 'flagged') {
    return { strict: true, browser: false, skipped: false, reviewOnly: false, reason: 'canary_flagged' }
  }
  if (options.loginGated === true) {
    // A login-gated host the owner never allowed to log in to is review-only:
    // no browser is attempted for it, the links stay visible.
    if (!loginAllowed(options.loginAllow, host, options.hasProfile === true)) {
      return { strict: false, browser: false, skipped: false, reviewOnly: true, reason: 'review_only' }
    }
    return { strict: true, browser: true, skipped: false, reviewOnly: false, reason: 'login_gated' }
  }
  if (options.hasProfile === true) {
    return { strict: true, browser: true, skipped: false, reviewOnly: false, reason: 'has_profile' }
  }
  return { strict: false, browser: false, skipped: false, reviewOnly: false, reason: null }
}

/**
 * True when the pipeline may log in to this host.
 *
 * An empty allow list means "no restriction": every login-walled host is
 * allowed, exactly as before the allow list existed. A host with a saved
 * profile is always allowed (the session exists already).
 */
export function loginAllowed(
  allow: string[] | undefined,
  host: string,
  hasProfile = false,
): boolean {
  if (!allow || allow.length === 0) return true
  if (hasProfile) return true
  return matchesPattern(allow, host)
}

/**
 * Normalize a host for pattern matching: lowercase, without the port and
 * without the brackets the URL API keeps around an IPv6 literal (`[::1]`
 * becomes `::1`). A config entry may be written either way.
 */
export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase()
  if (lower.startsWith('[') && lower.endsWith(']')) return lower.slice(1, -1)
  return lower
}

/** True when the host matches the skip-list entry (exact host or `*.suffix`). */
export function matchesPattern(patterns: string[] | undefined, host: string): boolean {
  if (!patterns || patterns.length === 0) return false
  const lower = normalizeHost(host)
  return patterns.some((pattern) => {
    const normalized = normalizeHost(pattern)
    if (normalized.startsWith('*.')) {
      const suffix = normalized.slice(2)
      return lower === suffix || lower.endsWith(`.${suffix}`)
    }
    return lower === normalized
  })
}

/**
 * The loopback hosts: `localhost`, `127.0.0.1`, `::1` and any `*.localhost`
 * name. A pipeline run can never fetch them (they are the user's own
 * services, and a headless agent-browser has no session for them), so they
 * are skipped by default.
 *
 * This is a built-in rule, not a config entry: it names no third-party site
 * and it cannot be disabled by accident. The config skip-list still wins for
 * everything else.
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']

/** True when the host is a loopback address (or a `*.localhost` name). */
export function isLoopbackHost(host: string): boolean {
  const lower = normalizeHost(host)
  if (LOOPBACK_HOSTS.includes(lower)) return true
  return lower.endsWith('.localhost')
}

/** The effective limit for a host after config merges. */
export function limitForHost(
  config: LimitsConfig,
  host: string,
  hasProfile: boolean,
  trialState: HostState['trialState'] = 'unknown',
  loginGated = false,
): HostLimit {
  if (host === LLM_KEY) {
    return { ...LLM_LIMIT, concurrency: config.llmConcurrency }
  }
  const policy = hostPolicy(config, host, { hasProfile, trialState, loginGated })
  const base = policy.strict ? WALLED_GARDEN_LIMIT : ORDINARY_LIMIT
  const override = config.hosts[host]
  if (override === undefined) return base
  return {
    intervalMs: override.intervalMs ?? base.intervalMs,
    dailyCap: override.dailyCap ?? base.dailyCap,
    concurrency: override.concurrency ?? base.concurrency,
  }
}

/**
 * Back-compat helper: the strict (walled-garden) verdict for a host. Strict
 * now means "config override, flagged canary, login gate or saved profile".
 */
export function isWalledGarden(
  config: LimitsConfig,
  host: string,
  hasProfile: boolean,
  trialState: HostState['trialState'] = 'unknown',
  loginGated = false,
): boolean {
  if (host === LLM_KEY) return false
  return hostPolicy(config, host, { hasProfile, trialState, loginGated }).strict
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

/**
 * Read the upstream pacing signals from a response and turn them into the
 * moment the host may be contacted again.
 *
 * `Retry-After` is seconds or an HTTP date. `X-RateLimit-Reset` is a unix
 * timestamp in seconds, `X-RateLimit-Remaining: 0` means "no budget left"
 * and falls back to the host spacing. The strongest signal wins.
 */
export function pacingSignalMs(
  headers: Record<string, string | undefined> | undefined,
  now: number,
  fallbackMs: number,
): number {
  if (!headers) return 0
  const lower = new Map<string, string>()
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') lower.set(key.toLowerCase(), value)
  }

  let waitMs = 0
  const retryAfter = lower.get('retry-after')
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter.trim())
    if (Number.isFinite(seconds)) waitMs = Math.max(waitMs, seconds * 1000)
    else {
      const at = Date.parse(retryAfter)
      if (Number.isFinite(at)) waitMs = Math.max(waitMs, at - now)
    }
  }

  const reset = lower.get('x-ratelimit-reset')
  if (reset !== undefined) {
    const seconds = Number(reset.trim())
    if (Number.isFinite(seconds)) {
      // The header is a unix timestamp in seconds; a small value is a delta.
      const at = seconds > 1_000_000_000 ? seconds * 1000 : now + seconds * 1000
      waitMs = Math.max(waitMs, at - now)
    }
  }

  const remaining = lower.get('x-ratelimit-remaining')
  if (remaining !== undefined && Number(remaining.trim()) === 0) {
    waitMs = Math.max(waitMs, fallbackMs)
  }

  return Math.max(0, waitMs)
}

export interface LimiterDeps {
  load(key: string): Promise<HostState | null>
  save(state: HostState): Promise<void>
  clock: Clock
  random: Random
  config: LimitsConfig
  /** True when the host has a saved browser profile (walled garden). */
  hasProfile(host: string): Promise<boolean>
  /** The human pacing profile applied to strict hosts (default applies). */
  pacing?: PacingConfig
}

export interface LimiterGate {
  admitted: boolean
  waitMs: number
  reason?:
    | 'spacing'
    | 'daily_cap'
    | 'concurrency'
    | 'rate_limited'
    | 'human_break'
    | 'outside_hours'
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
  const state = (await deps.load(key)) ?? emptyHostState(key)
  const limit = limitForHost(deps.config, key, hasProfile, state.trialState, state.loginGated)
  // An upstream "slow down" signal (Retry-After, X-RateLimit-Reset) extends
  // the host spacing until that moment, whatever the configured interval is.
  const rateLimitWait = state.rateLimitedUntil !== null ? Math.max(0, state.rateLimitedUntil - now) : 0
  if (rateLimitWait > 0) {
    return { admitted: false, waitMs: rateLimitWait, reason: 'rate_limited' }
  }

  // Strict (walled-garden) hosts are paced like a human instead of a
  // metronome: sampled dwell, occasional longer breaks, a working-hours
  // window and the pacing daily cap. Ordinary hosts keep the fixed
  // token-bucket rules. No host names here: the pacing profile follows the
  // shared hostPolicy verdict.
  const policy = key === LLM_KEY
    ? { strict: false }
    : hostPolicy(deps.config, key, { hasProfile, trialState: state.trialState, loginGated: state.loginGated })
  if (policy.strict) {
    const pacing = deps.pacing ?? DEFAULT_PACING
    const verdict = pacingGate(state, pacing, now, deps.random)
    if (!verdict.admitted) {
      await deps.save(verdict.state)
      return {
        admitted: false,
        waitMs: verdict.waitMs,
        reason: verdict.reason === 'break'
          ? 'human_break'
          : verdict.reason === OUTSIDE_HOURS_REASON
            ? 'outside_hours'
            : verdict.reason,
        windowResetsAt: verdict.reason === 'daily_cap'
          ? (verdict.state.windowStart ?? now) + DAY_MS
          : undefined,
        state: verdict.state,
      }
    }
    await deps.save(verdict.state)
    return { admitted: true, waitMs: 0, state: verdict.state }
  }

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
