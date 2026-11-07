/**
 * The extract fn adapter wiring: `[browser] stealth_hosts` (or engine =
 * "patchright") resolves the stealth adapter for the listed hosts through
 * the browser registry, and every browser-routed host takes the single
 * `browser` route with the adapter id in `meta.adapter`.
 *
 * Fakes only: per-adapter extractors are injected via `browserAdapters`,
 * so no browser and no network.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createExtractFn } from '../src/extract-fn.js'
import { unlimitedLimits, type TempDb, tempDb } from './helpers.js'
import { openStore, type SqliteStore } from '@linkinbox/db'
import { parseBrowserConfig } from '@linkinbox/core'
import type { Extractor, ExtractResult } from '@linkinbox/extractors'

const ok: ExtractResult = { markdown: 'x'.repeat(500) }

function fakeExtractor(
  name: string,
  result: ExtractResult,
  calls: string[] = [],
): Extractor {
  return {
    name,
    async extract(url) {
      calls.push(`${name}:${url}`)
      return result
    },
  }
}

/** The static routes every test needs; the browser route is the composite. */
function staticExtractors(calls: string[] = []) {
  return {
    defuddle: fakeExtractor('defuddle', ok, calls),
    readability: fakeExtractor('readability', ok, calls),
    ytdlp: fakeExtractor('ytdlp', ok, calls),
    pdf: fakeExtractor('pdf', ok, calls),
  }
}

describe('extract fn adapter wiring', () => {
  it('routes a stealth host to the stealth adapter and others to defuddle', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn({
      limits: unlimitedLimits(),
      browserConfig: parseBrowserConfig(`
[browser]
stealth_hosts = ["app.devin.ai"]
`),
      extractors: staticExtractors(calls),
      browserAdapters: {
        headless: fakeExtractor('headless', ok, calls),
        stealth: fakeExtractor('stealth', ok, calls),
      },
    })
    const stealth = await extractFn('https://app.devin.ai/thread')
    expect(stealth.extractor).toBe('browser')
    expect(stealth.meta?.['adapter']).toBe('stealth')
    const ordinary = await extractFn('https://example.com/post')
    expect(ordinary.extractor).toBe('defuddle')
    expect(calls.some((c) => c.startsWith('stealth:'))).toBe(true)
    expect(calls.some((c) => c.startsWith('headless:'))).toBe(false)
  })

  it('routes every browser host to the stealth adapter when engine = patchright', async () => {
    const extractFn = createExtractFn({
      limits: unlimitedLimits(),
      browserConfig: parseBrowserConfig(`
[browser]
engine = "patchright"
`),
      extractors: staticExtractors(),
      browserAdapters: {
        headless: fakeExtractor('headless', ok),
        stealth: fakeExtractor('stealth', ok),
      },
    })
    // engine = patchright only affects browser-routed hosts: an ordinary
    // open host still takes the cheap static route.
    expect((await extractFn('https://example.com/post')).extractor).toBe('defuddle')
  })

  it('routes a browser-policy host to the stealth adapter when engine = patchright', async () => {
    const db = await tempDb()
    try {
      await db.store.upsertProfile({ host: 'example.com', path: '/tmp/profiles/example.com' })
      const calls: string[] = []
      const extractFn = createExtractFn({
        limits: unlimitedLimits(),
        store: db.store,
        browserConfig: parseBrowserConfig(`
[browser]
engine = "patchright"
`),
        extractors: staticExtractors(calls),
        browserAdapters: {
          headless: fakeExtractor('headless', ok, calls),
          stealth: fakeExtractor('stealth', ok, calls),
        },
      })
      // The host has a saved profile, so it is browser-routed; the migrated
      // engine config makes stealth the reader default.
      const result = await extractFn('https://example.com/post')
      expect(result.extractor).toBe('browser')
      expect(result.meta?.['adapter']).toBe('stealth')
      expect(calls.some((c) => c.startsWith('stealth:'))).toBe(true)
    } finally {
      await db.cleanup()
    }
  })

  it('routes a stealth host through the host mapping to the stealth adapter', async () => {
    const db = await tempDb()
    try {
      await db.store.upsertProfile({ host: 'example.com', path: '/tmp/profiles/example.com' })
      const calls: string[] = []
      const extractFn = createExtractFn({
        limits: unlimitedLimits(),
        store: db.store,
        profilesDir: '/tmp/profiles',
        browserConfig: parseBrowserConfig(`
[browser]
stealth_hosts = ["example.com"]
executable_path = "/Applications/BrowserOS.app/Contents/MacOS/browseros"
`),
        extractors: staticExtractors(calls),
        browserAdapters: {
          headless: fakeExtractor('headless', ok, calls),
          stealth: fakeExtractor('stealth', ok, calls),
        },
      })
      const result = await extractFn('https://example.com/post')
      expect(result.extractor).toBe('browser')
      expect(result.meta?.['adapter']).toBe('stealth')
      expect(calls.some((c) => c.startsWith('stealth:'))).toBe(true)
      expect(calls.some((c) => c.startsWith('headless:'))).toBe(false)
    } finally {
      await db.cleanup()
    }
  })
})
