import { describe, expect, it } from 'vitest'
import { ttlFromToml, ttlDaysForCategory, DEFAULT_TTL_CONFIG } from '../src/ttl.js'

describe('ttlFromToml', () => {
  it('reads the [ttl] table', () => {
    const cfg = ttlFromToml({
      ttl: {
        default_days: 30,
        by_category: { job: 45, event: 7, guide: 90 },
        archive_after_days: 90,
        delete_after_days: 365,
      },
    })
    expect(cfg.default_days).toBe(30)
    expect(cfg.by_category).toEqual({ job: 45, event: 7, guide: 90 })
    expect(cfg.archive_after_days).toBe(90)
    expect(cfg.delete_after_days).toBe(365)
  })

  it('falls back to defaults for missing keys', () => {
    const cfg = ttlFromToml({ ttl: { default_days: 14 } })
    expect(cfg.default_days).toBe(14)
    expect(cfg.archive_after_days).toBe(DEFAULT_TTL_CONFIG.archive_after_days)
    expect(cfg.delete_after_days).toBe(DEFAULT_TTL_CONFIG.delete_after_days)
    expect(cfg.by_category).toEqual({})
  })

  it('returns defaults when there is no [ttl] table', () => {
    expect(ttlFromToml({})).toEqual(DEFAULT_TTL_CONFIG)
  })

  it('rejects wrong types and inconsistent windows', () => {
    expect(() => ttlFromToml({ ttl: { default_days: 'thirty' } })).toThrow(TypeError)
    expect(() => ttlFromToml({ ttl: { default_days: -1 } })).toThrow(TypeError)
    expect(() => ttlFromToml({ ttl: { by_category: { job: 45 } } })).not.toThrow()
    expect(() => ttlFromToml({ ttl: { default_days: 100, archive_after_days: 30 } })).toThrow(
      TypeError,
    )
    expect(() =>
      ttlFromToml({ ttl: { default_days: 10, archive_after_days: 20, delete_after_days: 15 } }),
    ).toThrow(TypeError)
  })
})

describe('ttlDaysForCategory', () => {
  const cfg = ttlFromToml({
    ttl: { default_days: 30, by_category: { job: 45, event: 7 } },
  })

  it('overrides with by_category', () => {
    expect(ttlDaysForCategory(cfg, 'job')).toBe(45)
    expect(ttlDaysForCategory(cfg, 'event')).toBe(7)
  })

  it('falls back to default_days for unknown or missing categories', () => {
    expect(ttlDaysForCategory(cfg, 'unknown')).toBe(30)
    expect(ttlDaysForCategory(cfg, null)).toBe(30)
    expect(ttlDaysForCategory(cfg, undefined)).toBe(30)
  })
})
