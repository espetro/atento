/**
 * M2 collections: seven named views, link_events cursors, delta reads,
 * field projection, TSV serialization, and file exports with resource
 * links. Everything here goes through the app layer over a real sqlite
 * store so cursor semantics are exercised end to end.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLinkinboxOps,
  isCollectionName,
  serializeCollection,
  COLLECTION_NAMES,
  loadConfig,
  type AppConfig,
} from '../src/index.js'
import { openStore, type SqliteStore } from '@linkinbox/db'
import type { Enrichment, ParkReason } from '@linkinbox/core'
import { normalizeUrl } from '@linkinbox/core'

const dirs: string[] = []
const stores: SqliteStore[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkinbox-collections-'))
  dirs.push(dir)
  return dir
}

async function opsFor(dir: string) {
  const store = await openStore({ path: join(dir, 'links.db') })
  stores.push(store)
  const config = loadConfig({ LINKINBOX_HOME: dir } as NodeJS.ProcessEnv) as AppConfig
  const ops = createLinkinboxOps(config, { store, env: {}, spoolDir: join(dir, 'spool') })
  return { store, ops }
}

const at = '2026-01-01T00:00:00Z'

async function addLink(store: SqliteStore, rawUrl: string, title: string | null = rawUrl): Promise<number> {
  const { url, hash } = normalizeUrl(rawUrl)
  const link = await store.upsertLink({
    urlHash: hash,
    url,
    title: title ?? null,
    source: 'test',
    addedAt: null,
    note: null,
    tags: null,
    status: 'inbox',
    needsBrowser: false,
    captured: false,
    capturedAt: null,
    state: 'created',
    stateData: {},
  })
  return link.id
}

async function park(
  store: SqliteStore,
  id: number,
  event: 'needs_browser' | 'deferred',
  reasonClass: ParkReason,
  host = 'example.com',
): Promise<void> {
  await store.applyEvent(id, { type: 'EXTRACT_STARTED', at }, 'created')
  if (event === 'needs_browser') {
    await store.applyEvent(
      id,
      { type: 'NEEDS_BROWSER', at, host, reason: reasonClass, reasonClass },
      'extracting',
    )
  } else {
    await store.applyEvent(
      id,
      {
        type: 'DEFER',
        at,
        stage: 'extract',
        nextAttemptAt: at,
        attempts: 1,
        reason: reasonClass,
        reasonClass,
      },
      'extracting',
    )
  }
}

async function enrich(store: SqliteStore, id: number, enrichment: Enrichment): Promise<void> {
  await store.applyEvent(id, { type: 'EXTRACT_STARTED', at }, 'created')
  await store.applyEvent(id, { type: 'EXTRACTED', at, chars: 5 }, 'extracting')
  await store.applyEvent(id, { type: 'ENRICH_STARTED', at }, 'extracted')
  await store.applyEvent(id, { type: 'ENRICHED', at }, 'enriching')
  await store.setEnrichment(id, enrichment)
}

afterEach(async () => {
  while (stores.length > 0) await stores.pop()!.close()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('collections', () => {
  it('defines exactly the seven named collections', () => {
    expect([...COLLECTION_NAMES].sort()).toEqual(
      ['blocked', 'enriched', 'errored', 'needs_login', 'pending', 'review', 'triaged'].sort(),
    )
    for (const n of COLLECTION_NAMES) expect(isCollectionName(n)).toBe(true)
    expect(isCollectionName('everything')).toBe(false)
  })

  it('summary counts each collection and breaks down needs_login by host', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir)

    await addLink(store, 'https://a.example.com/1') // pending
    const nl1 = await addLink(store, 'https://login-a.example.com/x')
    await park(store, nl1, 'needs_browser', 'login_wall', 'login-a.example.com')
    const nl2 = await addLink(store, 'https://login-b.example.com/y')
    await park(store, nl2, 'deferred', 'login_wall', 'login-b.example.com')
    const bl = await addLink(store, 'https://blocked.example.com/z')
    await park(store, bl, 'needs_browser', 'bot_block', 'blocked.example.com')
    const rv = await addLink(store, 'https://review.example.com/r')
    await park(store, rv, 'needs_browser', 'review_only', 'review.example.com')
    const er = await addLink(store, 'https://err.example.com/e')
    await store.applyEvent(er, { type: 'EXTRACT_STARTED', at }, 'created')
    await store.applyEvent(
      er,
      { type: 'EXTRACT_FAILED', at, error: 'boom', retryable: false },
      'extracting',
    )
    const en = await addLink(store, 'https://enriched.example.com/i')
    await enrich(store, en, { category: 'article', priority: 'high', why_it_matters: 'because' } as Enrichment)
    const tr = await addLink(store, 'https://triaged.example.com/t')
    await store.applyEvent(tr, { type: 'TRIAGE', at, action: 'archive' }, 'created')

    const summary = await ops.collectionsSummary()
    expect(summary.total).toBe(8)
    expect(summary.collections.pending).toBe(1)
    expect(summary.collections.needs_login).toBe(2)
    expect(summary.collections.blocked).toBe(1)
    expect(summary.collections.review).toBe(1)
    expect(summary.collections.errored).toBe(1)
    expect(summary.collections.enriched).toBe(1)
    expect(summary.collections.triaged).toBe(1)
    expect(summary.needsLoginHosts).toEqual([
      { host: 'login-a.example.com', count: 1 },
      { host: 'login-b.example.com', count: 1 },
    ])
  })

  it('read --since returns only the delta and advances the cursor', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir)

    const a = await addLink(store, 'https://a.example.com/1')
    const b = await addLink(store, 'https://b.example.com/2')
    await park(store, a, 'needs_browser', 'login_wall', 'a.example.com')
    await park(store, b, 'needs_browser', 'login_wall', 'b.example.com')

    const first = await ops.collectionRead('needs_login', { since: 0 })
    expect(first.count).toBe(2)
    expect(first.cursor).toBeGreaterThan(0)
    const cursor = first.cursor

    // Mutate link a: RETRY out of the parked state (needs_browser -> created).
    await store.applyEvent(a, { type: 'RETRY', at }, 'needs_browser')

    const delta = await ops.collectionRead('needs_login', { since: cursor })
    expect(delta.count).toBe(0) // a left the collection; b did not change

    const pending = await ops.collectionRead('pending', { since: cursor })
    expect(pending.count).toBe(1)
    expect(pending.rows[0]?.['url']).toBe('https://a.example.com/1')
    expect(pending.cursor).toBeGreaterThan(cursor)
  })

  it('read projects only requested fields and truncates summary at 200 chars', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir)
    const id = await addLink(store, 'https://x.example.com/p')
    await enrich(store, id, {
      category: 'article',
      priority: 'low',
      why_it_matters: 'y'.repeat(500),
    } as Enrichment)

    const result = await ops.collectionRead('enriched', {
      fields: ['id', 'url', 'title', 'summary', 'nonexistent'],
    })
    expect(result.count).toBe(1)
    const row = result.rows[0]!
    expect(Object.keys(row).sort()).toEqual(['id', 'summary', 'title', 'url'])
    expect(String(row['summary'])).toHaveLength(200)
    expect(row['url']).toBe('https://x.example.com/p')
  })

  it('serializes tsv and md deterministically', () => {
    const rows = [
      { id: 1, url: 'https://a', title: 'A\tB', summary: 'one\ntwo' },
      { id: 2, url: 'https://b', title: null, summary: 'xxxxxxxxxx' },
    ]
    const fields = ['id', 'url', 'title', 'summary']
    const tsv = serializeCollection(rows, fields, 'tsv')
    expect(tsv.split('\n')[0]).toBe('id\turl\ttitle\tsummary')
    expect(tsv).toContain('A B')
    expect(tsv).toContain('one two')
    const md = serializeCollection(rows, fields, 'md')
    expect(md).toContain('| id | url | title | summary |')
    expect(md).toContain('| 2 | https://b |  | xxxxxxxxxx |')
    const jsonl = serializeCollection(rows, ['id'], 'jsonl')
    expect(jsonl.trim().split('\n')).toEqual(['{"id":1}', '{"id":2}'])
  })

  it('export writes a file under exportsDir and returns path + resource uri', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir)
    const id = await addLink(store, 'https://e.example.com/x')
    await enrich(store, id, { category: 'article' } as Enrichment)

    const result = await ops.collectionExport('enriched', { format: 'jsonl' })
    expect(result.count).toBe(1)
    expect(result.format).toBe('jsonl')
    expect(result.uri).toMatch(/^linkinbox:\/\/exports\/enriched-\d+\.jsonl$/)
    expect(existsSync(result.path)).toBe(true)
    expect(result.path).toContain(join('exports', 'enriched-'))
    const body = readFileSync(result.path, 'utf8')
    expect(body.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(body.trim())).toMatchObject({ url: 'https://e.example.com/x' })
    expect(result.bytes).toBe(Buffer.byteLength(body, 'utf8'))
  })

  it('export honors since and field projection', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir)
    const id = await addLink(store, 'https://d.example.com/x')
    await store.applyEvent(id, { type: 'EXTRACT_STARTED', at }, 'created')
    const cursor = await store.linkEventCursor()

    const result = await ops.collectionExport('pending', {
      since: cursor,
      fields: ['id', 'url'],
      format: 'tsv',
    })
    expect(result.count).toBe(0) // no events after the cursor

    const again = await ops.collectionExport('pending', {
      since: 0,
      fields: ['id', 'url'],
      format: 'tsv',
    })
    expect(again.count).toBe(1)
    const body = readFileSync(again.path, 'utf8')
    expect(body.split('\n')[0]).toBe('id\turl')
    expect(body).toContain('https://d.example.com/x')
  })
})
