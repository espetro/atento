import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from '../src/index.js'
import {
  normalizeUrl,
  planSweep,
  planPrune,
  ttlFromToml,
  ttlDaysForCategory,
} from '@linkinbox/core'
import { importFile } from '@linkinbox/importers'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'fixtures', 'importers')

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-29T12:00:00.000Z')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-e2e-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ttl = ttlFromToml({
  ttl: {
    default_days: 30,
    by_category: { job: 45, event: 7 },
    archive_after_days: 90,
    delete_after_days: 365,
  },
})

async function ingest(filePath: string): Promise<number> {
  const store = await openStore({ path: join(dir, 'links.db') })
  try {
    const { links, warnings } = await importFile(filePath)
    for (const link of links) {
      const { hash } = normalizeUrl(link.url)
      await store.upsertLink({
        urlHash: hash,
        url: normalizeUrl(link.url).url,
        title: link.title ?? null,
        source: link.source,
        addedAt: link.addedAt ?? null,
        note: link.note ?? null,
        tags: link.tags ?? null,
        status: 'inbox',
        needsBrowser: false,
      })
    }
    return warnings.length
  } finally {
    await store.close()
  }
}

describe('test set A: import then store', () => {
  it('re-import is idempotent: no new rows for known urls', async () => {
    await ingest(join(fixtures, 'stash-export.md'))
    const store = await openStore({ path: join(dir, 'links.db') })
    const first = await store.listLinks()
    expect(first).toHaveLength(19)
    // normalize on ingest: the tracked variants collapse onto their clean urls
    const urls = first.map((l) => l.url).sort()
    expect(urls).toContain('https://example.com/tracked?id=42')
    expect(urls).not.toContain('https://example.com/tracked?utm_source=newsletter&utm_campaign=weekly&id=42')
    await store.close()

    const warnings = await ingest(join(fixtures, 'stash-export.md'))
    expect(warnings).toBe(0)
    const store2 = await openStore({ path: join(dir, 'links.db') })
    expect(await store2.listLinks()).toHaveLength(19)
    await store2.close()
  })

  it('imports the safari plist into normalized rows', async () => {
    await ingest(join(fixtures, 'safari-bookmarks.plist'))
    const store = await openStore({ path: join(dir, 'links.db') })
    const links = await store.listLinks()
    expect(links).toHaveLength(5)
    const tracked = links.find((l) => l.url.includes('tracked'))
    expect(tracked?.url).toBe('https://example.com/rl/tracked')
    expect(tracked?.source).toBe('safari-reading-list')
    expect(tracked?.note).toBe('Has utm params.')
    expect(tracked?.addedAt?.toISOString()).toBe('2026-09-20T14:00:00.000Z')
    await store.close()
  })
})

describe('test set D: sweep and prune through the store', () => {
  async function seed(): Promise<Awaited<ReturnType<typeof openStore>>> {
    const store = await openStore({ path: join(dir, 'sweep.db') })
    const mk = async (
      url: string,
      category: string,
      expiresAt: Date,
      status: 'inbox' | 'scheduled' | 'archived' | 'discarded' = 'inbox',
      addedAt = new Date(NOW.getTime() - 100 * DAY),
    ) => {
      const { url: normalized, hash } = normalizeUrl(url)
      const link = await store.upsertLink({
        urlHash: hash,
        url: normalized,
        source: 'test',
        status: 'inbox',
        needsBrowser: false,
        addedAt,
      })
      await store.setEnrichment(link.id, {
        category,
        priority: 'normal',
        why_it_matters: 'test',
        read_minutes: 5,
        action: 'read_now',
        expires_at: expiresAt.toISOString(),
        expiry_reason: 'test',
        confidence: 0.9,
      })
      if (status !== 'inbox') await store.updateStatus([link.id], status)
      return link.id
    }

    // stale by category
    await mk('https://a.test/1', 'job', new Date(NOW.getTime() - 10 * DAY)) // stale
    await mk('https://a.test/2', 'job', new Date(NOW.getTime() - 2 * DAY)) // stale
    await mk('https://a.test/3', 'event', new Date(NOW.getTime() - 1 * DAY)) // stale
    await mk('https://a.test/4', 'guide', new Date(NOW.getTime() + 30 * DAY)) // fresh
    await mk('https://a.test/5', 'news', new Date(NOW.getTime() - 400 * DAY)) // stale + prune-eligible
    await mk('https://a.test/6', 'job', new Date(NOW.getTime() - 10 * DAY), 'archived') // ignored by sweep
    return store
  }

  it('dry-run groups exactly the expected stale set by category', async () => {
    const store = await seed()
    const links = await store.listLinks()
    const plan = planSweep(links, { now: NOW, ttl })

    expect(plan.totals.archive).toBe(4)
    expect(plan.groups.map((g) => g.category)).toEqual(['event', 'job', 'news'])
    const job = plan.groups.find((g) => g.category === 'job')
    expect(job?.items.map((i) => i.url).sort()).toEqual(['https://a.test/1', 'https://a.test/2'])
    const news = plan.groups.find((g) => g.category === 'news')
    expect(news?.items[0]?.pruneEligible).toBe(true)
    const guide = plan.groups.find((g) => g.category === 'guide')
    expect(guide).toBeUndefined()
    await store.close()
  })

  it('apply archives and never deletes', async () => {
    const store = await seed()
    const links = await store.listLinks()
    const plan = planSweep(links, { now: NOW, ttl })

    const ids = plan.groups.flatMap((g) => g.items.map((i) => i.linkId))
    await store.updateStatus(ids, 'archived')

    expect(await store.countLinks({ status: 'archived' })).toBe(5) // 4 swept + 1 pre-archived
    expect(await store.countLinks({ status: 'inbox' })).toBe(1) // the fresh guide item
    // everything still exists: sweep never deletes
    expect(await store.countLinks()).toBe(6)
    await store.close()
  })

  it('prune only past delete_after_days and only already-actioned items', async () => {
    const store = await seed()
    const links = await store.listLinks()
    const sweepPlan = planSweep(links, { now: NOW, ttl })
    const ids = sweepPlan.groups.flatMap((g) => g.items.map((i) => i.linkId))
    await store.updateStatus(ids, 'archived')

    const afterSweep = await store.listLinks()
    const prune = planPrune(afterSweep, { now: NOW, ttl })
    // only the news item (expired 400 days ago, now archived); the pre-archived
    // job item expired 10 days ago, and the fresh guide item is still inbox
    expect(prune.items.map((i) => i.url)).toEqual(['https://a.test/5'])

    const deleted = await store.deleteLinks(prune.items.map((i) => i.linkId))
    expect(deleted).toBe(1)
    expect(await store.countLinks()).toBe(5)
    await store.close()
  })

  it('by_category override changes expiry but not sweep mechanics', async () => {
    const store = await seed()
    const links = await store.listLinks()
    const custom = ttlFromToml({
      ttl: {
        default_days: 30,
        by_category: { job: 1 },
        archive_after_days: 90,
        delete_after_days: 365,
      },
    })
    const plan = planSweep(links, { now: NOW, ttl: custom })
    // by_category only affects *setting* expiresAt (enrich layer); the sweep
    // still groups whatever is stale. Here all job items are already stale so
    // the grouping is unchanged.
    expect(plan.totals.archive).toBe(4)
    await store.close()
  })

  it('by_category override drives expiresAt derivation from ttlDaysForCategory', async () => {
    const store = await openStore({ path: join(dir, 'ttl.db') })
    const addedAt = new Date(NOW.getTime() - 10 * DAY)
    const { url, hash } = normalizeUrl('https://b.test/1')
    const link = await store.upsertLink({
      urlHash: hash,
      url,
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
      addedAt,
    })
    const days = ttlDaysForCategory(ttl, 'event') // 7
    const expiresAt = new Date(addedAt.getTime() + days * DAY)
    await store.setEnrichment(link.id, {
      category: 'event',
      priority: 'normal',
      why_it_matters: 'test',
      read_minutes: 5,
      action: 'read_now',
      expires_at: expiresAt.toISOString(),
      expiry_reason: null,
      confidence: 1,
    })

    // 7 days TTL from 10 days ago: stale
    let stale = await store.listLinks({ staleAsOf: NOW })
    expect(stale).toHaveLength(1)

    // with the override job=45: not stale anymore
    const custom = ttlFromToml({
      ttl: { default_days: 30, by_category: { event: 45 } },
    })
    const overrideDays = ttlDaysForCategory(custom, 'event')
    await store.setExpiry(link.id, new Date(addedAt.getTime() + overrideDays * DAY), null)
    stale = await store.listLinks({ staleAsOf: NOW })
    expect(stale).toHaveLength(0)
    await store.close()
  })
})
