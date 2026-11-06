/**
 * The patchright login flow: a headed persistent context for one host, wait
 * for Enter, close cleanly so the cookies persist, save the profile row and
 * requeue the host's parked links.
 *
 * Fakes only: the launcher, the prompt and the store are injected, so
 * nothing opens a browser and nothing touches the network.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { capture, insertLink, tempDb, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { runLogin, requeueHostLinks } from '../src/commands/login.js'
import { runPatchrightLogin } from '../src/patchright-login.js'
import { parseBrowserConfig } from '@linkinbox/core'
import type { PatchrightContext, PatchrightPage } from '@linkinbox/extractors'

async function contextFor(db: TempDb, browser?: string): Promise<CliContext> {
  const ctx = await createContext({
    env: { LINKINBOX_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
  })
  if (browser !== undefined) ctx.config.browser = parseBrowserConfig(browser)
  return ctx
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

describe('runPatchrightLogin', () => {
  it('opens a headed persistent context, waits for Enter and closes cleanly', async () => {
    const browser = fakeBrowser()
    const prompts: string[] = []
    const result = await runPatchrightLogin('app.devin.ai', {
      profilesDir: '/tmp/profiles',
      launch: browser.launch,
      waitForEnter: async (prompt) => {
        prompts.push(prompt)
      },
      log: () => undefined,
    })
    expect(result.ok).toBe(true)
    expect(result.profilePath).toBe('/tmp/profiles/app.devin.ai/patchright')
    // Headed: the user has to see the window to log in.
    expect(browser.calls[0]?.headless).toBe(false)
    expect(browser.calls[0]?.dir).toBe('/tmp/profiles/app.devin.ai/patchright')
    expect(browser.visited).toEqual(['https://app.devin.ai/'])
    expect(prompts[0]).toContain('app.devin.ai')
    // The context is closed, so the session is flushed to the profile.
    expect(browser.closed).toBe(1)
  })

  it('passes the executable path to the launcher', async () => {
    const browser = fakeBrowser()
    await runPatchrightLogin('app.devin.ai', {
      profilesDir: '/tmp/profiles',
      executablePath: '/Applications/BrowserOS.app/Contents/MacOS/browseros',
      launch: browser.launch,
      waitForEnter: async () => undefined,
      log: () => undefined,
    })
    expect(browser.calls[0]?.executablePath).toBe(
      '/Applications/BrowserOS.app/Contents/MacOS/browseros',
    )
  })

  it('never throws when the browser cannot start', async () => {
    const messages: string[] = []
    const result = await runPatchrightLogin('app.devin.ai', {
      profilesDir: '/tmp/profiles',
      launch: async () => {
        throw new Error("Executable doesn't exist")
      },
      waitForEnter: async () => undefined,
      log: (m) => messages.push(m),
    })
    expect(result.ok).toBe(false)
    expect(messages.join('\n')).toContain("Executable doesn't exist")
  })
})

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
      expect(profile?.path).toBe(
        join(ctx.config.profilesDir, 'app.devin.ai', 'patchright'),
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
        join(ctx.config.profilesDir, 'example.com', 'patchright'),
      )
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
      expect(profile?.path).toBe(join(ctx.config.profilesDir, 'example.com'))
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
