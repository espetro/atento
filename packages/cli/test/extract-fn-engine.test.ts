/**
 * The extract fn engine wiring: `[browser] stealth_hosts` (or engine =
 * "patchright") routes the listed hosts to the patchright extractor, and
 * `[browser] executable_path` reaches both engines.
 *
 * Fakes only: extractors are injected, so no browser and no network.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createExtractFn } from '../src/extract-fn.js'
import { unlimitedLimits, type TempDb, tempDb } from './helpers.js'
import { openStore, type SqliteStore } from '@linkinbox/db'
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

describe('extract fn engine wiring', () => {
  it('routes a stealth host to patchright and others to agent-browser', async () => {
    const calls: string[] = []
    const extractFn = createExtractFn({
      limits: unlimitedLimits(),
      browserConfig: {
        engine: 'agent-browser',
        stealthHosts: ['app.devin.ai'],
      },
      extractors: {
        defuddle: fakeExtractor('defuddle', ok),
        readability: fakeExtractor('readability', ok),
        browser: fakeExtractor('browser', ok, calls),
        patchright: fakeExtractor('patchright', ok, calls),
        ytdlp: fakeExtractor('ytdlp', ok),
        pdf: fakeExtractor('pdf', ok),
      },
    })
    const stealth = await extractFn('https://app.devin.ai/thread')
    expect(stealth.extractor).toBe('patchright')
    const ordinary = await extractFn('https://example.com/post')
    expect(ordinary.extractor).toBe('defuddle')
    expect(calls.some((c) => c.startsWith('patchright:'))).toBe(true)
    expect(calls.some((c) => c.startsWith('browser:'))).toBe(false)
  })

  it('routes every host to patchright when the engine is patchright', async () => {
    const extractFn = createExtractFn({
      limits: unlimitedLimits(),
      browserConfig: { engine: 'patchright', stealthHosts: [] },
      extractors: {
        defuddle: fakeExtractor('defuddle', ok),
        readability: fakeExtractor('readability', ok),
        browser: fakeExtractor('browser', ok),
        patchright: fakeExtractor('patchright', ok),
        ytdlp: fakeExtractor('ytdlp', ok),
        pdf: fakeExtractor('pdf', ok),
      },
    })
    // engine = patchright only affects browser-routed hosts: an ordinary
    // open host still takes the cheap static route.
    expect((await extractFn('https://example.com/post')).extractor).toBe('defuddle')
  })

  it('routes a browser-policy host with engine patchright to patchright', async () => {
    const db = await tempDb()
    try {
      await db.store.upsertProfile({ host: 'example.com', path: '/tmp/profiles/example.com' })
      const calls: string[] = []
      const extractFn = createExtractFn({
        limits: unlimitedLimits(),
        store: db.store,
        browserConfig: { engine: 'patchright', stealthHosts: [] },
        extractors: {
          defuddle: fakeExtractor('defuddle', ok),
          readability: fakeExtractor('readability', ok),
          browser: fakeExtractor('browser', ok),
          patchright: fakeExtractor('patchright', ok, calls),
          ytdlp: fakeExtractor('ytdlp', ok),
          pdf: fakeExtractor('pdf', ok),
        },
      })
      // The host has a saved profile, so it is browser-routed; the engine
      // config sends it to the stealth extractor.
      const result = await extractFn('https://example.com/post')
      expect(result.extractor).toBe('patchright')
      expect(calls.some((c) => c.startsWith('patchright:'))).toBe(true)
    } finally {
      await db.cleanup()
    }
  })

  it('routes a stealth host with an executable path to patchright', async () => {
    const db = await tempDb()
    try {
      await db.store.upsertProfile({ host: 'example.com', path: '/tmp/profiles/example.com' })
      const calls: string[] = []
      const extractFn = createExtractFn({
        limits: unlimitedLimits(),
        store: db.store,
        profilesDir: '/tmp/profiles',
        browserConfig: {
          engine: 'agent-browser',
          stealthHosts: ['example.com'],
          executablePath: '/Applications/BrowserOS.app/Contents/MacOS/browseros',
        },
        extractors: {
          defuddle: fakeExtractor('defuddle', { markdown: '' }),
          readability: fakeExtractor('readability', { markdown: '' }),
          browser: fakeExtractor('browser', ok, calls),
          patchright: fakeExtractor('patchright', ok, calls),
          ytdlp: fakeExtractor('ytdlp', ok),
          pdf: fakeExtractor('pdf', ok),
        },
      })
      const result = await extractFn('https://example.com/post')
      expect(result.extractor).toBe('patchright')
      expect(calls.some((c) => c.startsWith('patchright:'))).toBe(true)
    } finally {
      await db.cleanup()
    }
  })
})
