/**
 * Adapter between the extractors router and the core `ExtractFn` interface.
 * The core pipeline never imports the extractors package: the CLI injects
 * this function instead.
 *
 * The host policy is injected from the core package (the shared
 * `hostPolicy` function over the config skip-list, the persisted canary
 * state and the saved browser profiles), so the router and the limiter
 * agree on every host.
 */
import {
  hostPolicy,
  isLoginWall,
  type LimitsConfig,
  type PacingConfig,
  type Store,
} from '@linkinbox/core'
import { createRouter, type RouterOptions } from '@linkinbox/extractors'
import type { ExtractFn } from '@linkinbox/core'

export interface RouterExtractOptions extends RouterOptions {
  /** Directory holding agent-browser login profiles. */
  profilesDir?: string
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
  /** The human pacing profile: the dwell time before reading a page. */
  pacing?: PacingConfig
  /** The store, for the persisted canary state and the saved profiles. */
  store?: Store
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
  const router = createRouter({
    ...options,
    fetch: options.fetchImpl ? adaptFetch(options.fetchImpl) : defaultFetch,
    browser: {
      profilesDir: options.profilesDir,
      // Human pacing: dwell the sampled time and scroll a little before
      // reading, so a logged-in session does not look like a script. The
      // sleep is the real one; tests inject fakes at the extractor level.
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
      scroll: async (px) => {
        const { execFile } = await import('node:child_process')
        await new Promise<void>((resolve) => {
          execFile(
            options.browser?.command ?? 'agent-browser',
            ['scroll', 'down', String(px)],
            { timeout: 10_000 },
            () => resolve(),
          )
        })
      },
      dwellMs: options.pacing
        ? Math.min(options.pacing.dwellMaxS, options.pacing.dwellMedianS) * 1000
        : undefined,
      ...options.browser,
    },
    // The host policy: one shared function from the core package. Skipped
    // hosts never reach the router (the pipeline parks them first), but the
    // browser routing decision is made here.
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
          const policy = hostPolicy(limits, host, { hasProfile, trialState, loginGated })
          return { browser: policy.browser, skipped: policy.skipped }
        }
      : undefined,
  })

  return async (url: string) => {
    const result = await router.extract(url)
    const meta = result.meta ?? {}
    const blockedMeta = meta['blocked'] === true
    const wall = isLoginWall({
      url: result.finalUrl ?? url,
      body: result.html ?? result.markdown,
      status: result.status,
      hasProfile: meta['hasProfile'] === true,
    })
    return {
      markdown: result.markdown,
      title: result.title,
      needsBrowser: result.needsBrowser === true,
      extractor: result.route,
      blocked: blockedMeta || (wall && result.needsBrowser !== true),
      blockReason: blockedMeta
        ? typeof meta['reason'] === 'string'
          ? (meta['reason'] as string)
          : 'login_wall'
        : wall
          ? 'login_wall'
          : undefined,
      gone: result.gone,
      finalUrl: result.finalUrl,
      status: result.status,
      html: result.html,
    }
  }
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
