import type { RawLink } from '@linkinbox/core'
import { readTextFile } from './fs-utils.js'
import type { ImportResult } from './types.js'

/**
 * Generic markdown importer.
 *
 * Understands the shape used by most read-later exports:
 *
 * ```markdown
 * ## Some title
 * - [link text](https://example.com/page?utm_source=x)
 * ```
 *
 * A `## heading` sets the title for the links that follow it until the next
 * heading. Links without a heading use their anchor text as the title.
 */
export const MARKDOWN_SOURCE = 'markdown'

const LINK_RE = /^\s*[-*+]\s+\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)(?:\s+.*)?$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/

export function parseMarkdown(text: string): { links: RawLink[]; warnings: string[] } {
  const warnings: string[] = []
  const links: RawLink[] = []
  let heading: string | null = null
  let skipped = 0
  let inCodeFence = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inCodeFence = !inCodeFence
      continue
    }
    if (inCodeFence) continue
    if (line === '') continue

    const headingMatch = HEADING_RE.exec(line)
    if (headingMatch) {
      heading = headingMatch[2]?.trim() || null
      continue
    }

    const linkMatch = LINK_RE.exec(line)
    if (!linkMatch) continue

    const [, text_, url] = linkMatch
    if (!url || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      skipped += 1
      continue
    }
    const anchorText = (text_ ?? '').trim()
    links.push({
      url,
      title: heading ?? (anchorText || undefined),
      source: MARKDOWN_SOURCE,
    })
  }

  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} markdown list item(s) that are not absolute http(s) links.`)
  }
  if (links.length === 0) {
    warnings.push('No links found in markdown file.')
  }
  return { links, warnings }
}

export async function importMarkdown(filePath: string): Promise<ImportResult> {
  const { text, warning } = await readTextFile(filePath)
  if (text === null) return { links: [], warnings: [warning ?? `Cannot read ${filePath}.`] }
  const parsed = parseMarkdown(text)
  return { links: parsed.links, warnings: parsed.warnings }
}
