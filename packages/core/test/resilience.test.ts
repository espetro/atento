/**
 * Resilience tests: fake clock, deterministic random, no real sleeps.
 */
import { describe, expect, it } from 'vitest'
import {
  backoffCeilingMs,
  backoffDelayMs,
  classifyError,
  DEFAULT_RETRY_POLICY,
  isNetworkError,
  looksBlocked,
  parseRetryAfter,
  retry,
} from '../src/resilience/retry.js'
import {
  cooldownForLevel,
  isBlocked,
  maybeHalfOpen,
  recordOutcome,
  LLM_BREAKER,
  WALLED_GARDEN_BREAKER,
} from '../src/resilience/breaker.js'
import {
  gateHost,
  isWalledGarden,
  jitteredInterval,
  limitForHost,
  minIntervalMs,
  remainingBudget,
  DEFAULT_LIMITS,
  LLM_LIMIT,
  WALLED_GARDEN_LIMIT,
} from '../src/resilience/limiter.js'
import { createBoundedQueue } from '../src/resilience/queue.js'
import { emptyHostState, LLM_KEY } from '../src/resilience/types.js'

/** Deterministic fake clock. */
function fakeClock(start = 0) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** Deterministic random: cycles 0, 0.5, 0.9999. */
function fakeRandom() {
  const seq = [0, 0.5, 0.9999]
  let i = 0
  return () => seq[i++ % seq.length]
}

describe('retry: backoff schedule and jitter bounds', () => {
  it('the ceiling grows exponentially and caps at maxDelayMs', () => {
    expect(backoffCeilingMs(1, DEFAULT_RETRY_POLICY)).toBe(1000)
    expect(backoffCeilingMs(2, DEFAULT_RETRY_POLICY)).toBe(2000)
    expect(backoffCeilingMs(3, DEFAULT_RETRY_POLICY)).toBe(4000)
    expect(backoffCeilingMs(10, DEFAULT_RETRY_POLICY)).toBe(60_000)
  })

  it('full jitter keeps every delay inside [0, ceiling]', () => {
    for (const r of [0, 0.25, 0.5, 0.99]) {
      const delay = backoffDelayMs(3, DEFAULT_RETRY_POLICY, () => r)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual(backoffCeilingMs(3, DEFAULT_RETRY_POLICY))
    }
  })

  it('the sleep is called with the jittered delay and the clock advances', async () => {
    const sleeps: number[] = []
    const outcome = await retry(
      async (attempt) => {
        if (attempt < 3) throw new Error('fetch failed: transient')
        return 'done'
      },
      {
        maxAttempts: 5,
        baseDelayMs: 100,
        factor: 2,
        maxDelayMs: 10_000,
        random: () => 0.5,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.attempts).toBe(3)
    expect(sleeps).toEqual([50, 100])
  })

  it('gives up after maxAttempts and reports the classified error', async () => {
    const outcome = await retry(
      async () => {
        throw Object.assign(new Error('boom'), { status: 500 })
      },
      { maxAttempts: 2, sleep: async () => {} },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.attempts).toBe(2)
    expect(outcome.error?.retryable).toBe(true)
  })
})

describe('retry: error classifier', () => {
  it('retries network errors, 408, 429 and 5xx', () => {
    expect(classifyError(new Error('fetch failed')).retryable).toBe(true)
    expect(classifyError({ status: 408 }).retryable).toBe(true)
    expect(classifyError({ status: 429 }).retryable).toBe(true)
    expect(classifyError({ status: 500 }).retryable).toBe(true)
    expect(classifyError({ status: 503 }).retryable).toBe(true)
  })

  it('never retries auth 4xx or 404', () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(classifyError({ status }).retryable).toBe(false)
    }
  })

  it('flags 429, 403 and 999 as hard block signals', () => {
    expect(classifyError({ status: 429 }).block).toBe(true)
    expect(classifyError({ status: 403 }).block).toBe(true)
    expect(classifyError({ status: 999 }).block).toBe(true)
    expect(classifyError({ status: 500 }).block).toBe(false)
  })

  it('flags captcha, login wall and unusual-activity text as blocks', () => {
    for (const text of [
      'Please complete the captcha to continue',
      'Sign in to continue',
      'We noticed unusual activity on your account',
    ]) {
      expect(looksBlocked(text)).toBe(true)
      expect(classifyError(new Error(text)).block).toBe(true)
    }
    expect(looksBlocked('a perfectly normal article about cats')).toBe(false)
  })

  it('honors Retry-After: seconds and HTTP date forms', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000)
    expect(parseRetryAfter('0', 0)).toBe(0)
    const date = new Date(100_000).toUTCString()
    expect(parseRetryAfter(date, 50_000)).toBe(50_000)
    expect(parseRetryAfter(null, 0)).toBeUndefined()
    expect(parseRetryAfter('garbage', 0)).toBeUndefined()
  })

  it('a Retry-After overrides the computed backoff', async () => {
    const sleeps: number[] = []
    await retry(
      async () => {
        throw Object.assign(new Error('slow down'), { status: 503 })
      },
      {
        maxAttempts: 2,
        retryAfterMs: 42_000,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      },
    )
    expect(sleeps).toEqual([42_000])
  })

  it('detects network errors by code', () => {
    expect(isNetworkError({ code: 'ECONNRESET' })).toBe(true)
    expect(isNetworkError({ code: 'ENOTFOUND' })).toBe(true)
    expect(isNetworkError(new Error('socket hang up'))).toBe(true)
    expect(isNetworkError(new Error('nope'))).toBe(false)
  })
})

describe('circuit breaker transitions', () => {
  it('opens after N consecutive failures', () => {
    const now = 0
    let state = emptyHostState('example.com')
    for (let i = 0; i < WALLED_GARDEN_BREAKER.failureThreshold - 1; i += 1) {
      const r = recordOutcome(state, 'failure', { retryable: true, block: false, reason: 'http_500' }, WALLED_GARDEN_BREAKER, now)
      state = r.state
      expect(r.tripped).toBe(false)
      expect(state.breakerState).toBe('closed')
    }
    const final = recordOutcome(state, 'failure', { retryable: true, block: false, reason: 'http_500' }, WALLED_GARDEN_BREAKER, now)
    expect(final.tripped).toBe(true)
    expect(final.state.breakerState).toBe('open')
    expect(final.state.openedUntil).toBe(cooldownForLevel(WALLED_GARDEN_BREAKER, 0))
  })

  it('opens immediately on any hard block signal', () => {
    const r = recordOutcome(
      emptyHostState('x.com'),
      'failure',
      { retryable: false, block: true, reason: 'http_403' },
      WALLED_GARDEN_BREAKER,
      0,
    )
    expect(r.tripped).toBe(true)
    expect(r.state.breakerState).toBe('open')
    expect(r.state.openedUntil).toBe(cooldownForLevel(WALLED_GARDEN_BREAKER, 1))
  })

  it('cooldown doubles per level and caps at 48h for walled gardens', () => {
    expect(cooldownForLevel(WALLED_GARDEN_BREAKER, 0)).toBe(6 * 60 * 60 * 1000)
    expect(cooldownForLevel(WALLED_GARDEN_BREAKER, 1)).toBe(12 * 60 * 60 * 1000)
    expect(cooldownForLevel(WALLED_GARDEN_BREAKER, 2)).toBe(24 * 60 * 60 * 1000)
    expect(cooldownForLevel(WALLED_GARDEN_BREAKER, 3)).toBe(48 * 60 * 60 * 1000)
    expect(cooldownForLevel(WALLED_GARDEN_BREAKER, 10)).toBe(48 * 60 * 60 * 1000)
  })

  it('llm cooldown stays short', () => {
    expect(cooldownForLevel(LLM_BREAKER, 0)).toBe(30_000)
    expect(cooldownForLevel(LLM_BREAKER, 3)).toBe(240_000)
    expect(cooldownForLevel(LLM_BREAKER, 100)).toBe(LLM_BREAKER.maxCooldownMs)
  })

  it('isBlocked while open, then half-open after the cooldown elapses', () => {
    let state = emptyHostState('x.com')
    state = recordOutcome(state, 'failure', { retryable: true, block: true, reason: 'http_429' }, WALLED_GARDEN_BREAKER, 0).state
    expect(isBlocked(state, WALLED_GARDEN_BREAKER, 1000)).toBe(true)
    expect(isBlocked(state, WALLED_GARDEN_BREAKER, cooldownForLevel(WALLED_GARDEN_BREAKER, 1))).toBe(false)
    state = maybeHalfOpen(state, cooldownForLevel(WALLED_GARDEN_BREAKER, 1))
    expect(state.breakerState).toBe('half_open')
  })

  it('a successful probe closes the breaker and resets the level', () => {
    let state = emptyHostState('x.com')
    state = recordOutcome(state, 'failure', { retryable: true, block: true, reason: 'http_429' }, WALLED_GARDEN_BREAKER, 0).state
    state = maybeHalfOpen(state, state.openedUntil!)
    expect(state.breakerState).toBe('half_open')
    const r = recordOutcome(state, 'success', null, WALLED_GARDEN_BREAKER, state.openedUntil! + 1)
    expect(r.state.breakerState).toBe('closed')
    expect(r.state.cooldownLevel).toBe(0)
  })

  it('a failed probe reopens one level deeper', () => {
    let state = emptyHostState('x.com')
    state = recordOutcome(state, 'failure', { retryable: true, block: true, reason: 'http_429' }, WALLED_GARDEN_BREAKER, 0).state
    state = maybeHalfOpen(state, state.openedUntil!)
    const r = recordOutcome(state, 'failure', { retryable: true, block: false, reason: 'http_500' }, WALLED_GARDEN_BREAKER, state.openedUntil! + 1)
    expect(r.tripped).toBe(true)
    expect(r.state.breakerState).toBe('open')
    expect(r.state.cooldownLevel).toBe(2)
    expect(r.state.openedUntil).toBe(
      state.openedUntil! + 1 + cooldownForLevel(WALLED_GARDEN_BREAKER, 2),
    )
  })
})

describe('rate limiter: walled garden spacing and daily cap', () => {
  const host = 'x.com'
  const limit = limitForHost(DEFAULT_LIMITS, host, false)

  it('walled gardens get the conservative limits', () => {
    expect(limit).toEqual(WALLED_GARDEN_LIMIT)
    expect(isWalledGarden(DEFAULT_LIMITS, 'x.com', false)).toBe(true)
    expect(isWalledGarden(DEFAULT_LIMITS, 'example.com', false)).toBe(false)
    expect(isWalledGarden(DEFAULT_LIMITS, 'example.com', true)).toBe(true)
  })

  it('jitter stays within +-30 percent and the floor is deterministic', () => {
    for (const r of [0, 0.5, 0.9999]) {
      const interval = jitteredInterval(WALLED_GARDEN_LIMIT.intervalMs, () => r)
      expect(interval).toBeGreaterThanOrEqual(minIntervalMs(WALLED_GARDEN_LIMIT.intervalMs))
      expect(interval).toBeLessThanOrEqual(WALLED_GARDEN_LIMIT.intervalMs * 1.3)
    }
  })

  it('enforces spacing between requests', () => {
    const clock = fakeClock(0)
    let state = emptyHostState(host)
    const first = gateHost(state, limit, clock.now(), 0, () => 0)
    expect(first.admitted).toBe(true)
    state = first.state

    const tooSoon = gateHost(state, limit, clock.now() + 1000, 0, () => 0)
    expect(tooSoon.admitted).toBe(false)
    if (!tooSoon.admitted) {
      expect(tooSoon.reason).toBe('spacing')
      expect(tooSoon.waitMs).toBeGreaterThan(0)
    }

    clock.advance(WALLED_GARDEN_LIMIT.intervalMs * 1.31)
    const later = gateHost(state, limit, clock.now(), 0, () => 0.9999)
    expect(later.admitted).toBe(true)
  })

  it('enforces the daily cap across process reloads', () => {
    const clock = fakeClock(0)
    // Process 1 burns through the cap.
    let state = emptyHostState(host)
    for (let i = 0; i < WALLED_GARDEN_LIMIT.dailyCap; i += 1) {
      const r = gateHost(state, limit, clock.now(), 0, () => 0)
      expect(r.admitted).toBe(true)
      state = r.state
      clock.advance(WALLED_GARDEN_LIMIT.intervalMs * 1.31)
    }
    // Persisted state handed to process 2: same record, no memory.
    const reloaded: typeof state = { ...state }
    const rejected = gateHost(reloaded, limit, clock.now(), 0, () => 0)
    expect(rejected.admitted).toBe(false)
    if (!rejected.admitted) {
      expect(rejected.reason).toBe('daily_cap')
      expect(rejected.windowResetsAt).toBeDefined()
    }
    // After the window resets the budget is back.
    const nextDay = gateHost(reloaded, limit, WALLED_GARDEN_LIMIT.dailyCap * 0 + (reloaded.windowStart ?? 0) + 24 * 60 * 60 * 1000, 0, () => 0)
    expect(nextDay.admitted).toBe(true)
  })

  it('a 500-link burst admits at most the daily cap', () => {
    const clock = fakeClock(0)
    let state = emptyHostState(host)
    let admitted = 0
    for (let i = 0; i < 500; i += 1) {
      const r = gateHost(state, limit, clock.now(), 0, () => 0)
      if (r.admitted) {
        admitted += 1
        state = r.state
        clock.advance(WALLED_GARDEN_LIMIT.intervalMs * 1.31)
      } else {
        // No time passes in the burst; spacing alone rejects the rest.
        break
      }
    }
    expect(admitted).toBe(WALLED_GARDEN_LIMIT.dailyCap)
  })

  it('ordinary hosts get 2s spacing and concurrency 4', () => {
    const l = limitForHost(DEFAULT_LIMITS, 'example.com', false)
    expect(l.intervalMs).toBe(2000)
    expect(l.concurrency).toBe(4)
  })

  it('config overrides win over defaults', () => {
    const l = limitForHost(
      { ...DEFAULT_LIMITS, hosts: { 'x.com': { intervalMs: 1000, dailyCap: 5 } } },
      'x.com',
      false,
    )
    expect(l.intervalMs).toBe(1000)
    expect(l.dailyCap).toBe(5)
    expect(l.concurrency).toBe(WALLED_GARDEN_LIMIT.concurrency)
  })

  it('the llm key gets its own concurrency', () => {
    expect(limitForHost(DEFAULT_LIMITS, LLM_KEY, false).concurrency).toBe(LLM_LIMIT.concurrency)
  })

  it('remainingBudget reports the leftover daily allowance', () => {
    const state = { ...emptyHostState(host), windowStart: 0, windowCount: 10 }
    expect(remainingBudget(state, limit, 1000)).toBe(WALLED_GARDEN_LIMIT.dailyCap - 10)
    expect(remainingBudget(state, limit, 25 * 60 * 60 * 1000)).toBe(WALLED_GARDEN_LIMIT.dailyCap)
  })
})

describe('bounded queue backpressure', () => {
  it('accepts up to maxSize and rejects past it', () => {
    const queue = createBoundedQueue<number>({ maxSize: 3, concurrency: 2 })
    expect(queue.enqueue(1).accepted).toBe(true)
    expect(queue.enqueue(2).accepted).toBe(true)
    expect(queue.enqueue(3).accepted).toBe(true)
    const rejected = queue.enqueue(4)
    expect(rejected.accepted).toBe(false)
    if (!rejected.accepted) {
      expect(rejected.reason).toBe('queue_full')
      expect(rejected.size).toBe(3)
    }
  })

  it('refuses enqueues after close', () => {
    const queue = createBoundedQueue<number>({ maxSize: 2, concurrency: 1 })
    queue.close()
    const r = queue.enqueue(1)
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.reason).toBe('queue_closed')
  })

  it('drains at bounded concurrency', async () => {
    let active = 0
    let peak = 0
    const queue = createBoundedQueue<number>({ maxSize: 10, concurrency: 3 })
    for (let i = 0; i < 10; i += 1) queue.enqueue(i)
    await queue.drain(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1))
      active -= 1
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(queue.size()).toBe(0)
  })
})
