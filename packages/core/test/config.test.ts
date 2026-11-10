import { describe, expect, it } from 'vitest'
import { parseTtlConfig } from '../src/config.js'

const TOML = `
# ~/.atento/config.toml
[ttl]
default_days = 30
by_category = { job = 45, event = 7, guide = 90 }
archive_after_days = 90
delete_after_days = 365
`

describe('parseTtlConfig', () => {
  it('parses the [ttl] table from raw TOML text', () => {
    const cfg = parseTtlConfig(TOML)
    expect(cfg.default_days).toBe(30)
    expect(cfg.by_category).toEqual({ job: 45, event: 7, guide: 90 })
    expect(cfg.archive_after_days).toBe(90)
    expect(cfg.delete_after_days).toBe(365)
  })

  it('applies defaults when the document has no [ttl] table', () => {
    const cfg = parseTtlConfig('[other]\nkey = "value"\n')
    expect(cfg.default_days).toBe(30)
  })

  it('throws a useful error on malformed TOML', () => {
    expect(() => parseTtlConfig('[ttl\nbroken')).toThrow()
  })
})
