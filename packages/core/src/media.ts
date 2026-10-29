/**
 * The media port: what the pipeline needs from the tiered media stage.
 *
 * The stage itself lives in `@linkinbox/media`; the pipeline depends only on
 * this port so core stays free of download and transcription code. The
 * caller (CLI, MCP) injects the implementation alongside the extract and
 * enrich functions. Nothing here names a provider or a model.
 */
import type { MediaTierName } from './media-config.js'

/** One per-tier result, shaped like the media package's per-tier result. */
export interface MediaTierReport {
  tier: MediaTierName
  status: 'ok' | 'empty' | 'failed' | 'unsupported' | 'skipped'
  seconds?: number
  /** Text the tier produced (caption text, transcript). */
  text?: string
  /** Why the tier produced nothing (skipped, unsupported, empty). */
  reason?: string
  /** The error string when the status is failed. */
  error?: string
}

/** The combined report for one link: every requested tier appears once. */
export interface MediaReport {
  url: string
  tiers: MediaTierReport[]
}

/**
 * The result of one media run: the per-tier report plus the markdown the
 * pipeline appends to the link's extracted content. The renderer lives in
 * the media package (`renderMedia`), so core stays free of it.
 */
export interface MediaRun {
  report: MediaReport
  /** The rendered markdown sections (empty when no tier produced content). */
  markdown: string
}

/**
 * The media stage function. It receives the url, the extracted content and
 * the extractor metadata, runs its configured tiers and reports per tier. It
 * never throws: every failure is reported as a tier status.
 */
export type MediaFn = (input: {
  url: string
  content?: string | null
  meta?: Record<string, unknown> | null
  tiers?: MediaTierName[]
}) => Promise<MediaRun>

/**
 * The per-day budget for media runs. The counters are per tier and in total.
 * The store-backed implementation survives restarts; the media package also
 * ships an in-memory one for single-run use.
 */
export interface MediaBudget {
  /** Try to spend one run of this tier. False when the budget is exhausted. */
  consume(tier: MediaTierName): Promise<boolean>
  /** Runs spent today, total and per tier. */
  snapshot(): Promise<{ total: number; byTier: Record<string, number> }>
}

/**
 * Signals that the extracted page is a video or other yt-dlp-able media.
 * Detection is metadata-driven: the extractor's own flag wins, then
 * og:type / twitter:card / schema.org VideoObject. No host names appear here.
 */
export function isVideoMeta(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta) return false
  if (meta['isVideo'] === true) return true
  if (meta['videoObject'] === true) return true
  const ogType = meta['ogType']
  if (typeof ogType === 'string' && /video|movie/i.test(ogType)) return true
  const twitterCard = meta['twitterCard']
  if (twitterCard === true) return true
  if (typeof twitterCard === 'string' && /player|video/i.test(twitterCard)) return true
  return false
}

/** URL path patterns that point at yt-dlp-able media. */
const VIDEO_URL_PATTERNS = [
  /\/(?:reel|reels|watch|video|videos|clips?|embed|media|status)\//i,
  /\.(?:mp4|m4v|webm|mkv|mov|avi)$/i,
  /[?&](?:v|video_id)=/i,
]

/** True when the URL itself looks like a video page or file. */
export function isVideoUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'file:' || parsed.protocol === 'data:') return false
  return VIDEO_URL_PATTERNS.some((p) => p.test(parsed.pathname) || p.test(parsed.search))
}

/** Should the media stage run for this link? See isVideoMeta and isVideoUrl. */
export function isMediaLink(
  url: string,
  meta: Record<string, unknown> | null | undefined,
): boolean {
  return isVideoMeta(meta) || isVideoUrl(url)
}
