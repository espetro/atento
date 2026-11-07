/**
 * Browser engine config, parsed from the `[browser]` TOML table.
 *
 * New shape (M1):
 *
 *   [browser]
 *   reader = "headless"            # default PageReader adapter instance
 *   login = "headless"             # default SessionLogin adapter instance
 *   escalate = ["stealth"]         # ordered fallback on bot block / login wall
 *
 *   [browser.adapters.headless]
 *   kind = "agent-browser"
 *   executable = "/path/to/chromium"
 *
 *   [browser.adapters.stealth]
 *   kind = "patchright"
 *
 *   [browser.adapters.user-session]
 *   kind = "cdp-attach"
 *   endpoint = "http://127.0.0.1:9222"
 *
 *   [browser.hosts]
 *   "x.com" = "user-session"
 *
 * Legacy shape (still works through the migration shim):
 *
 *   [browser]
 *   engine = "agent-browser"            # or "patchright"
 *   stealth_hosts = ["app.devin.ai", "*.usebrioso.com"]
 *   executable_path = "/Applications/BrowserOS.app/..."
 *
 * `engine`/`stealth_hosts`/`executable_path` are translated into an
 * equivalent adapter registry at parse time: a "headless" agent-browser
 * adapter, a "stealth" patchright adapter, stealth_hosts mapped onto
 * [browser.hosts], and escalate = ["stealth"] when the default engine is
 * agent-browser. `executable_path` lands on both migrated adapters.
 *
 * `AGENT_BROWSER_EXECUTABLE_PATH` env still wins at resolve time (see
 * executablePathFor). No provider or model names anywhere.
 */

import type { BrowserAdapterConfig, BrowserAdapterKind } from './ports/browser.js'

export type BrowserEngine = 'agent-browser' | 'patchright'

export const DEFAULT_BROWSER_ENGINE: BrowserEngine = 'agent-browser'

/** Adapter ids the migration shim synthesizes from legacy keys. */
export const LEGACY_HEADLESS_ADAPTER = 'headless'
export const LEGACY_STEALTH_ADAPTER = 'stealth'

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

  // ---- M1 registry fields --------------------------------------------
  /** Default PageReader adapter instance id. */
  reader: string
  /** Default SessionLogin adapter instance id. */
  login: string
  /** Ordered adapter ids tried on bot-block / login-wall signals. */
  escalate: string[]
  /** Adapter instance id -> its table. */
  adapters: Record<string, BrowserAdapterConfig>
  /** Host pattern -> adapter instance id (exact host or `*.suffix`). */
  hosts: Record<string, string>
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  engine: DEFAULT_BROWSER_ENGINE,
  stealthHosts: [],
  reader: LEGACY_HEADLESS_ADAPTER,
  login: LEGACY_HEADLESS_ADAPTER,
  escalate: [LEGACY_STEALTH_ADAPTER],
  adapters: {
    [LEGACY_HEADLESS_ADAPTER]: { kind: 'agent-browser', options: {} },
    [LEGACY_STEALTH_ADAPTER]: { kind: 'patchright', options: {} },
  },
  hosts: {},
}

function tomlTable(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const ADAPTER_KINDS: readonly BrowserAdapterKind[] = [
  'agent-browser',
  'patchright',
  'cdp-attach',
  'external',
]

/**
 * Parse one `[browser.adapters.<id>]` table. Unknown keys are kept in
 * `options` so newer kinds stay forward-compatible.
 */
function adapterFromToml(id: string, value: unknown): BrowserAdapterConfig | undefined {
  const table = tomlTable(value)
  const kind = table['kind']
  if (typeof kind !== 'string' || !ADAPTER_KINDS.includes(kind as BrowserAdapterKind)) {
    return undefined
  }
  const options: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(table)) {
    if (key === 'kind') continue
    // `executable` is the documented key; accept the snake/legacy spellings.
    if (key === 'executable' || key === 'executable_path' || key === 'executablePath') {
      options['executablePath'] = v
      continue
    }
    options[key] = v
  }
  return { kind: kind as BrowserAdapterKind, options }
}

/**
 * Parse the `[browser]` table. Additive: a missing table keeps the defaults
 * and garbage values are ignored. Hosts are lowercased like the skip-list.
 *
 * When no `[browser.adapters]` table is present the legacy keys synthesize
 * the equivalent registry (the migration shim); an explicit adapters table
 * is used verbatim and the legacy keys only fill gaps.
 */
export function browserFromToml(toml: Record<string, unknown>): BrowserConfig {
  const out: BrowserConfig = {
    engine: DEFAULT_BROWSER_CONFIG.engine,
    stealthHosts: [...DEFAULT_BROWSER_CONFIG.stealthHosts],
    reader: DEFAULT_BROWSER_CONFIG.reader,
    login: DEFAULT_BROWSER_CONFIG.login,
    escalate: [...DEFAULT_BROWSER_CONFIG.escalate],
    adapters: {},
    hosts: {},
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

  // ---- new-style keys -------------------------------------------------
  const reader = str(table['reader'])
  if (reader) out.reader = reader
  const login = str(table['login'])
  if (login) out.login = login
  const escalate = table['escalate']
  const escalateSet = Array.isArray(escalate)
  if (escalateSet) {
    out.escalate = (escalate as unknown[]).filter(
      (e): e is string => typeof e === 'string' && e !== '',
    )
  }

  const adaptersTable = tomlTable(table['adapters'])
  for (const [id, value] of Object.entries(adaptersTable)) {
    const adapter = adapterFromToml(id, value)
    if (adapter) out.adapters[id] = adapter
  }

  const hostsTable = tomlTable(table['hosts'])
  for (const [host, value] of Object.entries(hostsTable)) {
    const id = str(value)
    if (id) out.hosts[host.toLowerCase()] = id
  }

  // ---- migration shim ---------------------------------------------------
  // No explicit adapters: synthesize the legacy pair so old configs keep
  // working unchanged.
  if (Object.keys(out.adapters).length === 0) {
    out.adapters[LEGACY_HEADLESS_ADAPTER] = {
      kind: 'agent-browser',
      options: out.executablePath ? { executablePath: out.executablePath } : {},
    }
    out.adapters[LEGACY_STEALTH_ADAPTER] = {
      kind: 'patchright',
      options: out.executablePath ? { executablePath: out.executablePath } : {},
    }
    if (out.engine === 'patchright') {
      out.reader = LEGACY_STEALTH_ADAPTER
      out.login = LEGACY_STEALTH_ADAPTER
      out.escalate = escalateSet ? out.escalate : []
    } else if (!escalateSet) {
      // No explicit escalate list: keep the legacy patchright fallback.
      out.escalate = [LEGACY_STEALTH_ADAPTER]
    }
    for (const pattern of out.stealthHosts) {
      out.hosts[pattern] = LEGACY_STEALTH_ADAPTER
    }
  } else {
    // Explicit adapters: legacy keys fill the gaps only — but they still
    // mean what they meant before: engine picks the default reader/login
    // engine and stealth_hosts names hosts that need the stealth engine.
    const kindId = (kind: BrowserAdapterKind): string | undefined =>
      Object.keys(out.adapters).find((id) => out.adapters[id]!.kind === kind)

    // Legacy stealth demand (engine = "patchright" or any stealth_hosts
    // entry) requires a patchright-kind adapter. When the explicit table
    // provides none, synthesize the migrated stealth adapter so old keys
    // keep working next to new ones.
    const wantsStealth = out.engine === 'patchright' || out.stealthHosts.length > 0
    let stealthId = kindId('patchright')
    if (wantsStealth && stealthId === undefined && !(LEGACY_STEALTH_ADAPTER in out.adapters)) {
      out.adapters[LEGACY_STEALTH_ADAPTER] = {
        kind: 'patchright',
        options: out.executablePath ? { executablePath: out.executablePath } : {},
      }
      stealthId = LEGACY_STEALTH_ADAPTER
    }

    // The engine's preferred adapter: the migrated id for the engine
    // ('stealth'/'headless') when present, else any adapter of the
    // engine's kind, else the first configured adapter.
    const engineKind: BrowserAdapterKind =
      out.engine === 'patchright' ? 'patchright' : 'agent-browser'
    const migratedId = out.engine === 'patchright' ? LEGACY_STEALTH_ADAPTER : LEGACY_HEADLESS_ADAPTER
    const preferred =
      (out.adapters[migratedId] !== undefined ? migratedId : undefined) ?? kindId(engineKind)
    const fallback = firstAdapterId(out.adapters)
    if (!str(table['reader'])) {
      out.reader = preferred ?? fallback
    }
    if (!str(table['login'])) {
      out.login = preferred ?? fallback
    }
    for (const pattern of out.stealthHosts) {
      // stealth_hosts keeps meaning "the stealth adapter" — whichever
      // patchright-kind adapter that is — and never overrides an explicit
      // [browser.hosts] entry.
      if (!(pattern in out.hosts) && stealthId !== undefined) {
        out.hosts[pattern] = stealthId
      }
    }
    // executable_path applies to adapters that understand it and have none.
    if (out.executablePath) {
      for (const adapter of Object.values(out.adapters)) {
        const opts = adapter.options
        const has =
          typeof opts['executablePath'] === 'string' ||
          typeof opts['executable'] === 'string' ||
          typeof opts['executable_path'] === 'string'
        if (!has && (adapter.kind === 'agent-browser' || adapter.kind === 'patchright')) {
          opts['executablePath'] = out.executablePath
        }
      }
    }
  }
  return out
}

function firstAdapterId(adapters: Record<string, BrowserAdapterConfig>): string {
  return Object.keys(adapters).sort()[0] ?? LEGACY_HEADLESS_ADAPTER
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
  return (config.stealthHosts ?? []).some((pattern) => {
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

// ---- M1 registry resolution --------------------------------------------

/** The role a registry lookup plays: reading pages or capturing logins. */
export type BrowserRole = 'reader' | 'login'

/**
 * The adapter instance id a host resolves to for a role: an explicit
 * `[browser.hosts]` mapping (or a migrated stealth_hosts entry) wins,
 * else the role's default (`reader` / `login`).
 */
export function resolveBrowserAdapter(
  config: BrowserConfig,
  role: BrowserRole,
  host: string,
): string {
  const mapped = browserHostAdapter(config, host)
  if (mapped !== undefined) return mapped
  if (role === 'login') return config.login ?? LEGACY_HEADLESS_ADAPTER
  return config.reader ?? LEGACY_HEADLESS_ADAPTER
}

/**
 * The `[browser.hosts]` adapter id for a host, honouring exact hosts and
 * `*.suffix` patterns. First match in insertion order wins.
 */
export function browserHostAdapter(config: BrowserConfig, host: string): string | undefined {
  const lower = host.toLowerCase()
  for (const [pattern, id] of Object.entries(config.hosts ?? {})) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2)
      if (lower === suffix || lower.endsWith(`.${suffix}`)) return id
    } else if (lower === pattern) {
      return id
    }
  }
  return undefined
}

/**
 * The ordered adapter ids escalation walks on a bot block or login wall:
 * `[browser] escalate`, minus the adapter that already ran for the host
 * (escalating onto itself would loop).
 */
export function browserEscalation(
  config: BrowserConfig,
  host: string,
  usedAdapterId?: string,
): string[] {
  const used =
    usedAdapterId ?? resolveBrowserAdapter(config, 'reader', host)
  const adapters = config.adapters ?? {}
  return (config.escalate ?? []).filter((id) => id !== used && id in adapters)
}

/** The config table of one adapter instance, when it exists. */
export function browserAdapterConfig(
  config: BrowserConfig,
  id: string,
): BrowserAdapterConfig | undefined {
  return config.adapters?.[id]
}

/**
 * Normalize a BrowserConfig that may have been built by hand (tests,
 * programmatic callers) instead of `browserFromToml`: registry fields
 * that are missing are filled with the same rules the TOML migration shim
 * uses, but an explicitly supplied `adapters` table is never dropped —
 * only gaps are filled. Idempotent on already-normalized configs.
 */
export function normalizeBrowserConfig(config: BrowserConfig): BrowserConfig {
  const engine = config.engine ?? DEFAULT_BROWSER_ENGINE
  const executablePath = config.executablePath
  const adapterOptions = executablePath ? { executablePath } : {}
  const adapters: Record<string, BrowserAdapterConfig> = { ...(config.adapters ?? {}) }

  const kindId = (kind: BrowserAdapterKind): string | undefined =>
    Object.keys(adapters).find((id) => adapters[id]!.kind === kind)

  if (Object.keys(adapters).length === 0) {
    // No adapters at all: the legacy pair, exactly like the TOML shim.
    adapters[LEGACY_HEADLESS_ADAPTER] = { kind: 'agent-browser', options: { ...adapterOptions } }
    adapters[LEGACY_STEALTH_ADAPTER] = { kind: 'patchright', options: { ...adapterOptions } }
  }

  // Legacy stealth demand needs a patchright-kind adapter; synthesize the
  // migrated stealth one when the table does not provide any.
  const stealthHosts = config.stealthHosts ?? []
  const wantsStealth = engine === 'patchright' || stealthHosts.length > 0
  let stealthId = kindId('patchright')
  if (wantsStealth && stealthId === undefined && !(LEGACY_STEALTH_ADAPTER in adapters)) {
    adapters[LEGACY_STEALTH_ADAPTER] = { kind: 'patchright', options: { ...adapterOptions } }
    stealthId = LEGACY_STEALTH_ADAPTER
  }

  const engineKind: BrowserAdapterKind = engine === 'patchright' ? 'patchright' : 'agent-browser'
  const migratedId = engine === 'patchright' ? LEGACY_STEALTH_ADAPTER : LEGACY_HEADLESS_ADAPTER
  const preferred =
    (adapters[migratedId] !== undefined ? migratedId : undefined) ?? kindId(engineKind)
  const fallback = firstAdapterId(adapters)

  const hosts: Record<string, string> = { ...(config.hosts ?? {}) }
  for (const pattern of stealthHosts) {
    if (!(pattern in hosts) && stealthId !== undefined) hosts[pattern] = stealthId
  }

  return {
    ...config,
    engine,
    stealthHosts,
    reader: config.reader || preferred || fallback,
    login: config.login || preferred || fallback,
    escalate: config.escalate ?? (engine === 'patchright' ? [] : [stealthId ?? LEGACY_STEALTH_ADAPTER]),
    adapters,
    hosts,
  }
}
