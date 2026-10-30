import { describe, expect, it } from 'vitest'
import {
  decideCapture,
  isPrivilegedUrl,
  matchesDenyPattern,
  DEFAULT_DENY_LIST,
} from '../src/guard.js'
import { runActiveTabCapture, type CaptureDeps } from '../src/capture.js'

describe('matchesDenyPattern', () => {
  it('matches an exact host', () => {
    expect(matchesDenyPattern('privatebank.com', 'privatebank.com')).toBe(true)
    expect(matchesDenyPattern('www.privatebank.com', 'privatebank.com')).toBe(false)
  })

  it('matches a wildcard suffix, including the bare suffix', () => {
    expect(matchesDenyPattern('secure.bank', '*.bank')).toBe(true)
    expect(matchesDenyPattern('bank', '*.bank')).toBe(true)
    expect(matchesDenyPattern('notbank.com', '*.bank')).toBe(false)
  })
})

describe('isPrivilegedUrl', () => {
  it('rejects browser-owned pages', () => {
    expect(isPrivilegedUrl('chrome://extensions')).toBe(true)
    expect(isPrivilegedUrl('chrome-extension://abc/options.html')).toBe(true)
    expect(isPrivilegedUrl('about:blank')).toBe(true)
    expect(isPrivilegedUrl('file:///etc/passwd')).toBe(true)
    expect(isPrivilegedUrl('data:text/html,<p>x')).toBe(true)
  })

  it('accepts ordinary web pages', () => {
    expect(isPrivilegedUrl('https://example.com/article')).toBe(false)
    expect(isPrivilegedUrl('http://example.com/')).toBe(false)
  })
})

describe('decideCapture', () => {
  it('allows an ordinary page', () => {
    const decision = decideCapture('https://example.com/article')
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBeNull()
  })

  it('refuses a banking-like host', () => {
    const decision = decideCapture('https://secure.bank/login')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('banking')
  })

  it('refuses a privileged page', () => {
    const decision = decideCapture('chrome://extensions')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('privileged page')
  })

  it('refuses a host on the user deny list', () => {
    const decision = decideCapture('https://intranet.example.com/', [
      { pattern: 'intranet.example.com', reason: 'user deny list' },
    ])
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('user deny list')
  })

  it('ships a deny list that names no ordinary site', () => {
    for (const entry of DEFAULT_DENY_LIST) {
      expect(matchesDenyPattern('example.com', entry.pattern)).toBe(false)
      expect(matchesDenyPattern('news.ycombinator.com', entry.pattern)).toBe(false)
    }
  })
})

describe('runActiveTabCapture', () => {
  const now = new Date('2026-10-30T12:00:00.000Z')

  function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
    return {
      tab: { id: 1, url: 'https://example.com/article', title: 'An article' },
      extract: async () => ({ body: '# An article\n\nBody text.', title: 'An article' }),
      getToken: async () => 'secret-token',
      send: async () => ({ ok: true }),
      enqueue: () => true,
      now,
      ...overrides,
    }
  }

  it('captures the tab and sends the payload', async () => {
    const sent: unknown[] = []
    const result = await runActiveTabCapture(
      deps({
        send: async (payload) => {
          sent.push(payload)
          return { ok: true }
        },
      }),
    )
    expect(result.status).toBe('captured')
    expect(sent).toHaveLength(1)
    const payload = sent[0] as { url: string; body: string; source: string }
    expect(payload.url).toBe('https://example.com/article')
    expect(payload.body).toContain('An article')
    expect(payload.source).toBe('extension')
  })

  it('refuses a private window', async () => {
    const result = await runActiveTabCapture(
      deps({ tab: { id: 1, url: 'https://example.com/a', incognito: true } }),
    )
    expect(result.status).toBe('refused')
    if (result.status === 'refused') expect(result.reason).toBe('private window')
  })

  it('refuses a denied host before extracting anything', async () => {
    let extracted = false
    const result = await runActiveTabCapture(
      deps({
        tab: { id: 1, url: 'https://secure.bank/login' },
        extract: async () => {
          extracted = true
          return { body: 'x' }
        },
      }),
    )
    expect(result.status).toBe('refused')
    expect(extracted).toBe(false)
  })

  it('reports a missing token instead of sending', async () => {
    let sent = false
    const result = await runActiveTabCapture(
      deps({
        getToken: async () => '   ',
        send: async () => {
          sent = true
          return { ok: true }
        },
      }),
    )
    expect(result.status).toBe('no_token')
    expect(sent).toBe(false)
  })

  it('reports an empty extraction', async () => {
    const result = await runActiveTabCapture(deps({ extract: async () => null }))
    expect(result.status).toBe('extraction_failed')
  })

  it('queues the payload when the send fails', async () => {
    const queued: unknown[] = []
    const result = await runActiveTabCapture(
      deps({
        send: async () => ({ ok: false, error: 'fetch failed' }),
        enqueue: (payload) => {
          queued.push(payload)
          return true
        },
      }),
    )
    expect(result.status).toBe('queued')
    expect(queued).toHaveLength(1)
  })
})
