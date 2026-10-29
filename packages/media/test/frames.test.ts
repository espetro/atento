import { describe, expect, it } from 'vitest'
import { FRAMES_UNSUPPORTED_REASON, framesTier } from '../src/frames.js'
import { mediaReportSchema } from '../src/types.js'

describe('frames tier', () => {
  it('reports unsupported with a stable reason', () => {
    const result = framesTier(1.5)
    expect(result.tier).toBe('frames')
    expect(result.status).toBe('unsupported')
    expect(result.kind === 'unsupported' ? result.reason : '').toBe(FRAMES_UNSUPPORTED_REASON)
    expect(result.kind === 'unsupported' ? result.reason : '').toBe(
      'frame analysis not implemented',
    )
  })

  it('fits the report schema', () => {
    const report = mediaReportSchema.parse({
      url: 'https://example.com/video',
      tiers: [framesTier()],
    })
    expect(report.tiers[0]?.status).toBe('unsupported')
  })
})
