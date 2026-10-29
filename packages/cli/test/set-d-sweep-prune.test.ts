/**
 * Test set D: TTL / sweep / prune against a seeded SQLite database.
 *
 * Criteria:
 *  - sweep dry-run lists exactly the expected set, grouped by category
 *  - sweep --apply archives and never deletes
 *  - prune --apply deletes only items past delete_after_days, after confirmation
 *  - config by_category overrides default_days correctly
 */
import { describe, expect, it } from 'vitest'
import { enrich, normalizeUrl, ttlFromToml, type TtlConfig } from '@linkinbox/core'
import { capture, insertLink, tempDb, type TempDb } from './helpers.js'
import { runPrune, runSweep } from '../src/commands/maintenance.js'
import { createContext, type CliContext } from '../src/context.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-29T12:00:00.000Z')

const ttl: TtlConfig = ttlFromToml({
  ttl: {
    default_days: 30,
    by_category: { job: 45, event: 7 },
    archive_after_days: 90,
    delete_after_days: 365,
  },
})

async function contextFor(db: TempDb): Promise<CliContext> {
  const ctx = await createContext({
    env: { LINKINBOX_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: `${db.dir}/log.jsonl`,
  })
  return ctx
}

async function seed(db: TempDb): Promise<void> {
  // stale job posting, expired 10 days ago
  const job = await insertLink(db.store, 'https://example.com/job', { title: 'Job posting' })
  await db.store.setEnrichment(job.id, {
    category: 'job',
    priority: 'high',
    why_it_matters: 'expires soon',
    read_minutes: 2,
    action: 'read_now',
    expires_at: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    expiry_reason: 'job posting',
    confidence: 0.9,
  })

  // stale event, expired 1 day ago
  const event = await insertLink(db.store, 'https://example.com/event', { title: 'Event' })
  await db.store.setEnrichment(event.id, {
    category: 'event',
    priority: 'normal',
    why_it_matters: 'over',
    read_minutes: 1,
    action: 'read_now',
    expires_at: new Date(NOW.getTime() - 1 * DAY).toISOString(),
    expiry_reason: 'event over',
    confidence: 0.8,
  })

  // fresh link, expires in 10 days
  const fresh = await insertLink(db.store, 'https://example.com/fresh', { title: 'Fresh' })
  await db.store.setEnrichment(fresh.id, {
    category: 'job',
    priority: 'low',
    why_it_matters: 'still good',
    read_minutes: 5,
    action: 'read_now',
    expires_at: new Date(NOW.getTime() + 10 * DAY).toISOString(),
    expiry_reason: null,
    confidence: 0.7,
  })

  // archived and old enough to prune
  const old = await insertLink(db.store, 'https://example.com/old', {
    title: 'Old archived',
    status: 'archived',
  })
  await db.store.setEnrichment(old.id, {
    category: 'guide',
    priority: 'low',
    why_it_matters: 'ancient',
    read_minutes: 1,
    action: 'archive',
    expires_at: new Date(NOW.getTime() - 400 * DAY).toISOString(),
    expiry_reason: null,
    confidence: 0.5,
  })
}

describe('test set D: sweep and prune over a seeded sqlite database', () => {
  it('sweep dry-run lists exactly the stale set grouped by category', async () => {
    const db = await tempDb()
    try {
      await seed(db)
      const ctx = await contextFor(db)
      const out = await capture(async () => {
        await runSweep(ctx, ttl, { now: NOW })
      })

      expect(out.stdout).toContain('event (1)')
      expect(out.stdout).toContain('job (1)')
      expect(out.stdout).toContain('https://example.com/event')
      expect(out.stdout).toContain('https://example.com/job')
      expect(out.stdout).not.toContain('https://example.com/fresh')
      expect(out.stdout).toContain('dry-run')

      // nothing was archived
      expect((await db.store.getLink(1))?.status).toBe('inbox')
      expect((await db.store.getLink(2))?.status).toBe('inbox')
    } finally {
      await db.cleanup()
    }
  })

  it('sweep --apply archives and never deletes', async () => {
    const db = await tempDb()
    try {
      await seed(db)
      const ctx = await contextFor(db)
      await capture(async () => {
        await runSweep(ctx, ttl, { now: NOW, apply: true })
      })

      const links = await db.store.listLinks({})
      expect(links).toHaveLength(4)
      expect((await db.store.getLink(1))?.status).toBe('archived')
      expect((await db.store.getLink(2))?.status).toBe('archived')
      expect((await db.store.getLink(3))?.status).toBe('inbox')
      // the already archived old link is untouched by sweep
      expect((await db.store.getLink(4))?.status).toBe('archived')
    } finally {
      await db.cleanup()
    }
  })

  it('prune dry-run proposes only items past delete_after_days', async () => {
    const db = await tempDb()
    try {
      await seed(db)
      const ctx = await contextFor(db)
      const out = await capture(async () => {
        await runPrune(ctx, ttl, { now: NOW })
      })

      expect(out.stdout).toContain('https://example.com/old')
      expect(out.stdout).not.toContain('https://example.com/job')
      expect(out.stdout).toContain('dry-run')
      expect((await db.store.listLinks({})).length).toBe(4)
    } finally {
      await db.cleanup()
    }
  })

  it('prune --apply deletes only after confirmation', async () => {
    const db = await tempDb()
    try {
      await seed(db)
      const ctx = await contextFor(db)

      // declining the prompt keeps everything
      const declined = await capture(async () => {
        await runPrune(ctx, ttl, { now: NOW, apply: true, confirm: async () => 'n' })
      })
      expect(declined.stdout).toContain('aborted')
      expect((await db.store.listLinks({})).length).toBe(4)

      // accepting the prompt deletes exactly the eligible rows
      const accepted = await capture(async () => {
        await runPrune(ctx, ttl, { now: NOW, apply: true, confirm: async () => 'y' })
      })
      expect(accepted.stdout).toContain('deleted 1 link(s)')
      const left = await db.store.listLinks({})
      expect(left).toHaveLength(3)
      expect(left.map((l) => l.url)).not.toContain('https://example.com/old')
    } finally {
      await db.cleanup()
    }
  })

  it('never prunes links that are still in the inbox', async () => {
    const db = await tempDb()
    try {
      const link = await insertLink(db.store, 'https://example.com/inbox-old', {
        status: 'inbox',
      })
      await db.store.setExpiry(link.id, new Date(NOW.getTime() - 400 * DAY), null)
      const ctx = await contextFor(db)
      await capture(async () => {
        await runPrune(ctx, ttl, { now: NOW, apply: true, yes: true })
      })
      expect((await db.store.listLinks({})).length).toBe(1)
    } finally {
      await db.cleanup()
    }
  })

  it('config by_category overrides default_days when deriving the expiry', async () => {
    // The ttl config drives the expiry the enrich stage derives when the
    // enrichment carries no expires_at: by_category wins over the default.
    const jobTtl = ttlFromToml({
      ttl: {
        default_days: 30,
        by_category: { job: 45 },
        archive_after_days: 90,
        delete_after_days: 365,
      },
    })
    expect(jobTtl.by_category['job']).toBe(45)
    expect(jobTtl.default_days).toBe(30)

    const db = await tempDb()
    try {
      const link = await insertLink(db.store, 'https://example.com/job')
      const ctx = await contextFor(db)
      await enrich(ctx.store, {
        enrich: async () => ({
          ok: true,
          enrichment: {
            category: 'job',
            priority: 'normal',
            why_it_matters: 'job posting',
            read_minutes: 2,
            action: 'read_now',
            expires_at: null,
            expiry_reason: null,
            confidence: 0.9,
          },
          tokensIn: 10,
          tokensOut: 5,
          modelId: 'test-model',
        }),
        ttl: jobTtl,
        now: () => NOW,
      })

      // 45 days out: still fresh for a sweep run 40 days later.
      const stored = await db.store.getLink(link.id)
      expect(stored?.expiresAt).not.toBeNull()
      const daysOut = Math.round((stored!.expiresAt!.getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000))
      expect(daysOut).toBe(45)

      const out = await capture(async () => {
        await runSweep(ctx, jobTtl, { now: new Date(NOW.getTime() + 40 * DAY) })
      })
      expect(out.stdout).toContain('nothing to sweep')

      // 46 days later it is stale.
      const out2 = await capture(async () => {
        await runSweep(ctx, jobTtl, { now: new Date(NOW.getTime() + 46 * DAY) })
      })
      expect(out2.stdout).toContain('https://example.com/job')
    } finally {
      await db.cleanup()
    }
  })

  it('stale links are discoverable through the store filter', async () => {
    const db = await tempDb()
    try {
      await seed(db)
      const stale = await db.store.listLinks({ staleAsOf: NOW })
      expect(stale.map((l) => l.url).sort()).toEqual([
        'https://example.com/event',
        'https://example.com/job',
        'https://example.com/old',
      ])
      const { url, hash } = normalizeUrl('https://example.com/job')
      expect((await db.store.getLinkByUrlHash(hash))?.url).toBe(url)
    } finally {
      await db.cleanup()
    }
  })
})
