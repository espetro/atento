import { parse as parseToml } from 'smol-toml'
import { ttlFromToml, type TtlConfig, type TomlTable } from './ttl.js'
import {
  DEFAULT_MEDIA_CONFIG,
  MEDIA_TIERS,
  mediaFromToml,
  type MediaConfig,
  type MediaTierName,
} from './media-config.js'
import {
  DEFAULT_LIMITS,
  DEFAULT_LOGIN_CONFIG,
  ORDINARY_LIMIT,
  WALLED_GARDEN_LIMIT,
  type LimitsConfig,
  type LoginConfig,
} from './resilience/index.js'
import {
  DEFAULT_CAPTURE_CONFIG,
  captureFromToml,
  type CaptureConfig,
} from './capture.js'
import {
  DEFAULT_PACING,
  type PacingConfig,
} from './resilience/human-pacing.js'
import {
  browserFromToml,
  type BrowserConfig,
} from './browser-config.js'
import {
  DEFAULT_SHARE_CONFIG,
  shareFromToml,
  type ShareConfig,
} from './share-config.js'

/**
 * Parse the `[ttl]` table out of raw TOML text. The only TOML the pipeline
 * needs today is the ttl table, but the full document parses so other config
 * sections can live in the same file.
 */
export function parseTtlConfig(tomlText: string): TtlConfig {
  return ttlFromToml(parseToml(tomlText) as TomlTable)
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Parse the `[limits]` table. Shape:
 *
 *   [limits]
 *   global_concurrency = 8
 *   max_batch = 20
 *   llm_concurrency = 3
 *   skip_hosts = ["gemini.google.com", "*.duckduckgo.com"]
 *   review_hosts = ["revolut.com", "*.revolut.com"]
 *   walled_gardens = ["example.com"]
 *
 *   [limits.hosts."x.com"]
 *   interval_ms = 45000
 *   daily_cap = 40
 *   concurrency = 1
 *
 * `skip_hosts` are never fetched. `review_hosts` are never fetched either,
 * but their links stay visible in `needs_browser` (reason `review_only`) so
 * the owner reviews them by hand. `walled_gardens` is an optional manual
 * override that FORCES the strict limits and browser routing for the listed
 * hosts; it ships with no default entries because walled gardens are
 * discovered by canary probing.
 */
export function limitsFromToml(toml: TomlTable): LimitsConfig {
  const limits = toml['limits']
  const out: LimitsConfig = {
    ...DEFAULT_LIMITS,
    hosts: {},
    walledGardens: [...DEFAULT_LIMITS.walledGardens],
    skipHosts: [...DEFAULT_LIMITS.skipHosts],
    reviewHosts: [...DEFAULT_LIMITS.reviewHosts],
  }
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return out
  const table = limits as TomlTable

  const globalConcurrency = num(table['global_concurrency'])
  if (globalConcurrency !== undefined) out.globalConcurrency = Math.max(1, globalConcurrency)
  const maxBatch = num(table['max_batch'])
  if (maxBatch !== undefined) out.maxBatch = Math.max(1, maxBatch)
  const llmConcurrency = num(table['llm_concurrency'])
  if (llmConcurrency !== undefined) out.llmConcurrency = Math.max(1, llmConcurrency)
  const gardens = table['walled_gardens']
  if (Array.isArray(gardens)) {
    out.walledGardens = gardens
      .filter((g): g is string => typeof g === 'string')
      .map((g) => g.toLowerCase())
  }
  const skipHosts = table['skip_hosts']
  if (Array.isArray(skipHosts)) {
    out.skipHosts = skipHosts
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.toLowerCase())
  }
  const reviewHosts = table['review_hosts']
  if (Array.isArray(reviewHosts)) {
    out.reviewHosts = reviewHosts
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.toLowerCase())
  }

  const hosts = table['hosts']
  if (hosts && typeof hosts === 'object' && !Array.isArray(hosts)) {
    for (const [host, value] of Object.entries(hosts as TomlTable)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const hostTable = value as TomlTable
      const override: { intervalMs?: number; dailyCap?: number; concurrency?: number } = {}
      const interval = num(hostTable['interval_ms'])
      if (interval !== undefined) override.intervalMs = Math.max(0, interval)
      const cap = num(hostTable['daily_cap'])
      if (cap !== undefined) override.dailyCap = Math.max(0, cap)
      const concurrency = num(hostTable['concurrency'])
      if (concurrency !== undefined) override.concurrency = Math.max(1, concurrency)
      out.hosts[host.toLowerCase()] = override
    }
  }
  return out
}

/** Parse the `[limits]` table out of raw TOML text. */
export function parseLimitsConfig(tomlText: string): LimitsConfig {
  return limitsFromToml(parseToml(tomlText) as TomlTable)
}

/**
 * Parse the `[login]` table. Shape:
 *
 *   [login]
 *   allow = ["app.devin.ai", "chat.z.ai", "docs.google.com"]
 *
 * `allow` holds host patterns with the same syntax as `skip_hosts` (exact
 * host or `*.suffix`). An empty or missing table means "no restriction":
 * every login-walled host behaves as before.
 */
export function loginFromToml(toml: TomlTable): LoginConfig {
  const out: LoginConfig = { allow: [...DEFAULT_LOGIN_CONFIG.allow] }
  const login = toml['login']
  if (!login || typeof login !== 'object' || Array.isArray(login)) return out
  const table = login as TomlTable
  const allow = table['allow']
  if (Array.isArray(allow)) {
    out.allow = allow
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.toLowerCase())
  }
  return out
}

/** Parse the `[login]` table out of raw TOML text. */
export function parseLoginConfig(tomlText: string): LoginConfig {
  return loginFromToml(parseToml(tomlText) as TomlTable)
}

/** Parse the `[media]` table out of raw TOML text. */
export function parseMediaConfig(tomlText: string): MediaConfig {
  return mediaFromToml(parseToml(tomlText) as TomlTable)
}

/** Parse the `[capture]` table out of raw TOML text. */
export function parseCaptureConfig(tomlText: string): CaptureConfig {
  return captureFromToml(parseToml(tomlText) as TomlTable)
}

/**
 * Parse the `[pacing]` table. Shape:
 *
 *   [pacing]
 *   dwell_median_s = 20
 *   dwell_max_s = 90
 *   break_every_min = 5
 *   break_every_max = 12
 *   break_min_s = 120
 *   break_max_s = 360
 *   daily_cap = 40
 *   hours_start = 8
 *   hours_end = 23
 *
 * The table is additive: a missing table keeps the defaults, and garbage
 * values are ignored. Set `daily_cap` very high (or `hours_start = 0` with
 * `hours_end = 24`) to disable the pacing profile.
 */
export function pacingFromToml(toml: TomlTable): PacingConfig {
  const out: PacingConfig = { ...DEFAULT_PACING }
  const pacing = toml['pacing']
  if (!pacing || typeof pacing !== 'object' || Array.isArray(pacing)) return out
  const table = pacing as TomlTable

  const dwellMedian = num(table['dwell_median_s'])
  if (dwellMedian !== undefined) out.dwellMedianS = Math.max(1, dwellMedian)
  const dwellMax = num(table['dwell_max_s'])
  if (dwellMax !== undefined) out.dwellMaxS = Math.max(1, dwellMax)
  const breakEveryMin = num(table['break_every_min'])
  if (breakEveryMin !== undefined) out.breakEveryMin = Math.max(1, breakEveryMin)
  const breakEveryMax = num(table['break_every_max'])
  if (breakEveryMax !== undefined) out.breakEveryMax = Math.max(1, breakEveryMax)
  const breakMin = num(table['break_min_s'])
  if (breakMin !== undefined) out.breakMinS = Math.max(0, breakMin)
  const breakMax = num(table['break_max_s'])
  if (breakMax !== undefined) out.breakMaxS = Math.max(0, breakMax)
  const dailyCap = num(table['daily_cap'])
  if (dailyCap !== undefined) out.dailyCap = Math.max(0, dailyCap)
  const hoursStart = num(table['hours_start'])
  if (hoursStart !== undefined) out.hoursStart = Math.min(24, Math.max(0, hoursStart))
  const hoursEnd = num(table['hours_end'])
  if (hoursEnd !== undefined) out.hoursEnd = Math.min(24, Math.max(0, hoursEnd))

  // The dwell cap can never sit below the median: the sampler would then
  // always return the cap and the median would be meaningless.
  if (out.dwellMaxS < out.dwellMedianS) out.dwellMaxS = out.dwellMedianS
  if (out.breakEveryMax < out.breakEveryMin) out.breakEveryMax = out.breakEveryMin
  if (out.breakMaxS < out.breakMinS) out.breakMaxS = out.breakMinS
  return out
}

/** Parse the `[pacing]` table out of raw TOML text. */
export function parsePacingConfig(tomlText: string): PacingConfig {
  return pacingFromToml(parseToml(tomlText) as TomlTable)
}

/** Parse the `[share]` table out of raw TOML text. */
export function parseShareConfig(tomlText: string): ShareConfig {
  return shareFromToml(parseToml(tomlText) as unknown as Record<string, unknown>)
}

/** Parse the `[browser]` table out of raw TOML text. */
export function parseBrowserConfig(tomlText: string): BrowserConfig {
  return browserFromToml(parseToml(tomlText) as TomlTable)
}


/** Parse the `[browser]` table out of raw TOML text. */
export function parseBrowserConfig(tomlText: string): BrowserConfig {
  return browserFromToml(parseToml(tomlText) as TomlTable)
}


export { DEFAULT_LIMITS, DEFAULT_LOGIN_CONFIG, ORDINARY_LIMIT, WALLED_GARDEN_LIMIT, DEFAULT_CAPTURE_CONFIG, DEFAULT_SHARE_CONFIG }

export type { LimitsConfig, LoginConfig, CaptureConfig, PacingConfig, ShareConfig, BrowserConfig }
