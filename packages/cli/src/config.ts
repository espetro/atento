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
  mediaFromToml,
  pacingFromToml,
  ttlFromToml,
  captureFromToml,
  type CaptureConfig,
  type LimitsConfig,
  type MediaConfig,
  type PacingConfig,
  type TomlTable,
  type TtlConfig,
} from '@linkinbox/core'

export interface AppConfig {
  /** Path of the sqlite database file. */
  dbPath: string
  ttl: TtlConfig
  /** Rate limit and breaker configuration from `[limits]`. */
  limits: LimitsConfig
  /** Human pacing profile for strict hosts from `[pacing]`. */
  pacing: PacingConfig
  /** Tiered media stage configuration from `[media]`. */
  media: MediaConfig
  /** Capture endpoint configuration from `[capture]`. */
  capture: CaptureConfig
  /** Directory holding agent-browser login profiles. */
  profilesDir: string
  /** Directory holding config.toml. */
  dir: string
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
    pacing: pacingFromToml(toml),
    media: mediaFromToml(toml),
    capture: captureFromToml(toml as unknown as Record<string, unknown>),
    profilesDir: defaultProfilesDir(env),
    dir,
  }
}
