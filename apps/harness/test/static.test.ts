import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { openStore, type SqliteStore } from '@linkinbox/db'
import { createApp } from '@linkinbox/server'
import { createStaticMiddleware } from '../src/static.js'
import { resolveWebDir, webDirCandidates } from '../src/serve.js'
import { DEFAULT_HARNESS_CONFIG } from '../src/config.js'

const dirs: string[] = []
const stores: SqliteStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkinbox-harness-static-'))
  dirs.push(dir)
  return dir
}

/** A web root with an index.html, a hashed asset and a plain asset. */
function makeWebRoot(): string {
  const root = tempDir()
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<html><body>spa</body></html>')
  writeFileSync(join(root, 'assets', 'index-abc12345.js'), 'console.log(1)')
  writeFileSync(join(root, 'favicon.ico'), 'icon')
  return root
}

/** api routes + static middleware, mirroring startHarness's composition. */
async function appWith(webDir: string | null): Promise<Hono> {
  const dir = tempDir()
  const store = await openStore({ path: join(dir, 'test.db') })
  stores.push(store)
  const app = createApp(store, {})
  app.use('*', createStaticMiddleware({ webDir }))
  return app
}

describe('createStaticMiddleware', () => {
  it('serves index.html at /', async () => {
    const app = await appWith(makeWebRoot())
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('spa')
  })

  it('serves real files with correct mime types', async () => {
    const root = makeWebRoot()
    const app = await appWith(root)
    const res = await app.request('/favicon.ico')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/x-icon')
  })

  it('marks hashed assets immutable and others no-cache', async () => {
    const app = await appWith(makeWebRoot())
    const hashed = await app.request('/assets/index-abc12345.js')
    expect(hashed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(hashed.headers.get('content-type')).toContain('javascript')
    const index = await app.request('/')
    expect(index.headers.get('cache-control')).toBe('no-cache')
  })

  it('falls back to index.html for unknown non-file paths (SPA)', async () => {
    const app = await appWith(makeWebRoot())
    const res = await app.request('/links/42')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('spa')
  })

  it('404s missing files with extensions instead of the SPA fallback', async () => {
    const app = await appWith(makeWebRoot())
    const res = await app.request('/missing.js')
    expect(res.status).toBe(404)
  })

  it('never shadows api routes', async () => {
    const app = await appWith(makeWebRoot())
    const res = await app.request('/api/links')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { items: unknown[] }
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('rejects path traversal', async () => {
    // Web root inside a parent dir; the secret lives next to it, outside root.
    const parent = tempDir()
    const root = join(parent, 'web')
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'index.html'), '<html><body>spa</body></html>')
    writeFileSync(join(parent, 'outside-secret.txt'), 'secret')
    const app = await appWith(root)
    const res = await app.request('/%2e%2e/outside-secret.txt')
    expect(await res.text()).not.toContain('secret')
  })

  it('reserves /api exactly and by segment, but not lookalike prefixes', async () => {
    const app = await appWith(makeWebRoot())
    // /api has no route → real 404, not the SPA page.
    const api = await app.request('/api')
    expect(api.status).toBe(404)
    // Segment lookalikes are ordinary SPA routes.
    for (const p of ['/apiary', '/capturefoo', '/mcpfoo']) {
      const res = await app.request(p)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('spa')
    }
  })

  it('serves the placeholder page when no build exists', async () => {
    const app = await appWith(null)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const text = await res.text()
    expect(text).toContain('not been built')
    // api still works
    const api = await app.request('/api/links')
    expect(api.status).toBe(200)
  })

  it('serves the placeholder when webDir lacks index.html', async () => {
    const empty = tempDir()
    const app = await appWith(empty)
    const res = await app.request('/anything')
    expect(await res.text()).toContain('not been built')
  })
})

describe('resolveWebDir / webDirCandidates', () => {
  it('prefers packages/ui dist, then apps/web layouts', () => {
    const c = webDirCandidates('/repo')
    expect(c[0]).toBe(join('/repo', 'packages', 'ui', 'dist'))
    expect(c[1]).toBe(join('/repo', 'apps', 'web', 'build'))
    expect(c[2]).toBe(join('/repo', 'apps', 'web', 'dist'))
  })

  it('prefers harness.toml web_dir when it has index.html', () => {
    const web = makeWebRoot()
    const harness = { ...DEFAULT_HARNESS_CONFIG, webDir: web }
    expect(resolveWebDir(harness, {} as NodeJS.ProcessEnv, '/nonexistent')).toBe(web)
  })

  it('returns null for a web_dir without index.html', () => {
    const harness = { ...DEFAULT_HARNESS_CONFIG, webDir: tempDir() }
    expect(resolveWebDir(harness, {} as NodeJS.ProcessEnv, '/nonexistent')).toBeNull()
  })

  it('falls back to candidates under the repo root', () => {
    const root = tempDir()
    mkdirSync(join(root, 'apps', 'web', 'build'), { recursive: true })
    writeFileSync(join(root, 'apps', 'web', 'build', 'index.html'), 'x')
    expect(resolveWebDir(DEFAULT_HARNESS_CONFIG, {} as NodeJS.ProcessEnv, root)).toBe(
      join(root, 'apps', 'web', 'build'),
    )
  })
})
