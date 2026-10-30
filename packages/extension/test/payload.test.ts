import { describe, expect, it } from 'vitest'
import {
  buildCapturePayload,
  serializeCapturePayload,
  DEFAULT_SOURCE,
  CONTENT_TYPE_PAGE,
} from '../src/payload.js'

describe('buildCapturePayload', () => {
  const now = new Date('2026-10-30T12:00:00.000Z')

  it('builds the wire shape the server expects', () => {
    const payload = buildCapturePayload(
      {
        url: 'https://example.com/article',
        title: 'An article',
        body: '# An article\n\nBody text.',
      },
      { now },
    )
    expect(payload).toEqual({
      url: 'https://example.com/article',
      title: 'An article',
      capturedAt: '2026-10-30T12:00:00.000Z',
      contentType: CONTENT_TYPE_PAGE,
      body: '# An article\n\nBody text.',
      source: DEFAULT_SOURCE,
    })
  })

  it('serialises to JSON with the required fields', () => {
    const payload = buildCapturePayload(
      { url: 'https://example.com/a', body: 'text' },
      { now },
    )
    const parsed = JSON.parse(serializeCapturePayload(payload))
    expect(parsed.url).toBe('https://example.com/a')
    expect(parsed.capturedAt).toBe('2026-10-30T12:00:00.000Z')
    expect(parsed.contentType).toBe('page')
    expect(parsed.body).toBe('text')
    expect(parsed.source).toBe('extension')
  })

  it('drops a blank title and a blank selection', () => {
    const payload = buildCapturePayload(
      { url: 'https://example.com/a', title: '   ', body: 'text', selection: '  ' },
      { now },
    )
    expect(payload.title).toBeUndefined()
    expect(payload.selection).toBeUndefined()
  })

  it('keeps a selection when there is one', () => {
    const payload = buildCapturePayload(
      { url: 'https://example.com/a', body: 'text', selection: 'a quoted fragment' },
      { now },
    )
    expect(payload.selection).toBe('a quoted fragment')
  })

  it('carries the free-form meta through unchanged', () => {
    const payload = buildCapturePayload(
      {
        url: 'https://example.com/reel',
        body: 'text',
        meta: { ogType: 'video.other', twitterCard: 'player' },
      },
      { now },
    )
    expect(payload.meta).toEqual({ ogType: 'video.other', twitterCard: 'player' })
  })

  it('omits an empty meta object', () => {
    const payload = buildCapturePayload(
      { url: 'https://example.com/a', body: 'text', meta: {} },
      { now },
    )
    expect(payload.meta).toBeUndefined()
  })

  it('uses the injected source identity', () => {
    const payload = buildCapturePayload(
      { url: 'https://example.com/a', body: 'text' },
      { now, source: 'extension@browseros' },
    )
    expect(payload.source).toBe('extension@browseros')
  })

  it('uses the current time when no clock is injected', () => {
    const before = Date.now()
    const payload = buildCapturePayload({ url: 'https://example.com/a', body: 'text' })
    const at = new Date(payload.capturedAt).getTime()
    expect(at).toBeGreaterThanOrEqual(before - 1000)
    expect(at).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('does not mutate the meta object it was given', () => {
    const meta = { ogType: 'video' }
    const payload = buildCapturePayload(
      { url: 'https://example.com/a', body: 'text', meta },
      { now },
    )
    payload.meta!['ogType'] = 'changed'
    expect(meta.ogType).toBe('video')
  })
})
