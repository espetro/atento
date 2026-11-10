/**
 * The browse adapter: turns the core `browseRead` into a command and an
 * MCP tool, and wires the browser engine for the host.
 *
 * The engine is chosen by the config through the browser registry, never
 * hardcoded: `[browser.hosts]` mappings win, then the `reader` default.
 * The share allowlist (`[share] hosts`) decides whether a host may be read
 * at all, and it ships empty.
 */
import {
  browseRead,
  listShareHosts,
  type BrowseFn,
  type BrowseOptions,
  type BrowseResult,
  type ShareConfig,
  type ShareHostEntry,
} from '@atento/core'
import { DEFAULT_BROWSER_CONFIG, isStealthHost, normalizeBrowserConfig, type BrowserConfig } from '@atento/core'
import { createBrowseReader, type BrowseReader } from '@atento/extractors'
import {
  browserAdapterReaders,
  createBrowserRegistry,
  type BrowserRegistry,
} from '@atento/browser'

export interface BrowseFnOptions {
  /** The share allowlist. */
  share: ShareConfig
  /** The browser config: adapters, host mappings, reader default. */
  browser?: BrowserConfig
  /** Directory holding the saved login profiles. */
  profilesDir: string
  /** The guard: pacing, daily cap, working hours, breaker. */
  guard?: BrowseOptions['guard']
  /** The injected reader (tests). Defaults to the real engines. */
  reader?: BrowseReader
  /** The agent-browser binary, overridable for tests. */
  command?: string
  /** A prebuilt registry (tests). */
  browserRegistry?: BrowserRegistry
}

/**
 * Build the read primitive for one host. The adapter follows the config:
 * the registry's reader resolution, with the legacy stealth_hosts rule as
 * the fallback for hand-built configs.
 */
export function createBrowseFn(options: BrowseFnOptions): BrowseFn {
  const browser = normalizeBrowserConfig(options.browser ?? DEFAULT_BROWSER_CONFIG)
  const registry =
    options.browserRegistry ??
    createBrowserRegistry(browser, { profilesDir: options.profilesDir })
  const adapterReaders = browserAdapterReaders(registry, {
    profilesDir: options.profilesDir,
  })
  const reader =
    options.reader ??
    createBrowseReader({
      profilesDir: options.profilesDir,
      adapterFor: (host) => registry.resolve('reader', host),
      adapterReaders,
      // Legacy fallback for configs without an adapters table: the
      // stealth_hosts rule still picks the built-in pair.
      stealthHost: (host) => isStealthHost(browser, host),
    })
  return async (url: string, host: string) => {
    const outcome = await reader(url, host)
    return {
      ok: outcome.ok,
      markdown: outcome.markdown,
      finalUrl: outcome.finalUrl,
      engine: outcome.engine,
      reason: outcome.reason,
      detail: outcome.detail,
    }
  }
}

export interface BrowseDeps {
  share: ShareConfig
  browser?: BrowserConfig
  profilesDir: string
  hasProfile(host: string): Promise<boolean>
  guard?: BrowseOptions['guard']
  reader?: BrowseReader
  command?: string
  browserRegistry?: BrowserRegistry
}

/** Read one page. The result is the core `BrowseResult`. */
export async function runBrowse(
  url: string,
  deps: BrowseDeps,
): Promise<BrowseResult> {
  const read = createBrowseFn(deps)
  return await browseRead(url, {
    share: deps.share,
    read,
    hasProfile: deps.hasProfile,
    guard: deps.guard,
  })
}

/**
 * The hosts that may be shared: the saved profiles with their share
 * verdict. Nothing here touches the network.
 */
export async function runBrowseHosts(
  profiles: { host: string }[],
  deps: { share: ShareConfig },
): Promise<ShareHostEntry[]> {
  return await listShareHosts(profiles, deps.share)
}
