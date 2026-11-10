/**
 * patchright adapter: the stealth engine (patched Playwright) behind the
 * core ports. Same persistent-context mechanics the pre-M1 patchright
 * extractor used, exposed as PageReaderPort + SessionLoginPort.
 *
 * The patchright import stays dynamic and optional (peer dependency): the
 * package builds and every test runs when it is not installed. The browser
 * is reached only through the injected launcher.
 */
import { existsSync } from 'node:fs'
import { isLoginWall as coreIsLoginWall } from '@atento/core'
import { browserProfileDir } from '@atento/core'
import type {
  BrowserCaps,
  BrowserHealth,
  LoginResult,
  PageNavigation,
  PageReaderPort,
  PageSession,
  ProfileRef,
  SessionLoginPort,
  SessionLoginUi,
} from '@atento/core'
import {
  defaultPatchrightLaunch,
  htmlToMarkdown,
  textToMarkdown,
  type PatchrightContext,
  type PatchrightLaunch,
  type PatchrightPage,
} from '@atento/extractors'

export interface PatchrightAdapterOptions {
  /** The adapter instance id (config key). */
  id: string
  /** Chromium binary; default the engine's own resolution (real Chrome channel). */
  executablePath?: string
  /** Base profiles dir, used when open() gets no ProfileRef. */
  profilesDir?: string
  /** Browser launch, injected in tests. */
  launch?: PatchrightLaunch
  /** Navigation timeout in ms. */
  timeoutMs?: number
}

const CAPS: BrowserCaps = {
  stealth: true,
  headless: true,
  persistentProfile: true,
}

export interface PatchrightAdapter {
  reader: PageReaderPort
  login: SessionLoginPort
  health(): Promise<BrowserHealth>
}

export function createPatchrightAdapter(
  options: PatchrightAdapterOptions,
): PatchrightAdapter {
  const launch = options.launch ?? defaultPatchrightLaunch
  const profilesDir = options.profilesDir ?? defaultProfilesDir()
  const timeoutMs = options.timeoutMs ?? 120_000

  const profilePath = (host: string, profile?: ProfileRef): string =>
    profile?.path ?? browserProfileDir(profilesDir, host, options.id)

  const launchContext = (dir: string, headless: boolean, viewport?: { width: number; height: number } | null) =>
    launch(dir, {
      headless,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      ...(viewport !== undefined ? { viewport } : {}),
    })

  function sessionFor(context: PatchrightContext, page: PatchrightPage, url: string): PageSession {
    return {
      async goto(target: string): Promise<PageNavigation> {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        return { finalUrl: pageUrl(page) || target }
      },
      async html(): Promise<string> {
        const html = await page.content()
        return html
      },
      async scroll(pixels: number): Promise<void> {
        try {
          if (page.scroll) await page.scroll(pixels)
          else await page.evaluate(`window.scrollBy(0, ${pixels}); ''`)
        } catch {
          // A page that refuses to scroll is still worth reading.
        }
      },
      async close(): Promise<void> {
        try {
          await context.close()
        } catch {
          // Closing is best effort: the profile is flushed by the browser.
        }
      },
    }
  }

  const reader: PageReaderPort = {
    id: options.id,
    caps: CAPS,
    contentFormat: 'html',
    async open({ host, profile }): Promise<PageSession> {
      const dir = profilePath(host, profile)
      const context = await launchContext(dir, true, { width: 1280, height: 800 })
      try {
        const page = context.pages()[0] ?? (await context.newPage())
        return sessionFor(context, page, `https://${host}/`)
      } catch (error) {
        try {
          await context.close()
        } catch {
          // already failing
        }
        throw error
      }
    },
  }

  const login: SessionLoginPort = {
    id: options.id,
    async login(
      host: string,
      profile: ProfileRef,
      ui: SessionLoginUi,
      url?: string,
    ): Promise<LoginResult> {
      const target = url ?? `https://${host}/`
      let context: PatchrightContext | undefined
      try {
        context = await launchContext(profile.path, false, null)
        const page = context.pages()[0] ?? (await context.newPage())
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        await ui.waitForUser(
          `Log in to ${host} in the browser window, then press Enter here to save the session... `,
        )
        try {
          await context.close()
        } catch (error) {
          return {
            ok: true,
            detail: `the browser did not close cleanly: ${String(error).split('\n')[0]}`,
          }
        }
        context = undefined
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message.split('\n')[0]! : String(error),
        }
      } finally {
        if (context) {
          try {
            await context.close()
          } catch {
            // Already reported through the result.
          }
        }
      }
    },
    async verify(host: string, profile: ProfileRef): Promise<boolean> {
      let context: PatchrightContext | undefined
      try {
        context = await launchContext(profile.path, true, { width: 1280, height: 800 })
        const page = context.pages()[0] ?? (await context.newPage())
        const url = `https://${host}/`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        const html = await page.content()
        let markdown = await htmlToMarkdown(html)
        if (!markdown) {
          const text = await page.evaluate("document.body ? document.body.innerText : ''")
          markdown = textToMarkdown(text)
        }
        if (!markdown.trim()) return false
        return !coreIsLoginWall({
          url: pageUrl(page) || url,
          body: markdown,
          hasProfile: existsSync(profile.path),
        })
      } catch {
        return false
      } finally {
        if (context) {
          try {
            await context.close()
          } catch {
            // best effort
          }
        }
      }
    },
  }

  return {
    reader,
    login,
    async health(): Promise<BrowserHealth> {
      // Cheap check: the optional package must be importable. A real launch
      // smoke stays with the orchestrator's real-browser verification.
      try {
        const specifier = 'patchright'
        const mod = (await import(specifier)) as { chromium?: unknown; default?: { chromium?: unknown } }
        if (!mod.chromium && !mod.default?.chromium) {
          return { id: options.id, kind: 'patchright', ok: false, detail: 'patchright: no chromium browser type' }
        }
        return { id: options.id, kind: 'patchright', ok: true, detail: 'patchright importable' }
      } catch (error) {
        return {
          id: options.id,
          kind: 'patchright',
          ok: false,
          detail: `patchright not importable: ${String(error).split('\n')[0]}`,
        }
      }
    },
  }
}

/** The page URL when the page object reports one (fake pages may not). */
function pageUrl(page: PatchrightPage): string {
  const candidate = (page as { url?: () => string }).url
  if (typeof candidate === 'function') {
    try {
      return candidate.call(page)
    } catch {
      return ''
    }
  }
  return ''
}

function defaultProfilesDir(): string {
  const home = process.env['HOME'] ?? ''
  return `${home}/.atento/profiles`
}
