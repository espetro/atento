/**
 * TTL configuration, parsed from the `[ttl]` table of the user's config.toml.
 * Pure types + parsing; sweep/prune planning lives in sweep.ts.
 */

export interface TtlConfig {
  default_days: number
  by_category: Record<string, number>
  archive_after_days: number
  delete_after_days: number
}

export const DEFAULT_TTL_CONFIG: TtlConfig = {
  default_days: 30,
  by_category: {},
  archive_after_days: 90,
  delete_after_days: 365,
}

interface TomlTable {
  [key: string]: TomlValue
}
type TomlValue = string | number | boolean | TomlTable | TomlValue[]

/**
 * Extract and validate the `[ttl]` table from already-parsed TOML
 * (pass the object your TOML parser returned; kept parser-agnostic so the
 * config-loading layer can pick any TOML lib).
 * Falls back to defaults for missing keys; throws on wrong-typed values.
 */
export function ttlFromToml(toml: TomlTable): TtlConfig {
  const ttl = toml?.['ttl']
  if (ttl === undefined) return { ...DEFAULT_TTL_CONFIG, by_category: {} }
  if (typeof ttl !== 'object' || ttl === null || Array.isArray(ttl)) {
    throw new TypeError('[ttl] must be a table')
  }
  const t = ttl as TomlTable
  const cfg: TtlConfig = {
    default_days: intField(t, 'default_days', DEFAULT_TTL_CONFIG.default_days),
    by_category: byCategory(t['by_category']),
    archive_after_days: intField(t, 'archive_after_days', DEFAULT_TTL_CONFIG.archive_after_days),
    delete_after_days: intField(t, 'delete_after_days', DEFAULT_TTL_CONFIG.delete_after_days),
  }
  validate(cfg)
  return cfg
}

function intField(t: TomlTable, key: string, fallback: number): number {
  const v = t[key]
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new TypeError(`[ttl] ${key} must be a non-negative integer, got ${String(v)}`)
  }
  return v
}

function byCategory(v: TomlValue | undefined): Record<string, number> {
  if (v === undefined) return {}
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new TypeError('[ttl] by_category must be an inline table of { category = days }')
  }
  const out: Record<string, number> = {}
  for (const [k, days] of Object.entries(v as TomlTable)) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) {
      throw new TypeError(`[ttl] by_category.${k} must be a non-negative integer`)
    }
    out[k] = days
  }
  return out
}

function validate(cfg: TtlConfig): void {
  const { default_days, archive_after_days, delete_after_days } = cfg
  if (!(archive_after_days >= default_days)) {
    throw new TypeError('[ttl] archive_after_days must be >= default_days')
  }
  if (!(delete_after_days >= archive_after_days)) {
    throw new TypeError('[ttl] delete_after_days must be >= archive_after_days')
  }
}

/** Effective TTL in days for a category: by_category override, else default. Pure. */
export function ttlDaysForCategory(cfg: TtlConfig, category: string | null | undefined): number {
  if (category && Object.prototype.hasOwnProperty.call(cfg.by_category, category)) {
    return cfg.by_category[category] as number
  }
  return cfg.default_days
}
