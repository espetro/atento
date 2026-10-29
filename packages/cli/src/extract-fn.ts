/**
 * Adapter between the extractors router and the core `ExtractFn` interface.
 * The core pipeline never imports the extractors package: the CLI injects
 * this function instead.
 */
import { createRouter, type RouterOptions } from '@linkinbox/extractors'
import type { ExtractFn } from '@linkinbox/core'

export interface RouterExtractOptions extends RouterOptions {
  /** Directory holding agent-browser login profiles. */
  profilesDir?: string
  /** Override the underlying fetch (tests). */
  fetchImpl?: (url: string) => Promise<{ status: number; body: string; contentType?: string }>
}

/**
 * Build an ExtractFn backed by the extractors router. The router never
 * throws: a page it cannot read comes back with `needsBrowser: true`.
 */
export function createExtractFn(options: RouterExtractOptions = {}): ExtractFn {
  const router = createRouter({
    ...options,
    fetch: options.fetchImpl ?? defaultFetch,
    browser: {
      profilesDir: options.profilesDir,
      ...options.browser,
    },
  })

  return async (url: string) => {
    const result = await router.extract(url)
    return {
      markdown: result.markdown,
      title: result.title,
      needsBrowser: result.needsBrowser === true,
      extractor: result.route,
    }
  }
}

/** Default fetch: plain GET with a browser-ish user agent. */
async function defaultFetch(
  url: string,
): Promise<{ status: number; body: string; contentType?: string }> {
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
  return { status: res.status, body, contentType }
}
