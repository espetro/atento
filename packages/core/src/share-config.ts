/**
 * Shared-browser config, parsed from the `[share]` TOML table.
 *
 *   [share]
 *   hosts = ["x.com", "*.linkedin.com"]
 *
 * `hosts` is the allowlist of hosts another agent may READ through a saved
 * browser profile (`atento browse`, the MCP browse_read tool). It ships
 * EMPTY: nothing is shared until the owner opts in host by host. The same
 * pattern syntax as the skip-list applies (exact host or `*.suffix`,
 * via core.matchesPattern), and a listed host still needs a saved profile
 * from `atento login` before anything can be read for it.
 *
 * The allowlist only opens the read path. Nothing the browse surface reads
 * is ever written back to the link store.
 */

import { matchesPattern } from './resilience/limiter.js'

export interface ShareConfig {
  /**
   * Host patterns another agent may read through a saved profile. Empty
   * means nothing is shared.
   */
  hosts: string[]
}

export const DEFAULT_SHARE_CONFIG: ShareConfig = {
  hosts: [],
}

function tomlTable(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Parse the `[share]` table. Additive: a missing table keeps the default
 * (empty) allowlist and garbage values are ignored. Hosts are lowercased
 * like the skip-list.
 */
export function shareFromToml(toml: Record<string, unknown>): ShareConfig {
  const out: ShareConfig = { hosts: [...DEFAULT_SHARE_CONFIG.hosts] }
  const table = tomlTable(toml['share'])
  const hosts = table['hosts']
  if (Array.isArray(hosts)) {
    out.hosts = hosts
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.toLowerCase())
  }
  return out
}

/**
 * True when the owner allows reading this host through a saved profile.
 * A false verdict is the reason every browse call is refused by default.
 */
export function isSharedHost(config: ShareConfig, host: string): boolean {
  if (config.hosts.length === 0) return false
  return matchesPattern(config.hosts, host)
}
