/**
 * Auto-escalation in the extract-fn adapter: when the first result is a
 * bot block (Cloudflare or captcha markers in the content, HTTP 403/429)
 * or a login wall, the adapter walks the `[browser] escalate` chain — the
 * migrated default is the stealth (patchright) adapter — in order.
 * Fakes only: per-adapter extractors are injected, no browser, no network.
 */
import { describe, expect, it } from 'vitest'
import { createExtractFn } from '../src/extract-fn.js'
import { unlimitedLimits } from './helpers.js'
import { parseBrowserConfig } from '@linkinbox/core'
import type { Extractor, ExtractResult } from '@linkinbox/extractors'

const ok: ExtractResult = { markdown: 'x'.repeat(500) }

/** A Cloudflare challenge body the defuddle route returns. */
const cfBody =
  '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. Enable JavaScript and cookies to continue. cf-challenge</body></html>'

function fakeExtractor(
  name: string,
  results: ExtractResult[],
  calls: string[] = [],
): Extractor {
  let i = 0
  return {
    name,
    async extract(url) {
      calls.push(`${name}:${url}`)
      const result = results[Math.min(i, results.length - 1)]
      i += 1
      return result ?? ok
    },
  }
}

function baseOptions(
  defuddleResult: ExtractResult,
  stealthResult: ExtractResult,
  calls: string[] = [],
  browserToml = `
[browser]
engine = "agent-browser"
`,
) {
  return {
    limits: unlimitedLimits(),
    browserConfig: parseBrowserConfig(browserToml),
    extractors: {
      defuddle: fakeExtractor('defuddle', [defuddleResult], calls),
      readability: fakeExtractor('readability', [{ markdown: '' }]),
      ytdlp: fakeExtractor('ytdlp', ok),
      pdf: fakeExtractor('pdf', ok),
    },
    browserAdapters: {
      // The headless adapter answers the router's browser fallback attempt
      // with an empty page so the last attempt stays the browser route.
      headless: fakeExtractor('headless', [{ markdown: '' }], calls),
      stealth: fakeExtractor('stealth', [stealthResult], calls),
    },
  }
}

describe('extract fn auto-escalation', () => {
  it('escalates a Cloudflare block to the stealth adapter and returns its content', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions({ markdown: '', html: cfBody, status: 200 }, ok, calls),
    )
    const result = await extractFn('https://example.com/post')
    expect(calls.some((c) => c.startsWith('stealth:'))).toBe(true)
    expect(result.extractor).toBe('browser')
    expect(result.meta?.['adapter']).toBe('stealth')
    expect(result.markdown).toBe(ok.markdown)
    expect(result.blocked).toBeFalsy()
    expect(result.needsBrowser).toBeFalsy()
  })

  it('escalates an HTTP 403 to the stealth adapter', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions({ markdown: '', html: '<p>forbidden</p>', status: 403 }, ok, calls),
    )
    const result = await extractFn('https://example.com/post')
    expect(result.meta?.['adapter']).toBe('stealth')
    expect(result.markdown).toBe(ok.markdown)
  })

  it('escalates a login wall to the stealth adapter', async () => {
    const calls: string[] = []
    const wall = { markdown: 'Sign in to continue reading', status: 200 }
    const extractFn = createExtractFn(baseOptions(wall, ok, calls))
    const result = await extractFn('https://example.com/post')
    expect(result.meta?.['adapter']).toBe('stealth')
    expect(result.markdown).toBe(ok.markdown)
  })

  it('returns the login-wall outcome when the retry still shows a wall', async () => {
    const wallResult: ExtractResult = {
      markdown: '',
      needsBrowser: true,
      meta: { blocked: true, reason: 'login_wall' },
    }
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions({ markdown: 'Sign in to continue reading' }, wallResult, calls),
    )
    const result = await extractFn('https://example.com/post')
    expect(calls.filter((c) => c.startsWith('stealth:')).length).toBe(1)
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('login_wall')
  })

  it('returns the blocked outcome when the retry is still blocked (captcha)', async () => {
    const captcha: ExtractResult = {
      markdown: '',
      needsBrowser: true,
      meta: { blocked: true, reason: 'captcha' },
    }
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions(
        { markdown: '', html: cfBody, status: 429 },
        captcha,
        calls,
      ),
    )
    const result = await extractFn('https://example.com/post')
    expect(calls.filter((c) => c.startsWith('stealth:')).length).toBe(1)
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('captcha')
  })

  it('skips the retry silently when the stealth adapter cannot run', async () => {
    const failed: ExtractResult = {
      markdown: '',
      needsBrowser: true,
      meta: { failed: true, adapter: 'stealth', error: 'Executable does not exist' },
    }
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions({ markdown: '', html: cfBody, status: 403 }, failed, calls),
    )
    const result = await extractFn('https://example.com/post')
    // The original outcome comes back untouched: the router's last attempt,
    // not the failed stealth adapter.
    expect(result.extractor).toBe('browser')
    expect(result.meta?.['adapter']).toBe('headless')
    expect(result.blocked).toBeFalsy()
    expect(calls.filter((c) => c.startsWith('stealth:')).length).toBe(1)
  })

  it('does not escalate when the first route already used the stealth adapter', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn({
      limits: unlimitedLimits(),
      browserConfig: parseBrowserConfig(`
[browser]
stealth_hosts = ["app.devin.ai"]
`),
      extractors: {
        defuddle: fakeExtractor('defuddle', [{ markdown: '' }]),
        readability: fakeExtractor('readability', [{ markdown: '' }]),
        ytdlp: fakeExtractor('ytdlp', ok),
        pdf: fakeExtractor('pdf', ok),
      },
      browserAdapters: {
        headless: fakeExtractor('headless', [{ markdown: '' }], calls),
        stealth: fakeExtractor('stealth', [ok], calls),
      },
    })
    const result = await extractFn('https://app.devin.ai/thread')
    // The stealth adapter ran once as the primary route, never twice.
    expect(calls.filter((c) => c.startsWith('stealth:')).length).toBe(1)
    expect(result.meta?.['adapter']).toBe('stealth')
  })

  it('walks the configured escalate chain in order', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn({
      limits: unlimitedLimits(),
      browserConfig: parseBrowserConfig(`
[browser]
reader = "headless"
escalate = ["stealth", "user-session"]

[browser.adapters.headless]
kind = "agent-browser"
[browser.adapters.stealth]
kind = "patchright"
[browser.adapters.user-session]
kind = "external"
module = "./plugin.js"
`),
      extractors: {
        defuddle: fakeExtractor('defuddle', [{ markdown: '', html: cfBody, status: 403 }], calls),
        readability: fakeExtractor('readability', [{ markdown: '' }]),
        ytdlp: fakeExtractor('ytdlp', ok),
        pdf: fakeExtractor('pdf', ok),
      },
      browserAdapters: {
        headless: fakeExtractor('headless', [{ markdown: '' }], calls),
        // The stealth adapter cannot run: the chain moves on to the next.
        stealth: fakeExtractor('stealth', [
          { markdown: '', needsBrowser: true, meta: { failed: true } },
        ], calls),
        'user-session': fakeExtractor('user-session', [ok], calls),
      },
    })
    const result = await extractFn('https://example.com/post')
    expect(calls.filter((c) => c.startsWith('stealth:')).length).toBe(1)
    expect(calls.filter((c) => c.startsWith('user-session:')).length).toBe(1)
    expect(result.meta?.['adapter']).toBe('user-session')
    expect(result.markdown).toBe(ok.markdown)
  })

  it('keeps walking the chain when a retry still looks blocked', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn({
      limits: unlimitedLimits(),
      browserConfig: parseBrowserConfig(`
[browser]
reader = "headless"
escalate = ["stealth", "user-session"]

[browser.adapters.headless]
kind = "agent-browser"
[browser.adapters.stealth]
kind = "patchright"
[browser.adapters.user-session]
kind = "cdp-attach"
endpoint = "http://127.0.0.1:9222"
`),
      extractors: {
        defuddle: fakeExtractor('defuddle', [{ markdown: '', html: cfBody, status: 403 }], calls),
        readability: fakeExtractor('readability', [{ markdown: '' }]),
        ytdlp: fakeExtractor('ytdlp', ok),
        pdf: fakeExtractor('pdf', ok),
      },
      browserAdapters: {
        headless: fakeExtractor('headless', [{ markdown: '' }], calls),
        // The stealth adapter gets through the bot check but lands on a
        // login wall: the chain must not stop here.
        stealth: fakeExtractor('stealth', [
          { markdown: 'Sign in to continue reading this page', status: 200 },
        ], calls),
        'user-session': fakeExtractor('user-session', [ok], calls),
      },
    })
    const result = await extractFn('https://example.com/post')
    expect(calls.filter((c) => c.startsWith('stealth:')).length).toBe(1)
    expect(calls.filter((c) => c.startsWith('user-session:')).length).toBe(1)
    expect(result.meta?.['adapter']).toBe('user-session')
    expect(result.markdown).toBe(ok.markdown)
  })

  it('never retries more than the escalate chain allows', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions(
        { markdown: '', html: cfBody, status: 403 },
        { markdown: '', html: cfBody, status: 403 },
        calls,
      ),
    )
    await extractFn('https://example.com/post')
    expect(calls.filter((c) => c.startsWith('stealth:')).length).toBe(1)
  })
})
