import type { RawLink } from '@atento/core'
import { readTextFile } from './fs-utils.js'
import type { ImportResult } from './types.js'

/**
 * Generic JSON importer. Accepts either a top-level array of link-ish
 * objects or an object with an `items` array. Objects need a `url` field;
 * `title`, `note`/`description`, `tags`, `addedAt`/`added_at`/`date_added`
 * are picked up when present.
 */
export const JSON_SOURCE = 'json'

const URL_KEYS = ['url', 'link', 'href']
const TITLE_KEYS = ['title', 'name', 'text']
const NOTE_KEYS = ['note', 'description', 'summary', 'excerpt']
const ADDED_KEYS = ['addedAt', 'added_at', 'date_added', 'createdAt', 'created_at', 'time_added']

export function parseJsonLinks(text: string): { links: RawLink[]; warnings: string[] } {
  const warnings: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { links: [], warnings: [`Malformed JSON: ${(err as Error).message}`] }
  }

  let items: unknown[] | null = null
  if (Array.isArray(parsed)) {
    items = parsed
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const candidate = obj['items'] ?? obj['links'] ?? obj['data']
    if (Array.isArray(candidate)) items = candidate
    else {
      return { links: [], warnings: ['JSON object has no "items" array; nothing to import.'] }
    }
  } else {
    return { links: [], warnings: ['JSON root is not an array or object; nothing to import.'] }
  }

  const links: RawLink[] = []
  let skipped = 0
  for (const item of items) {
    const link = toRawLink(item)
    if (link) links.push(link)
    else skipped += 1
  }
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} JSON item(s) without a usable "url" field.`)
  }
  if (links.length === 0 && skipped === 0) {
    warnings.push('JSON file contained no items.')
  }
  return { links, warnings }
}

function toRawLink(item: unknown): RawLink | null {
  if (typeof item === 'string') {
    const url = item.trim()
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? { url, source: JSON_SOURCE } : null
  }
  if (!item || typeof item !== 'object') return null
  const obj = item as Record<string, unknown>
  const url = pickString(obj, URL_KEYS)
  if (!url || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null
  const link: RawLink = { url, source: JSON_SOURCE }
  const title = pickString(obj, TITLE_KEYS)
  if (title) link.title = title
  const note = pickString(obj, NOTE_KEYS)
  if (note) link.note = note
  const tags = pickTags(obj)
  if (tags) link.tags = tags
  const added = pickDate(obj)
  if (added) link.addedAt = added
  return link
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

function pickTags(obj: Record<string, unknown>): string[] | undefined {
  const v = obj['tags']
  if (Array.isArray(v)) {
    const tags = v.filter((t): t is string => typeof t === 'string')
    return tags.length > 0 ? tags : undefined
  }
  if (typeof v === 'string' && v.trim() !== '') {
    return v
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }
  return undefined
}

function pickDate(obj: Record<string, unknown>): Date | undefined {
  for (const key of ADDED_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim() !== '') {
      const d = new Date(v)
      if (!Number.isNaN(d.getTime())) return d
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      const d = new Date(v)
      if (!Number.isNaN(d.getTime())) return d
    }
  }
  return undefined
}

export async function importJson(filePath: string): Promise<ImportResult> {
  const { text, warning } = await readTextFile(filePath)
  if (text === null) return { links: [], warnings: [warning ?? `Cannot read ${filePath}.`] }
  const parsed = parseJsonLinks(text)
  return { links: parsed.links, warnings: parsed.warnings }
}
