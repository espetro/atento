/**
 * Browser ports (M1): the capability interfaces every browser adapter
 * implements, split so an adapter only declares what it can do.
 *
 *   PageReaderPort   — open a page session and read it (crawl/scrape)
 *   SessionLoginPort — capture a login session into a profile (headed)
 *
 * Adapters live outside core (packages/browser today, external modules
 * tomorrow). Core only knows the shapes and the config that selects them;
 * nothing here spawns a browser or touches the network.
 */

/** What an adapter can do, declared up front for routing and `browsers`. */
export interface BrowserCaps {
  /** Resists bot fingerprinting (stealth patches, real Chrome channel). */
  stealth: boolean
  /** Can run without a display. */
  headless: boolean
  /** Reads/writes a persistent on-disk profile per host. */
  persistentProfile: boolean
}

/**
 * A saved login profile for one host on one adapter.
 * `path` is the adapter-specific user-data directory; adapters that do not
 * persist profiles (cdp-attach) ignore it.
 */
export interface ProfileRef {
  host: string
  /** The adapter instance id this profile belongs to. */
  adapterId: string
  /** Absolute path of the profile directory. */
  path: string
}

/** The result of one navigation. */
export interface PageNavigation {
  /** HTTP status of the final response, when the adapter reports one. */
  status?: number
  /** The URL after redirects. */
  finalUrl: string
}

/**
 * One open page. `html()` returns the rendered page content: raw HTML for
 * DOM-driven adapters, agent-readable text for CLI-driven ones — the
 * adapter declares which through `PageReaderPort.contentFormat`.
 */
export interface PageSession {
  goto(url: string): Promise<PageNavigation>
  html(): Promise<string>
  /**
   * Optional human-like scroll, run between goto and html by readers that
   * pace themselves. Adapters without a scroll primitive omit it.
   */
  scroll?(pixels: number): Promise<void>
  screenshot?(path: string): Promise<void>
  close(): Promise<void>
}

export interface PageReaderPort {
  /** The adapter instance id from config (e.g. "headless", "user-session"). */
  readonly id: string
  readonly caps: BrowserCaps
  /**
   * What `PageSession.html()` returns. "html" (default) is converted to
   * markdown by the caller; "markdown" is already readable text.
   */
  readonly contentFormat?: 'html' | 'markdown'
  open(opts: { host: string; profile?: ProfileRef }): Promise<PageSession>
}

/** What the user is asked to do while a headed login browser is open. */
export interface SessionLoginUi {
  waitForUser(message: string): Promise<void>
}

export interface LoginResult {
  ok: boolean
  /** Short detail when ok is false (or a note when it is true). */
  detail?: string
}

export interface SessionLoginPort {
  readonly id: string
  /**
   * Open a headed browser on the host's profile, let the user log in,
   * then close so the session persists. `profile.path` receives the
   * session data. `url` overrides the landing page (default
   * `https://<host>/`); adapters that cannot honour it may ignore it.
   */
  login(
    host: string,
    profile: ProfileRef,
    ui: SessionLoginUi,
    url?: string,
  ): Promise<LoginResult>
  /**
   * Check whether the saved profile still holds a usable session for the
   * host. Adapters that cannot verify return false rather than guess.
   */
  verify(host: string, profile: ProfileRef): Promise<boolean>
}

/** The adapter kinds the registry knows how to build. */
export type BrowserAdapterKind =
  | 'agent-browser'
  | 'patchright'
  | 'cdp-attach'
  | 'external'

/** One `[browser.adapters.<id>]` table. */
export interface BrowserAdapterConfig {
  kind: BrowserAdapterKind
  /** Kind-specific options, verbatim from TOML (executable, endpoint, module, ...). */
  options: Record<string, unknown>
}

/** The outcome of a `linkinbox browsers` health check. */
export interface BrowserHealth {
  id: string
  kind: BrowserAdapterKind
  ok: boolean
  detail: string
}
