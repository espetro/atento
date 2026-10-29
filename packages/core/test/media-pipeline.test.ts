/**
 * The media stage wiring inside the extract stage: video links get a media
 * run appended to their extracted content, captured links keep their own
 * content, and a media failure never fails the link. Everything here is
 * faked at the MediaFn level, so the tests run offline.
 */
import { describe, expect, it } from 'vitest'
import {
  extract,
  ingest,
  isMediaLink,
  isVideoMeta,
  isVideoUrl,
  type ExtractFn,
  type MediaFn,
  type RawLink,
} from '../src/index.js'
import { FakeStore } from './fake-store.js'

const raw = (url: string, source = 'capture', extra: Partial<RawLink> = {}): RawLink => ({
  url,
  source,
  ...extra,
})

const mediaReport = (url: string, tiers = [{ tier: 'caption' as const, status: 'ok' as const }]) => ({
  url,
  tiers,
})

/** A media fn that reports what it was called with. */
function fakeMediaFn(records: Record<string, unknown>[]): MediaFn {
  return async (input) => {
    records.push({ ...input })
    return {
      report: mediaReport(input.url),
      markdown: '## Caption\n\nfrom the media stage',
    }
  }
}

const extractVideo: ExtractFn = async (url) => ({
  markdown: `extracted markdown for ${url}`,
  meta: { ogType: 'video.other' },
})

describe('media wiring in the extract stage', () => {
  it('runs the media stage for video links and appends the rendered markdown', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://video.example/reel/1')])
    const calls: Record<string, unknown>[] = []
    const result = await extract(store, {
      extract: extractVideo,
      media: fakeMediaFn(calls),
    })

    expect(result.mediaCount).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.['url']).toBe('https://video.example/reel/1')
    expect(calls[0]?.['meta']).toEqual({ ogType: 'video.other' })

    const link = store.links[0]!
    expect(link.mediaReport?.tiers).toEqual([{ tier: 'caption', status: 'ok' }])
    expect(link.extractedContent).toBe(
      'extracted markdown for https://video.example/reel/1\n\n## Caption\n\nfrom the media stage',
    )
    expect(store.metrics.find((m) => m.stage === 'extract' && m.key === 'media')?.value).toBe(1)
  })

  it('does not run the media stage for plain links', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://example.com/article')])
    const calls: Record<string, unknown>[] = []
    const result = await extract(store, {
      extract: async () => ({ markdown: 'plain article', meta: { ogType: 'article' } }),
      media: fakeMediaFn(calls),
    })

    expect(result.mediaCount).toBe(0)
    expect(calls).toHaveLength(0)
    expect(store.links[0]?.mediaReport).toBeNull()
    expect(store.links[0]?.extractedContent).toBe('plain article')
  })

  it('a captured link skips the download: only the caption tier runs', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://video.example/reel/2')])
    await store.markCaptured(store.links[0]!.id, new Date())
    const calls: Record<string, unknown>[] = []
    const result = await extract(store, {
      extract: extractVideo,
      media: fakeMediaFn(calls),
    })

    expect(result.mediaCount).toBe(1)
    expect(calls[0]?.['tiers']).toEqual(['caption'])
  })

  it('a media failure never fails the link and keeps the extracted content', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://video.example/reel/3')])
    const failing: MediaFn = async (input) => ({
      report: {
        url: input.url,
        tiers: [
          { tier: 'caption', status: 'ok' as const },
          { tier: 'transcript', status: 'failed' as const, error: 'boom' },
          { tier: 'frames', status: 'unsupported' as const, reason: 'not implemented' },
        ],
      },
      markdown: '## Caption\n\nkept content',
    })
    const result = await extract(store, { extract: extractVideo, media: failing })

    expect(result.errorCount).toBe(0)
    expect(result.okCount).toBe(1)
    const link = store.links[0]!
    expect(link.mediaReport?.tiers.map((t) => t.status)).toEqual(['ok', 'failed', 'unsupported'])
    expect(link.extractedContent).toContain('kept content')
  })

  it('a media fn that throws does not fail the link either', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://video.example/reel/4')])
    const throwing: MediaFn = async () => {
      throw new Error('media blew up')
    }
    const result = await extract(store, { extract: extractVideo, media: throwing })

    expect(result.errorCount).toBe(0)
    expect(result.mediaCount).toBe(0)
    expect(store.links[0]?.extractedContent).toContain('extracted markdown')
    expect(store.links[0]?.mediaReport).toBeNull()
  })

  it('runs without a media stage injected (no regression)', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://video.example/reel/5')])
    const result = await extract(store, { extract: extractVideo })

    expect(result.mediaCount).toBe(0)
    expect(store.links[0]?.extractedContent).toBe(
      'extracted markdown for https://video.example/reel/5',
    )
  })
})

describe('video detection', () => {
  it('detects video from og:type metadata', () => {
    expect(isVideoMeta({ ogType: 'video.other' })).toBe(true)
    expect(isVideoMeta({ ogType: 'movie' })).toBe(true)
    expect(isVideoMeta({ ogType: 'article' })).toBe(false)
  })

  it('detects video from twitter:card and VideoObject markers', () => {
    expect(isVideoMeta({ twitterCard: 'player' })).toBe(true)
    expect(isVideoMeta({ videoObject: true })).toBe(true)
    expect(isVideoMeta({ author: 'someone' })).toBe(false)
  })

  it('detects video urls without any metadata', () => {
    expect(isVideoUrl('https://example.com/reel/123')).toBe(true)
    expect(isVideoUrl('https://example.com/watch?v=abc')).toBe(true)
    expect(isVideoUrl('https://example.com/media/file.mp4')).toBe(true)
    expect(isVideoUrl('https://example.com/blog/some-post')).toBe(false)
    expect(isVideoUrl('not a url')).toBe(false)
  })

  it('isMediaLink combines metadata and url detection, no host names', () => {
    expect(isMediaLink('https://anything.example/clip/x', null)).toBe(true)
    expect(isMediaLink('https://anything.example/page', { isVideo: true })).toBe(true)
    expect(isMediaLink('https://anything.example/page', null)).toBe(false)
  })
})
