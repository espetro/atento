/**
 * The store-backed per-day media budget: the cap survives a restart because
 * the counters live in the database, not in memory.
 */
import { describe, expect, it } from 'vitest'
import { createMediaBudget, todayKey } from '../src/index.js'
import { FakeStore } from './fake-store.js'

describe('store-backed media budget', () => {
  it('counts runs per day and per tier', async () => {
    const store = new FakeStore()
    const budget = createMediaBudget(store, { dailyCap: 3 })

    expect(await budget.consume('transcript')).toBe(true)
    expect(await budget.consume('transcript')).toBe(true)
    expect(await budget.consume('caption')).toBe(true)
    expect(await budget.consume('caption')).toBe(false)

    const snapshot = await budget.snapshot()
    expect(snapshot.total).toBe(3)
    expect(snapshot.byTier['transcript']).toBe(2)
    expect(snapshot.byTier['caption']).toBe(1)
  })

  it('survives a restart: a new budget over the same store sees the spend', async () => {
    const store = new FakeStore()
    const first = createMediaBudget(store, { dailyCap: 1 })
    expect(await first.consume('transcript')).toBe(true)

    // A fresh process reads the same counters from the store.
    const second = createMediaBudget(store, { dailyCap: 1 })
    expect(await second.consume('transcript')).toBe(false)
    expect((await second.snapshot()).total).toBe(1)
  })

  it('honours a per-tier cap', async () => {
    const store = new FakeStore()
    const budget = createMediaBudget(store, {
      dailyCap: 10,
      dailyCaps: { transcript: 1 },
    })
    expect(await budget.consume('transcript')).toBe(true)
    expect(await budget.consume('transcript')).toBe(false)
    expect(await budget.consume('caption')).toBe(true)
  })

  it('keys the counters by UTC day', () => {
    expect(todayKey(new Date('2026-10-29T23:59:59Z'))).toBe('2026-10-29')
    expect(todayKey(new Date('2026-10-30T00:00:00Z'))).toBe('2026-10-30')
  })
})
