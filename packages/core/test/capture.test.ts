import { describe, expect, it } from 'vitest'
import { FakeStore } from './fake-store.js'
import {
  captureIngest,
  parseCapture,
  captureFromToml,
  tokensEqual,
  captureToken,
  DEFAULT_CAPTURE_CONFIG,
  CaptureValidationError,
} from '../src/index.js'
import { normalizeUrl } from '../src/url.js'

const BASE = {
  url: 'https://example.com/page',
  capturedAt: '2026-10-29T12:00:00.000Z',
  contentType: 'page' as const,
  body: 'captured body',
  source: 'stash',
}

describe('parseCapture', () => {
  it('accepts a valid page capture', () => {
    expect(() => parseCapture(BASE)).not.toThrow()
  })

  it('rejects content types other than page', () => {
    expect(() => parseCapture({ ...BASE, contentType: 'note' })).toThrow(CaptureValidationError)
  })

  it('rejects a non-ISO capturedAt', () => {
    expect(() => parseCapture({ ...BASE, capturedAt: 'yesterday' })).toThrow(CaptureValidationError)
  })

  it('rejects a missing body or source', () => {
    expect(() => parseCapture({ ...BASE, body: '' })).toThrow(CaptureValidationError)
    expect(() => parseCapture({ ...BASE, source: '' })).toThrow(CaptureValidationError)
  })
})

describe('captureFromToml', () => {
  it('defaults to the standard token env and no origins', () => {
    expect(captureFromToml({})).toEqual(DEFAULT_CAPTURE_CONFIG)
  })

  it('reads token_env, allowed_origins and max_body_bytes', () => {
    const cfg = captureFromToml({
      capture: {
        token_env: 'MY_TOKEN',
        allowed_origins: ['chrome-extension://abc'],
        max_body_bytes: 4096,
      },
    })
    expect(cfg.tokenEnv).toBe('MY_TOKEN')
    expect(cfg.allowedOrigins).toEqual(['chrome-extension://abc'])
    expect(cfg.maxBodyBytes).toBe(4096)
  })

  it('ignores garbage values', () => {
    const cfg = captureFromToml({ capture: { max_body_bytes: 'nope', allowed_origins: 'x' } })
    expect(cfg.maxBodyBytes).toBe(DEFAULT_CAPTURE_CONFIG.maxBodyBytes)
    expect(cfg.allowedOrigins).toEqual([])
  })
})

describe('tokensEqual', () => {
  it('matches equal tokens', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true)
  })

  it('rejects different tokens of any length', () => {
    expect(tokensEqual('abc', 'abd')).toBe(false)
    expect(tokensEqual('abc', 'abcd')).toBe(false)
  })
})

describe('captureToken', () => {
  it('reads from the configured env var', () => {
    expect(captureToken(DEFAULT_CAPTURE_CONFIG, { ATENTO_CAPTURE_TOKEN: 'x' })).toBe('x')
  })

  it('returns null when unset or blank', () => {
    expect(captureToken(DEFAULT_CAPTURE_CONFIG, {})).toBeNull()
    expect(captureToken(DEFAULT_CAPTURE_CONFIG, { ATENTO_CAPTURE_TOKEN: '  ' })).toBeNull()
  })
})

describe('captureIngest', () => {
  it('creates a captured link in extracted with the supplied body', async () => {
    const store = new FakeStore()
    const { outcome, link } = await captureIngest(store, parseCapture(BASE))
    expect(outcome).toBe('created')
    expect(link.state).toBe('extracted')
    expect(link.captured).toBe(true)
    expect(link.source).toBe('stash')
    expect(link.extractedContent).toBe('captured body')
    // The skip is visible in the history: created -> extracted, no extract run.
    const history = await store.getHistory(link.id)
    expect(history.some((h) => h.event === 'EXTRACTED')).toBe(true)
  })

  it('dedupes by normalized url hash', async () => {
    const store = new FakeStore()
    await captureIngest(store, parseCapture({ ...BASE, url: 'https://example.com/p?utm_source=x' }))
    const second = await captureIngest(store, parseCapture({ ...BASE, url: 'https://example.com/p', body: 'second' }))
    expect(second.outcome).toBe('duplicate')
    expect(second.link.extractedContent).toBe('captured body')
    const links = await store.listLinks({})
    expect(links).toHaveLength(1)
  })

  it('updates an anonymous-extracted link with a newer capture', async () => {
    const store = new FakeStore()
    const { hash, url } = normalizeUrl(BASE.url)
    const seeded = await store.upsertLink({ urlHash: hash, url, source: 'test', status: 'inbox', needsBrowser: false })
    await store.setExtractedContent(seeded.id, 'anonymous body', false, new Date('2026-01-01T00:00:00Z'))
    const { outcome } = await captureIngest(store, parseCapture(BASE))
    expect(outcome).toBe('updated')
    const link = await store.getLink(seeded.id)
    expect(link?.extractedContent).toBe('captured body')
    expect(link?.captured).toBe(true)
  })

  it('keeps a newer captured link over an older capture', async () => {
    const store = new FakeStore()
    const { hash, url } = normalizeUrl(BASE.url)
    const seeded = await store.upsertLink({ urlHash: hash, url, source: 'test', status: 'inbox', needsBrowser: false })
    await store.setExtractedContent(seeded.id, 'newer captured', false, new Date('2026-10-29T13:00:00Z'))
    await store.markCaptured(seeded.id, new Date('2026-10-29T13:00:00Z'))
    const { outcome } = await captureIngest(store, parseCapture(BASE))
    expect(outcome).toBe('duplicate')
    expect((await store.getLink(seeded.id))?.extractedContent).toBe('newer captured')
  })

  it('fills empty content regardless of timestamps', async () => {
    const store = new FakeStore()
    const { hash, url } = normalizeUrl(BASE.url)
    const seeded = await store.upsertLink({ urlHash: hash, url, source: 'test', status: 'inbox', needsBrowser: false })
    const { outcome } = await captureIngest(store, parseCapture(BASE))
    expect(outcome).toBe('updated')
    expect((await store.getLink(seeded.id))?.extractedContent).toBe('captured body')
  })

  it('never touches a deleted link', async () => {
    const store = new FakeStore()
    const { hash, url } = normalizeUrl(BASE.url)
    const seeded = await store.upsertLink({ urlHash: hash, url, source: 'test', status: 'inbox', needsBrowser: false })
    await store.deleteLinks([seeded.id])
    const { outcome } = await captureIngest(store, parseCapture(BASE))
    expect(outcome).toBe('duplicate')
    expect((await store.getLink(seeded.id))?.extractedContent).toBeNull()
  })
})
