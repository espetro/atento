import { extname } from 'node:path'
import type { RawLink } from '@linkinbox/core'
import { importMarkdown, parseMarkdown, MARKDOWN_SOURCE } from './markdown.js'
import { importJson, parseJsonLinks, JSON_SOURCE } from './json.js'
import { importUrlList, parseUrlList, URL_LIST_SOURCE } from './url-list.js'
import {
  importSafariBookmarks,
  importSafariReadingList,
  SAFARI_SOURCE,
  DEFAULT_BOOKMARKS_PATH,
} from './safari-reading-list.js'
import type { ImportResult, Importer } from './types.js'

/** Ordered registry of built-in importers. */
export const importers: Importer[] = [
  {
    name: MARKDOWN_SOURCE,
    matches: (p) => /^\.md$|^\.markdown$/i.test(extname(p)),
    import: importMarkdown,
  },
  {
    name: JSON_SOURCE,
    matches: (p) => extname(p).toLowerCase() === '.json',
    import: importJson,
  },
  {
    name: URL_LIST_SOURCE,
    matches: (p) => /^\.txt$|^\.urls$|^\.list$/i.test(extname(p)),
    import: importUrlList,
  },
  {
    name: SAFARI_SOURCE,
    matches: (p) => /^\.plist$/i.test(extname(p)),
    import: (p) => importSafariBookmarks(p),
  },
]

/**
 * Import one file with the first matching importer. Unknown extension falls
 * back to the markdown parser (most forgiving text format). Never throws on
 * malformed input: the result carries warnings instead.
 */
export async function importFile(filePath: string): Promise<ImportResult & { importer: string }> {
  const importer = pickImporter(filePath)
  const result = await importer.import(filePath)
  return { ...result, importer: importer.name }
}

export function pickImporter(filePath: string): Importer {
  return importers.find((i) => i.matches(filePath)) ?? markdownImporterFallback()
}

function markdownImporterFallback(): Importer {
  return { name: MARKDOWN_SOURCE, matches: () => true, import: importMarkdown }
}

export {
  MARKDOWN_SOURCE,
  JSON_SOURCE,
  URL_LIST_SOURCE,
  SAFARI_SOURCE,
  DEFAULT_BOOKMARKS_PATH,
  parseMarkdown,
  parseJsonLinks,
  parseUrlList,
}
export type { ImportResult, Importer, RawLink }
