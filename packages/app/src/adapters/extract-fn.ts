/**
 * Adapter between the extractors router and the core `ExtractFn` interface.
 * The core pipeline never imports the extractors package: the CLI injects
 * this function instead.
 *
 * The host policy is injected from the core package (the shared
 * `hostPolicy` function over the config skip-list, the persisted canary
 * state and the saved browser profiles), so the router and the limiter
 * agree on every host.
 *
 * M1: the `browser` and `patchright` routes are merged into ONE `browser`
 * route. A composite browser extractor resolves the adapter id per host
 * through the browser registry (`[browser.hosts]` -> reader default) and
 * delegates to that adapter's Extractor; `result.meta.adapter` records
 * which adapter ran. Escalation on bot-block/login-wall signals walks the
 * `[browser] escalate` list in order.
 */
import {
  DEFAULT_BROWSER_CONFIG,
  browserHostAdapter,
  emptyHostState,
  hostPolicy,
  isLoginWall,
  normalizeBrowserConfig,
  isListedStealthHost,
  limitForHost,
  minIntervalMs,
  pacingGate,
  realSleep,
  type BrowserConfig,
  type LimitsConfig,
  type LoginConfig,
  type PacingConfig,
  type Store,
} from '@linkinbox/core'
import {
  browserAdapterReaders,
  createBrowserRegistry,
  type BrowserRegistry,
} from '@linkinbox/browser'
import {
  createBrowserExtractor,
  createRouter,
  type Extractor,
  type RouterOptions,
} from '@linkinbox/extractors'
import type { ExtractFn } from '@linkinbox/core'

export interface RouterExtractOptions extends RouterOptions {
  /** Directory holding browser login profiles. */
  profilesDir?: string;
  /** Override the underlying fetch (tests). */
  fetchImpl?: (url: string) => Promise<{
    status: number
    body: string
    contentType?: string
    headers?: Record<string, string | undefined>
    finalUrl?: string
  }>
  /** The config limits: the skip-list and the manual walled-garden override. */
  limits?: LimitsConfig
  /** Which hosts may be logged in to (`[login] allow`). */
  login?: LoginConfig
  /** The human pacing profile: the dwell time before reading a page. */
  pacing?: PacingConfig
  /** The store, for the persisted canary state and the saved profiles. */
  store?: Store
  /**
   * The browser config (`[browser]`): adapter instances, host mappings,
   * reader/login defaults and the escalate chain. Legacy engine keys are
   * migrated into the registry at parse time.
   */
  browserConfig?: BrowserConfig
  /** A prebuilt registry (tests, or callers that already resolved one). */
  browserRegistry?: BrowserRegistry
  /**
   * Per-adapter Extractor overrides (tests): adapterId -> Extractor. They
   * replace the port-backed extractor for that adapter id.
   */
  browserAdapters?: Record<string, Extractor>
}

/**
 * Build an ExtractFn backed by the extractors router. The router never
 * throws: a page it cannot read comes back with `needsBrowser: true`. A
 * login wall comes back as `blocked` with the reason `login_wall`.
 */
export function createExtractFn(options: RouterExtractOptions = {}): ExtractFn {
  const limits = options.limits
  const store = options.store
  const pacing = options.pacing
  const browserConfig = normalizeBrowserConfig(options.browserConfig ?? DEFAULT_BROWSER_CONFIG)

  // The adapter registry: which adapter reads which host. Built lazily
  // here; adapters only spawn a browser when actually opened.
  const registry =
    options.browserRegistry ??
    createBrowserRegistry(browserConfig, { profilesDir: options.profilesDir })

  // Human pacing shared by every port-backed adapter extractor.
  const dwellMs = options.pacing
    ? Math.min(options.pacing.dwellMaxS, options.pacing.dwellMedianS) * 1000
    : undefined
  const adapterReaders = browserAdapterReaders(registry, {
    profilesDir: options.profilesDir,
    // The sleep is the real one; tests inject fakes at the extractor level.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...(dwellMs !== undefined ? { dwellMs } : {}),
    overrides: options.browserAdapters,
  })

  // The fallback browser extractor: the pre-M1 agent-browser subprocess
  // engine, used when the resolved adapter id has no port-backed extractor
  // (e.g. a hand-built config without adapters).
  const fallbackBrowser =
    options.extractors?.browser ??
    createBrowserExtractor({
      profilesDir: options.profilesDir,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      scroll: async (px, profileDir) => {
        const { execFile } = await import('node:child_process')
        await new Promise<void>((resolve) => {
          execFile(
            options.browser?.command ?? 'agent-browser',
            ['--profile', profileDir, 'scroll', 'down', String(px)],
            { timeout: 10_000 },
            () => resolve(),
          )
        })
      },
      ...(dwellMs !== undefined ? { dwellMs } : {}),
      ...(browserConfig.executablePath ? { executablePath: browserConfig.executablePath } : {}),
      ...options.browser,
    })

  /**
   * The single `browser` route: resolve the adapter id for the URL's host
   * through the registry and delegate. `meta.adapter` records the choice.
   */
  const browserRoute: Extractor = options.extractors?.browser ?? {
    name: 'browser',
    async extract(url: string) {
      const host = hostFromUrl(url)
      const adapterId = registry.resolve('reader', host)
      const extractor = adapterReaders[adapterId] ?? fallbackBrowser
      const result = await extractor.extract(url)
      return {
        ...result,
        meta: { ...(result.meta ?? {}), adapter: adapterId },
      }
    },
  }

  const routerOptions: RouterOptions = {
    ...options,
    fetch: options.fetchImpl ? adaptFetch(options.fetchImpl) : defaultFetch,
    extractors: {
      ...options.extractors,
      browser: browserRoute,
    },
    // The host policy: one shared function from the core package. Skipped
    // hosts never reach the router (the pipeline parks them first), but the
    // browser routing decision is made here. A `[browser.hosts]` mapping or
    // a legacy stealth_hosts entry also forces the browser route: the owner
    // configured a browser adapter for that host on purpose.
    hostPolicy: limits
      ? async (host) => {
          let hasProfile = false
          let trialState: 'unknown' | 'open' | 'flagged' = 'unknown'
          let loginGated = false
          if (store) {
            const [profile, state] = await Promise.all([
              store.getProfile(host),
              store.getHostState(host),
            ])
            hasProfile = profile !== null
            trialState = state?.trialState ?? 'unknown'
            loginGated = state?.loginGated ?? false
          }
          const policy = hostPolicy(limits, host, {
            hasProfile,
            trialState,
            loginGated,
            loginAllow: options.login?.allow,
          })
          // A review-only host is never routed to the browser: no profile is
          // opened for a host the owner reviews by hand.
          return {
            browser:
              (policy.browser ||
                isListedStealthHost(browserConfig, host) ||
                browserHostAdapter(browserConfig, host) !== undefined) &&
              !policy.reviewOnly,
            skipped: policy.skipped,
          }
        }
      : undefined,
  }
  const router = createRouter(routerOptions)

  /**
   * The normal pacing gate before an escalation retry. Every retry is
   * another page read on the same host, so it waits like any other read:
   * the walled-garden pacing profile (working hours, daily cap, breaks,
   * jittered spacing) when the host is strict, else the host's spacing
   * wait. A throttled wait is skipped silently.
   */
  const pacingWait = async (url: string): Promise<void> => {
    if (!limits || !store) return
    let host: string
    try {
      host = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
    } catch {
      return
    }
    const state = (await store.getHostState(host)) ?? emptyHostState(host)
    const hasProfile = (await store.getProfile(host)) !== null
    const policy = hostPolicy(limits, host, { hasProfile })
    if (policy.strict && pacing) {
      const verdict = pacingGate(state, pacing, Date.now(), Math.random)
      if (verdict.admitted) await store.saveHostState(verdict.state)
      return
    }
    if (state.lastRequestAt !== null) {
      const waitMs = Math.max(
        0,
        state.lastRequestAt +
          minIntervalMs(limitForHost(limits, host, hasProfile).intervalMs) -
          Date.now(),
      )
      if (waitMs > 0) await realSleep(waitMs)
    }
  }

  return async (url: string) => {
    const first = await router.extract(url)
    const firstAdapted = adaptResult(first, url)
    // Auto-escalation: a bot block (Cloudflare, captcha, HTTP 403/429) or a
    // login wall gets ONE pass through the `[browser] escalate` chain, in
    // order, with no user input. Each retry runs after the normal pacing
    // the adapter applies (dwell, scroll); it never bypasses it. An adapter
    // that cannot run (missing package, no profile) is skipped and the next
    // one tried; when the chain is exhausted the original outcome stands.
    if (shouldEscalate(first, first.route)) {
      const host = hostFromUrl(url)
      const usedId = first.route === 'browser' ? registry.resolve('reader', host) : undefined
      for (const adapterId of registry.escalate(host, usedId)) {
        const extractor = adapterReaders[adapterId]
        if (!extractor) continue
        await pacingWait(url)
        const retried = await extractor.extract(url)
        // The adapter could not run (the package is missing, the browser
        // is absent, there is no profile): try the next one in the chain.
        if (retried.meta?.['failed'] === true || retried.meta?.['missingProfile'] === true) {
          continue
        }
        return adaptResult(
          {
            route: 'browser',
            ...retried,
            meta: { ...(retried.meta ?? {}), adapter: adapterId },
          },
          url,
        )
      }
    }
    return firstAdapted
  }
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The markers that mean the host served a bot challenge instead of content.
 * Deliberately narrow: a retry is only worth it for pages a stealth browser
 * plausibly passes.
 */
const BOT_BLOCK_MARKERS = [
  'cf-challenge',
  'cf-browser-verification',
  'checking your browser',
  'just a moment',
  'captcha',
  'verify you are human',
  'are you a robot',
  'unusual activity',
  'enable javascript and cookies to continue',
]

/** True when a page body (html or markdown) carries a bot-block marker. */
function looksBotBlocked(body?: string): boolean {
  if (!body) return false
  const lower = body.toLowerCase()
  return BOT_BLOCK_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * Decide whether the extract-fn result must escalate through the browser
 * adapter chain: a bot-block page (by markers or by status 403/429) or a
 * login wall. The whole attempt chain is scanned: the router falls back
 * from the static route to the browser route, and the fallback attempt
 * (the one that is returned) can hide the challenge page the static route
 * saw.
 */
function shouldEscalate(
  result: {
    route: string
    attempts: { route: string; result: ExtractResultShape }[]
    gone?: number
  },
  route: string,
): boolean {
  if (result.gone !== undefined) return false
  const attempts = result.attempts.length > 0 ? result.attempts : []
  return attempts.some((attempt) => {
    const r = attempt.result
    if (r.gone !== undefined) return false
    const blocked = r.meta?.['blocked'] === true
    if (blocked) return true
    if (r.status === 403 || r.status === 429) return true
    if (looksBotBlocked(r.html ?? r.markdown)) return true
    // A login wall on a page that still carries content.
    return isLoginWall({
      url: r.finalUrl ?? '',
      body: r.html ?? r.markdown,
      status: r.status,
      hasProfile: r.meta?.['hasProfile'] === true,
    })
  })
}

/** The subset of an extractor result the escalation check reads. */
interface ExtractResultShape {
  markdown?: string
  meta?: Record<string, unknown>
  needsBrowser?: boolean
  gone?: number
  finalUrl?: string
  status?: number
  html?: string
}

/** Turn a routed extract result into the ExtractFn shape (the old body). */
function adaptResult(
  result: {
    route: string
    markdown?: string
    title?: string
    meta?: Record<string, unknown>
    needsBrowser?: boolean
    gone?: number
    finalUrl?: string
    status?: number
    html?: string
  },
  url: string,
): Awaited<ReturnType<ExtractFn>> {
  const meta = result.meta ?? {}
  const blockedMeta = meta['blocked'] === true
  const wall = isLoginWall({
    url: result.finalUrl ?? url,
    body: result.html ?? result.markdown,
    status: result.status,
    hasProfile: meta['hasProfile'] === true,
  })
  const blockReason = blockedMeta
    ? typeof meta['reason'] === 'string'
      ? (meta['reason'] as string)
      : 'login_wall'
    : wall
      ? 'login_wall'
      : undefined
  return {
    markdown: result.markdown ?? '',
    title: result.title,
    // Site metadata (og:type, twitter:card, author, ...): the media stage
    // detects video pages from it. Booleans and plain values only.
    meta: stripMeta(meta),
    needsBrowser: result.needsBrowser === true,
    extractor: result.route,
    blocked: blockedMeta || (wall && result.needsBrowser !== true),
    blockReason,
    gone: result.gone,
    finalUrl: result.finalUrl,
    status: result.status,
    html: result.html,
  }
}

/** Keep only JSON-safe scalar metadata values. */
function stripMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) continue
    const t = typeof value
    if (t === 'string' || t === 'boolean' || t === 'number') out[key] = value
  }
  return out
}

/** Adapt the plain test fetch into the shape the router wants. */
function adaptFetch(
  impl: NonNullable<RouterExtractOptions['fetchImpl']>,
): NonNullable<RouterOptions['fetch']> {
  return async (url) => {
    const res = await impl(url)
    return {
      status: res.status,
      body: res.body,
      contentType: res.contentType,
      headers: res.headers,
      finalUrl: res.finalUrl ?? url,
    }
  }
}

/** Default fetch: plain GET with a browser-ish user agent. */
async function defaultFetch(
  url: string,
): Promise<{
  status: number
  body: string
  contentType?: string
  headers: Record<string, string | undefined>
  finalUrl: string
}> {
  const res = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  })
  const contentType = res.headers.get('content-type') ?? undefined
  const body = contentType?.includes('pdf')
    ? Buffer.from(await res.arrayBuffer()).toString('binary')
    : await res.text()
  return {
    status: res.status,
    body,
    contentType,
    headers: Object.fromEntries(res.headers.entries()),
    finalUrl: res.url || url,
  }
}
