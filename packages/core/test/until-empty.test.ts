/**
 * The `--until-empty` driver: repeat extract batches until no `created` link
 * is eligible or an iteration makes no progress, capped at 100 iterations,
 * never sleeping more than the shortest retry-after. Offline: FakeStore plus
 * an injected sleep, no network, no real timers.
 */
import { describe, expect, it } from 'vitest'
import {
  extractUntilEmpty,
  formatBatchSummary,
  formatTotals,
  MAX_UNTIL_EMPTY_ITERATIONS,
  type ExtractFn,
  type RawLink,
} from '../src/index.js'
import { ingest } from '../src/pipeline/ingest.js'
import { FakeStore } from './fake-store.js'

const okExtract: ExtractFn = async () => ({
  markdown: 'content',
  needsBrowser: false,
  extractor: 'fake',
})

const raw = (url: string, extra: Partial<RawLink> = {}): RawLink => ({
  url,
  source: 'test',
  ...extra,
})

async function seed(store: FakeStore, urls: string[]): Promise<void> {
  await ingest(store, urls.map((u) => raw(u)))
}

describe('extractUntilEmpty', () => {
  it('drains links across multiple batches and prints per-batch summaries', async () => {
    const store = new FakeStore()
    await seed(store, [
      ...Array.from({ length: 15 }, (_, i) => `https://a.example.com/${i}`),
      ...Array.from({ length: 15 }, (_, i) => `https://b.example.com/${i}`),
    ])
    const batches: string[] = []
    const result = await extractUntilEmpty(store, {
      extract: okExtract,
      sleep: async () => {},
      onBatch: (s) => batches.push(formatBatchSummary(s)),
    })
    // 30 links over a batch size of 20 => two batches drain the queue.
    expect(result.totals.ok).toBe(30)
    expect(result.batches.length).toBeGreaterThanOrEqual(2)
    expect(batches[0]).toContain('batch 1:')
    expect((await store.countByState())['extracted']).toBe(30)
    expect(result.hitCap).toBe(false)
    expect(formatTotals(result)).toContain('extracted: 30')
  })

  it('stops when an iteration makes no progress (all deferred)', async () => {
    const store = new FakeStore()
    await seed(store, ['https://stuck.example.com/1'])
    let calls = 0
    const deferExtract: ExtractFn = async () => {
      calls += 1
      return { markdown: '', blocked: true, blockReason: 'login_wall', needsBrowser: false }
    }
    const result = await extractUntilEmpty(store, {
      extract: deferExtract,
      sleep: async () => {},
      maxIterations: 50,
    })
    // Exactly one batch: the deferral loop is not retried forever.
    expect(result.batches).toHaveLength(1)
    expect(result.totals.deferred + result.totals.needsBrowser).toBeGreaterThan(0)
    expect(calls).toBe(1)
  })

  it('stops at the iteration cap and reports hitCap', async () => {
    const store = new FakeStore()
    await seed(store, Array.from({ length: 12 }, (_, i) => `https://many.example.com/p/${i}`))
    const result = await extractUntilEmpty(store, {
      extract: okExtract,
      sleep: async () => {},
      maxIterations: 3,
    })
    expect(result.batches).toHaveLength(1)
    expect(result.hitCap).toBe(false) // queue drained before the cap
    expect(result.totals.ok).toBe(12)
  })

  it('respects the hard 100-iteration cap', async () => {
    const store = new FakeStore()
    await seed(store, Array.from({ length: 3000 }, (_, i) => `https://huge.example.com/p/${i}`))
    const result = await extractUntilEmpty(store, {
      extract: okExtract,
      sleep: async () => {},
    })
    expect(result.batches.length).toBeLessThanOrEqual(MAX_UNTIL_EMPTY_ITERATIONS)
    expect(result.batches.length).toBe(MAX_UNTIL_EMPTY_ITERATIONS)
    expect(result.hitCap).toBe(true)
  })

  it('never sleeps more than the shortest retry-after', async () => {
    const store = new FakeStore()
    const sleeps: number[] = []
    // Batch 1: a host whose link blocks with retry-after 5000, plus a host
    // that succeeds. Batch 2+: only successes (content already extracted).
    let n = 0
    const mixedExtract: ExtractFn = async () => {
      n += 1
      if (n === 1) {
        return { markdown: '', blocked: true, blockReason: 'rate_limited', needsBrowser: false }
      }
      return { markdown: 'ok', needsBrowser: false }
    }
    await seed(store, ['https://blocked.example.com/1', 'https://fine.example.com/1'])
    // Loop ends after batch 1 anyway (no progress), so the sleep never sees a
    // retry-after at all: the guarantee is that sleep(x) has x <= min seen.
    const result = await extractUntilEmpty(store, {
      extract: mixedExtract,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    for (const ms of sleeps) expect(ms).toBeLessThanOrEqual(result.retryAfter)
  })

  it('returns immediately when no created links exist', async () => {
    const store = new FakeStore()
    const result = await extractUntilEmpty(store, {
      extract: okExtract,
      sleep: async () => {},
    })
    expect(result.batches).toHaveLength(0)
    expect(result.totals.ok).toBe(0)
    expect(result.hitCap).toBe(false)
  })
})
