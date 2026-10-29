import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '../src/index.js'
import { MIGRATIONS } from '../src/migrations.js'
import { runMigrations } from '../src/migrations.js'
import type { LinkInput } from '@linkinbox/core'
import { normalizeUrl } from '@linkinbox/core'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-fsm-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function linkInput(url: string, overrides: Partial<LinkInput> = {}): LinkInput {
  const { url: normalized, hash } = normalizeUrl(url)
  return {
    urlHash: hash,
    url: normalized,
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
    ...overrides,
  }
}

describe('FSM store', () => {
  it('new links start in created and claim atomically', async () => {
    const store = await openStore({ path: ':memory:' })
    const link = await store.upsertLink(linkInput('https://example.com/a'))
    expect(link.state).toBe('created')

    const claim1 = await store.applyEvent(link.id, {
      type: 'EXTRACT_STARTED',
      at: new Date().toISOString(),
    })
    expect(claim1.ok).toBe(true)
    if (claim1.ok) expect(claim1.state.state).toBe('extracting')

    // second claim from created fails with a typed stale error
    const claim2 = await store.applyEvent(
      link.id,
      { type: 'EXTRACT_STARTED', at: new Date().toISOString() },
      'created',
    )
    expect(claim2.ok).toBe(false)
    if (!claim2.ok) expect(claim2.error.code).toBe('STALE_STATE')
    await store.close()
  })

  it('concurrent claims: exactly one of two claimers wins', async () => {
    const store = await openStore({ path: ':memory:' })
    const link = await store.upsertLink(linkInput('https://example.com/race'))
    const event = { type: 'EXTRACT_STARTED' as const, at: new Date().toISOString() }
    const [a, b] = await Promise.all([
      store.applyEvent(link.id, event, 'created'),
      store.applyEvent(link.id, event, 'created'),
    ])
    const wins = [a, b].filter((r) => r.ok).length
    expect(wins).toBe(1)
    const losers = [a, b].filter((r) => !r.ok)
    expect(losers.every((r) => !r.ok && (r.error.code === 'STALE_STATE' || r.error.code === 'ILLEGAL_TRANSITION'))).toBe(true)
    await store.close()
  })

  it('lease expiry returns stranded items to their queue', async () => {
    const store = await openStore({ path: ':memory:' })
    const link = await store.upsertLink(linkInput('https://example.com/lease'))
    await store.applyEvent(link.id, { type: 'EXTRACT_STARTED', at: new Date().toISOString() })
    expect((await store.getState(link.id))?.state).toBe('extracting')

    await store.applyEvent(link.id, { type: 'LEASE_EXPIRED', at: new Date().toISOString() })
    expect((await store.getState(link.id))?.state).toBe('created')

    // enriching returns to extracted
    await store.applyEvent(link.id, { type: 'EXTRACT_STARTED', at: new Date().toISOString() })
    await store.applyEvent(link.id, { type: 'EXTRACTED', chars: 5, at: new Date().toISOString() })
    await store.applyEvent(link.id, { type: 'ENRICH_STARTED', at: new Date().toISOString() })
    await store.applyEvent(link.id, { type: 'LEASE_EXPIRED', at: new Date().toISOString() })
    expect((await store.getState(link.id))?.state).toBe('extracted')
    await store.close()
  })

  it('reclaimExpiredLeases returns stale leases to their queue', async () => {
    const store = await openStore({ path: ':memory:' })
    const old = await store.upsertLink(linkInput('https://example.com/old'))
    const fresh = await store.upsertLink(linkInput('https://example.com/fresh'))
    await store.applyEvent(old.id, { type: 'EXTRACT_STARTED', at: '2026-10-01T00:00:00.000Z' })
    await store.applyEvent(fresh.id, { type: 'EXTRACT_STARTED', at: new Date().toISOString() })

    // Only the stale lease is reclaimed; the fresh one stays leased.
    const reclaimed = await store.reclaimExpiredLeases(new Date('2026-10-20T00:00:00.000Z'))
    expect(reclaimed).toBe(1)
    expect((await store.getState(old.id))?.state).toBe('created')
    expect((await store.getState(fresh.id))?.state).toBe('extracting')
    await store.close()
  })

  it('restore from errored requeues, never resurrects from deleted', async () => {
    const store = await openStore({ path: ':memory:' })
    const err = await store.upsertLink(linkInput('https://example.com/err'))
    await store.applyEvent(err.id, { type: 'EXTRACT_STARTED', at: new Date().toISOString() })
    await store.applyEvent(err.id, { type: 'EXTRACT_FAILED', error: 'x', at: new Date().toISOString() })
    const restored = await store.applyEvent(err.id, { type: 'RESTORE', at: new Date().toISOString() })
    expect(restored.ok).toBe(true)
    if (restored.ok) expect(restored.state.state).toBe('created')
    await store.close()
  })

  it('nothing transitions out of deleted, restore never resurrects', async () => {
    const store = await openStore({ path: ':memory:' })
    const link = await store.upsertLink(linkInput('https://example.com/dead'))
    await store.applyEvent(link.id, { type: 'DELETE', at: new Date().toISOString() })
    expect((await store.getState(link.id))?.state).toBe('deleted')

    for (const event of [
      { type: 'RESTORE' as const, at: new Date().toISOString() },
      { type: 'RETRY' as const, at: new Date().toISOString() },
      { type: 'ENRICHED' as const, at: new Date().toISOString() },
    ]) {
      const outcome = await store.applyEvent(link.id, event)
      expect(outcome.ok, `${event.type} from deleted must fail`).toBe(false)
      if (!outcome.ok) expect(outcome.error.code).toBe('ILLEGAL_TRANSITION')
    }
    expect((await store.getState(link.id))?.state).toBe('deleted')
    await store.close()
  })

  it('re-import after prune does not resurrect the link', async () => {
    const store = await openStore({ path: ':memory:' })
    const link = await store.upsertLink(linkInput('https://example.com/pruned'))
    await store.applyEvent(link.id, { type: 'DELETE', at: new Date().toISOString() })

    const again = await store.upsertLink(linkInput('https://example.com/pruned'))
    expect(again.id).toBe(link.id)
    expect(again.state).toBe('deleted')
    expect(await store.countLinks()).toBe(1)
    await store.close()
  })

  it('deleted tombstones purge content but keep the url_hash', async () => {
    const store = await openStore({ path: ':memory:' })
    const link = await store.upsertLink(linkInput('https://example.com/tomb'))
    await store.setExtractedContent(link.id, 'some content', false, new Date())
    await store.applyEvent(link.id, { type: 'DELETE', at: new Date().toISOString() })
    const tomb = await store.getLink(link.id)
    expect(tomb?.extractedContent).toBeNull()
    expect(tomb?.urlHash).toBeTruthy()
    expect(tomb?.status).toBe('deleted')
    await store.close()
  })

  it('history is append-only and complete', async () => {
    const store = await openStore({ path: ':memory:' })
    const link = await store.upsertLink(linkInput('https://example.com/hist'))
    await store.applyEvent(link.id, { type: 'EXTRACT_STARTED', at: new Date().toISOString() })
    await store.applyEvent(link.id, { type: 'EXTRACTED', chars: 10, at: new Date().toISOString() })
    await store.applyEvent(link.id, { type: 'ENRICH_STARTED', at: new Date().toISOString() })
    await store.applyEvent(link.id, { type: 'ENRICHED', at: new Date().toISOString() })
    // an illegal transition leaves no history row
    await store.applyEvent(link.id, { type: 'RESTORE', at: new Date().toISOString() })

    const history = await store.getHistory(link.id)
    expect(history.map((h) => h.event)).toEqual([
      'EXTRACT_STARTED',
      'EXTRACTED',
      'ENRICH_STARTED',
      'ENRICHED',
    ])
    expect(history.map((h) => h.fromState)).toEqual(['created', 'extracting', 'extracted', 'enriching'])
    expect(history.map((h) => h.toState)).toEqual(['extracting', 'extracted', 'enriching', 'inbox'])

    const before = history.map((h) => h.id)
    await store.applyEvent(link.id, { type: 'TRIAGE', action: 'archive', at: new Date().toISOString() })
    const after = await store.getHistory(link.id)
    expect(after.slice(0, before.length).map((h) => h.id)).toEqual(before)
    expect(after).toHaveLength(5)
    await store.close()
  })

  it('countByState produces the histogram', async () => {
    const store = await openStore({ path: ':memory:' })
    await store.upsertLink(linkInput('https://example.com/1'))
    await store.upsertLink(linkInput('https://example.com/2'))
    const l3 = await store.upsertLink(linkInput('https://example.com/3'))
    await store.applyEvent(l3.id, { type: 'DELETE', at: new Date().toISOString() })
    const histogram = await store.countByState()
    expect(histogram['created']).toBe(2)
    expect(histogram['deleted']).toBe(1)
    await store.close()
  })

  it('backfill migration maps legacy statuses onto FSM states', async () => {
    const path = join(dir, 'legacy.db')
    // Seed an old-schema database with pre-FSM rows.
    const sqlite = new Database(path)
    sqlite.exec(MIGRATIONS[0]!.sql)
    const insert = sqlite.prepare(`
      INSERT INTO links (url_hash, url, source, status, needs_browser, created_at, updated_at, category)
      VALUES (?, ?, 'test', ?, 0, 1000, 2000, ?)
    `)
    insert.run('h1', 'https://example.com/1', 'inbox', 'job')
    insert.run('h2', 'https://example.com/2', 'scheduled', null)
    insert.run('h3', 'https://example.com/3', 'archived', null)
    insert.run('h4', 'https://example.com/4', 'discarded', null)
    sqlite.close()

    const store = await openStore({ path })
    expect(store.appliedMigrations()).toContain('0002_fsm')
    expect((await store.getState(1))?.state).toBe('inbox')
    expect((await store.getState(2))?.state).toBe('scheduled')
    expect((await store.getState(3))?.state).toBe('archived')
    expect((await store.getState(4))?.state).toBe('discarded')

    // synthesized history exists for the backfilled rows
    expect(await store.getHistory(1)).toHaveLength(1)
    expect(await store.getHistory(3)).toHaveLength(1)

    // the backfilled inbox row keeps working through the FSM
    const outcome = await store.applyEvent(1, { type: 'TRIAGE', action: 'archive', at: new Date().toISOString() })
    expect(outcome.ok).toBe(true)
    await store.close()
  })

  it('listByStates selects work by state', async () => {
    const store = await openStore({ path: ':memory:' })
    const a = await store.upsertLink(linkInput('https://example.com/a'))
    await store.upsertLink(linkInput('https://example.com/b'))
    await store.applyEvent(a.id, { type: 'EXTRACT_STARTED', at: new Date().toISOString() })
    const created = await store.listByStates(['created'])
    expect(created).toHaveLength(1)
    expect(created[0]?.url).toContain('/b')
    const extracting = await store.listByStates(['extracting'])
    expect(extracting).toHaveLength(1)
    expect(extracting[0]?.id).toBe(a.id)
    await store.close()
  })

  it('state_data is validated on read, never trusted', async () => {
    const path = join(dir, 'corrupt.db')
    const store = await openStore({ path })
    await store.upsertLink(linkInput('https://example.com/x'))
    store.close()
    // Corrupt the payload directly.
    const raw = new Database(path)
    raw.prepare("UPDATE links SET state_data = '{not json' WHERE id = 1").run()
    raw.close()

    const reopened = await openStore({ path })
    // A corrupt payload is never trusted: the read validates it and fails
    // loudly instead of handing out a half-parsed state.
    await expect(reopened.getState(1)).rejects.toThrow()
    await reopened.close()
  })
})
