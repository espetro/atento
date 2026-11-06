/**
 * Fair batch selection: without fairness, `extract` takes the first 20
 * `created` links by id, so one host with many links fills every batch and
 * starves the others. The batch must be selected round-robin across hosts
 * (at most 3 links per host per batch, oldest first within a host, hosts
 * ordered by their oldest created link). Fakes only: no network.
 */
import { describe, expect, it } from 'vitest'
import { extract, DEFAULT_LIMITS, type ExtractFn, type RawLink } from '../src/index.js'
import { FakeStore } from './fake-store.js'
import { ingest } from '../src/pipeline/ingest.js'

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

/** Ingest links into `created` without a guard (no spacing, no cap). */
async function seed(store: FakeStore, urls: string[]): Promise<void> {
  await ingest(store, urls.map((u) => raw(u)))
}

describe('fair batch selection', () => {
  it('every host appears in the first batch when one host has 100 links', async () => {
    const store = new FakeStore()
    const urls = [
      ...Array.from({ length: 100 }, (_, i) => `https://github.com/link${i}`),
      ...Array.from({ length: 3 }, (_, i) => `https://example.com/page${i}`),
      ...Array.from({ length: 3 }, (_, i) => `https://youtube.com/watch?v=${i}`),
    ]
    await seed(store, urls)
    expect(store.links.filter((l) => l.state === 'created')).toHaveLength(106)

    const result = await extract(store, { extract: okExtract, maxBatch: DEFAULT_LIMITS.maxBatch })

    const hostsInBatch = new Set(
      result.outcomes.map((o) => new URL(o.url).hostname),
    )
    expect(hostsInBatch.has('github.com')).toBe(true)
    expect(hostsInBatch.has('example.com')).toBe(true)
    expect(hostsInBatch.has('youtube.com')).toBe(true)
    // The batch never exceeds the cap.
    expect(result.outcomes.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxBatch)
  })

  it('caps a host at 3 links per batch and orders hosts by their oldest link', async () => {
    const store = new FakeStore()
    await seed(store, [
      ...Array.from({ length: 10 }, (_, i) => `https://a.example.com/${i}`),
      ...Array.from({ length: 10 }, (_, i) => `https://b.example.com/${i}`),
    ])
    const result = await extract(store, { extract: okExtract })

    const byHost = new Map<string, number>()
    for (const o of result.outcomes) {
      const host = new URL(o.url).hostname
      byHost.set(host, (byHost.get(host) ?? 0) + 1)
    }
    for (const count of byHost.values()) expect(count).toBeLessThanOrEqual(3)
    // Two hosts, 3 links each = 6 processed in the first batch.
    expect(result.outcomes.length).toBe(6)
  })

  it('within a host, the oldest created links are picked first', async () => {
    const store = new FakeStore()
    await seed(store, Array.from({ length: 5 }, (_, i) => `https://solo.example.com/${i}`))
    const result = await extract(store, { extract: okExtract, maxBatch: 3 })
    expect(result.outcomes.map((o) => o.url)).toEqual([
      'https://solo.example.com/0',
      'https://solo.example.com/1',
      'https://solo.example.com/2',
    ])
  })

  it('skips hosts whose host_state says they are rate limited until a future time', async () => {
    const store = new FakeStore()
    await seed(store, [
      'https://throttled.example.com/1',
      'https://healthy.example.com/1',
    ])
    const later = Date.now() + 10 * 60 * 1000
    await store.saveHostState({
      key: 'throttled.example.com',
      lastRequestAt: null,
      windowStart: null,
      windowCount: 0,
      consecutiveFailures: 0,
      breakerState: 'closed',
      openedUntil: null,
      cooldownLevel: 0,
      lastError: null,
      trialState: 'unknown',
      trialReason: null,
      trialAt: null,
      loginGated: false,
      rateLimitedUntil: later,
    })
    const result = await extract(store, { extract: okExtract })
    const hosts = result.outcomes.map((o) => new URL(o.url).hostname)
    expect(hosts).toEqual(['healthy.example.com'])
  })

  it('skips hosts past their daily cap when known from host_state', async () => {
    const store = new FakeStore()
    await seed(store, [
      'https://capped.example.com/1',
      'https://fresh.example.com/1',
    ])
    await store.saveHostState({
      key: 'capped.example.com',
      lastRequestAt: Date.now() - 1000,
      windowStart: Date.now() - 1000,
      windowCount: 40,
      consecutiveFailures: 0,
      breakerState: 'closed',
      openedUntil: null,
      cooldownLevel: 0,
      lastError: null,
      trialState: 'unknown',
      trialReason: null,
      trialAt: null,
      loginGated: false,
      rateLimitedUntil: null,
    })
    const result = await extract(store, {
      extract: okExtract,
      guard: {
        config: { limits: { ...DEFAULT_LIMITS, hosts: { 'capped.example.com': { dailyCap: 40 } } } },
      } as never,
    })
    const hosts = result.outcomes.map((o) => new URL(o.url).hostname)
    expect(hosts).toEqual(['fresh.example.com'])
  })
})
