/**
 * Browser engine config, parsed from the `[browser]` TOML table.
 *
 *   [browser]
 *   engine = "agent-browser"            # or "patchright"
 *   stealth_hosts = ["app.devin.ai", "*.usebrioso.com"]
 *   executable_path = "/Applications/BrowserOS.app/Contents/MacOS/browseros"
 *
 * `engine` selects the browser engine for every browser-routed host.
 * `stealth_hosts` additionally routes the listed hosts to the stealth
 * (Patchright) engine while the default engine stays agent-browser; it uses
 * the same host patterns as the limiter skip-list (exact host or `*.suffix`,
 * via core.matchesPattern). `executable_path` points either engine at a
 * specific Chromium (a BrowserOS or anti-detect build); the
 * AGENT_BROWSER_EXECUTABLE_PATH env var still wins when set.
 *
 * No provider or model names anywhere: the engine names are local product
 * choices, the binary comes from config/env.
 */

export type BrowserEngine = 'agent-browser' | 'patchright'

export const DEFAULT_BROWSER_ENGINE: BrowserEngine = 'agent-browser'

export interface BrowserConfig {
  /** The engine used for browser-routed hosts. Default "agent-browser". */
  engine: BrowserEngine
  /**
   * Hosts routed to the stealth engine even when the default engine is
   * agent-browser. Same pattern syntax as the skip-list.
   */
  stealthHosts: string[]
  /**
   * Chromium binary for either engine. Unset means: the engine's own
   * resolution (env var first, then the engine default).
   */
  executablePath?: string
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  engine: DEFAULT_BROWSER_ENGINE,
  stealthHosts: [],
}

function tomlTable(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Parse the `[browser]` table. Additive: a missing table keeps the defaults
 * and garbage values are ignored. Hosts are lowercased like the skip-list.
 */
export function browserFromToml(toml: Record<string, unknown>): BrowserConfig {
  const out: BrowserConfig = {
    engine: DEFAULT_BROWSER_CONFIG.engine,
    stealthHosts: [...DEFAULT_BROWSER_CONFIG.stealthHosts],
    ...(DEFAULT_BROWSER_CONFIG.executablePath
      ? { executablePath: DEFAULT_BROWSER_CONFIG.executablePath }
      : {}),
  }
  const table = tomlTable(toml['browser'])

  const engine = table['engine']
  if (engine === 'agent-browser' || engine === 'patchright') out.engine = engine

  const stealth = table['stealth_hosts']
  if (Array.isArray(stealth)) {
    out.stealthHosts = stealth
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.toLowerCase())
  }

  const executable = table['executable_path']
  if (typeof executable === 'string' && executable.trim() !== '') {
    out.executablePath = executable.trim()
  }
  return out
}

/**
 * True when a host must use the stealth engine: either the config engine is
 * patchright for everyone, or the host matches stealth_hosts. Pattern
 * matching is the limiter's matchesPattern (exact host or `*.suffix`).
 */
export function isStealthHost(config: BrowserConfig, host: string): boolean {
  if (config.engine === 'patchright') return true
  return isListedStealthHost(config, host)
}

/**
 * True when the host is explicitly listed in `stealth_hosts`, ignoring the
 * global engine. A listed host is one the owner knows blocks plain
 * requests, so it always goes through the stealth browser; the global
 * `engine = "patchright"` only picks the engine for the hosts that need a
 * browser at all.
 */
export function isListedStealthHost(config: BrowserConfig, host: string): boolean {
  const lower = host.toLowerCase()
  return config.stealthHosts.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2)
      return lower === suffix || lower.endsWith(`.${suffix}`)
    }
    return lower === pattern
  })
}

/**
 * Resolve the Chromium binary for a host's engine: the
 * AGENT_BROWSER_EXECUTABLE_PATH env var wins (existing behaviour, kept for
 * the agent-browser engine), then the config value, else undefined (the
 * engine's own default).
 */
export function executablePathFor(
  config: BrowserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env['AGENT_BROWSER_EXECUTABLE_PATH']
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  return config.executablePath
}
