/**
 * Human pacing for logged-in browser extraction.
 *
 * A strict (walled-garden) host should not be touched with a metronome:
 * a fixed 45 second spacing is machine-shaped and the behaviour that gets
 * an account flagged. This module samples human-shaped timing instead:
 *
 *   - a dwell time per page, log-normal around a configurable median,
 *     capped so a tail draw cannot stall the pipeline
 *   - jittered spacing between requests (log-normal around the median,
 *     which doubles as the spacing baseline)
 *   - an occasional longer break after every `breakEveryMin..breakEveryMax`
 *     pages, lasting `breakMinS..breakMaxS`
 *   - a per-host daily cap on paced requests
 *   - an optional working-hours window in LOCAL time; outside the window
 *     requests are deferred with the reason `outside_hours` until it opens
 *
 * Everything is pure: clock and random are injected, so tests are
 * deterministic and never sleep. No host names appear here: the profile
 * applies to whatever host the limiter's policy marks strict.
 */
import type { HostState, Random } from './types.js'

export interface PacingConfig {
  /** Median dwell time per page, in seconds. Default 20. */
  dwellMedianS: number
  /** Hard upper bound of a single dwell, in seconds. Default 90. */
  dwellMaxS: number
  /** Minimum pages between long breaks. Default 5. */
  breakEveryMin: number
  /** Maximum pages between long breaks. Default 12. */
  breakEveryMax: number
  /** Minimum length of a long break, in seconds. Default 120 (2 min). */
  breakMinS: number
  /** Maximum length of a long break, in seconds. Default 360 (6 min). */
  breakMaxS: number
  /** Per-host cap of paced requests per rolling day. Default 40. */
  dailyCap: number
  /** Working-hours window start, local hour 0..24. Default 8. */
  hoursStart: number
  /** Working-hours window end, local hour 0..24. Default 23. */
  hoursEnd: number
}

export const DEFAULT_PACING: PacingConfig = {
  dwellMedianS: 20,
  dwellMaxS: 90,
  breakEveryMin: 5,
  breakEveryMax: 12,
  breakMinS: 120,
  breakMaxS: 360,
  dailyCap: 40,
  hoursStart: 8,
  hoursEnd: 23,
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Log-normal sigma: ~median/2.7 at the low end, ~median*2.7 at the top. */
const DWELL_SIGMA = 1
/** Fraction of the spacing the jitter band may move a wait. */
const SPACING_JITTER_FRACTION = 0.3
const HOUR_MS = 60 * 60 * 1000

/** The deferral reason recorded when the working-hours window is closed. */
export const OUTSIDE_HOURS_REASON = 'outside_hours'

/** Clamp a number into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Box-Muller over two uniform draws: standard normal N(0, 1). Pure in the
 * injected random, so the same sequence always yields the same value.
 */
function standardNormal(random: Random): number {
  const u1 = Math.max(random(), Number.EPSILON)
  const u2 = random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * Log-normal dwell time around `median`, in ms, capped at `dwellMaxS`.
 * Sampling: exp(ln(median) + sigma * Z). With sigma 1 the draw sits in
 * roughly [median / 3, median * 3] before the cap.
 */
export function sampleDwellMs(config: PacingConfig, random: Random): number {
  const median = Math.max(1, config.dwellMedianS)
  const z = clamp(standardNormal(random), -2.5, 2.5)
  const seconds = median * Math.exp(DWELL_SIGMA * z)
  const capped = Math.min(seconds, config.dwellMaxS)
  return Math.max(1, Math.round(capped * 1000))
}

/**
 * Jittered spacing between two paced requests, in ms: log-normal around the
 * same median as the dwell, times (1 +/- 30 percent). The median doubles as
 * the spacing baseline: a human reading pages is also what spaces the
 * requests out.
 */
export function sampleSpacingMs(config: PacingConfig, random: Random): number {
  const base = sampleDwellMs(config, random)
  const jitter = 1 - SPACING_JITTER_FRACTION + random() * SPACING_JITTER_FRACTION * 2
  return Math.max(1, Math.round(base * jitter))
}

/** How many pages until the next long break, drawn once per host cycle. */
export function sampleBreakEvery(config: PacingConfig, random: Random): number {
  const min = Math.max(1, config.breakEveryMin)
  const max = Math.max(min, config.breakEveryMax)
  return min + Math.floor(random() * (max - min + 1))
}

/** Length of a long break, in ms. */
export function sampleBreakMs(config: PacingConfig, random: Random): number {
  const min = Math.max(0, config.breakMinS)
  const max = Math.max(min, config.breakMaxS)
  const seconds = min + random() * (max - min)
  return Math.round(seconds * 1000)
}

/** Local (not UTC) hour-of-day for a ms epoch. */
export function localHourOf(nowMs: number): number {
  return new Date(nowMs).getHours()
}

/**
 * Working-hours gate. `hoursStart === hoursEnd` (or a 0..24 window) means
 * always open. Returns `open: true`, or `open: false` with the number of ms
 * until the window next opens (never more than 24h).
 */
export function hoursGate(
  config: PacingConfig,
  nowMs: number,
  hourOf: (ms: number) => number = localHourOf,
): { open: boolean; opensInMs: number } {
  const start = config.hoursStart
  const end = config.hoursEnd
  if (start === end || (start === 0 && end >= 24)) return { open: true, opensInMs: 0 }
  const hour = hourOf(nowMs)
  const inWindow =
    start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end
  if (inWindow) return { open: true, opensInMs: 0 }
  const d = new Date(nowMs)
  const msIntoHour = d.getMinutes() * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds()
  const hoursUntil = start < end ? start - hour : (start - hour + 24) % 24
  const opensAt = nowMs - msIntoHour + hoursUntil * HOUR_MS
  return { open: false, opensInMs: Math.max(0, opensAt - nowMs) }
}

/**
 * Whether the host is due a long break, given the pages served since the
 * last one. `breakEvery` is drawn per cycle; the caller persists
 * `pagesSinceBreak` and `breakEvery` between runs through the HostState.
 */
export function isBreakDue(pagesSinceBreak: number, breakEvery: number): boolean {
  return pagesSinceBreak >= Math.max(1, breakEvery)
}

export type PacingDeferReason = 'outside_hours' | 'daily_cap' | 'break' | 'spacing'

export interface PacingVerdict {
  admitted: boolean
  /** Why the request was not made (only when not admitted). */
  reason?: PacingDeferReason
  /** How long to wait before the next allowed request (ms). */
  waitMs: number
  /** The state to persist (admitted or not). */
  state: HostState
}

/**
 * The pure pacing gate over a HostState. Decides, in order:
 *
 *   1. working hours (defer `outside_hours` until the window opens)
 *   2. the daily cap (defer until the window rolls over)
 *   3. a due long break (defer for the sampled break length)
 *   4. jittered spacing since the last request
 *
 * On admit it updates the state: lastRequestAt, the daily window, the
 * pages-since-break counter and, on a cycle boundary, the next breakEvery
 * draw. All randomness flows through the injected Random.
 */
export function pacingGate(
  state: HostState,
  config: PacingConfig,
  nowMs: number,
  random: Random,
): PacingVerdict {
  const next: HostState = { ...state }

  // 1. Working hours.
  const hours = hoursGate(config, nowMs)
  if (!hours.open) {
    return {
      admitted: false,
      reason: OUTSIDE_HOURS_REASON,
      waitMs: hours.opensInMs,
      state: next,
    }
  }

  // 2. Daily cap on a rolling calendar day, mirroring the limiter.
  if (next.windowStart === null || nowMs - next.windowStart >= DAY_MS) {
    next.windowStart = nowMs
    next.windowCount = 0
  }
  if (Number.isFinite(config.dailyCap) && next.windowCount >= config.dailyCap) {
    const resetsAt = (next.windowStart ?? nowMs) + DAY_MS
    return {
      admitted: false,
      reason: 'daily_cap',
      waitMs: Math.max(0, resetsAt - nowMs),
      state: next,
    }
  }

  // 3. Long break cadence: breakEvery is drawn when a cycle starts; a fresh
  // host draws one so the very first cycle is already human-shaped.
  if (next.pagesSinceBreak === undefined && next.breakEvery === undefined) {
    next.pagesSinceBreak = 0
    next.breakEvery = sampleBreakEvery(config, random)
  }
  if (
    next.pagesSinceBreak !== undefined &&
    next.breakEvery !== undefined &&
    isBreakDue(next.pagesSinceBreak, next.breakEvery)
  ) {
    const breakMs = sampleBreakMs(config, random)
    next.pagesSinceBreak = 0
    next.breakEvery = sampleBreakEvery(config, random)
    return { admitted: false, reason: 'break', waitMs: breakMs, state: next }
  }

  // 4. Jittered spacing since the last paced request.
  if (next.lastRequestAt !== null) {
    const spacing = sampleSpacingMs(config, random)
    const waitMs = Math.max(0, next.lastRequestAt + spacing - nowMs)
    if (waitMs > 0) {
      return { admitted: false, reason: 'spacing', waitMs, state: next }
    }
  }

  next.lastRequestAt = nowMs
  next.windowCount += 1
  next.pagesSinceBreak = (next.pagesSinceBreak ?? 0) + 1
  return { admitted: true, waitMs: 0, state: next }
}
