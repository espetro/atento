import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SqliteStore, MIGRATIONS } from '../src/index.js'
import type { Enrichment, LinkInput } from '@linkinbox/core'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-fts-'))
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
