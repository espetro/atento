import { describe, expect, it } from 'vitest'
import {
  createCollectingLogger,
  enrich,
  extract,
  ingest,
  type EnrichFn,
  type ExtractFn,
  type RawLink,
} from '../src/index.js'
import { FakeStore } from './fake-store.js'

const raw = (url: string, source = 'markdown', extra: Partial<RawLink> = {}): RawLink => ({
  url,
  source,
  ...extra,
})

describe('pipeline stage: ingest', () => {
  it('stores raw links and dedupes by normalized url hash', async () => {
    const store = new FakeStore()
    const result = await ingest(store, [
      raw('https://example.com/a'),
      raw('https://example.com/a?utm_source=newsletter'),
      raw('https://example.com/b/'),
      raw('https://example.com/b'),
    ])

    expect(store.links).toHaveLength(2)
    expect(result.okCount).toBe(4)
    expect(result.duplicates).toBe(2)
    expect(store.links.map((l) => l.url).sort()).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ])
  })

  it('is idempotent: re-ingesting the same links changes nothing', async () => {
    const store = new FakeStore()
    const links = [raw('https://example.com/a'), raw('https://example.com/b')]
    await ingest(store, links)
    const firstIds = store.links.map((l) => l.id)

    const second = await ingest(store, links)
    expect(store.links).toHaveLength(2)
    expect(store.links.map((l) => l.id)).toEqual(firstIds)
    expect(second.duplicates).toBe(2)
  })

  it('records a runs row plus metrics rows', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://example.com/a'), raw('https://example.com/b')])

    expect(store.runs).toHaveLength(1)
    const run = store.runs[0]!
    expect(run.stage).toBe('ingest')
    expect(run.inputCount).toBe(2)
    expect(run.okCount).toBe(2)
    expect(run.errorCount).toBe(0)
    expect(run.durationMs).not.toBeNull()

    const keys = store.metrics.map((m) => m.key).sort()
    expect(keys).toEqual(['duration_ms', 'errors', 'input', 'ok'])
    expect(store.metrics.find((m) => m.key === 'input')?.value).toBe(2)
    expect(store.metrics.find((m) => m.key === 'ok')?.value).toBe(2)
  })

  it('counts per-importer errors', async () => {
    const store = new FakeStore()
    // A source that fails: the fake store throws on an empty url.
    const broken = new FakeStore()
    broken.upsertLink = async () => {
      throw new Error('disk full')
    }
    const result = await ingest(broken, [raw('https://example.com/a', 'markdown')])
    expect(result.errorCount).toBe(1)
    expect(store.links).toHaveLength(0)
    const tagged = broken.metrics.find((m) => m.key === 'errors' && m.tags)
    expect(tagged?.tags).toEqual({ importer: 'markdown' })
  })

  it('logs one line per link', async () => {
    const store = new FakeStore()
    const logger = createCollectingLogger()
    await ingest(store, [raw('https://example.com/a'), raw('https://example.com/b')], { logger })
    const perLink = logger.records.filter((r) => r.message.includes('ingested {url}'))
    expect(perLink).toHaveLength(2)
  })
})

describe('pipeline stage: extract', () => {
  it('extracts links lacking content and records the content', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://example.com/a'), raw('https://example.com/b')])

    const extractFn: ExtractFn = async (url) => ({ markdown: `# ${url}\n\nbody text` })
    const logger = createCollectingLogger()
    const result = await extract(store, { extract: extractFn, logger })

    expect(result.inputCount).toBe(2)
    expect(result.okCount).toBe(2)
    expect(result.errorCount).toBe(0)
    expect(store.links.every((l) => l.extractedContent !== null)).toBe(true)
    expect(store.links.every((l) => l.needsBrowser === false)).toBe(true)

    const perLink = logger.records.filter((r) => r.message.includes('extracted {url}'))
    expect(perLink).toHaveLength(2)
  })

  it('sets needs_browser instead of crashing when extraction cannot run', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://x.com/a')])

    const extractFn: ExtractFn = async () => ({ markdown: '', needsBrowser: true })
    const result = await extract(store, { extract: extractFn })

    expect(result.errorCount).toBe(0)
    expect(result.needsBrowserCount).toBe(1)
    expect(store.links[0]?.needsBrowser).toBe(true)
    expect(store.metrics.find((m) => m.key === 'needs_browser')?.value).toBe(1)
  })

  it('counts failures as errors and keeps the stage alive', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://example.com/a'), raw('https://example.com/b')])

    const extractFn: ExtractFn = async (url) => {
      if (url.endsWith('/a')) throw new Error('boom')
      return { markdown: 'ok content' }
    }
    const result = await extract(store, { extract: extractFn })

    expect(result.okCount).toBe(1)
    expect(result.errorCount).toBe(1)
    const run = store.runs.find((r) => r.stage === 'extract')!
    expect(run.errorCount).toBe(1)
    expect(
      store.metrics.find((m) => m.stage === 'extract' && m.key === 'errors' && !m.tags)?.value,
    ).toBe(1)
    expect(
      store.metrics.find((m) => m.stage === 'extract' && m.key === 'errors' && m.tags)?.tags,
    ).toEqual({ extractor: 'unknown' })
  })

  it('skips links that already have content', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://example.com/a')])
    await extract(store, { extract: async () => ({ markdown: 'first pass' }) })

    const second = await extract(store, { extract: async () => ({ markdown: 'second pass' }) })
    expect(second.inputCount).toBe(0)
    expect(store.links[0]?.extractedContent).toBe('first pass')
  })
})

describe('pipeline stage: enrich', () => {
  it('records enrichment and its expiry, plus token and cost metrics', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://example.com/a')])
    await extract(store, { extract: async () => ({ markdown: 'content' }) })

    const expires = new Date('2026-12-01T00:00:00.000Z')
    const enrichFn: EnrichFn = async () => ({
      ok: true,
      enrichment: {
        category: 'job',
        priority: 'high',
        why_it_matters: 'a job posting',
        read_minutes: 3,
        action: 'read_now',
        expires_at: expires.toISOString(),
        expiry_reason: 'job posting',
        confidence: 0.91,
      },
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.002,
      modelId: 'test-model',
    })

    const logger = createCollectingLogger()
    const result = await enrich(store, { enrich: enrichFn, logger })

    expect(result.okCount).toBe(1)
    expect(result.tokensIn).toBe(100)
    expect(result.tokensOut).toBe(50)
    expect(result.costUsd).toBeCloseTo(0.002)

    const link = store.links[0]!
    expect(link.enrichment?.category).toBe('job')
    expect(link.category).toBe('job')
    expect(link.priority).toBe('high')
    expect(link.action).toBe('read_now')
    expect(link.readMinutes).toBe(3)
    expect(link.expiresAt?.toISOString()).toBe(expires.toISOString())
    expect(link.expiryReason).toBe('job posting')

    const run = store.runs.find((r) => r.stage === 'enrich')!
    expect(run.tokensIn).toBe(100)
    expect(run.tokensOut).toBe(50)
    expect(run.costUsd).toBeCloseTo(0.002)

    expect(store.metrics.find((m) => m.key === 'tokens_in')?.value).toBe(100)
    expect(store.metrics.find((m) => m.key === 'cost_usd')?.value).toBeCloseTo(0.002)

    const perLink = logger.records.filter((r) => r.message.includes('enriched {url}'))
    expect(perLink).toHaveLength(1)
  })

  it('records an error outcome without throwing', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://example.com/a')])
    await extract(store, { extract: async () => ({ markdown: '# body' }) })

    const enrichFn: EnrichFn = async () => ({ ok: false, error: 'model unavailable' })
    const result = await enrich(store, { enrich: enrichFn })

    expect(result.errorCount).toBe(1)
    expect(result.okCount).toBe(0)
    expect(store.links[0]?.enrichment).toBeNull()
    expect(
      store.metrics.find((m) => m.stage === 'enrich' && m.key === 'errors' && !m.tags)?.value,
    ).toBe(1)
  })

  it('leaves links that were never extracted for the extract stage', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://example.com/a')])
    let calls = 0
    const enrichFn: EnrichFn = async () => {
      calls += 1
      return { ok: false, error: 'should not run' }
    }
    const result = await enrich(store, { enrich: enrichFn })

    expect(calls).toBe(0)
    expect(result.okCount + result.errorCount).toBe(0)
    expect(store.links[0]?.state).toBe('created')
  })

  it('skips links that already have enrichment', async () => {
    const store = new FakeStore()
    await ingest(store, [raw('https://example.com/a')])
    const enrichFn: EnrichFn = async () => ({
      ok: true,
      enrichment: {
        category: 'guide',
        priority: 'low',
        why_it_matters: 'x',
        read_minutes: 1,
        action: 'archive',
        expires_at: null,
        expiry_reason: null,
        confidence: 0.5,
      },
      tokensIn: 1,
      tokensOut: 1,
      modelId: 'm',
    })
    await enrich(store, { enrich: enrichFn })
    const second = await enrich(store, { enrich: enrichFn })
    expect(second.inputCount).toBe(0)
  })
})
