/**
 * Retry with exponential backoff and full jitter.
 *
 * The classifier decides what is retryable. Everything is injected (clock,
 * random, sleep) so tests use a fake clock and never really sleep.
 */
import {
  type Clock,
  type ErrorSignal,
  type Random,
  type UpstreamError,
  mathRandom,
  systemClock,
} from './types.js'

export interface RetryPolicy {
  /** Maximum number of attempts, including the first one. Default 3. */
  maxAttempts: number
  /** Base delay in ms for the first retry. Default 1000. */
  baseDelayMs: number
  /** Upper bound of a single delay. Default 60_000. */
  maxDelayMs: number
  /** Multiplier applied per attempt. Default 2. */
  factor: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  factor: 2,
}

/** A sleep function the tests can replace with an instant resolve. */
export type Sleep = (ms: number) => Promise<void>

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms)).unref?.()
  })

/** HTTP statuses that are always safe to retry. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 522, 524])

/** HTTP statuses that must never be retried. */
const FATAL_STATUS = new Set([400, 401, 402, 403, 404, 405, 410, 422])

/** Text markers that mean the upstream blocked us. */
export const BLOCK_MARKERS = [
  'unusual activity',
  'captcha',
  'verify you are human',
  'are you a robot',
  'login wall',
  'sign in to continue',
  'please log in',
  'rate limit exceeded',
  'suspended',
  'account locked',
  'temporarily blocked',
]

/** True when the text of a page or an error body looks like a hard block. */
export function looksBlocked(text: string): boolean {
  const lower = text.toLowerCase()
  return BLOCK_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * Classify an upstream failure.
 *
 * Retryable: network errors, 408, 429 and every 5xx.
 * Never retried: 4xx auth (401/403), 404 and other fatal 4xx.
 * Hard block: 429, 403, 999, captcha/login-wall text.
 */
export function classifyError(err: UpstreamError): ErrorSignal {
  const status = statusOf(err)
  const message = messageOf(err)

  if (status === 429 || status === 403 || status === 999) {
    return { retryable: status === 429, block: true, reason: `http_${status}` }
  }
  if (status !== undefined && FATAL_STATUS.has(status)) {
    return { retryable: false, block: false, reason: `http_${status}` }
  }
  if (status !== undefined && RETRYABLE_STATUS.has(status)) {
    return { retryable: true, block: false, reason: `http_${status}` }
  }
  if (status !== undefined && status >= 500) {
    return { retryable: true, block: false, reason: `http_${status}` }
  }
  if (status !== undefined && status >= 400) {
    return { retryable: false, block: false, reason: `http_${status}` }
  }
  if (looksBlocked(message)) {
    return { retryable: false, block: true, reason: 'blocked_text' }
  }
  if (isNetworkError(err, message)) {
    return { retryable: true, block: false, reason: 'network_error' }
  }
  return { retryable: false, block: false, reason: message.slice(0, 120) || 'unknown_error' }
}

/** True when the failure is a transport problem, not an HTTP response. */
export function isNetworkError(err: UpstreamError, message?: string): boolean {
  const code = codeOf(err)
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_HEADERS_TIMEOUT'
  ) {
    return true
  }
  const text = (message ?? messageOf(err)).toLowerCase()
  return (
    text.includes('fetch failed') ||
    text.includes('network error') ||
    text.includes('socket hang up') ||
    text.includes('econnreset') ||
    text.includes('timeout')
  )
}

/** Parse a `Retry-After` header (seconds or an HTTP date) into ms. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return undefined
}

/**
 * Full-jitter backoff: the delay is uniform in [0, min(cap, base * factor^n)].
 * The bound never depends on the random draw, so the schedule stays
 * predictable while the actual wait is spread out.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: Random = mathRandom,
): number {
  const exp = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1)),
  )
  return Math.floor(random() * exp)
}

/** The deterministic upper bound of the delay for an attempt. */
export function backoffCeilingMs(attempt: number, policy: RetryPolicy): number {
  return Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1)),
  )
}

export interface RetryOptions extends Partial<RetryPolicy> {
  clock?: Clock
  random?: Random
  sleep?: Sleep
  /** Extra delay that overrides the computed backoff (Retry-After). */
  retryAfterMs?: number
  /** Called after every failed attempt with the classified signal. */
  onRetry?: (info: { attempt: number; delayMs: number; signal: ErrorSignal }) => void
}

export interface RetryOutcome<T> {
  ok: boolean
  value?: T
  error?: ErrorSignal
  /** Number of attempts made. */
  attempts: number
  /** Delay before the next attempt, when the call failed but may be retried. */
  retryAfterMs?: number
}

/**
 * Run `fn` with retries. The function receives the attempt number (1-based).
 * It throws to signal failure; the error is classified by `classifyError`.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryOutcome<T>> {
  const policy: RetryPolicy = {
    maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    factor: options.factor ?? DEFAULT_RETRY_POLICY.factor,
  }
  const clock = options.clock ?? systemClock
  const random = options.random ?? mathRandom
  const sleep = options.sleep ?? realSleep
  const maxAttempts = Math.max(1, policy.maxAttempts)

  let lastSignal: ErrorSignal = { retryable: false, block: false, reason: 'unknown_error' }
  let lastDelay: number | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await fn(attempt)
      return { ok: true, value, attempts: attempt }
    } catch (err) {
      const signal = classifyError(err as UpstreamError)
      lastSignal = signal
      if (!signal.retryable || attempt >= maxAttempts) {
        return { ok: false, error: signal, attempts: attempt, retryAfterMs: signal.retryAfterMs }
      }
      const delay =
        options.retryAfterMs !== undefined
          ? options.retryAfterMs
          : backoffDelayMs(attempt, policy, random)
      lastDelay = delay
      options.onRetry?.({ attempt, delayMs: delay, signal })
      await sleep(delay)
    }
  }

  void clock
  return { ok: false, error: lastSignal, attempts: maxAttempts, retryAfterMs: lastDelay }
}

function statusOf(err: UpstreamError): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: number }).status
    if (typeof status === 'number') return status
  }
  const anyErr = err as { statusCode?: number; response?: { status?: number } }
  if (typeof anyErr?.statusCode === 'number') return anyErr.statusCode
  if (typeof anyErr?.response?.status === 'number') return anyErr.response.status
  return undefined
}

function codeOf(err: UpstreamError): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

function messageOf(err: UpstreamError): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(err)
}
