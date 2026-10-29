/**
 * The `[media]` config table: what the tiered media stage is allowed to do.
 * Parsed next to `[limits]` in the same config.toml.
 *
 *   [media]
 *   enabled_tiers = ["caption", "transcript"]
 *   daily_cap = 20
 *   max_duration_seconds = 600
 *   cookies_from_browser = false
 *
 *   [media.daily_caps]
 *   transcript = 10
 */
import type { TomlTable } from './ttl.js'

/** The tier names the media stage knows about. */
export const MEDIA_TIERS = ['caption', 'transcript', 'frames'] as const
export type MediaTierName = (typeof MEDIA_TIERS)[number]

export interface MediaConfig {
  /** Tiers the stage runs, in order. */
  enabledTiers: MediaTierName[]
  /** Media runs allowed per day, all tiers together. */
  dailyCap: number
  /** Per-tier overrides for the daily cap. */
  dailyCaps: Partial<Record<MediaTierName, number>>
  /** Longest media the stage will download, in seconds. */
  maxDurationSeconds: number
  /** Pass browser cookies to yt-dlp. Off by default. */
  cookiesFromBrowser: boolean
}

export const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  enabledTiers: ['caption', 'transcript'],
  dailyCap: 20,
  dailyCaps: {},
  maxDurationSeconds: 600,
  cookiesFromBrowser: false,
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function tierName(value: unknown): MediaTierName | undefined {
  return MEDIA_TIERS.includes(value as MediaTierName) ? (value as MediaTierName) : undefined
}

/** Parse the `[media]` table out of a TOML document. */
export function mediaFromToml(toml: TomlTable): MediaConfig {
  const out: MediaConfig = {
    ...DEFAULT_MEDIA_CONFIG,
    enabledTiers: [...DEFAULT_MEDIA_CONFIG.enabledTiers],
    dailyCaps: {},
  }
  const media = toml['media']
  if (!media || typeof media !== 'object' || Array.isArray(media)) return out
  const table = media as TomlTable

  const tiers = table['enabled_tiers']
  if (Array.isArray(tiers)) {
    const parsed = tiers.map(tierName).filter((t): t is MediaTierName => t !== undefined)
    if (parsed.length > 0) out.enabledTiers = parsed
  }

  const cap = num(table['daily_cap'])
  if (cap !== undefined) out.dailyCap = Math.max(0, cap)

  const duration = num(table['max_duration_seconds'])
  if (duration !== undefined) out.maxDurationSeconds = Math.max(0, duration)

  if (typeof table['cookies_from_browser'] === 'boolean') {
    out.cookiesFromBrowser = table['cookies_from_browser']
  }

  const caps = table['daily_caps']
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    for (const [key, value] of Object.entries(caps as TomlTable)) {
      const tier = tierName(key)
      const limit = num(value)
      if (tier === undefined || limit === undefined) continue
      out.dailyCaps[tier] = Math.max(0, limit)
    }
  }

  return out
}
