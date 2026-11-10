import type { RawLink } from '@atento/core'
import { readTextFile } from './fs-utils.js'
import type { ImportResult } from './types.js'

/**
 * URL-list importer: one URL per line. Blank lines and `#` comments are
 * ignored. Optional trailing whitespace and inline `#` comments are stripped.
 */
export const URL_LIST_SOURCE = 'url-list'

export function parseUrlList(text: string): { links: RawLink[]; warnings: string[] } {
  const warnings: string[] = []
  const links: RawLink[] = []
  let skipped = 0

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const url = stripInlineComment(line)
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      skipped += 1
      continue
    }
    links.push({ url, source: URL_LIST_SOURCE })
  }

  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} line(s) that are not absolute URLs.`)
  }
  if (links.length === 0) {
    warnings.push('No URLs found in file.')
  }
  return { links, warnings }
}

function stripInlineComment(line: string): string {
  const hashIndex = line.indexOf('#')
  const withoutHash = hashIndex === -1 ? line : line.slice(0, hashIndex)
  return withoutHash.trim()
}

export async function importUrlList(filePath: string): Promise<ImportResult> {
  const { text, warning } = await readTextFile(filePath)
  if (text === null) return { links: [], warnings: [warning ?? `Cannot read ${filePath}.`] }
  const parsed = parseUrlList(text)
  return { links: parsed.links, warnings: parsed.warnings }
}
