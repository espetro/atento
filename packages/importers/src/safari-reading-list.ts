import { readFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'plist'
import type { PlistValue } from 'plist'
import type { RawLink } from '@linkinbox/core'
import type { ImportResult } from './types.js'

/**
 * Safari Reading List importer (read-only).
 *
 * Reads `~/Library/Safari/Bookmarks.plist`, picks `WebBookmarkTypeLeaf`
 * children that carry a `ReadingList` dict, and maps:
 * - `URLString` -> url
 * - `URIDictionary.title` -> title
 * - `ReadingList.PreviewText` -> note
 * - `ReadingList.DateAdded` -> addedAt
 * - `ReadingList.DateLastViewed` -> read state (informational; not imported)
 *
 * Reading the file requires Full Disk Access for the host terminal (macOS
 * TCC). On EPERM/EACCES we return [] with a helpful warning; the pipeline
 * never fails because of Safari.
 */
export const SAFARI_SOURCE = 'safari-reading-list'

export const DEFAULT_BOOKMARKS_PATH = join(
  homedir(),
  'Library',
  'Safari',
  'Bookmarks.plist',
)

const FDA_HINT =
  'Safari Reading List requires Full Disk Access: System Settings -> Privacy & Security -> Full Disk Access, then add and enable your terminal app.'

interface SafariLeaf {
  WebBookmarkType?: string
  URLString?: string
  URIDictionary?: { title?: string }
  ReadingList?: {
    PreviewText?: string
    DateAdded?: Date | string
    DateLastViewed?: Date | string
  }
  Title?: string
  Children?: SafariLeaf[]
}

export async function importSafariReadingList(
  filePath: string = DEFAULT_BOOKMARKS_PATH,
): Promise<ImportResult> {
  return importSafariPlist(filePath, { readingListOnly: true })
}

/**
 * Import a Safari `Bookmarks.plist` (binary or XML): Reading List entries
 * plus ordinary bookmarks (the enclosing folder becomes a tag). Used for
 * uploaded `.plist` files; the Reading List-only reader above stays the
 * default for the automatic Safari source.
 */
export async function importSafariBookmarks(filePath: string): Promise<ImportResult> {
  return importSafariPlist(filePath, { readingListOnly: false })
}

/** Top-level Safari folders that carry no meaning as a tag. */
const GENERIC_FOLDERS = new Set(['BookmarksBar', 'BookmarksMenu', 'com.apple.ReadingList', 'Favorites'])

async function importSafariPlist(
  filePath: string,
  { readingListOnly }: { readingListOnly: boolean },
): Promise<ImportResult> {
  const warnings: string[] = []

  let raw: Buffer
  try {
    // Probe + read: TCC denials surface as EPERM on open.
    await access(filePath)
    raw = await readFile(filePath)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return { links: [], warnings: [`Cannot read ${filePath} (${e.code}). ${FDA_HINT}`] }
    }
    if (e.code === 'ENOENT') {
      return {
        links: [],
        warnings: [`No Safari Bookmarks.plist at ${filePath}; skipping Reading List import.`],
      }
    }
    return { links: [], warnings: [`Cannot read ${filePath}: ${e.message}`] }
  }

  let tree: PlistValue
  try {
    // plist@5 treats Uint8Array as binary plist and string as XML/OpenStep.
    // Detect the format ourselves: binary plists start with the "bplist00"
    // magic, everything else is parsed as XML.
    const isBinary = raw.subarray(0, 8).toString('latin1') === 'bplist00'
    tree = isBinary ? parse(new Uint8Array(raw)) : parse(raw.toString('utf8'))
  } catch (err) {
    return { links: [], warnings: [`Malformed plist at ${filePath}: ${(err as Error).message}`] }
  }

  const leaves: Array<{ leaf: SafariLeaf; folder?: string }> = []
  collectLeaves(tree as SafariLeaf, leaves)

  const links: RawLink[] = []
  let skipped = 0
  for (const { leaf, folder } of leaves) {
    const url = typeof leaf.URLString === 'string' ? leaf.URLString : undefined
    if (!url) continue
    // Plain bookmarks are skipped for the Reading List reader; javascript:
    // bookmarklets and other non-web schemes are never links to triage.
    if (readingListOnly && !leaf.ReadingList) continue
    if (!/^https?:\/\//i.test(url)) continue
    const link: RawLink = { url, source: SAFARI_SOURCE }
    const title = leaf.URIDictionary?.title
    if (typeof title === 'string' && title.trim() !== '') link.title = title.trim()
    const note = leaf.ReadingList?.PreviewText
    if (typeof note === 'string' && note.trim() !== '') link.note = note.trim()
    const added = toDate(leaf.ReadingList?.DateAdded)
    if (added) link.addedAt = added
    if (!leaf.ReadingList && folder) link.tags = [folder]
    links.push(link)
  }

  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} Reading List entry(ies) without a URL.`)
  }
  if (links.length === 0) {
    warnings.push(
      readingListOnly
        ? 'Safari Reading List is empty (or the plist had no Reading List entries).'
        : 'No web bookmarks found in the plist.',
    )
  }
  return { links, warnings }
}

function collectLeaves(
  node: SafariLeaf,
  out: Array<{ leaf: SafariLeaf; folder?: string }>,
  folder?: string,
): void {
  if (!node || typeof node !== 'object') return
  if (node.WebBookmarkType === 'WebBookmarkTypeLeaf') {
    out.push({ leaf: node, ...(folder ? { folder } : {}) })
  }
  if (Array.isArray(node.Children)) {
    const title = typeof node.Title === 'string' ? node.Title.trim() : ''
    const next = title !== '' && !GENERIC_FOLDERS.has(title) ? title : folder
    for (const child of node.Children) collectLeaves(child, out, next)
  }
}

function toDate(v: Date | string | undefined): Date | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v
  if (typeof v === 'string') {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  return undefined
}
