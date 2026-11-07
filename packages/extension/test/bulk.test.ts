import { describe, expect, it } from 'vitest'
import {
  buildIngestBatches,
  captureKey,
  chunk,
  collectBookmarkUrls,
  collectTabUrls,
  ingestKey,
  INGEST_BATCH_MAX,
  isHttpUrl,
  shortHash,
} from '../src/bulk.js'

describe('isHttpUrl', () => {
  it('accepts http and https only', () => {
    expect(isHttpUrl('https://example.com')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
    expect(isHttpUrl('ftp://example.com')).toBe(false)
    expect(isHttpUrl('chrome://extensions')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})

describe('collectTabUrls', () => {
  it('keeps http(s) tabs, drops private windows, dupes and denied hosts', () => {
    const urls = collectTabUrls([
      { url: 'https://a.com/1' },
      { url: 'https://a.com/1' }, // dupe
      { url: 'https://b.com/2', incognito: true }, // private window
      { url: 'chrome://extensions' },
      { url: 'https://secure.bank/login' }, // deny list
      { url: undefined }, // no url
      { url: 'https://c.com/3' },
    ])
    expect(urls).toEqual(['https://a.com/1', 'https://c.com/3'])
  })
})

describe('collectBookmarkUrls', () => {
  it('flattens a bookmark tree depth-first, deduped, http(s) only', () => {
    const urls = collectBookmarkUrls([
      {
        title: 'folder',
        children: [
          { title: 'a', url: 'https://a.com' },
          {
            title: 'sub',
            children: [
              { title: 'b', url: 'https://b.com' },
              { title: 'a2', url: 'https://a.com' }, // dupe
              { title: 'sep', url: 'place:folder' }, // not http
            ],
          },
        ],
      },
      { title: 'top', url: 'https://top.com' },
    ])
    expect(urls).toEqual(['https://a.com', 'https://b.com', 'https://top.com'])
  })
})

describe('chunk', () => {
  it('splits into fixed-size chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
  })
})

describe('idempotency keys', () => {
  it('captureKey is stable per url+capturedAt', () => {
    expect(captureKey('https://a.com', '2026-01-01T00:00:00.000Z')).toBe(
      'capture:https://a.com:2026-01-01T00:00:00.000Z',
    )
  })

  it('ingestKey is order-insensitive and content-sensitive', () => {
    const a = ingestKey(['https://b.com', 'https://a.com'])
    const b = ingestKey(['https://a.com', 'https://b.com'])
    const c = ingestKey(['https://a.com'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^ingest:[0-9a-f]+$/)
  })

  it('shortHash is deterministic', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'))
    expect(shortHash('abc')).not.toBe(shortHash('abd'))
  })
})

describe('buildIngestBatches', () => {
  it('filters, dedupes and chunks at the server cap', () => {
    const urls = Array.from({ length: INGEST_BATCH_MAX + 10 }, (_, i) => `https://e.com/${i}`)
    urls.push('https://e.com/0') // dupe
    urls.push('https://secure.bank/x') // denied
    urls.push('ftp://e.com/nope') // not http
    const batches = buildIngestBatches(urls)
    expect(batches).toHaveLength(2)
    expect(batches[0]?.payload.urls).toHaveLength(INGEST_BATCH_MAX)
    expect(batches[1]?.payload.urls).toHaveLength(10)
    for (const batch of batches) {
      expect(batch.payload.kind).toBe('urls')
      expect(batch.idempotencyKey).toBe(ingestKey(batch.payload.urls))
    }
  })

  it('produces identical keys for identical selections (retry dedupe)', () => {
    const a = buildIngestBatches(['https://a.com', 'https://b.com'])
    const b = buildIngestBatches(['https://b.com', 'https://a.com'])
    expect(a[0]?.idempotencyKey).toBe(b[0]?.idempotencyKey)
  })

  it('passes note and tags through', () => {
    const [batch] = buildIngestBatches(['https://a.com'], { note: 'bulk', tags: ['x'] })
    expect(batch?.payload.note).toBe('bulk')
    expect(batch?.payload.tags).toEqual(['x'])
  })

  it('honours a smaller batchSize for tests', () => {
    const batches = buildIngestBatches(['https://a.com', 'https://b.com', 'https://c.com'], {
      batchSize: 2,
    })
    expect(batches.map((b) => b.payload.urls.length)).toEqual([2, 1])
  })
})
