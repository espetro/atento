import { describe, expect, it } from 'vitest'
import {
  ACTION_TO_STATUS,
  applyPrune,
  applySweep,
  getLink,
  listLinks,
  metricsSummary,
  parseRange,
  projectLink,
  prune,
  sweep,
  triage,
  ttlFromToml,
  type Link,
  type LinkField,
} from '../src/index.js'
import { FakeStore, seedLink } from './fake-store.js'

const NOW = new Date('2026-10-29T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

const ttl = ttlFromToml({
  ttl: {
    default_days: 30,
    by_category: { job: 45, event: 7 },
    archive_after_days: 90,
    delete_after_days: 365,
  },
})

async function seeded(): Promise<FakeStore> {
  const store = new FakeStore()
  await seedLink(store, 'https://example.com/one', {
    title: 'One',
    category: 'job',
    status: 'inbox',
    expiresAt: new Date(NOW.getTime() - 2 * DAY),
  })
  await seedLink(store, 'https://example.com/two', {
    title: 'Two',
    category: 'event',
    status: 'inbox',
    expiresAt: new Date(NOW.getTime() + 5 * DAY),
  })
  await seedLink(store, 'https://example.com/three', {
    title: 'Three',
    category: 'event',
    status: 'scheduled',
    expiresAt: new Date(NOW.getTime() - 1 * DAY),
  })
  return store
}

/** Snapshot helper: strips volatile fields so snapshots stay stable. */
function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (v instanceof Date) return v.toISOString()
      return v
    }),
  )
}

describe('ops.listLinks', () => {
  it('projects the compact default (no extracted content)', async () => {
    const store = await seeded()
    await store.setExtractedContent(1, 'a long markdown body', false, NOW)

    const rows = await listLinks(store, { now: NOW })
    expect(rows).toHaveLength(3)
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'action', 'category', 'expiresAt', 'expiryReason', 'id', 'needsBrowser',
      'priority', 'readMinutes', 'status', 'title', 'url',
    ])
    expect(rows[0]).not.toHaveProperty('extracted_content')
    expect(JSON.stringify(rows)).not.toContain('a long markdown body')
  })

  it('includes extracted content only when the field is requested', async () => {
    const store = await seeded()
    await store.setExtractedContent(1, 'a long markdown body', false, NOW)

    const rows = await listLinks(store, {
      now: NOW,
      fields: ['id', 'extracted_content'] as LinkField[],
    })
    const withContent = rows.find((r) => r['id'] === 1)!
    expect(withContent['extracted_content']).toBe('a long markdown body')
  })

  it('filters by status, category and staleness', async () => {
    const store = await seeded()
    expect(await listLinks(store, { now: NOW, status: 'inbox' })).toHaveLength(2)
    expect(await listLinks(store, { now: NOW, category: 'event' })).toHaveLength(2)
    const stale = await listLinks(store, { now: NOW, stale: true })
    expect(stale.map((r) => r['id']).sort()).toEqual([1, 3])
  })

  it('matches a free-text query over url and title', async () => {
    const store = await seeded()
    const rows = await listLinks(store, { now: NOW, q: 'example.com/three' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!['id']).toBe(3)
  })

  it('matches q over note, tags and the enrichment summary too', async () => {
    const store = new FakeStore()
    await seedLink(store, 'https://example.com/a', { title: 'A', note: 'uniquephrase' })
    await seedLink(store, 'https://example.com/b', { title: 'B', tags: ['uniquetag'] })
    await seedLink(store, 'https://example.com/c', { title: 'C' })
    const rows = await listLinks(store, { now: NOW, q: 'unique' })
    expect(rows.map((r) => r['id']).sort()).toEqual([1, 2])
  })

  it('composes q with host and paginates the filtered set', async () => {
    const store = new FakeStore()
    await seedLink(store, 'https://a.example.com/one', { title: 'needle one' })
    await seedLink(store, 'https://b.example.com/two', { title: 'needle two' })
    await seedLink(store, 'https://a.example.com/three', { title: 'needle three' })

    const all = await listLinks(store, { now: NOW, q: 'needle' })
    expect(all).toHaveLength(3)

    const onA = await listLinks(store, { now: NOW, q: 'needle', host: 'a.example.com' })
    expect(onA.map((r) => r['title'])).toEqual(['needle three', 'needle one'])

    const page = await listLinks(store, {
      now: NOW,
      q: 'needle',
      host: 'a.example.com',
      limit: 1,
      offset: 1,
    })
    expect(page.map((r) => r['title'])).toEqual(['needle one'])
  })

  it('defaults q to relevance, honors explicit newest, ignores sort without q', async () => {
    const store = await seeded()
    const seen: Array<import('../src/index.js').LinkFilter | undefined> = []
    const orig = store.listLinks.bind(store)
    store.listLinks = async (f) => {
      seen.push(f)
      return orig(f)
    }

    await listLinks(store, { now: NOW, q: 'example' })
    expect(seen[0]?.sort).toBe('relevance')
    expect(seen[0]?.match).toBe('example')

    await listLinks(store, { now: NOW, q: 'example', sort: 'newest' })
    expect(seen[1]?.sort).toBe('newest')

    await listLinks(store, { now: NOW, sort: 'relevance' })
    expect(seen[2]?.sort).toBe('relevance')
    expect(seen[2]?.match).toBeUndefined()

    await listLinks(store, { now: NOW })
    expect(seen[3]?.sort).toBeUndefined()
    expect(seen[3]?.match).toBeUndefined()
  })

  it('respects the limit', async () => {
    const store = await seeded()
    expect(await listLinks(store, { now: NOW, limit: 2 })).toHaveLength(2)
  })
})

describe('ops.getLink', () => {
  it('returns null for a missing id', async () => {
    const store = new FakeStore()
    expect(await getLink(store, 42)).toBeNull()
  })

  it('returns the full record when fields are requested', async () => {
    const store = await seeded()
    const row = await getLink(store, 1, [
      'id',
      'url',
      'title',
      'category',
      'expiresAt',
      'expiryReason',
      'enrichment',
    ])
    expect(row).not.toBeNull()
    expect(row!['expiresAt']).toBe(new Date(NOW.getTime() - 2 * DAY).toISOString())
  })
})

describe('ops.projectLink', () => {
  it('projects exactly the requested fields', () => {
    const link: Link = {
      id: 7,
      urlHash: 'h',
      url: 'https://example.com',
      title: 'T',
      source: 'markdown',
      addedAt: null,
      note: null,
      tags: null,
      extractedContent: 'body',
      extractedAt: null,
      enrichment: null,
      expiresAt: null,
      expiryReason: null,
      status: 'inbox',
      category: null,
      priority: null,
      action: null,
      confidence: null,
      readMinutes: null,
      needsBrowser: false,
      createdAt: NOW,
      updatedAt: NOW,
    }
    expect(Object.keys(projectLink(link))).toEqual([
      'id', 'url', 'title', 'status', 'category', 'priority', 'action',
      'expiresAt', 'expiryReason', 'readMinutes', 'needsBrowser',
    ])
    expect(Object.keys(projectLink(link, ['url', 'extracted_content']))).toEqual([
      'url',
      'extracted_content',
    ])
  })
})

describe('ops.triage', () => {
  it('maps every action to a status', () => {
    expect(ACTION_TO_STATUS).toEqual({
      read_now: 'inbox',
      schedule: 'scheduled',
      archive: 'archived',
      discard: 'discarded',
    })
  })

  it('triages a single link', async () => {
    const store = await seeded()
    const result = await triage(store, [1], 'archive')
    expect(result.status).toBe('archived')
    expect(result.updated).toBe(1)
    expect((await store.getLink(1))?.status).toBe('archived')
  })

  it('triages a batch and reports missing ids', async () => {
    const store = await seeded()
    const result = await triage(store, [1, 2, 999], 'schedule')
    expect(result.updated).toBe(2)
    expect(result.missing).toEqual([999])
    expect((await store.getLink(2))?.status).toBe('scheduled')
  })
})

describe('ops.sweep', () => {
  it('proposes archiving stale links grouped by category', async () => {
    const store = await seeded()
    const plan = await sweep(store, ttl, { now: NOW })
    expect(plan.groups.map((g) => g.category).sort()).toEqual(['event', 'job'])
    expect(plan.totals.archive).toBe(2)
    expect(plan.groups.every((g) => g.action === 'archive')).toBe(true)
    // dry-run: nothing changed
    expect((await store.getLink(1))?.status).toBe('inbox')
  })

  it('applies the plan by archiving, never deleting', async () => {
    const store = await seeded()
    const plan = await sweep(store, ttl, { now: NOW })
    const archived = await applySweep(store, plan, NOW)
    expect(archived).toBe(2)
    expect(store.links).toHaveLength(3)
    expect((await store.getLink(1))?.status).toBe('archived')
    expect((await store.getLink(3))?.status).toBe('archived')
  })
})

describe('ops.prune', () => {
  it('proposes deleting only items past delete_after_days', async () => {
    const store = new FakeStore()
    await seedLink(store, 'https://example.com/old', {
      status: 'archived',
      expiresAt: new Date(NOW.getTime() - 400 * DAY),
    })
    await seedLink(store, 'https://example.com/recent', {
      status: 'archived',
      expiresAt: new Date(NOW.getTime() - 10 * DAY),
    })
    await seedLink(store, 'https://example.com/inbox', {
      status: 'inbox',
      expiresAt: new Date(NOW.getTime() - 400 * DAY),
    })

    const plan = await prune(store, ttl, { now: NOW })
    expect(plan.totals.delete).toBe(1)
    expect(plan.items[0]?.url).toBe('https://example.com/old')
    // dry-run: nothing deleted
    expect(store.links).toHaveLength(3)
  })

  it('deletes only after the caller applies the plan', async () => {
    const store = new FakeStore()
    await seedLink(store, 'https://example.com/old', {
      status: 'archived',
      expiresAt: new Date(NOW.getTime() - 400 * DAY),
    })
    const plan = await prune(store, ttl, { now: NOW })
    const deleted = await applyPrune(store, plan)
    expect(deleted).toBe(1)
    // FSM semantics: prune moves the link to the terminal deleted state and
    // keeps the tombstone row, so the row still exists but is marked deleted.
    expect(store.links).toHaveLength(1)
    expect(store.links[0]?.state).toBe('deleted')
    expect(store.links[0]?.status).toBe('deleted')
    expect(store.links[0]?.enrichment).toBeNull()
    expect(store.links[0]?.extractedContent).toBeNull()
  })
})

describe('ops.metricsSummary', () => {
  it('parses range strings', () => {
    expect(parseRange('7d').ms).toBe(7 * 24 * 60 * 60 * 1000)
    expect(parseRange('24h').ms).toBe(24 * 60 * 60 * 1000)
    expect(parseRange('2w').ms).toBe(14 * 24 * 60 * 60 * 1000)
    expect(() => parseRange('nope')).toThrow()
  })

  it('aggregates per stage counts, durations, tokens and cost', async () => {
    const store = new FakeStore()
    await store.addMetric({ timestamp: NOW, stage: 'extract', key: 'input', value: 3 })
    await store.addMetric({ timestamp: NOW, stage: 'extract', key: 'ok', value: 2 })
    await store.addMetric({ timestamp: NOW, stage: 'extract', key: 'errors', value: 1 })
    await store.addMetric({ timestamp: NOW, stage: 'extract', key: 'duration_ms', value: 120 })
    await store.addMetric({
      timestamp: NOW,
      stage: 'extract',
      key: 'errors',
      value: 1,
      tags: { extractor: 'defuddle' },
    })
    await store.addMetric({ timestamp: NOW, stage: 'enrich', key: 'tokens_in', value: 500 })
    await store.addMetric({ timestamp: NOW, stage: 'enrich', key: 'cost_usd', value: 0.5 })

    const summary = await metricsSummary(store, '7d', NOW)
    const extract = summary.stages.find((s) => s.stage === 'extract')!
    expect(extract.runs).toBe(1)
    expect(extract.input).toBe(3)
    expect(extract.ok).toBe(2)
    expect(extract.errors).toBe(1)
    expect(extract.avgDurationMs).toBe(120)
    expect(extract.errorsByTag).toEqual({ 'extractor:defuddle': 1 })

    const enrichStage = summary.stages.find((s) => s.stage === 'enrich')!
    expect(enrichStage.tokensIn).toBe(500)
    expect(enrichStage.costUsd).toBeCloseTo(0.5)
  })

  it('excludes metrics outside the range', async () => {
    const store = new FakeStore()
    const old = new Date(NOW.getTime() - 30 * DAY)
    await store.addMetric({ timestamp: old, stage: 'extract', key: 'input', value: 5 })
    await store.addMetric({ timestamp: NOW, stage: 'extract', key: 'input', value: 1 })
    const summary = await metricsSummary(store, '7d', NOW)
    const extract = summary.stages.find((s) => s.stage === 'extract')!
    expect(extract.input).toBe(1)
  })
})

describe('ops snapshots', () => {
  it('listLinks projection is stable', async () => {
    const store = await seeded()
    const rows = await listLinks(store, { now: NOW, status: 'inbox' })
    const sorted = [...rows].sort((a, b) => Number(a['id']) - Number(b['id']))
    expect(stable(sorted)).toMatchInlineSnapshot(`
      [
        {
          "action": null,
          "category": "job",
          "expiresAt": "2026-10-27T12:00:00.000Z",
          "expiryReason": null,
          "id": 1,
          "needsBrowser": false,
          "priority": null,
          "readMinutes": null,
          "status": "inbox",
          "title": "One",
          "url": "https://example.com/one",
        },
        {
          "action": null,
          "category": "event",
          "expiresAt": "2026-11-03T12:00:00.000Z",
          "expiryReason": null,
          "id": 2,
          "needsBrowser": false,
          "priority": null,
          "readMinutes": null,
          "status": "inbox",
          "title": "Two",
          "url": "https://example.com/two",
        },
      ]
    `)
  })

  it('sweep plan is stable', async () => {
    const store = await seeded()
    const plan = await sweep(store, ttl, { now: NOW })
    expect(stable(plan)).toMatchInlineSnapshot(`
      {
        "groups": [
          {
            "action": "archive",
            "category": "event",
            "items": [
              {
                "action": "archive",
                "category": "event",
                "expiresAt": "2026-10-28T12:00:00.000Z",
                "expiryReason": null,
                "linkId": 3,
                "pruneEligible": false,
                "title": "Three",
                "url": "https://example.com/three",
              },
            ],
          },
          {
            "action": "archive",
            "category": "job",
            "items": [
              {
                "action": "archive",
                "category": "job",
                "expiresAt": "2026-10-27T12:00:00.000Z",
                "expiryReason": null,
                "linkId": 1,
                "pruneEligible": false,
                "title": "One",
                "url": "https://example.com/one",
              },
            ],
          },
        ],
        "totals": {
          "archive": 2,
        },
      }
    `)
  })

  it('metrics summary is stable', async () => {
    const store = new FakeStore()
    await store.addMetric({ timestamp: NOW, stage: 'ingest', key: 'input', value: 2 })
    await store.addMetric({ timestamp: NOW, stage: 'ingest', key: 'ok', value: 2 })
    await store.addMetric({ timestamp: NOW, stage: 'ingest', key: 'errors', value: 0 })
    await store.addMetric({ timestamp: NOW, stage: 'ingest', key: 'duration_ms', value: 7 })
    const summary = await metricsSummary(store, '7d', NOW)
    expect(stable(summary)).toMatchInlineSnapshot(`
      {
        "since": "2026-10-22T12:00:00.000Z",
        "stages": [
          {
            "avgDurationMs": 7,
            "costUsd": 0,
            "countsByTag": {},
            "errors": 0,
            "errorsByTag": {},
            "input": 2,
            "ok": 2,
            "runs": 1,
            "stage": "ingest",
            "tokensIn": 0,
            "tokensOut": 0,
          },
        ],
        "states": {
          "archived": 0,
          "created": 0,
          "deferred": 0,
          "deleted": 0,
          "discarded": 0,
          "enriching": 0,
          "errored": 0,
          "extracted": 0,
          "extracting": 0,
          "inbox": 0,
          "needs_browser": 0,
          "scheduled": 0,
        },
        "until": "2026-10-29T12:00:00.000Z",
      }
    `)
  })
})
