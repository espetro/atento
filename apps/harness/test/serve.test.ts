import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@atento/app'
import { DEFAULT_HARNESS_CONFIG } from '../src/config.js'
import { harnessStatus, harnessPidPath } from '../src/lifecycle.js'
import { startHarness, type HarnessRuntime } from '../src/serve.js'
import { createServer } from 'node:net'

const dirs: string[] = []
const runtimes: HarnessRuntime[] = []

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atento-harness-serve-'))
  dirs.push(dir)
  return dir
}

async function boot(webDir: string | null) {
  const home = tempDir()
  const env = { ATENTO_HOME: home } as NodeJS.ProcessEnv
  const config = loadConfig(env)
  const runtime = await startHarness({
    config,
    env,
    harness: { ...DEFAULT_HARNESS_CONFIG },
    port: 0, // ephemeral
    webDir,
  })
  runtimes.push(runtime)
  return { runtime, env, home }
}

describe('startHarness', () => {
  it('serves api, mcp, openapi and the placeholder web page', async () => {
    const { runtime } = await boot(null)
    expect(runtime.port).toBeGreaterThan(0)
    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const api = await fetch(`${runtime.url}/api/links`)
    expect(api.status).toBe(200)
    expect(api.headers.get('content-type')).toContain('application/json')

    const openapi = await fetch(`${runtime.url}/openapi.json`)
    expect(openapi.status).toBe(200)

    // /mcp exists (may 405/400 a bare GET without a session, but not 404).
    const mcp = await fetch(`${runtime.url}/mcp`)
    expect(mcp.status).not.toBe(404)

    const page = await fetch(`${runtime.url}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('not been built')
  })

  it('writes a pidfile that status/stop can find', async () => {
    const { runtime, env } = await boot(null)
    const pidPath = harnessPidPath(env)
    expect(existsSync(pidPath)).toBe(true)
    const status = harnessStatus(env)
    expect(status.running).toBe(true)
    expect(status.pid).toBe(process.pid)
    expect(status.port).toBe(runtime.port)
    expect(status.url).toBe(runtime.url)
    await runtime.close()
    runtimes.pop()
    expect(harnessStatus(env).running).toBe(false)
  })

  it('serves a built web dir at / with SPA fallback', async () => {
    const web = tempDir()
    writeFileSync(join(web, 'index.html'), '<html><body>built-ui</body></html>')
    mkdirSync(join(web, 'assets'), { recursive: true })
    writeFileSync(join(web, 'assets', 'app-deadbeef.js'), 'x=1')
    const { runtime } = await boot(web)
    expect(runtime.webDir).toBe(web)

    const index = await fetch(`${runtime.url}/`)
    expect(await index.text()).toContain('built-ui')

    const spa = await fetch(`${runtime.url}/some/client/route`)
    expect(await spa.text()).toContain('built-ui')

    const asset = await fetch(`${runtime.url}/assets/app-deadbeef.js`)
    expect(asset.headers.get('cache-control')).toContain('immutable')
  })

  it('fails with a clear error on EADDRINUSE', async () => {
    // Grab a free port, occupy it, then try to bind the same one twice.
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address()
        const p = typeof addr === 'object' && addr !== null ? addr.port : 0
        probe.close(() => resolve(p))
      })
    })
    const blocker = createServer()
    await new Promise<void>((res) => blocker.listen(port, '127.0.0.1', res))
    try {
      const home = tempDir()
      const env = { ATENTO_HOME: home } as NodeJS.ProcessEnv
      const config = loadConfig(env)
      await expect(
        startHarness({
          config,
          env,
          harness: { ...DEFAULT_HARNESS_CONFIG },
          port,
          hostname: '127.0.0.1',
          webDir: null,
        }),
      ).rejects.toThrow(/address already in use/)
    } finally {
      await new Promise<void>((res) => blocker.close(() => res()))
    }
  })
})
