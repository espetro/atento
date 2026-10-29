import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { importMarkdown } from '../src/markdown.js'
import { importJson } from '../src/json.js'
import { importUrlList } from '../src/url-list.js'
import { importSafariReadingList } from '../src/safari-reading-list.js'
import type { RawLink } from '@linkinbox/core'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'fixtures', 'importers')

function plain(links: RawLink[]): Array<Record<string, unknown>> {
  return links.map((l) => ({
    url: l.url,
    title: l.title ?? null,
    source: l.source,
    addedAt: l.addedAt ? l.addedAt.toISOString() : null,
    note: l.note ?? null,
    tags: l.tags ?? null,
  }))
}

describe('markdown importer', () => {
  it('returns the exact expected RawLink[] for the stash fixture', async () => {
    const result = await importMarkdown(join(fixtures, 'stash-export.md'))
    expect(result.warnings).toEqual([])
    expect(plain(result.links)).toEqual([
      {
        url: 'https://deno.com/blog/v2',
        title: 'Engineering',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://www.sqlite.org/btreetrans.html',
        title: 'Engineering',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://danluu.com/lf-implementations/',
        title: 'Engineering',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://www.nngroup.com/articles/design-of-everyday-things-revised/',
        title: 'Reading',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://patterns.dev/patterns-pattern-language/',
        title: 'Reading',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://you-dont-need/You-Dont-Need-Lodash/',
        title: 'JavaScript',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Optional_chaining',
        title: 'JavaScript',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled',
        title: 'JavaScript',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://devblogs.microsoft.com/typescript/announcing-typescript-5-9/',
        title: 'TypeScript',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://www.typescriptlang.org/docs/handbook/2/narrowing.html#the-infer-keyword',
        title: 'TypeScript',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md',
        title: 'Tools',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://github.com/junegunn/fzf/wiki/integration',
        title: 'Tools',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://dataintensive.net/',
        title: 'Architecture',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://www.youtube.com/watch?v=mpPc4D8V_-Q',
        title: 'Architecture',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://example.com/plain-url',
        title: 'Random',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://example.com/tracked?utm_source=newsletter&utm_campaign=weekly&id=42',
        title: 'Random',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://example.com/click?utm_medium=email&fbclid=IwAR3xyz',
        title: 'Random',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://example.com/trailing/',
        title: 'Random',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
      {
        url: 'https://example.com/after-prose',
        title: 'Notes',
        source: 'markdown',
        addedAt: null,
        note: null,
        tags: null,
      },
    ])
  })

  it('returns [] plus a warning for malformed markdown', async () => {
    const result = await importMarkdown(join(fixtures, 'malformed.md'))
    expect(result.links).toEqual([])
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('returns [] plus a warning when the file does not exist', async () => {
    const result = await importMarkdown(join(fixtures, 'does-not-exist.md'))
    expect(result.links).toEqual([])
    expect(result.warnings[0]).toContain('does-not-exist.md')
  })
})

describe('json importer', () => {
  it('imports a top level array', async () => {
    const result = await importJson(join(fixtures, 'links.json'))
    expect(result.warnings).toEqual([])
    expect(result.links.map((l) => l.url)).toEqual([
      'https://example.com/json-array/1',
      'https://example.com/json-array/2',
      'https://example.com/json-array/3',
      'https://example.com/json-array/4?utm_source=rss',
    ])
    expect(result.links[0]?.title).toBe('First JSON item')
    expect(result.links[0]?.tags).toEqual(['json', 'array'])
    expect(result.links[0]?.addedAt?.toISOString()).toBe('2026-01-05T10:00:00.000Z')
    expect(result.links[3]?.note).toBe('stripped url')
  })

  it('imports an { items: [] } object', async () => {
    const result = await importJson(join(fixtures, 'items.json'))
    expect(result.warnings).toEqual([])
    expect(result.links).toHaveLength(2)
    expect(result.links[0]?.url).toBe('https://example.com/items/1')
    expect(result.links[1]?.title).toBe('Second item')
  })

  it('returns [] plus a warning for malformed JSON', async () => {
    const result = await importJson(join(fixtures, 'malformed.json'))
    expect(result.links).toEqual([])
    expect(result.warnings[0]).toContain('Malformed JSON')
  })
})

describe('url-list importer', () => {
  it('imports one url per line and ignores comments and blanks', async () => {
    const result = await importUrlList(join(fixtures, 'urls.txt'))
    expect(result.links.map((l) => l.url)).toEqual([
      'https://example.com/list/1',
      'https://example.com/list/2?utm_source=x&fbclid=y',
      'https://example.com/list/3/',
    ])
    expect(result.warnings).toEqual([])
  })

  it('returns [] plus a warning for a file with no urls', async () => {
    const result = await importUrlList(join(fixtures, 'empty.txt'))
    expect(result.links).toEqual([])
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

describe('safari reading list importer', () => {
  it('maps reading list entries from an xml plist', async () => {
    const result = await importSafariReadingList(join(fixtures, 'safari-bookmarks.plist'))
    expect(result.warnings).toEqual([])
    expect(plain(result.links)).toEqual([
      {
        url: 'https://example.com/rl/job-posting',
        title: 'Senior Engineer at ExampleCo',
        source: 'safari-reading-list',
        addedAt: '2026-09-01T12:00:00.000Z',
        note: 'We are hiring a senior engineer...',
        tags: null,
      },
      {
        url: 'https://example.com/rl/event-2026',
        title: 'ExampleConf 2026',
        source: 'safari-reading-list',
        addedAt: '2026-09-02T09:30:00.000Z',
        note: 'A conference about things.',
        tags: null,
      },
      {
        url: 'https://example.com/rl/guide-sqlite',
        title: 'SQLite guide',
        source: 'safari-reading-list',
        addedAt: '2026-09-10T18:00:00.000Z',
        note: 'How SQLite works, notes on internals.',
        tags: null,
      },
      {
        url: 'https://example.com/rl/no-preview',
        title: 'No preview entry',
        source: 'safari-reading-list',
        addedAt: '2026-09-15T08:00:00.000Z',
        note: null,
        tags: null,
      },
      {
        url: 'https://example.com/rl/tracked?utm_source=safari',
        title: 'Tracked link',
        source: 'safari-reading-list',
        addedAt: '2026-09-20T14:00:00.000Z',
        note: 'Has utm params.',
        tags: null,
      },
    ])
  })

  it('parses a binary plist identically', async () => {
    const xml = await importSafariReadingList(join(fixtures, 'safari-bookmarks.plist'))
    const binary = await importSafariReadingList(join(fixtures, 'safari-bookmarks-binary.plist'))
    expect(plain(binary.links)).toEqual(plain(xml.links))
  })

  it('returns [] with a helpful warning when the file is not readable (EPERM)', async () => {
    const result = await importSafariReadingList('/nonexistent/Bookmarks.plist')
    expect(result.links).toEqual([])
    expect(result.warnings[0]).toContain('No Safari Bookmarks.plist')
  })

  it('never throws on a malformed plist', async () => {
    const result = await importSafariReadingList(join(fixtures, 'malformed.plist'))
    expect(result.links).toEqual([])
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
