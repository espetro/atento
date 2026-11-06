/**
 * The browse adapter: turns the core `browseRead` into a command and an
 * MCP tool, and wires the browser engine for the host.
 *
 * The engine is chosen by the config, never hardcoded: the default engine
 * for every host, and the stealth engine for the hosts the owner listed in
 * `stealth_hosts`. The share allowlist (`[share] hosts`) decides whether
 * a host may be read at all, and it ships empty.
 */
import {
  browseRead,
  listShareHosts,
  type BrowseFn,
  type BrowseOptions,
  type BrowseResult,
  type ShareConfig,
  type ShareHostEntry,
} from '@linkinbox/core'
import { createBrowseReader, type BrowseReader } from '@linkinbox/extractors'
import { isStealthHost, type BrowserConfig } from '@linkinbox/core'

export interface BrowseFnOptions {
  /** The share allowlist. */
  share: ShareConfig
  /** The browser engine config: the stealth hosts and the binary. */
  browser?: BrowserConfig
  /** Directory holding the saved login profiles. */
  profilesDir: string
  /** The guard: pacing, daily cap, working hours, breaker. */
  guard?: BrowseOptions['guard']
  /** The injected reader (tests). Defaults to the real engines. */
  reader?: BrowseReader
  /** The agent-browser binary, overridable for tests. */
  command?: string
}

/**
 * Build the read primitive for one host. The engine follows the config:
 * the stealth engine for the hosts in `stealth_hosts`, the default engine
 * for the rest.
 */
export function createBrowseFn(options: BrowseFnOptions): BrowseFn {
  const reader =
    options.reader ??
    createBrowseReader({
      profilesDir: options.profilesDir,
      stealthHost: (host) => (options.browser ? isStealthHost(options.browser, host) : false),
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
