import { parse as parseToml } from 'smol-toml'
import { ttlFromToml, type TtlConfig, type TomlTable } from './ttl.js'
import {
  DEFAULT_LIMITS,
  ORDINARY_LIMIT,
  WALLED_GARDEN_LIMIT,
  type LimitsConfig,
} from './resilience/index.js'

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
 *
 *   [limits.hosts."x.com"]
 *   interval_ms = 45000
 *   daily_cap = 40
 *   concurrency = 1
 */
export function limitsFromToml(toml: TomlTable): LimitsConfig {
  const limits = toml['limits']
  const out: LimitsConfig = {
    ...DEFAULT_LIMITS,
    hosts: {},
    walledGardens: [...DEFAULT_LIMITS.walledGardens],
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
    out.walledGardens = gardens.filter((g): g is string => typeof g === 'string')
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

export { DEFAULT_LIMITS, ORDINARY_LIMIT, WALLED_GARDEN_LIMIT }
export type { LimitsConfig }
