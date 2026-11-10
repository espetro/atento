import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSiteCache, isCacheableHost, sanitizeRender } from '../src/site-cache.js'

describe('isCacheableHost', () => {
  it('accepts public DNS names only', () => {
    expect(isCacheableHost('example.com')).toBe(true)
    expect(isCacheableHost('a.b.example.co.uk')).toBe(true)
    for (const bad of ['localhost', '127.0.0.1', '10.0.0.1', 'intranet', 'x.local', '../etc', 'a b.com', '']) {
      expect(isCacheableHost(bad)).toBe(false)
    }
  })
})

describe('sanitizeRender', () => {
  it('strips scripts and handlers and pins the base url', () => {
    const out = sanitizeRender(
      '<html><head><title>t</title><script>evil()</script></head><body onload="x()"><p onclick=\'y()\'>hi</p></body></html>',
      'https://example.com/a',
    )
    expect(out).not.toMatch(/<script|onload|onclick|evil/)
    expect(out).toContain('<base href="https://example.com/a">')
    expect(out).toContain('<p>hi</p>')
  })
})

describe('site cache render', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'site-cache-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('round-trips the last render per url and misses cleanly', async () => {
    const cache = createSiteCache(dir)
    expect(await cache.readRender('https://example.com/x')).toBeNull()
    await cache.saveRender('https://example.com/x', '<html><body>hello</body></html>')
    const hit = await cache.readRender('https://example.com/x')
    expect(hit?.contentType).toContain('text/html')
    expect(hit?.body.toString()).toContain('hello')
    expect(await cache.favicon('localhost')).toBeNull()
  })
})

describe('extract wrapper keeps the last render', () => {
  it('saves html from a good extraction and serves it by link id', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { createAtentoOps, loadConfig } = await import('../src/index.js')
    const { openStore } = await import('@atento/db')
    const home = mkdtempSync(join(tmpdir(), 'atento-render-'))
    const store = await openStore({ path: join(home, 'links.db') })
    try {
      const config = loadConfig({ ATENTO_HOME: home } as NodeJS.ProcessEnv)
      const url = 'https://example.com/post'
      const ops = createAtentoOps(config as never, {
        store,
        env: {},
        spoolDir: join(home, 'spool'),
        extractFn: async () => ({ markdown: '# hi', html: '<html><body><script>x</script>hello</body></html>' }),
      })
      const link = await store.upsertLink({ urlHash: 'hr', url, source: 'test', status: 'inbox' } as never)
      const fn = await ops.extractFn()
      await fn(url)
      const page = await ops.readRender(link.id)
      expect(page?.body.toString()).toContain('hello')
      expect(page?.body.toString()).not.toContain('<script')
    } finally {
      await store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
