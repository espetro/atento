import { describe, expect, it } from 'vitest'
import { planSweep, planPrune } from '../src/sweep.js'
import { ttlFromToml } from '../src/ttl.js'
import type { Link } from '../src/types.js'

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

let nextId = 1

function makeLink(overrides: Partial<Link> & { category?: string | null } = {}): Link {
  const { category, ...rest } = overrides
  const id = nextId++
  return {
    id,
    urlHash: `hash-${id}`,
    url: `https://example.com/${id}`,
    title: `Link ${id}`,
    source: 'test',
    addedAt: new Date(NOW.getTime() - 100 * DAY),
    note: null,
    tags: null,
    extractedContent: null,
    extractedAt: null,
    enrichment:
      category === undefined
        ? null
        : {
            category,
            priority: 'normal',
            why_it_matters: 'because',
            read_minutes: 5,
            action: 'read_now',
            expires_at: null,
            expiry_reason: null,
            confidence: 0.9,
          },
    expiresAt: new Date(NOW.getTime() - 10 * DAY),
    expiryReason: 'expired',
    status: 'inbox',
    needsBrowser: false,
    createdAt: new Date(NOW.getTime() - 100 * DAY),
    updatedAt: new Date(NOW.getTime() - 10 * DAY),
    ...rest,
  }
}

describe('planSweep', () => {
  it('groups stale links by category', () => {
    const links = [
      makeLink({ category: 'job' }),
      makeLink({ category: 'job' }),
      makeLink({ category: 'event' }),
      makeLink({ category: 'guide' }),
    ]
    const plan = planSweep(links, { now: NOW, ttl })
    expect(plan.totals.archive).toBe(4)
    expect(plan.groups.map((g) => g.category)).toEqual(['event', 'guide', 'job'])
    const job = plan.groups.find((g) => g.category === 'job')
    expect(job?.items).toHaveLength(2)
    expect(job?.action).toBe('archive')
  })

  it('excludes links whose expiry is in the future', () => {
    const links = [makeLink({ category: 'job', expiresAt: new Date(NOW.getTime() + DAY) })]
    expect(planSweep(links, { now: NOW, ttl }).totals.archive).toBe(0)
  })

  it('excludes links without an expiry date', () => {
    const links = [makeLink({ category: 'job', expiresAt: null })]
    expect(planSweep(links, { now: NOW, ttl }).totals.archive).toBe(0)
  })

  it('ignores links outside the considered statuses', () => {
    const links = [
      makeLink({ category: 'job', status: 'archived' }),
      makeLink({ category: 'job', status: 'discarded' }),
      makeLink({ category: 'job', status: 'scheduled' }),
    ]
    const plan = planSweep(links, { now: NOW, ttl })
    expect(plan.totals.archive).toBe(1)
    expect(plan.groups[0]?.items[0]?.linkId).toBe(links[2]?.id)
  })

  it('groups links without a category under uncategorized', () => {
    const links = [makeLink({ category: undefined })]
    const plan = planSweep(links, { now: NOW, ttl })
    expect(plan.groups[0]?.category).toBe('uncategorized')
  })

  it('only marks pruneEligible for links past delete_after_days', () => {
    const old = makeLink({ category: 'job', expiresAt: new Date(NOW.getTime() - 400 * DAY) })
    const recent = makeLink({ category: 'job', expiresAt: new Date(NOW.getTime() - 10 * DAY) })
    const plan = planSweep([old, recent], { now: NOW, ttl })
    const job = plan.groups.find((g) => g.category === 'job')
    const oldItem = job?.items.find((i) => i.linkId === old.id)
    const recentItem = job?.items.find((i) => i.linkId === recent.id)
    expect(oldItem?.pruneEligible).toBe(true)
    expect(recentItem?.pruneEligible).toBe(false)
  })
})

describe('planPrune', () => {
  it('deletes only archived or discarded links past delete_after_days', () => {
    const oldArchived = makeLink({
      status: 'archived',
      addedAt: new Date(NOW.getTime() - 400 * DAY),
    })
    const oldInbox = makeLink({ status: 'inbox', addedAt: new Date(NOW.getTime() - 400 * DAY) })
    const recentArchived = makeLink({
      status: 'archived',
      addedAt: new Date(NOW.getTime() - 10 * DAY),
    })
    const plan = planPrune([oldArchived, oldInbox, recentArchived], { now: NOW, ttl })
    expect(plan.totals.delete).toBe(1)
    expect(plan.items[0]?.linkId).toBe(oldArchived.id)
  })

  it('falls back to createdAt when addedAt is missing', () => {
    const old = makeLink({
      status: 'archived',
      addedAt: null,
      createdAt: new Date(NOW.getTime() - 400 * DAY),
    })
    expect(planPrune([old], { now: NOW, ttl }).totals.delete).toBe(1)
  })

  it('respects a custom delete_after_days', () => {
    const custom = ttlFromToml({
      ttl: { default_days: 10, archive_after_days: 20, delete_after_days: 30 },
    })
    const old = makeLink({
      status: 'archived',
      addedAt: new Date(NOW.getTime() - 40 * DAY),
    })
    const newer = makeLink({
      status: 'archived',
      addedAt: new Date(NOW.getTime() - 20 * DAY),
    })
    const plan = planPrune([old, newer], { now: NOW, ttl: custom })
    expect(plan.totals.delete).toBe(1)
    expect(plan.items[0]?.linkId).toBe(old.id)
  })
})
