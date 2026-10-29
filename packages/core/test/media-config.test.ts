import { describe, expect, it } from 'vitest'
import { parseMediaConfig } from '../src/config.js'
import {
  mediaFromToml,
  DEFAULT_MEDIA_CONFIG,
  MEDIA_TIERS,
} from '../src/media-config.js'

describe('media config', () => {
  it('defaults when the table is missing', () => {
    expect(mediaFromToml({})).toEqual(DEFAULT_MEDIA_CONFIG)
    expect(DEFAULT_MEDIA_CONFIG.cookiesFromBrowser).toBe(false)
  })

  it('parses the [media] table', () => {
    const config = parseMediaConfig(`
      [media]
      enabled_tiers = ["caption", "transcript", "frames"]
      daily_cap = 5
      max_duration_seconds = 120
      cookies_from_browser = true

      [media.daily_caps]
      transcript = 3
    `)
    expect(config.enabledTiers).toEqual(['caption', 'transcript', 'frames'])
    expect(config.dailyCap).toBe(5)
    expect(config.maxDurationSeconds).toBe(120)
    expect(config.cookiesFromBrowser).toBe(true)
    expect(config.dailyCaps).toEqual({ transcript: 3 })
  })

  it('ignores unknown tiers and non-numeric caps', () => {
    const config = mediaFromToml({
      media: {
        enabled_tiers: ['caption', 'whatever', 42],
        daily_caps: { transcript: 'lots', frames: 1 },
      },
    })
    expect(config.enabledTiers).toEqual(['caption'])
    expect(config.dailyCaps).toEqual({ frames: 1 })
  })

  it('knows the three tier names', () => {
    expect(MEDIA_TIERS).toEqual(['caption', 'transcript', 'frames'])
  })
})
