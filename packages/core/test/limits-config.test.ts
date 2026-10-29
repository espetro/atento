import { describe, expect, it } from 'vitest'
import { parseLimitsConfig } from '../src/config.js'
import { DEFAULT_LIMITS } from '../src/resilience/limiter.js'

describe('limits config', () => {
  it('defaults apply when the table is missing', () => {
    expect(parseLimitsConfig('')).toEqual(DEFAULT_LIMITS)
  })

  it('reads the top level limits', () => {
    const limits = parseLimitsConfig(`
[limits]
global_concurrency = 4
max_batch = 7
llm_concurrency = 2
`)
    expect(limits.globalConcurrency).toBe(4)
    expect(limits.maxBatch).toBe(7)
    expect(limits.llmConcurrency).toBe(2)
  })

  it('reads per-host overrides', () => {
    const limits = parseLimitsConfig(`
[limits.hosts."x.com"]
interval_ms = 90000
daily_cap = 10
concurrency = 1
`)
    expect(limits.hosts['x.com']).toEqual({
      intervalMs: 90000,
      dailyCap: 10,
      concurrency: 1,
    })
  })

  it('ignores garbage values and keeps the defaults', () => {
    const limits = parseLimitsConfig(`
[limits]
global_concurrency = "nope"
[limits.hosts."example.com"]
interval_ms = "nope"
`)
    expect(limits.globalConcurrency).toBe(DEFAULT_LIMITS.globalConcurrency)
    expect(limits.hosts['example.com']).toEqual({})
  })
})
