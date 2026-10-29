/**
 * The caption tier: caption text, hashtags, author, audio track name and the
 * counts, all taken from metadata that was already extracted for the link.
 * Nothing is fetched here.
 *
 * Two sources are supported:
 *
 * 1. A `media-meta` HTML comment with a JSON object, which the extractor can
 *    emit into the extracted content:
 *
 *    <!--media-meta
 *    {"author":"someone","audioTrack":"Original audio","likeCount":12}
 *    -->
 *
 * 2. Plain text conventions in the extracted markdown, e.g. "Likes: 1,234".
 */
import type { CaptionResult } from './types.js'

export interface CaptionInput {
  /** The link's extracted content (markdown). */
  content?: string | null
  /** Page metadata, when the extractor recorded any. */
  meta?: Record<string, unknown> | null
}

const META_BLOCK = /<!--media-meta\s*([\s\S]*?)-->/

/** Parse "1,234" or "1.2k" into a number. */
export function parseCount(value: string): number | undefined {
  const trimmed = value.trim().toLowerCase()
  const match = /^([0-9][0-9,._]*)\s*([km])?$/.exec(trimmed)
  if (!match) return undefined
  const raw = (match[1] ?? '').replace(/,/g, '').replace(/_/g, '')
  // "1.234" is a thousands separator in this context, "1.2" is a decimal.
  const n = /^\d{1,3}(\.\d{3})+$/.test(raw) ? Number(raw.replace(/\./g, '')) : Number(raw)
  if (!Number.isFinite(n)) return undefined
  const suffix = match[2]
  if (suffix === 'k') return Math.round(n * 1000)
  if (suffix === 'm') return Math.round(n * 1_000_000)
  return n
}

/** All hashtags in the text, in order, without the hash. */
export function extractHashtags(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    const tag = (match[1] ?? '').toLowerCase()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read the metadata the extractor left in the content, if any. */
export function parseMetaBlock(content: string): Record<string, unknown> {
  const match = META_BLOCK.exec(content)
  if (!match) return {}
  try {
    const parsed: unknown = JSON.parse((match[1] ?? '').trim())
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // A malformed block is not fatal: the tier still reports what it can.
  }
  return {}
}

/** The caption text: the first non-empty paragraph of the content. */
export function firstParagraph(content: string): string {
  const withoutMeta = content.replace(META_BLOCK, '')
  for (const block of withoutMeta.split(/\n{2,}/)) {
    const text = block.replace(/^#+\s*/, '').trim()
    if (text !== '') return text
  }
  return ''
}

/** Look for a "Likes: 1,234" style line in the text. */
function countFromText(content: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const pattern = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im')
    const match = pattern.exec(content)
    if (!match) continue
    const parsed = parseCount(match[1] ?? '')
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/**
 * Build the caption tier result from already extracted content.
 * Status is `ok` when there is anything to report, `empty` when the content
 * carries no caption data at all.
 */
export function captionTier(
  input: CaptionInput,
  seconds: number,
): CaptionResult | {
  kind: 'empty'
  tier: 'caption'
  status: 'empty'
  seconds: number
  reason?: string
} {
  const content = input.content ?? ''
  const meta = { ...parseMetaBlock(content), ...(input.meta ?? {}) }

  const caption = str(meta['caption']) ?? firstParagraph(content)
  const hashtags = Array.isArray(meta['hashtags'])
    ? meta['hashtags'].filter((h): h is string => typeof h === 'string')
    : extractHashtags(content)
  const author = str(meta['author'])
  const audioTrack = str(meta['audioTrack']) ?? str(meta['audio_track'])
  const likeCount =
    num(meta['likeCount']) ?? num(meta['likes']) ?? countFromText(content, ['likes', 'Likes'])
  const commentCount =
    num(meta['commentCount']) ?? num(meta['comments']) ?? countFromText(content, ['comments', 'Comments'])
  const viewCount =
    num(meta['viewCount']) ?? num(meta['views']) ?? countFromText(content, ['views', 'Views'])

  const hasAnything =
    caption !== '' ||
    hashtags.length > 0 ||
    author !== undefined ||
    audioTrack !== undefined ||
    likeCount !== undefined ||
    commentCount !== undefined ||
    viewCount !== undefined

  if (!hasAnything) {
    return {
      kind: 'empty',
      tier: 'caption',
      status: 'empty',
      seconds,
      reason: 'no caption metadata in the extracted content',
    }
  }

  return {
    kind: 'caption',
    tier: 'caption',
    status: 'ok',
    seconds,
    text: caption,
    caption: caption === '' ? undefined : caption,
    hashtags,
    author,
    audioTrack,
    likeCount,
    commentCount,
    viewCount,
  }
}
