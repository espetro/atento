/**
 * Rendering a media report as markdown sections. The pipeline appends this
 * to the link's extracted content; the function is pure and is not called
 * from the pipeline yet.
 */
import type { MediaReport, TierResult } from './types.js'

const HEADINGS: Record<string, string> = {
  caption: 'Caption',
  transcript: 'Transcript',
  frames: 'Frames',
}

/** The markdown section for one tier, or null when the tier has no content. */
export function renderTier(tier: TierResult): string | null {
  if (tier.tier === 'caption') {
    if (tier.status !== 'ok') return null
    const lines: string[] = []
    if (tier.caption) lines.push(tier.caption)
    if (tier.author) lines.push(`Author: ${tier.author}`)
    if (tier.audioTrack) lines.push(`Audio: ${tier.audioTrack}`)
    const counts: string[] = []
    if (tier.likeCount !== undefined) counts.push(`${tier.likeCount} likes`)
    if (tier.commentCount !== undefined) counts.push(`${tier.commentCount} comments`)
    if (tier.viewCount !== undefined) counts.push(`${tier.viewCount} views`)
    if (counts.length > 0) lines.push(counts.join(', '))
    if (tier.hashtags.length > 0) lines.push(tier.hashtags.map((h) => `#${h}`).join(' '))
    if (lines.length === 0) return null
    return `## ${HEADINGS['caption']}\n\n${lines.join('\n')}`
  }

  if (tier.tier === 'transcript') {
    if (tier.status !== 'ok') return null
    return `## ${HEADINGS['transcript']}\n\n${tier.text}`
  }

  return null
}

/**
 * Render the whole report as labeled markdown sections. Only tiers with
 * content produce a section; empty, failed, unsupported and skipped tiers
 * are left out so the appended text stays clean.
 */
export function renderMedia(report: MediaReport): string {
  const sections = report.tiers
    .map(renderTier)
    .filter((s): s is string => s !== null && s.trim() !== '')
  return sections.join('\n\n')
}
