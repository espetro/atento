/**
 * Human pacing tests: deterministic distribution bounds, break cadence,
 * daily cap rollover, working-hours deferral and release, and integration
 * through guardRun with a fake clock. Nothing sleeps, nothing hits the
 * network, no host names are hardcoded in the module.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PACING,
  OUTSIDE_HOURS_REASON,
  hoursGate,
  isBreakDue,
  localHourOf,
  pacingGate,
  sampleBreakEvery,
  sampleBreakMs,
  sampleDwellMs,
  sampleSpacingMs,
  type PacingConfig,
} from '../src/resilience/human-pacing.js'
import { emptyHostState } from '../src/resilience/types.js'
import { guardRun, type GuardDeps } from '../src/resilience/guard.js'
import { DEFAULT_LIMITS } from '../src/resilience/limiter.js'

const base = (over: Partial<PacingConfig> = {}): PacingConfig => ({
  ...DEFAULT_PACING,
  ...over,
})

describe('dwell distribution', () => {
  it('stays within [1, dwellMaxS] for every draw', () => {
    let r = 0.001
    for (let i = 0; i < 500; i += 1) {
      const dwell = sampleDwellMs(base({ dwellMedianS: 20, dwellMaxS: 90 }), () => r)
      expect(dwell).toBeGreaterThanOrEqual(1)
      expect(dwell).toBeLessThanOrEqual(90_000)
      r = (r + 0.001999) % 1
    }
  })

  it('clusters around the configured median', () => {
    // Sweep the unit interval; the median draw should sit near 20s.
    let sum = 0
    let n = 0
    for (let i = 1; i < 100; i += 2) {
      sum += sampleDwellMs(base({ dwellMedianS: 20 }), () => i / 100)
      n += 1
    }
    const meanS = sum / n / 1000
    expect(meanS).toBeGreaterThan(14)
    expect(meanS).toBeLessThan(34)
  })

  it('respects the configured median and cap', () => {
    expect(sampleDwellMs(base({ dwellMedianS: 5, dwellMaxS: 6 }), () => 0.5)).toBeLessThanOrEqual(6_000)
    expect(sampleDwellMs(base({ dwellMedianS: 5, dwellMaxS: 6 }), () => 0.5)).toBeGreaterThanOrEqual(1)
  })
})

describe('spacing jitter', () => {
  it('stays positive and within the jitter band of the dwell sample', () => {
    for (const r of [0, 0.25, 0.5, 0.99]) {
      const spacing = sampleSpacingMs(base({ dwellMedianS: 20, dwellMaxS: 90 }), () => r)
      expect(spacing).toBeGreaterThanOrEqual(1)
      const dwell = sampleDwellMs(base({ dwellMedianS: 20, dwellMaxS: 90 }), () => r)
      expect(spacing).toBeLessThanOrEqual(Math.ceil(dwell * 1.31))
    }
  })
})

describe('break cadence', () => {
  it('samples breakEvery inside [min, max]', () => {
    for (const r of [0, 0.5, 0.9999]) {
      expect(sampleBreakEvery(base(), () => r)).toBeGreaterThanOrEqual(5)
      expect(sampleBreakEvery(base(), () => r)).toBeLessThanOrEqual(12)
    }
  })

  it('samples the break length inside [breakMinS, breakMaxS]', () => {
    for (const r of [0, 0.5, 0.9999]) {
      const ms = sampleBreakMs(base(), () => r)
      expect(ms).toBeGreaterThanOrEqual(120_000)
      expect(ms).toBeLessThanOrEqual(360_000)
    }
  })

  it('is due only when the page count reaches the drawn cycle', () => {
    expect(isBreakDue(4, 5)).toBe(false)
    expect(isBreakDue(5, 5)).toBe(true)
    expect(isBreakDue(9, 7)).toBe(true)
  })

  it('defers with reason break when the cycle completes, then resets', () => {
    const random = () => 0.5
    // A fresh host draws its cycle length: 0.5 lands mid-range (5..12).
    const first = pacingGate(emptyHostState('gated.example'), base(), 0, random)
    expect(first.admitted).toBe(true)
    const cycle = first.state.breakEvery ?? 0
    expect(cycle).toBeGreaterThanOrEqual(5)
    expect(cycle).toBeLessThanOrEqual(12)

    // Serve pages until the cycle completes: the gate defers with a break.
    let state = first.state
    let deferred: { reason?: string; waitMs: number } | null = null
    for (let i = 0; i < cycle + 2; i += 1) {
      const verdict = pacingGate(state, base(), (i + 1) * 10 * 60 * 1000, random)
      if (!verdict.admitted) {
        deferred = verdict
        state = verdict.state
        break
      }
      state = verdict.state
    }
    expect(deferred).not.toBeNull()
    expect(deferred?.reason).toBe('break')
    // The break lasts between 2 and 6 minutes.
    expect(deferred?.waitMs).toBeGreaterThanOrEqual(120_000)
    expect(deferred?.waitMs).toBeLessThanOrEqual(360_000)
    // The counter resets and a new cycle is drawn.
    expect(state.pagesSinceBreak).toBe(0)
    expect(state.breakEvery).toBeGreaterThanOrEqual(5)
    expect(state.breakEvery).toBeLessThanOrEqual(12)
  })
})

describe('pacing gate', () => {
  it('admits the first request and defers the immediate second', () => {
    const state = emptyHostState('gated.example')
    const first = pacingGate(state, base({ dwellMedianS: 20 }), 0, () => 0.5)
    expect(first.admitted).toBe(true)
    // The second request at the same instant is spacing-deferred.
    const second = pacingGate(first.state, base(), 0, () => 0.5)
    expect(second.admitted).toBe(false)
    if (!second.admitted) expect(second.reason).toBe('spacing')
  })

  it('defers by the spacing wait when called too soon', () => {
    const config = base({ dwellMedianS: 20, dwellMaxS: 90 })
    const state = { ...emptyHostState('gated.example'), lastRequestAt: 0 }
    // Draw 0.5 keeps the dwell sample near the median; spacing >= 1ms.
    const verdict = pacingGate(state, config, 1000, () => 0.5)
    expect(verdict.admitted).toBe(false)
    if (!verdict.admitted) {
      expect(verdict.reason).toBe('spacing')
      expect(verdict.waitMs).toBeGreaterThan(0)
    }
  })

  it('admits after the spacing wait has passed', () => {
    const config = base({ dwellMedianS: 20, dwellMaxS: 90 })
    const state = { ...emptyHostState('gated.example'), lastRequestAt: 0 }
    // Any spacing sample is at most dwellMax * 1.3 seconds; 3 minutes clears it.
    const verdict = pacingGate(state, config, 3 * 60 * 1000, () => 0.5)
    expect(verdict.admitted).toBe(true)
  })

  it('rolls the daily window over after 24h', () => {
    const config = base({ dwellMedianS: 20, dwellMaxS: 90, dailyCap: 2 })
    const random = () => 0.5
    let state = emptyHostState('gated.example')
    let now = 3_600_000 // 01:00 local-ish
    let admits = 0
    for (let i = 0; i < 10 && admits < 2; i += 1) {
      const v = pacingGate(state, config, now, random)
      if (v.admitted) {
        state = v.state
        admits += 1
        now += 60_000
      } else {
        now += v.waitMs + 1
      }
    }
    expect(admits).toBe(2)
    // The window is full: further gates defer with daily_cap until it rolls.
    const next = pacingGate(state, config, now, random)
    expect(next.admitted).toBe(false)
    if (!next.admitted) expect(next.reason).toBe('daily_cap')
    const nextDay = pacingGate(state, config, (state.windowStart ?? now) + 24 * 60 * 60 * 1000, random)
    expect(nextDay.admitted).toBe(true)
  })
})

describe('working hours', () => {
  it('localHourOf reads the local clock', () => {
    const d = new Date()
    d.setHours(13, 0, 0, 0)
    expect(localHourOf(d.getTime())).toBe(13)
  })

  it('is open inside the window and closed outside', () => {
    const config = base({ hoursStart: 8, hoursEnd: 23 })
    const at = (h: number) => {
      const d = new Date()
      d.setHours(h, 30, 0, 0)
      return d.getTime()
    }
    expect(hoursGate(config, at(9)).open).toBe(true)
    expect(hoursGate(config, at(22)).open).toBe(true)
    expect(hoursGate(config, at(3)).open).toBe(false)
    expect(hoursGate(config, at(23)).open).toBe(false)
  })

  it('supports an overnight window', () => {
    const config = base({ hoursStart: 22, hoursEnd: 6 })
    const at = (h: number) => {
      const d = new Date()
      d.setHours(h, 0, 0, 0)
      return d.getTime()
    }
    expect(hoursGate(config, at(23)).open).toBe(true)
    expect(hoursGate(config, at(2)).open).toBe(true)
    expect(hoursGate(config, at(12)).open).toBe(false)
  })

  it('a 0..24 window is always open', () => {
    const config = base({ hoursStart: 0, hoursEnd: 24 })
    for (let h = 0; h < 24; h += 1) {
      const d = new Date()
      d.setHours(h, 0, 0, 0)
      expect(hoursGate(config, d.getTime()).open).toBe(true)
    }
  })

  it('the pacing gate defers with outside_hours and waits until the window opens', () => {
    const config = base({ hoursStart: 8, hoursEnd: 23 })
    const at = (h: number) => {
      const d = new Date()
      d.setHours(h, 15, 0, 0)
      return d.getTime()
    }
    const verdict = pacingGate(emptyHostState('gated.example'), config, at(5), () => 0.5)
    expect(verdict.admitted).toBe(false)
    if (!verdict.admitted) {
      expect(verdict.reason).toBe(OUTSIDE_HOURS_REASON)
      // 05:15 -> 08:00 is 2h45m.
      expect(verdict.waitMs).toBe(2 * 3_600_000 + 45 * 60_000)
    }
  })
})

describe('guardRun integration', () => {
  function fakeClock(start = 0) {
    let now = start
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  /** 10:30 on the fake clock's local day: inside a 08:00..23:00 window. */
  const IN_HOURS = (() => {
    const d = new Date()
    d.setHours(10, 30, 0, 0)
    return d.getTime()
  })()

  function guard(clock: ReturnType<typeof fakeClock>): GuardDeps {
    return {
      getHostState: async () => null,
      saveHostState: async () => {},
      clock: () => clock.now(),
      random: () => 0.5,
      sleep: async () => {},
      hasProfile: async () => false,
      config: {
        limits: { ...DEFAULT_LIMITS, walledGardens: ['gated.example'] },
      },
    }
  }

  it('paces a strict host through guardRun', async () => {
    const clock = fakeClock(IN_HOURS)
    const g = guard(clock)
    const out = await guardRun(g, 'gated.example', async () => 'fetched')
    expect(out.kind).toBe('ok')
  })

  it('defers the second request until the sampled spacing elapses', async () => {
    const clock = fakeClock(IN_HOURS)
    const store = new Map<string, unknown>()
    const g: GuardDeps = {
      ...guard(clock),
      getHostState: async (key) => (store.get(key) as never) ?? null,
      saveHostState: async (state) => {
        store.set(state.key, { ...state })
      },
    }
    const first = await guardRun(g, 'gated.example', async () => 'one')
    expect(first.kind).toBe('ok')
    // Immediately again: the pacing gate defers (spacing, break or hours).
    const second = await guardRun(g, 'gated.example', async () => 'two')
    expect(second.kind).toBe('defer')
    if (second.kind === 'defer') {
      expect(['spacing', 'break']).toContain(second.reason)
      expect(second.retryAfterMs).toBeGreaterThan(0)
    }
    // After the maximum possible spacing (dwellMax * 1.3 s) it admits again.
    clock.advance(90 * 1.3 * 1000 + 1000)
    const third = await guardRun(g, 'gated.example', async () => 'three')
    expect(third.kind).toBe('ok')
  })

  it('defers with outside_hours when the window is closed', async () => {
    const at = (h: number) => {
      const d = new Date()
      d.setHours(h, 0, 0, 0)
      return d.getTime()
    }
    const clock = fakeClock(at(4))
    const g = guard(clock)
    const out = await guardRun(g, 'gated.example', async () => 'never')
    expect(out.kind).toBe('defer')
    if (out.kind === 'defer') {
      expect(out.reason).toBe('outside_hours')
      // 04:00 -> 08:00.
      expect(out.retryAfterMs).toBe(4 * 3_600_000)
    }
  })

  it('releases the deferral when the clock reaches the window', async () => {
    const at = (h: number) => {
      const d = new Date()
      d.setHours(h, 0, 0, 0)
      return d.getTime()
    }
    const clock = fakeClock(at(7))
    const g = guard(clock)
    const out = await guardRun(g, 'gated.example', async () => 'never')
    void out
    clock.advance(60 * 60_000 + 60_000)
    const released = await guardRun(g, 'gated.example', async () => 'fetched')
    expect(released.kind).toBe('ok')
  })

  it('enforces the pacing daily cap and rolls over the next day', async () => {
    const clock = fakeClock(IN_HOURS)
    const store = new Map<string, unknown>()
    const g: GuardDeps = {
      ...guard(clock),
      getHostState: async (key) => (store.get(key) as never) ?? null,
      saveHostState: async (state) => {
        store.set(state.key, { ...state })
      },
      config: {
        limits: { ...DEFAULT_LIMITS, walledGardens: ['gated.example'] },
        pacing: base({ dailyCap: 2, dwellMedianS: 20, dwellMaxS: 90 }),
      },
    }
    let oks = 0
    let sawCap = false
    for (let i = 0; i < 40; i += 1) {
      const out = await guardRun(g, 'gated.example', async () => 'x')
      if (out.kind === 'ok') {
        oks += 1
        clock.advance(90 * 1.3 * 1000 + 1000)
      } else if (out.kind === 'defer') {
        if (out.reason === 'daily_cap') {
          sawCap = true
          break
        }
        clock.advance(out.retryAfterMs + 1000)
      }
    }
    expect(sawCap).toBe(true)
    expect(oks).toBe(2)
    // The next day the budget is back.
    clock.advance(24 * 60 * 60 * 1000)
    const nextDay = await guardRun(g, 'gated.example', async () => 'x')
    expect(nextDay.kind).toBe('ok')
  })

  it('ordinary hosts keep the fixed 2s spacing, not human pacing', async () => {
    const clock = fakeClock(IN_HOURS)
    const g = guard(clock)
    const first = await guardRun(g, 'open.example', async () => 'one')
    expect(first.kind).toBe('ok')
    // 2s later the ordinary host admits again (jitter band 1.4s..2.6s).
    clock.advance(3_000)
    const second = await guardRun(g, 'open.example', async () => 'two')
    expect(second.kind).toBe('ok')
  })
})

describe('hoursGate: the wait to the next opening', () => {
  it('waits until tomorrow when the window start is already past today', () => {
    const config = base({ hoursStart: 3, hoursEnd: 4 })
    const at = (h: number, min = 0) => {
      const d = new Date()
      d.setHours(h, min, 0, 0)
      return d.getTime()
    }
    // 19:30 with a 03:00 to 04:00 window: the next opening is tomorrow 03:00.
    const { open, opensInMs } = hoursGate(config, at(19, 30))
    expect(open).toBe(false)
    expect(opensInMs).toBe(7.5 * 60 * 60 * 1000)
  })

  it('never reports a zero wait for a closed window', () => {
    for (let start = 0; start < 24; start += 5) {
      const config = base({ hoursStart: start, hoursEnd: (start + 1) % 24 })
      for (let hour = 0; hour < 24; hour += 3) {
        const d = new Date()
        d.setHours(hour, 17, 0, 0)
        const { open, opensInMs } = hoursGate(config, d.getTime())
        if (!open) expect(opensInMs).toBeGreaterThan(0)
      }
    }
  })
})
