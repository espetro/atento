import { describe, expect, it } from 'vitest'
import { parsePacingConfig } from '../src/config.js'
import { DEFAULT_PACING } from '../src/resilience/human-pacing.js'

describe('pacing config', () => {
  it('defaults apply when the table is missing', () => {
    expect(parsePacingConfig('')).toEqual(DEFAULT_PACING)
  })

  it('reads the pacing table', () => {
    const pacing = parsePacingConfig(`
[pacing]
dwell_median_s = 30
dwell_max_s = 120
break_every_min = 3
break_every_max = 8
break_min_s = 60
break_max_s = 240
daily_cap = 25
hours_start = 9
hours_end = 21
`)
    expect(pacing).toEqual({
      dwellMedianS: 30,
      dwellMaxS: 120,
      breakEveryMin: 3,
      breakEveryMax: 8,
      breakMinS: 60,
      breakMaxS: 240,
      dailyCap: 25,
      hoursStart: 9,
      hoursEnd: 21,
    })
  })

  it('ignores garbage values and keeps the defaults', () => {
    const pacing = parsePacingConfig(`
[pacing]
dwell_median_s = "nope"
daily_cap = -3
`)
    expect(pacing.dwellMedianS).toBe(DEFAULT_PACING.dwellMedianS)
    expect(pacing.dailyCap).toBe(0)
  })

  it('the dwell cap never sits below the median', () => {
    const pacing = parsePacingConfig(`
[pacing]
dwell_median_s = 60
dwell_max_s = 10
`)
    expect(pacing.dwellMaxS).toBe(60)
  })

  it('a 0..24 window and a huge cap disable the profile', () => {
    const pacing = parsePacingConfig(`
[pacing]
daily_cap = 1000000
hours_start = 0
hours_end = 24
`)
    expect(pacing.hoursStart).toBe(0)
    expect(pacing.hoursEnd).toBe(24)
    expect(pacing.dailyCap).toBe(1_000_000)
  })
})
