/**
 * The patchright login flow: a headed persistent context for one host, wait
 * for Enter, close cleanly so the cookies persist, save the profile row and
 * requeue the host's parked links.
 *
 * The flow itself lives in the app layer's `loginInteractive` use case and
 * the patchright adapter's SessionLoginPort; these tests drive it through
 * `runLogin` with an injected launcher. Fakes only: the launcher, the
 * prompt and the store are injected, so nothing opens a browser and
 * nothing touches the network.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { capture, insertLink, tempDb, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { runLogin } from '../src/commands/login.js'
import { loadConfig } from '../src/config.js'
import { parseBrowserConfig } from '@linkinbox/core'
import type { PatchrightContext, PatchrightPage } from '@linkinbox/extractors'

async function contextFor(db: TempDb, browser?: string): Promise<CliContext> {
  const env = { LINKINBOX_DB: db.path }
  // The browser config must be in place when the app is built: the use
  // cases resolve it once at construction, so a post-hoc ctx.config
  // mutation would never reach them.
  const config = loadConfig(env)
  if (browser !== undefined) config.browser = parseBrowserConfig(browser)
  return createContext({
    env,
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
    config,
  })
}

/** Park a link in needs_browser the way the extract stage does. */
async function parkNeedsBrowser(db: TempDb, url: string): Promise<string> {
  const link = await insertLink(db.store, url)
  await db.store.applyEvent(link.id, {
    type: 'EXTRACT_STARTED',
    at: new Date().toISOString(),
  })
  await db.store.applyEvent(link.id, {
    type: 'NEEDS_BROWSER',
    host: new URL(url).host,
    at: new Date().toISOString(),
  })
  return link.id
}

interface FakeBrowser {
  launch: (
    dir: string,
    options: { headless: boolean; executablePath?: string; viewport?: unknown },
  ) => Promise<PatchrightContext>
  calls: { dir: string; headless: boolean; executablePath?: string; viewport?: unknown }[]
  closed: number
  visited: string[]
}

/** A fake patchright browser: records the launch and the navigation. */
function fakeBrowser(): FakeBrowser {
  const state: FakeBrowser = {
    calls: [],
    closed: 0,
    visited: [],
    launch: async (dir, options) => {
      state.calls.push({
        dir,
        headless: options.headless,
        executablePath: options.executablePath,
        viewport: options.viewport,
      })
      const page: PatchrightPage = {
        goto: async (url) => {
          state.visited.push(url)
        },
        content: async () => '<p>ok</p>',
        evaluate: async () => 'ok',
      }
      return {
        pages: () => [page],
        newPage: async () => page,
        close: async () => {
          state.closed += 1
        },
      }
    },
  }
  return state
}

describe('login with the patchright engine', () => {
  it('uses the patchright engine for a host in stealth_hosts', async () => {
    const db = await tempDb()
    try {
      const id = await parkNeedsBrowser(db, 'https://app.devin.ai/thread/1')
      const ctx = await contextFor(
        db,
        `
[browser]
stealth_hosts = ["app.devin.ai"]
`,
      )
      const browser = fakeBrowser()
      const out = await capture(async () => {
        const result = await runLogin(ctx, 'app.devin.ai', {
          patchrightLaunch: browser.launch,
          waitForEnter: async () => undefined,
        })
        expect(result.code).toBe(0)
      })
      expect(browser.calls).toHaveLength(1)
      expect(browser.calls[0]?.headless).toBe(false)
      // The profile row points at the patchright profile directory.
      const profile = await db.store.getProfile('app.devin.ai')
      // The migrated stealth adapter id names the profile directory.
      expect(profile?.path).toBe(
        join(ctx.config.profilesDir, 'app.devin.ai', 'stealth'),
      )
      expect(out.stdout).toContain('saved profile for app.devin.ai')
      // The parked links are requeued for the next extract run.
      expect((await db.store.getState(id))?.state).toBe('created')
    } finally {
      await db.cleanup()
    }
  })

  it('uses the patchright engine for every host when engine = patchright', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(
        db,
        `
[browser]
engine = "patchright"
`,
      )
      const browser = fakeBrowser()
      await capture(() =>
        runLogin(ctx, 'example.com', {
          patchrightLaunch: browser.launch,
          waitForEnter: async () => undefined,
        }),
      )
      expect(browser.calls).toHaveLength(1)
      expect(browser.calls[0]?.headless).toBe(false)
      const profile = await db.store.getProfile('example.com')
      expect(profile?.path).toBe(
        join(ctx.config.profilesDir, 'example.com', 'stealth'),
      )
    } finally {
      await db.cleanup()
    }
  })

  it('threads a custom --url through runLogin to page.goto', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(
        db,
        `
[browser]
engine = "patchright"
`,
      )
      const browser = fakeBrowser()
      await capture(() =>
        runLogin(ctx, 'example.com', {
          url: 'https://example.com/login?next=/feed',
          patchrightLaunch: browser.launch,
          waitForEnter: async () => undefined,
        }),
      )
      expect(browser.visited).toEqual(['https://example.com/login?next=/feed'])
    } finally {
      await db.cleanup()
    }
  })

  it('leaves an ordinary host on the agent-browser flow', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      const browser = fakeBrowser()
      const out = await capture(async () => {
        const result = await runLogin(ctx, 'example.com', {
          launch: async () => 0,
          patchrightLaunch: browser.launch,
          waitForEnter: async () => undefined,
        })
        expect(result.code).toBe(0)
      })
      expect(browser.calls).toHaveLength(0)
      const profile = await db.store.getProfile('example.com')
      expect(profile?.path).toBe(join(ctx.config.profilesDir, 'example.com', 'headless'))
      expect(out.stdout).toContain('saved profile for example.com')
    } finally {
      await db.cleanup()
    }
  })

  it('saves no profile when the patchright browser cannot start', async () => {
    const db = await tempDb()
    try {
      const id = await parkNeedsBrowser(db, 'https://app.devin.ai/thread/1')
      const ctx = await contextFor(
        db,
        `
[browser]
engine = "patchright"
`,
      )
      await capture(() =>
        runLogin(ctx, 'app.devin.ai', {
          patchrightLaunch: async () => {
            throw new Error('no chromium here')
          },
          waitForEnter: async () => undefined,
        }),
      )
      expect(await db.store.getProfile('app.devin.ai')).toBeNull()
      // The links stay parked: nothing was logged in.
      expect((await db.store.getState(id))?.state).toBe('needs_browser')
    } finally {
      await db.cleanup()
    }
  })

  it('requeues only the logged-in host', async () => {
    const db = await tempDb()
    try {
      const devin = await parkNeedsBrowser(db, 'https://app.devin.ai/thread/1')
      const other = await parkNeedsBrowser(db, 'https://other.com/a')
      const ctx = await contextFor(
        db,
        `
[browser]
stealth_hosts = ["app.devin.ai"]
`,
      )
      const browser = fakeBrowser()
      const out = await capture(async () => {
        const result = await runLogin(ctx, 'app.devin.ai', {
          patchrightLaunch: browser.launch,
          waitForEnter: async () => undefined,
        })
        // The login requeues the host's parked links on the spot.
        expect(result.requeued).toBe(1)
      })
      expect((await db.store.getState(devin))?.state).toBe('created')
      expect((await db.store.getState(other))?.state).toBe('needs_browser')
    } finally {
      await db.cleanup()
    }
  })
})
