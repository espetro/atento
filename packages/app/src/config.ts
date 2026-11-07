/**
 * Config loading: TOML from ~/.linkinbox/config.toml with env overrides.
 * Only the db path and ttl table today.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import {
  limitsFromToml,
  loginFromToml,
  mediaFromToml,
  pacingFromToml,
  ttlFromToml,
  captureFromToml,
  shareFromToml,
  browserFromToml,
  type BrowserConfig,
  type CaptureConfig,
  type LimitsConfig,
  type LoginConfig,
  type MediaConfig,
  type PacingConfig,
  serverFromToml,
  type ServerConfig,
  type ShareConfig,
  type TomlTable,
  type TtlConfig,
} from '@linkinbox/core'

export interface AppConfig {
  /** Path of the sqlite database file. */
  dbPath: string
  ttl: TtlConfig
  /** Rate limit and breaker configuration from `[limits]`. */
  limits: LimitsConfig
  /** Which hosts may be logged in to, from `[login]`. */
  login: LoginConfig
  /** Human pacing profile for strict hosts from `[pacing]`. */
  pacing: PacingConfig
  /** Tiered media stage configuration from `[media]`. */
  media: MediaConfig
  /** Capture endpoint configuration from `[capture]`. */
  capture: CaptureConfig
  /** HTTP server auth configuration from `[server]`. */
  server: ServerConfig
  /** The share allowlist from `[share]`: the hosts another agent may read. */
  share: ShareConfig
  /** Browser engine configuration from `[browser]`. */
  browser: BrowserConfig
  /** Directory holding agent-browser login profiles. */
  profilesDir: string
  /** Directory holding config.toml. */
  dir: string
  /**
   * Configured ingest sources from `[sources] paths = [...]` in config.toml:
   * local file paths and/or http(s) URLs that `app.run` ingests each pass.
   */
  sources: string[]
}

export const DEFAULT_CONFIG_DIR = join(homedir(), '.linkinbox')

/** Env keys that override the config file. */
export const ENV_KEYS = {
  dbPath: 'LINKINBOX_DB',
  configDir: 'LINKINBOX_CONFIG_DIR',
  home: 'LINKINBOX_HOME',
} as const

/** Resolve the config dir: env override, then ~/.linkinbox. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[ENV_KEYS.configDir]
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  const home = env[ENV_KEYS.home]
  if (home && home.trim() !== '') return join(home, '.linkinbox')
  return DEFAULT_CONFIG_DIR
}

/** Resolve the db path: env override, then [db] path in the toml, then default. */
export function resolveDbPath(toml: TomlTable, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[ENV_KEYS.dbPath]
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  const db = toml['db']
  if (db && typeof db === 'object' && !Array.isArray(db)) {
    const p = (db as TomlTable)['path']
    if (typeof p === 'string' && p !== '') return expandHome(p)
  }
  return join(configDir(env), 'links.db')
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export function defaultProfilesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'profiles')
}

/**
 * Load the config: reads ~/.linkinbox/config.toml when present (missing file
 * is fine, defaults apply) and applies env overrides on top.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dir = configDir(env)
  const configPath = join(dir, 'config.toml')
  let toml: TomlTable = {}
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, 'utf8')
    toml = parseToml(text) as unknown as TomlTable
  }
  return {
    dbPath: resolveDbPath(toml, env),
    ttl: ttlFromToml(toml),
    limits: limitsFromToml(toml),
    login: loginFromToml(toml),
    pacing: pacingFromToml(toml),
    media: mediaFromToml(toml),
    capture: captureFromToml(toml as unknown as Record<string, unknown>),
    server: serverFromToml(toml as unknown as Record<string, unknown>),
    share: shareFromToml(toml as unknown as Record<string, unknown>),
    browser: browserFromToml(toml as unknown as Record<string, unknown>),
    profilesDir: defaultProfilesDir(env),
    dir,
    sources: sourcesFromToml(toml),
  }
}

/**
 * `[sources] paths = [...]` — each entry is a local path (expanded for `~`)
 * or an http(s) URL; `app.run` routes them to ingest file/remote jobs.
 */
export function sourcesFromToml(toml: TomlTable): string[] {
  const sources = toml['sources']
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return []
  const paths = (sources as TomlTable)['paths']
  if (!Array.isArray(paths)) return []
  return paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .map((p) => (p.startsWith('~/') || p === '~' ? expandHome(p) : p))
}
