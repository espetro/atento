/**
 * The shared browser read path.
 *
 * `browseRead` reads ONE page through the saved browser profile of its
 * host and returns markdown. It is the only way another agent (or a human
 * at the terminal) sees a page that needs a session, and it is deliberately
 * narrow:
 *
 *   - READ-ONLY. There is no click, no type, no form and no navigation
 *     API exposed: the surface is `read(url)` and nothing else.
 *   - ALLOWLISTED. Only the hosts in the `[share] hosts` list may be read,
 *     and the list ships empty, so nothing is shared until the owner opts
 *     in host by host.
 *   - PACED. The call goes through the same guard as the extraction stage:
 *     the human pacing profile, the per-host daily cap, the working-hours
 *     window and the circuit breaker. A shared read spends the same
 *     budget as a pipeline read.
 *   - WRITE-NONE. Nothing is written to the link store: no link row, no
 *     content, no history. The only persisted state is the host budget in
 *     `host_state`, which is shared with the extraction stage on purpose.
 *
 * The engine is never named here: the caller injects a `BrowseFn` and the
 * CLI decides whether a host is read with agent-browser or with the
 * stealth engine.
 */
import { hostOf } from './pipeline/resilience.js'
import { isSharedHost, type ShareConfig } from './share-config.js'
import type { GuardDeps } from './resilience/guard.js'
import { guardRun } from './resilience/guard.js'

/** Why a browse call was refused or failed. */
export type BrowseReason =
  | 'not_shared'
  | 'invalid_url'
  | 'no_profile'
  | 'login_wall'
  | 'deferred'
  | 'error'

export interface BrowseResult {
  /** True when the page was read and the markdown is usable. */
  ok: boolean
  /** The page as markdown. Empty when the read failed. */
  markdown: string
  /** The host that was read (the profile owner). */
  host: string
  /** The final URL after redirects, when the engine reports one. */
  finalUrl?: string
  /** The page title, when the engine reports one. */
  title?: string
  /** Which engine read the page (for the caller's information). */
  engine?: string
  /** Why the call failed, when it did. */
  reason?: BrowseReason
  /** A human-readable detail for the reason. */
  detail?: string
  /** How long to wait before retrying, when the call was deferred. */
  retryAfterMs?: number
}

/**
 * The injected read primitive. The CLI wires it to the browser engine for
 * the host (agent-browser, or the stealth engine for the hosts listed in
 * `stealth_hosts`); the tests inject a fake.
 */
export type BrowseFn = (
  url: string,
  host: string,
) => Promise<{
  ok: boolean
  markdown: string
  finalUrl?: string
  title?: string
  engine?: string
  reason?: BrowseReason
  detail?: string
}>

export interface BrowseOptions {
  /** The share allowlist. Only these hosts may be read. */
  share: ShareConfig
  /** The injected read primitive. */
  read: BrowseFn
  /** True when the host has a saved browser profile. */
  hasProfile(host: string): Promise<boolean>
  /** The guard: pacing, daily cap, working hours and the breaker. */
  guard?: GuardDeps
}

/**
 * The hosts that may be read, with the reason a host is not shareable.
 * Pure data: the CLI and the MCP tool render from it.
 */
export interface ShareHostEntry {
  host: string
  /** True when the host is in the `[share] hosts` allowlist. */
  shared: boolean
  /** True when the host has a saved browser profile. */
  hasProfile: boolean
  /** True when a browse of this host would be admitted right now. */
  ready: boolean
  /** Why the host is not ready, when it is not. */
  reason?: string
}

/**
 * Read one page through the host's saved profile.
 *
 * The order of the checks matters: the allowlist comes first, so a host
 * that is not shared is refused before any budget is spent and before the
 * browser is touched at all.
 */
export async function browseRead(
  url: string,
  options: BrowseOptions,
): Promise<BrowseResult> {
  const host = hostOf(url)
  if (host === 'unknown') {
    return {
      ok: false,
      markdown: '',
      host,
      reason: 'invalid_url',
      detail: 'not a valid absolute url',
    }
  }

  if (!isSharedHost(options.share, host)) {
    return {
      ok: false,
      markdown: '',
      host,
      reason: 'not_shared',
      detail: `${host} is not in the [share] hosts allowlist; the owner must opt in before another agent may read it`,
    }
  }

  const hasProfile = await options.hasProfile(host)
  if (!hasProfile) {
    return {
      ok: false,
      markdown: '',
      host,
      reason: 'no_profile',
      detail: `no saved browser profile for ${host}; run: atento login ${host}`,
    }
  }

  // The guard is the same one the extraction stage uses: the human pacing
  // profile, the daily cap, the working-hours window and the breaker. A
  // shared read spends the host budget exactly like a pipeline read.
  if (options.guard) {
    const outcome = await guardRun(options.guard, host, async () => {
      const result = await options.read(url, host)
      if (!result.ok) {
        // A login wall is a block signal: the guard opens the breaker so
        // the host stops being hammered.
        const error = new Error(result.detail ?? result.reason ?? 'browse_failed') as Error & {
          status?: number
        }
        if (result.reason === 'login_wall') error.status = 403
        throw error
      }
      return result
    })
    if (outcome.kind === 'defer') {
      // A hard block surfaces as its own reason: browse throws 403 only for
      // a login wall, so a blocked:http_403 IS the login wall coming back.
      const blocked = outcome.reason.startsWith('blocked:')
      const blockReason = blocked ? outcome.reason.slice('blocked:'.length) : undefined
      return {
        ok: false,
        markdown: '',
        host,
        reason: blocked ? (blockReason === 'http_403' ? 'login_wall' : 'error') : 'deferred',
        detail: outcome.reason,
        retryAfterMs: outcome.retryAfterMs,
      }
    }
    if (outcome.kind === 'error') {
      return {
        ok: false,
        markdown: '',
        host,
        reason: outcome.reason === 'http_403' ? 'login_wall' : 'error',
        detail: outcome.reason,
        retryAfterMs: 0,
      }
    }
    return toResult(outcome.value, host)
  }

  const result = await options.read(url, host)
  return toResult(result, host)
}

function toResult(
  result: {
    ok: boolean
    markdown: string
    finalUrl?: string
    title?: string
    engine?: string
    reason?: BrowseReason
    detail?: string
  },
  host: string,
): BrowseResult {
  return {
    ok: result.ok,
    markdown: result.markdown,
    host,
    finalUrl: result.finalUrl,
    title: result.title,
    engine: result.engine,
    reason: result.reason,
    detail: result.detail,
  }
}

/**
 * The hosts that may be shared: the saved profiles, each one marked with
 * whether the owner allowed it and whether a read would go through right
 * now.
 *
 * A profile-backed host is a strict host for the limiter, so it is paced
 * like a human: the "ready" verdict only reports the allowlist and the
 * profile, never the remaining budget. The budget itself is reported by
 * the existing `limits_status` tool.
 */
export async function listShareHosts(
  profiles: { host: string }[],
  share: ShareConfig,
): Promise<ShareHostEntry[]> {
  return profiles
    .map((profile) => {
      const shared = isSharedHost(share, profile.host)
      const ready = shared
      return {
        host: profile.host,
        shared,
        hasProfile: true,
        ready,
        reason: shared ? undefined : 'not_shared',
      }
    })
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))
}
