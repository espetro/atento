import { describe, expect, it } from 'vitest'
import { EnrichmentSchema } from '../src/enrichment.js'

const valid = {
  category: 'job',
  priority: 'normal',
  why_it_matters: 'role closes in a week',
  read_minutes: 3,
  action: 'read_now',
  expires_at: '2026-11-30',
  expiry_reason: 'job posting',
  confidence: 0.8,
}

describe('EnrichmentSchema', () => {
  it('accepts a well formed enrichment', () => {
    const parsed = EnrichmentSchema.parse(valid)
    expect(parsed.category).toBe('job')
    expect(parsed.expires_at).toBe('2026-11-30')
  })

  it('allows null expiry fields', () => {
    const parsed = EnrichmentSchema.parse({ ...valid, expires_at: null, expiry_reason: null })
    expect(parsed.expires_at).toBeNull()
  })

  it('rejects invalid priorities, actions and out of range confidence', () => {
    expect(() => EnrichmentSchema.parse({ ...valid, priority: 'urgent' })).toThrow()
    expect(() => EnrichmentSchema.parse({ ...valid, action: 'maybe' })).toThrow()
    expect(() => EnrichmentSchema.parse({ ...valid, confidence: 1.5 })).toThrow()
    expect(() => EnrichmentSchema.parse({ ...valid, read_minutes: -1 })).toThrow()
  })
})
