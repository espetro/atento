import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SqliteStore, MIGRATIONS, toFts5Query } from '../src/index.js'
import type { Enrichment, LinkInput } from '@atento/core'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atento-fts-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Open a migrated store plus the raw handle, for direct links_fts reads. */
async function open(dbName: string): Promise<{ store: SqliteStore; sqlite: Database.Database }> {
  const sqlite = new Database(join(dir, dbName))
  sqlite.pragma('foreign_keys = ON')
  const store = new SqliteStore(sqlite)
  await store.migrate()
  return { store, sqlite }
}

function enrichment(why: string): Enrichment {
  return {
    category: 'dev',
    priority: 'normal',
    why_it_matters: why,
    read_minutes: 4,
    action: 'read_now',
    expires_at: null,
    expiry_reason: null,
    confidence: 0.9,
  }
}

function linkInput(overrides: Partial<LinkInput> = {}): LinkInput {
  const id = Math.floor(Math.random() * 1e9)
  return {
    urlHash: `hash-${id}`,
    url: `https://example.com/${id}`,
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
    ...overrides,
  }
}

/** rowids currently in the FTS index. */
function ftsRowids(sqlite: Database.Database): number[] {
  return (sqlite.prepare(`SELECT rowid FROM links_fts ORDER BY rowid`).all() as Array<{
    rowid: number
  }>).map((r) => r.rowid)
}

/** FTS5 MATCH over links_fts, returning matching rowids. */
function ftsMatch(sqlite: Database.Database, query: string): number[] {
  return (
    sqlite.prepare(`SELECT rowid FROM links_fts WHERE links_fts MATCH ?`).all(query) as Array<{
      rowid: number
    }>
  ).map((r) => r.rowid)
}

describe('links_fts migration', () => {
  it('backfills rows that existed before the migration', async () => {
    const dbPath = join(dir, 'backfill.db')
    // Build a database that stops at 0009, insert a link, then migrate.
    const sqlite = new Database(dbPath)
    sqlite.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.filter((m) => m.name !== '0010_links_fts')) {
      sqlite.exec(m.sql)
      sqlite
        .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
        .run(`migration:${m.name}`, 'test')
    }
    sqlite
      .prepare(
        `INSERT INTO links (url_hash, url, title, source, note, tags, enrichment, status, created_at, updated_at, state)
         VALUES ('h1', 'https://old.example/a', 'Old Title', 'test', 'a note', '["oldtag"]',
                 '{"why_it_matters":"legacy summary text"}', 'inbox', 1, 1, 'inbox')`,
      )
      .run()

    const store = new SqliteStore(sqlite)
    await store.migrate()

    const rows = sqlite
      .prepare(`SELECT rowid, title, note, tags, summary FROM links_fts`)
      .all() as Array<{ rowid: number; title: string; note: string; tags: string; summary: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('Old Title')
    expect(rows[0]!.note).toBe('a note')
    expect(rows[0]!.tags).toBe('["oldtag"]')
    expect(rows[0]!.summary).toBe('legacy summary text')
    expect(ftsMatch(sqlite, 'legacy')).toEqual([rows[0]!.rowid])
    sqlite.close()
  })

  it('rebuilds a partially-backfilled index left without a meta row', async () => {
    // Simulate the pre-transactional crash shape: fts objects exist and
    // some rows are indexed, but migration:0010_links_fts was never
    // recorded. migrate() must rebuild the index, not die on rowids.
    const sqlite = new Database(join(dir, 'partial.db'))
    sqlite.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.filter((m) => m.name !== '0010_links_fts')) {
      sqlite.exec(m.sql)
      sqlite
        .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
        .run(`migration:${m.name}`, 'test')
    }
    const store = new SqliteStore(sqlite)
    const a = await store.upsertLink(linkInput({ title: 'alpha' }))
    const b = await store.upsertLink(linkInput({ title: 'beta' }))
    // Run the 0010 DDL+backfill directly (no meta row), then drop one fts
    // row to fake a crash mid-backfill.
    const m0010 = MIGRATIONS.find((m) => m.name === '0010_links_fts')!
    sqlite.exec(m0010.sql)
    sqlite.prepare(`DELETE FROM links_fts WHERE rowid = ?`).run(b.id)
    expect(ftsRowids(sqlite)).toEqual([a.id])

    await store.migrate()
    expect(store.appliedMigrations()).toContain('0010_links_fts')
    expect(ftsRowids(sqlite).sort((x, y) => x - y)).toEqual([a.id, b.id].sort((x, y) => x - y))
    sqlite.close()
  })

  it('is recorded as an applied migration and migrate() is idempotent', async () => {
    const { store, sqlite } = await open('idem.db')
    expect(store.appliedMigrations()).toContain('0010_links_fts')
    await store.migrate()
    await store.close()
    sqlite.close()
  })
})

describe('links_fts sync', () => {
  it('indexes inserts across all five columns', async () => {
    const { store, sqlite } = await open('sync.db')
    const link = await store.upsertLink(
      linkInput({
        title: 'FTS Title Hit',
        url: 'https://fts.example/title',
        note: 'note needle',
        tags: ['tagneedle'],
        enrichment: enrichment('summary needle'),
      }),
    )
    for (const q of ['title', 'needle', 'tagneedle', 'summary', 'fts']) {
      expect(ftsMatch(sqlite, `"${q}"*`)).toEqual([link.id])
    }
    sqlite.close()
  })

  it('reindexes on title, note/tags patch and enrichment writes', async () => {
    const { store, sqlite } = await open('update.db')
    const link = await store.upsertLink(linkInput({ title: 'before' }))

    await store.updateTitle(link.id, 'after rename')
    expect(ftsMatch(sqlite, '"before"*')).toEqual([])
    expect(ftsMatch(sqlite, '"rename"*')).toEqual([link.id])

    await store.patchLink(link.id, { note: 'patched note text', tags: ['patchedtag'] })
    expect(ftsMatch(sqlite, '"patchedtag"*')).toEqual([link.id])

    await store.setEnrichment(link.id, enrichment('enrichwhymatters'))
    const summary = sqlite
      .prepare(`SELECT summary FROM links_fts WHERE rowid = ?`)
      .get(link.id) as { summary: string }
    expect(summary.summary).toBe('enrichwhymatters')
    expect(ftsMatch(sqlite, '"enrichwhymatters"*')).toEqual([link.id])
    sqlite.close()
  })

  it('reindexes on upsert conflict (title/note/tags update)', async () => {
    const { store, sqlite } = await open('upsert.db')
    const first = await store.upsertLink(
      linkInput({ urlHash: 'same', url: 'https://example.com/same', title: 'v1' }),
    )
    await store.upsertLink(
      linkInput({ urlHash: 'same', url: 'https://example.com/same', title: 'v2 uniquetoken' }),
    )
    expect(ftsRowids(sqlite)).toEqual([first.id])
    expect(ftsMatch(sqlite, '"uniquetoken"*')).toEqual([first.id])
    expect(ftsMatch(sqlite, '"v1"*')).toEqual([])
    sqlite.close()
  })

  it('drops the summary from the index when the deleted-state purge clears enrichment', async () => {
    const { store, sqlite } = await open('purge.db')
    const link = await store.upsertLink(
      linkInput({ title: 'purge me please', enrichment: enrichment('purgeterm') }),
    )
    expect(ftsMatch(sqlite, '"purgeterm"*')).toEqual([link.id])

    await store.deleteLinks([link.id])
    // The row survives as a tombstone: url/title still match, the purged
    // enrichment summary no longer does.
    expect(ftsMatch(sqlite, '"purge"*')).toEqual([link.id])
    expect(ftsMatch(sqlite, '"purgeterm"*')).toEqual([])
    sqlite.close()
  })

  it('leaves the index intact when only non-indexed columns change', async () => {
    const { store, sqlite } = await open('skip.db')
    const link = await store.upsertLink(linkInput({ title: 'stable' }))
    const before = sqlite
      .prepare(`SELECT rowid FROM links_fts`)
      .all() as Array<{ rowid: number }>
    await store.setStateData(link.id, { note: 'state payload only' })
    await store.markCaptured(link.id, new Date())
    const after = sqlite.prepare(`SELECT rowid FROM links_fts`).all()
    expect(after).toEqual(before)
    sqlite.close()
  })
})

describe('links_fts query', () => {
  it('matches across columns with prefix terms and AND semantics', async () => {
    const { store, sqlite } = await open('query.db')
    const a = await store.upsertLink(
      linkInput({ title: 'Rust async deep dive', note: 'about concurrency' }),
    )
    await store.upsertLink(linkInput({ title: 'Async only', url: 'https://x.example/async' }))
    await store.upsertLink(linkInput({ title: 'Cooking', note: 'pasta' }))

    // prefix: 'asy' matches 'async'
    expect(await store.listLinks({ match: 'asy' })).toHaveLength(2)
    // AND: both terms required
    const both = await store.listLinks({ match: 'rust async' })
    expect(both.map((l) => l.id)).toEqual([a.id])
    // url path tokens are searchable
    const byUrl = await store.listLinks({ match: 'x.example async' })
    expect(byUrl).toHaveLength(1)
    expect(await store.countLinks({ match: 'rust async' })).toBe(1)
    sqlite.close()
  })

  it('treats FTS5 operators and punctuation in user input as plain text', async () => {
    const { store } = await open('safe.db')
    await store.upsertLink(linkInput({ title: 'NEAR the OR operator' }))
    // Raw operators/quotes must not break MATCH syntax.
    for (const q of ['NEAR(', '"unclosed', 'rust" OR title:x', '!!!', '   ']) {
      const rows = await store.listLinks({ match: q })
      expect(Array.isArray(rows)).toBe(true)
    }
    expect(await store.listLinks({ match: '!!!' })).toHaveLength(0)
    expect(await store.countLinks({ match: '!!!' })).toBe(0)
    await store.close()
  })

  it('countLinks agrees with listLinks on match filters', async () => {
    const { store } = await open('count.db')
    await store.upsertLink(linkInput({ title: 'alpha beta' }))
    await store.upsertLink(linkInput({ title: 'alpha gamma' }))
    await store.upsertLink(linkInput({ title: 'delta' }))
    expect(await store.countLinks({ match: 'alpha' })).toBe(2)
    expect((await store.listLinks({ match: 'alpha' })).length).toBe(2)
    expect(await store.countLinks({ match: 'alpha', limit: 1 })).toBe(2)
    await store.close()
  })

  it('orders by bm25 rank only when sort=relevance', async () => {
    const { store } = await open('rank.db')
    // Inserted oldest -> newest so created_at DESC is the reverse of the
    // relevance expectation.
    await store.upsertLink(
      linkInput({ title: 'Misc', note: 'mentions rust and async once each' }),
    )
    const best = await store.upsertLink(
      linkInput({ title: 'Rust async cookbook', url: 'https://rank.example/rust-async' }),
    )
    const middle = await store.upsertLink(
      linkInput({ title: 'Async patterns', note: 'rust appears in a long note body' }),
    )

    const ranked = await store.listLinks({ match: 'rust async', sort: 'relevance' })
    expect(ranked.length).toBeGreaterThanOrEqual(2)
    expect(ranked[0]!.id).toBe(best.id)

    const defaultOrder = await store.listLinks({ match: 'rust async' })
    expect(defaultOrder[0]!.id).toBe(middle.id) // newest first
    await store.close()
  })

  it('composes match with status filters and pagination', async () => {
    const { store } = await open('compose.db')
    await store.upsertLink(linkInput({ title: 'needle one', status: 'inbox' }))
    await store.upsertLink(linkInput({ title: 'needle two', status: 'archived' }))
    await store.upsertLink(linkInput({ title: 'other' }))

    const all = await store.listLinks({ match: 'needle' })
    expect(all).toHaveLength(2)
    const inboxOnly = await store.listLinks({ match: 'needle', status: 'inbox' })
    expect(inboxOnly).toHaveLength(1)
    expect(inboxOnly[0]!.title).toBe('needle one')

    const page = await store.listLinks({ match: 'needle', limit: 1, offset: 1 })
    expect(page).toHaveLength(1)
    expect(page[0]!.id).toBe(all[1]!.id)
    expect(await store.countLinks({ match: 'needle' })).toBe(2)
    await store.close()
  })

  it('still answers match queries on an unmigrated database (LIKE fallback)', async () => {
    // A store whose migrate() never ran has no links_fts; match must degrade
    // to substring search instead of throwing.
    const sqlite = new Database(join(dir, 'nomigrate.db'))
    sqlite.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.filter((m) => m.name !== '0010_links_fts')) {
      sqlite.exec(m.sql)
      sqlite
        .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
        .run(`migration:${m.name}`, 'test')
    }
    const store = new SqliteStore(sqlite)
    await store.upsertLink(linkInput({ title: 'fallback needle' }))
    const hits = await store.listLinks({ match: 'needle' })
    expect(hits).toHaveLength(1)
    sqlite.close()
  })
})

describe('toFts5Query', () => {
  it('builds ANDed quoted prefix terms and dedupes', () => {
    expect(toFts5Query('Rust rust ASYNC')).toBe('"Rust"* AND "ASYNC"*')
    expect(toFts5Query('foo-bar_baz')).toBe('"foo"* AND "bar"* AND "baz"*')
    expect(toFts5Query('NEAR("x") OR {y}')).toBe('"NEAR"* AND "x"* AND "OR"* AND "y"*')
    expect(toFts5Query('!!!')).toBeNull()
    expect(toFts5Query('')).toBeNull()
  })
})
