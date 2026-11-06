/**
 * Auto-escalation in the extract-fn adapter: when the first (non-stealth)
 * result is a bot block (Cloudflare or captcha markers in the content, HTTP
 * 403/429) or a login wall, the adapter retries ONCE with the patchright
 * extractor. Fakes only: no browser, no network.
 */
import { describe, expect, it } from 'vitest'
import { createExtractFn } from '../src/extract-fn.js'
import { unlimitedLimits } from './helpers.js'
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
  patchrightResult: ExtractResult,
  calls: string[] = [],
) {
  return {
    limits: unlimitedLimits(),
    browserConfig: {
      engine: 'agent-browser' as const,
      stealthHosts: [] as string[],
    },
    extractors: {
      defuddle: fakeExtractor('defuddle', [defuddleResult], calls),
      readability: fakeExtractor('readability', [{ markdown: '' }]),
      browser: fakeExtractor('browser', [{ markdown: '' }]),
      patchright: fakeExtractor('patchright', [patchrightResult], calls),
      ytdlp: fakeExtractor('ytdlp', ok),
      pdf: fakeExtractor('pdf', ok),
    },
  }
}

describe('extract fn auto-escalation', () => {
  it('escalates a Cloudflare block to patchright and returns its content', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions({ markdown: '', html: cfBody, status: 200 }, ok, calls),
    )
    const result = await extractFn('https://example.com/post')
    expect(calls.some((c) => c.startsWith('patchright:'))).toBe(true)
    expect(result.extractor).toBe('patchright')
    expect(result.markdown).toBe(ok.markdown)
    expect(result.blocked).toBeFalsy()
    expect(result.needsBrowser).toBeFalsy()
  })

  it('escalates an HTTP 403 to patchright', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions({ markdown: '', html: '<p>forbidden</p>', status: 403 }, ok, calls),
    )
    const result = await extractFn('https://example.com/post')
    expect(result.extractor).toBe('patchright')
    expect(result.markdown).toBe(ok.markdown)
  })

  it('escalates a login wall to patchright', async () => {
    const calls: string[] = []
    const wall = { markdown: 'Sign in to continue reading', status: 200 }
    const extractFn = createExtractFn(baseOptions(wall, ok, calls))
    const result = await extractFn('https://example.com/post')
    expect(result.extractor).toBe('patchright')
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
    expect(calls.filter((c) => c.startsWith('patchright:')).length).toBe(1)
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
    expect(calls.filter((c) => c.startsWith('patchright:')).length).toBe(1)
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('captcha')
  })

  it('skips the retry silently when patchright cannot launch', async () => {
    const failed: ExtractResult = {
      markdown: '',
      needsBrowser: true,
      meta: { failed: true, engine: 'patchright', error: 'Executable does not exist' },
    }
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions({ markdown: '', html: cfBody, status: 403 }, failed, calls),
    )
    const result = await extractFn('https://example.com/post')
    // The original outcome comes back untouched: the router's last attempt,
    // not the failed stealth engine.
    expect(result.extractor).toBe('browser')
    expect(result.blocked).toBeFalsy()
    expect(calls.filter((c) => c.startsWith('patchright:')).length).toBe(1)
  })

  it('does not escalate when the first route is already stealth', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn({
      limits: unlimitedLimits(),
      browserConfig: {
        engine: 'agent-browser' as const,
        stealthHosts: ['app.devin.ai'],
      },
      extractors: {
        defuddle: fakeExtractor('defuddle', [{ markdown: '' }]),
        readability: fakeExtractor('readability', [{ markdown: '' }]),
        browser: fakeExtractor('browser', [{ markdown: '' }]),
        patchright: fakeExtractor('patchright', [ok], calls),
        ytdlp: fakeExtractor('ytdlp', ok),
        pdf: fakeExtractor('pdf', ok),
      },
    })
    const result = await extractFn('https://app.devin.ai/thread')
    // The patchright extractor ran once as the primary route, never twice.
    expect(calls.filter((c) => c.startsWith('patchright:')).length).toBe(1)
    expect(result.extractor).toBe('patchright')
  })

  it('never retries more than once', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn(
      baseOptions(
        { markdown: '', html: cfBody, status: 403 },
        { markdown: '', html: cfBody, status: 403 },
        calls,
      ),
    )
    await extractFn('https://example.com/post')
    expect(calls.filter((c) => c.startsWith('patchright:')).length).toBe(1)
  })
})
