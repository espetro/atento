import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/index.js'
import { SqliteStore } from '../src/store.js'
import type { LinkInput, Enrichment } from '@linkinbox/core'
const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-29T12:00:00.000Z')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-db-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function enrichment(category: string): Enrichment {
  return {
    category,
    priority: 'normal',
    why_it_matters: 'test',
    read_minutes: 4,
    action: 'read_now',
    expires_at: '2026-10-01T00:00:00.000Z',
    expiry_reason: 'test expiry',
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

describe('SqliteStore', () => {
  it('migrates idempotently and records schema version', async () => {
    const store = await openStore({ path: join(dir, 'test.db') })
    expect(await store.schemaVersion()).toBe('4')
    await store.migrate() // second run must not throw
    expect(await store.schemaVersion()).toBe('4')
    await store.close()
  })

  it('records applied migrations and does not reapply them', async () => {
    const dbPath = join(dir, 'migrations.db')
    const store = await openStore({ path: dbPath })
    expect(store.appliedMigrations()).toEqual(['0001_initial', '0002_fsm', '0003_host_state', '0004_canary_trial', '0005_capture'])
    await store.migrate()
    expect(store.appliedMigrations()).toEqual(['0001_initial', '0002_fsm', '0003_host_state', '0004_canary_trial', '0005_capture'])
    await store.close()

    // reopening an existing database keeps the same migration set
    const reopened = await openStore({ path: dbPath })
    expect(reopened.appliedMigrations()).toEqual(['0001_initial', '0002_fsm', '0003_host_state', '0004_canary_trial', '0005_capture'])
    expect(await reopened.countLinks()).toBe(0)
    await reopened.close()
  })

  it('enables WAL and busy_timeout on file databases', async () => {
    const dbPath = join(dir, 'wal.db')
    const store = await openStore({ path: dbPath })
    const mode = store.pragma('journal_mode', { simple: true })
    expect(String(mode).toLowerCase()).toBe('wal')
    const timeout = store.pragma('busy_timeout', { simple: true })
    expect(Number(timeout)).toBeGreaterThan(0)
    await store.close()
  })

  it('upserts keyed on url_hash: same hash updates, never duplicates', async () => {
    const store = await openStore({ path: join(dir, 'upsert.db') })
    const base = linkInput({ urlHash: 'same-hash', url: 'https://example.com/same' })
    const first = await store.upsertLink(base)
    const second = await store.upsertLink({ ...base, title: 'Updated title' })
    expect(second.id).toBe(first.id)
    const all = await store.listLinks()
    expect(all).toHaveLength(1)
    expect(all[0]?.title).toBe('Updated title')
    await store.close()
  })

  it('re-import is a no-op for downstream fields', async () => {
    const store = await openStore({ path: join(dir, 'reimport.db') })
    const base = linkInput({ urlHash: 'h', url: 'https://example.com/h' })
    const created = await store.upsertLink(base)
    await store.setEnrichment(created.id, enrichment('job'))
    // importer runs again with the same raw data
    await store.upsertLink(base)
    const after = await store.getLink(created.id)
    expect(after?.enrichment?.category).toBe('job')
    expect(after?.category).toBe('job')
    await store.close()
  })

  it('filters by status, category, and stale-as-of', async () => {
    const store = await openStore({ path: ':memory:' })
    const stale = await store.upsertLink(linkInput({ urlHash: 's1' }))
    await store.setEnrichment(stale.id, {
      ...enrichment('job'),
      expires_at: new Date(NOW.getTime() - DAY).toISOString(),
    })
    const fresh = await store.upsertLink(linkInput({ urlHash: 'f1' }))
    await store.setEnrichment(fresh.id, {
      ...enrichment('event'),
      expires_at: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    })
    const archived = await store.upsertLink(linkInput({ urlHash: 'a1' }))
    await store.updateStatus([archived.id], 'archived')

    expect(await store.countLinks({ status: 'inbox' })).toBe(2)
    expect(await store.countLinks({ status: 'archived' })).toBe(1)
    expect(await store.countLinks({ category: 'job' })).toBe(1)
    const staleList = await store.listLinks({ staleAsOf: NOW })
    expect(staleList).toHaveLength(1)
    expect(staleList[0]?.id).toBe(stale.id)
    await store.close()
  })

  it('updateStatus archives in bulk and deleteLinks tombstones the given ids', async () => {
    const store = await openStore({ path: ':memory:' })
    const a = await store.upsertLink(linkInput({ urlHash: 'a' }))
    const b = await store.upsertLink(linkInput({ urlHash: 'b' }))
    const c = await store.upsertLink(linkInput({ urlHash: 'c' }))
    expect(await store.updateStatus([a.id, b.id], 'archived')).toBe(2)
    expect((await store.getLink(a.id))?.status).toBe('archived')
    expect((await store.getLink(a.id))?.state).toBe('archived')
    expect((await store.getLink(c.id))?.status).toBe('inbox')
    // FSM semantics: delete leaves a tombstone row, the row is not removed.
    expect(await store.deleteLinks([c.id])).toBe(1)
    const tomb = await store.getLink(c.id)
    expect(tomb?.state).toBe('deleted')
    expect(tomb?.status).toBe('deleted')
    expect(tomb?.urlHash).toBe('c')
    await store.close()
  })

  it('runs and metrics round-trip', async () => {
    const store = await openStore({ path: ':memory:' })
    const run = await store.startRun('ingest', 10, new Date(NOW.getTime() - 1000))
    await store.finishRun(run.id, {
      okCount: 9,
      errorCount: 1,
      durationMs: 1000,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    })
    const runs = store.allRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.okCount).toBe(9)
    expect(runs[0]?.errorCount).toBe(1)

    await store.addMetric({
      timestamp: NOW,
      stage: 'ingest',
      key: 'links.imported',
      value: 9,
      tags: { source: 'markdown' },
    })
    const metrics = await store.listMetrics({ stage: 'ingest' })
    expect(metrics).toHaveLength(1)
    expect(metrics[0]?.value).toBe(9)
    expect(metrics[0]?.tags).toEqual({ source: 'markdown' })
    await store.close()
  })

  it('profiles round-trip per host', async () => {
    const store = await openStore({ path: ':memory:' })
    expect(await store.listProfiles()).toEqual([])
    const created = await store.upsertProfile({ host: 'x.com', path: '/profiles/x.com' })
    expect(created.host).toBe('x.com')
    await store.upsertProfile({ host: 'x.com', path: '/profiles/x.com-v2' })
    const fetched = await store.getProfile('x.com')
    expect(fetched?.path).toBe('/profiles/x.com-v2')
    expect(await store.listProfiles()).toHaveLength(1)
    expect(await store.deleteProfile('x.com')).toBe(1)
    expect(await store.getProfile('x.com')).toBeNull()
    await store.close()
  })

  it('meta get/set round-trips', async () => {
    const store = await openStore({ path: ':memory:' })
    expect(await store.getMeta('config.snapshot')).toBeNull()
    await store.setMeta('config.snapshot', '{"ttl":{"default_days":30}}')
    expect(await store.getMeta('config.snapshot')).toContain('default_days')
    await store.setMeta('config.snapshot', 'v2')
    expect(await store.getMeta('config.snapshot')).toBe('v2')
    await store.close()
  })

  it('memory-backed constructor is usable for tests', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await store.migrate()
    await store.upsertLink(linkInput({ urlHash: 'x' }))
    expect(await store.countLinks()).toBe(1)
    await store.close()
  })

  it('host trial state survives a reopen (restart persistence)', async () => {
    const { emptyHostState, markFlagged } = await import('@linkinbox/core')
    const dbPath = join(dir, 'trial.db')
    const store = await openStore({ path: dbPath })
    const now = Date.parse('2026-01-01T00:00:00Z')
    const flagged = markFlagged(emptyHostState('gated.example'), now, 'http_429', { loginGated: true })
    await store.saveHostState(flagged)
    await store.saveHostState(markFlagged(emptyHostState('open.example'), now, 'x'))
    await store.close()

    const reopened = await openStore({ path: dbPath })
    const state = await reopened.getHostState('gated.example')
    expect(state?.trialState).toBe('flagged')
    expect(state?.trialReason).toBe('http_429')
    expect(state?.trialAt).toBe(now)
    expect(state?.loginGated).toBe(true)
    const open = await reopened.getHostState('open.example')
    expect(open?.trialState).toBe('flagged')
    expect(open?.loginGated).toBe(false)
    await reopened.close()
  })
})
