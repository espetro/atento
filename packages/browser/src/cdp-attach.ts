/**
 * cdp-attach adapter: attaches to a browser the user is already running
 * (Chrome, BrowserOS, Brave) over the DevTools protocol and reuses its
 * session. This removes most login walls for hosts the user browses with.
 *
 * Login is a no-op plus verify: there is no profile to write — the user's
 * own session is the profile. `verify` opens the host in a new tab of the
 * running browser and checks the page is not a login wall.
 *
 * The CDP client comes from the optional `patchright` peer (its chromium
 * exposes connectOverCDP, the same API surface as playwright). The import
 * is dynamic so the package builds without it; tests inject `connect`.
 */
import { isLoginWall } from '@linkinbox/core'
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
} from '@linkinbox/core'

/** The narrow CDP page surface the adapter uses (playwright-compatible). */
export interface CdpPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  content(): Promise<string>
  url(): string
  evaluate?(expression: string): Promise<unknown>
  mouse?: { wheel(deltaX: number, deltaY: number): Promise<void> }
  close?(): Promise<void>
}

export interface CdpContext {
  pages(): CdpPage[]
  newPage(): Promise<CdpPage>
}

export interface CdpBrowser {
  contexts(): CdpContext[]
  newContext?(): Promise<CdpContext>
  close(): Promise<void>
}

export type CdpConnect = (endpoint: string) => Promise<CdpBrowser>

export interface CdpAttachAdapterOptions {
  /** The adapter instance id (config key). */
  id: string
  /** CDP endpoint, e.g. http://127.0.0.1:9222. */
  endpoint: string
  /** Injected connector (tests). Default: patchright's connectOverCDP. */
  connect?: CdpConnect
  /** Injected fetch for the /json/version health probe (tests). */
  fetchImpl?: typeof fetch
  /** Navigation timeout in ms. */
  timeoutMs?: number
}

const CAPS: BrowserCaps = {
  // A real, logged-in browser is not automation-fingerprinted.
  stealth: true,
  headless: false,
  persistentProfile: false,
}

/**
 * The default connector: patchright's chromium.connectOverCDP. Dynamic
 * import on purpose — the package is an optional peer.
 */
export const defaultCdpConnect: CdpConnect = async (endpoint) => {
  const specifier = 'patchright'
  const mod = (await import(specifier)) as {
    chromium?: { connectOverCDP(endpoint: string): Promise<CdpBrowser> }
    default?: { chromium?: { connectOverCDP(endpoint: string): Promise<CdpBrowser> } }
  }
  const chromium = mod.chromium ?? mod.default?.chromium
  if (!chromium?.connectOverCDP) {
    throw new Error('cdp-attach: patchright chromium.connectOverCDP is unavailable')
  }
  return chromium.connectOverCDP(endpoint)
}

export interface CdpAttachAdapter {
  reader: PageReaderPort
  login: SessionLoginPort
  health(): Promise<BrowserHealth>
}

export function createCdpAttachAdapter(options: CdpAttachAdapterOptions): CdpAttachAdapter {
  const connect = options.connect ?? defaultCdpConnect
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 120_000

  async function openPage(host: string): Promise<{ browser: CdpBrowser; page: CdpPage }> {
    const browser = await connect(options.endpoint)
    try {
      let context = browser.contexts()[0]
      if (!context && browser.newContext) {
        context = await browser.newContext()
      }
      if (!context) throw new Error('cdp-attach: the browser exposed no context')
      const page = context.pages()[0] ?? (await context.newPage())
      return { browser, page }
    } catch (error) {
      try {
        await browser.close()
      } catch {
        // already failing
      }
      throw error
    }
  }

  const reader: PageReaderPort = {
    id: options.id,
    caps: CAPS,
    contentFormat: 'html',
    async open({ host }): Promise<PageSession> {
      const { browser, page } = await openPage(host)
      return {
        async goto(url: string): Promise<PageNavigation> {
          const response = (await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
          })) as { status?: () => number } | null
          const status = typeof response?.status === 'function' ? response.status() : undefined
          return { ...(status !== undefined ? { status } : {}), finalUrl: safeUrl(page) || url }
        },
        async html(): Promise<string> {
          return page.content()
        },
        async scroll(pixels: number): Promise<void> {
          try {
            if (page.mouse) await page.mouse.wheel(0, pixels)
            else if (page.evaluate) await page.evaluate(`window.scrollBy(0, ${pixels}); ''`)
          } catch {
            // A page that refuses to scroll is still worth reading.
          }
        },
        async close(): Promise<void> {
          // Disconnecting never closes the user's browser; the tab stays.
          try {
            await browser.close()
          } catch {
            // best effort
          }
        },
      }
    },
  }

  const login: SessionLoginPort = {
    id: options.id,
    async login(_host: string, _profile: ProfileRef, _ui: SessionLoginUi): Promise<LoginResult> {
      // The user's own session is reused: there is nothing to capture.
      return { ok: true, detail: 'session reused from the running browser' }
    },
    async verify(host: string, _profile: ProfileRef): Promise<boolean> {
      let browser: CdpBrowser | undefined
      try {
        const opened = await openPage(host)
        browser = opened.browser
        const url = `https://${host}/`
        await opened.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        const html = await opened.page.content()
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (!text) return false
        return !isLoginWall({
          url: safeUrl(opened.page) || url,
          body: text,
          hasProfile: true,
        })
      } catch {
        return false
      } finally {
        if (browser) {
          try {
            await browser.close()
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
      try {
        const res = await fetchImpl(`${options.endpoint.replace(/\/+$/, '')}/json/version`, {
          signal: AbortSignal.timeout(5_000),
        })
        if (!res.ok) {
          return { id: options.id, kind: 'cdp-attach', ok: false, detail: `endpoint answered HTTP ${res.status}` }
        }
        const body = (await res.json()) as { Browser?: string }
        return {
          id: options.id,
          kind: 'cdp-attach',
          ok: true,
          detail: body.Browser ?? 'cdp endpoint reachable',
        }
      } catch (error) {
        return {
          id: options.id,
          kind: 'cdp-attach',
          ok: false,
          detail: `endpoint unreachable: ${String(error).split('\n')[0]}`,
        }
      }
    },
  }
}

function safeUrl(page: CdpPage): string {
  try {
    return page.url()
  } catch {
    return ''
  }
}
