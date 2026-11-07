/**
 * Adapter contract tests: every built-in kind satisfies the core ports —
 * PageReaderPort (open -> goto -> html -> close) and SessionLoginPort
 * (login + verify) — with fakes only. No real browser, no network.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseBrowserConfig, type ProfileRef } from '@linkinbox/core'
import type { ExecLike, PatchrightContext, PatchrightPage } from '@linkinbox/extractors'
import { createAgentBrowserAdapter } from '../src/agent-browser.js'
import { createPatchrightAdapter } from '../src/patchright.js'
import { createCdpAttachAdapter, type CdpBrowser, type CdpConnect } from '../src/cdp-attach.js'
import { createExternalAdapter } from '../src/external.js'
import { createBrowserRegistry } from '../src/registry.js'

const profile: ProfileRef = { host: 'example.com', adapterId: 'a', path: '/tmp/profiles/example.com/a' }
const ui = { waitForUser: async () => undefined }

// ---- agent-browser -------------------------------------------------------

describe('agent-browser adapter contract', () => {
  it('reader: open, goto, html, close drive the CLI in order', async () => {
    const calls: string[][] = []
    const exec: ExecLike = async (_file, args) => {
      calls.push(args)
      if (args.includes('read')) return { code: 0, stdout: '# page', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const adapter = createAgentBrowserAdapter({ id: 'headless', exec, profilesDir: '/tmp/p' })
    const session = await adapter.reader.open({ host: 'example.com' })
    await session.goto('https://example.com/a')
    expect(await session.html()).toBe('# page')
    await session.close()
    const verbs = calls.map((a) => a.filter((x) => !x.startsWith('--'))[1] ?? a.at(-1))
    expect(calls[0]!.slice(0, 2)).toEqual(['--profile', '/tmp/p/example.com/headless'])
    expect(verbs).toEqual(['open', 'read', 'close'])
    expect(adapter.reader.caps.persistentProfile).toBe(true)
    expect(adapter.reader.contentFormat).toBe('markdown')
  })

  it('login: headed open, waitForUser, close; verify checks the profile dir', async () => {
    const spawned: string[][] = []
    const prompts: string[] = []
    const adapter = createAgentBrowserAdapter({
      id: 'headless',
      profilesDir: '/tmp/p',
      spawn: async (_cmd, args) => {
        spawned.push(args)
        return 0
      },
    })
    const result = await adapter.login.login('example.com', profile, {
      waitForUser: async (m) => void prompts.push(m),
    })
    expect(result.ok).toBe(true)
    expect(spawned).toHaveLength(2)
    expect(spawned[0]).toContain('--headed')
    expect(prompts[0]).toContain('example.com')
    expect(await adapter.login.verify('example.com', profile)).toBe(false) // /tmp/profiles/... does not exist
  })

  it('health runs <bin> --version through the injected exec', async () => {
    const adapter = createAgentBrowserAdapter({
      id: 'headless',
      exec: async () => ({ code: 0, stdout: 'agent-browser 1.2.3\n', stderr: '' }),
    })
    const health = await adapter.health()
    expect(health.ok).toBe(true)
    expect(health.detail).toContain('1.2.3')
  })
})

// ---- patchright ----------------------------------------------------------

function fakePatchrightPage(html = '<html><body>ok</body></html>'): PatchrightPage {
  return {
    goto: async () => ({}),
    content: async () => html,
    evaluate: async () => 'ok',
    close: async () => undefined,
  }
}

function fakePatchrightContext(): PatchrightContext {
  const page = fakePatchrightPage()
  return {
    pages: () => [page],
    newPage: async () => page,
    close: async () => undefined,
  }
}

describe('patchright adapter contract', () => {
  it('reader: open launches a persistent context, session reads html', async () => {
    const dirs: string[] = []
    const adapter = createPatchrightAdapter({
      id: 'stealth',
      profilesDir: '/tmp/p',
      launch: async (dir, opts) => {
        dirs.push(`${dir}:${opts.headless}`)
        return fakePatchrightContext()
      },
    })
    const session = await adapter.reader.open({ host: 'example.com' })
    await session.goto('https://example.com/a')
    expect(await session.html()).toContain('<html>')
    await session.close()
    expect(dirs).toEqual(['/tmp/p/example.com/stealth:true'])
    expect(adapter.reader.caps.stealth).toBe(true)
  })

  it('login: headed context (null viewport), waits for the user, closes', async () => {
    const launches: { headless: boolean; viewport?: unknown }[] = []
    const prompts: string[] = []
    let closed = 0
    const adapter = createPatchrightAdapter({
      id: 'stealth',
      profilesDir: '/tmp/p',
      launch: async (_dir, opts) => {
        launches.push({ headless: opts.headless, viewport: opts.viewport })
        return {
          ...fakePatchrightContext(),
          close: async () => {
            closed += 1
          },
        }
      },
    })
    const result = await adapter.login.login('example.com', profile, {
      waitForUser: async (m) => void prompts.push(m),
    })
    expect(result.ok).toBe(true)
    expect(launches[0]?.headless).toBe(false)
    expect(launches[0]?.viewport).toBeNull()
    expect(prompts[0]).toContain('example.com')
    expect(closed).toBe(1)
  })
})

// ---- cdp-attach ----------------------------------------------------------

function fakeCdpConnect(): { connect: CdpConnect; closed: () => number } {
  let closed = 0
  const page = {
    goto: async () => ({ status: () => 200 }),
    content: async () => '<html><body>hi</body></html>',
    url: () => 'https://example.com/',
  }
  const context = { pages: () => [page], newPage: async () => page }
  const browser: CdpBrowser = {
    contexts: () => [context],
    close: async () => {
      closed += 1
    },
  }
  return { connect: async () => browser, closed: () => closed }
}

describe('cdp-attach adapter contract', () => {
  it('reader: attaches over CDP, reads html, disconnects without closing tabs', async () => {
    const { connect, closed } = fakeCdpConnect()
    const adapter = createCdpAttachAdapter({ id: 'user-session', endpoint: 'http://x', connect })
    const session = await adapter.reader.open({ host: 'example.com' })
    const nav = await session.goto('https://example.com/a')
    expect(nav.status).toBe(200)
    expect(await session.html()).toContain('<html>')
    await session.close()
    expect(closed()).toBe(1)
    expect(adapter.reader.caps.persistentProfile).toBe(false)
  })

  it('login is a no-op that reuses the running session; verify opens the host', async () => {
    const { connect } = fakeCdpConnect()
    const adapter = createCdpAttachAdapter({ id: 'user-session', endpoint: 'http://x', connect })
    const login = await adapter.login.login('example.com', profile, ui)
    expect(login.ok).toBe(true)
    expect(await adapter.login.verify('example.com', profile)).toBe(true)
  })

  it('health probes /json/version through the injected fetch', async () => {
    const adapter = createCdpAttachAdapter({
      id: 'user-session',
      endpoint: 'http://127.0.0.1:9222/',
      connect: fakeCdpConnect().connect,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ Browser: 'Chrome/131' }), { status: 200 })) as typeof fetch,
    })
    const health = await adapter.health()
    expect(health.ok).toBe(true)
    expect(health.detail).toContain('Chrome/131')
  })
})

// ---- external ------------------------------------------------------------

describe('external adapter contract', () => {
  it('loads reader and login ports from a plugin module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lb-plugin-'))
    const modulePath = join(dir, 'plugin.mjs')
    writeFileSync(
      modulePath,
      `export const reader = {
        id: 'plug',
        caps: { stealth: true, headless: true, persistentProfile: false },
        async open() {
          return {
            async goto() { return { finalUrl: 'https://example.com/' } },
            async html() { return '<p>plugin</p>' },
            async close() {},
          }
        },
      }
      export const login = {
        id: 'plug',
        async login() { return { ok: true } },
        async verify() { return true },
      }
      export const caps = { stealth: true, headless: true, persistentProfile: false }
      `,
    )
    const adapter = createExternalAdapter({
      id: 'plug',
      module: pathToFileURL(modulePath).href,
    })
    const session = await adapter.reader.open({ host: 'example.com' })
    await session.goto('https://example.com/')
    expect(await session.html()).toBe('<p>plugin</p>')
    await session.close()
    expect((await adapter.login.login('example.com', profile, ui)).ok).toBe(true)
    expect(await adapter.login.verify('example.com', profile)).toBe(true)
    expect((await adapter.caps())?.stealth).toBe(true)
    expect((await adapter.health()).ok).toBe(true)
  })

  it('health reports a missing module instead of throwing', async () => {
    const adapter = createExternalAdapter({ id: 'plug', module: './does-not-exist.mjs' })
    const health = await adapter.health()
    expect(health.ok).toBe(false)
  })
})

// ---- registry ------------------------------------------------------------

describe('browser registry', () => {
  const config = parseBrowserConfig(`
[browser]
reader = "headless"
login = "user-session"
escalate = ["stealth", "user-session"]

[browser.adapters.headless]
kind = "agent-browser"
[browser.adapters.stealth]
kind = "patchright"
[browser.adapters.user-session]
kind = "cdp-attach"
endpoint = "http://127.0.0.1:9222"

[browser.hosts]
"x.com" = "user-session"
`)

  it('resolves role + host: host mapping wins, then the role default', () => {
    const registry = createBrowserRegistry(config, {
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      connect: fakeCdpConnect().connect,
    })
    expect(registry.resolve('reader', 'x.com')).toBe('user-session')
    expect(registry.resolve('login', 'x.com')).toBe('user-session')
    expect(registry.resolve('reader', 'example.com')).toBe('headless')
    expect(registry.resolve('login', 'example.com')).toBe('user-session')
    expect(registry.adapter('user-session')?.kind).toBe('cdp-attach')
  })

  it('escalate walks the configured order minus the adapter that ran', () => {
    const registry = createBrowserRegistry(config, { exec: async () => ({ code: 0, stdout: '', stderr: '' }) })
    expect(registry.escalate('example.com', 'headless')).toEqual(['stealth', 'user-session'])
    expect(registry.escalate('example.com', 'stealth')).toEqual(['user-session'])
  })

  it('list() reports id, kind, roles, caps and defaults', () => {
    const registry = createBrowserRegistry(config, {
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      connect: fakeCdpConnect().connect,
    })
    const rows = registry.list()
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['headless']?.kind).toBe('agent-browser')
    expect(byId['headless']?.defaultFor.reader).toBe(true)
    expect(byId['user-session']?.defaultFor.login).toBe(true)
    expect(byId['user-session']?.caps?.persistentProfile).toBe(false)
    expect(byId['stealth']?.inEscalate).toBe(true)
  })

  it('health checks each kind without launching a browser', async () => {
    const registry = createBrowserRegistry(config, {
      exec: async () => ({ code: 0, stdout: 'agent-browser 9.9\n', stderr: '' }),
      connect: fakeCdpConnect().connect,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ Browser: 'Chrome/131' }), { status: 200 })) as typeof fetch,
    })
    expect((await registry.health('headless')).ok).toBe(true)
    expect((await registry.health('user-session')).ok).toBe(true)
    // patchright may or may not be installed in this environment: the check
    // must answer either way, never throw.
    const stealth = await registry.health('stealth')
    expect(stealth.kind).toBe('patchright')
    expect(typeof stealth.ok).toBe('boolean')
    expect((await registry.health('nope')).ok).toBe(false)
  })
})
