import { describe, expect, it } from 'vitest'
import { generateObject } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { EnrichmentSchema } from '@linkinbox/core'
import { enrichLink, enrichPending, createModelFromEnv, type EnrichModel } from '../src/run.js'
import { buildPrompt } from '../src/prompt.js'
import type { Link, Store, Enrichment } from '@linkinbox/core'

const modelId = 'mock-enricher'

function mockModel(rawOutput: unknown, modelIdOverride = modelId): EnrichModel {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: modelIdOverride,
    doGenerate: async () => ({
      finishReason: { unified: 'stop', raw: undefined },
      content: [{ type: 'text', text: JSON.stringify(rawOutput) }],
      warnings: [],
      usage: { inputTokens: { total: 100 }, outputTokens: { total: 40 } },
      request: {},
      response: { id: 'mock-1', timestamp: new Date(), modelId: modelIdOverride },
    }),
  })
}

const validEnrichment = {
  category: 'job',
  priority: 'high',
  why_it_matters: 'Role matches your saved search.',
  read_minutes: 4,
  action: 'read_now',
  expires_at: '2026-12-01T00:00:00.000Z',
  expiry_reason: 'job posting',
  confidence: 0.9,
}

const now = () => new Date('2026-10-29T12:00:00Z')

const baseLink: Link = {
  id: 1,
  urlHash: 'hash-1',
  url: 'https://example.com/job',
  title: 'Senior Engineer at Example',
  source: 'markdown',
  addedAt: new Date('2026-10-28T00:00:00Z'),
  note: null,
  tags: null,
  extractedContent: 'We are hiring a senior engineer...',
  extractedAt: new Date('2026-10-28T00:00:00Z'),
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
  createdAt: new Date('2026-10-28T00:00:00Z'),
  updatedAt: new Date('2026-10-28T00:00:00Z'),
}

function makeLink(overrides: Partial<Link> = {}): Link {
  return { ...baseLink, ...overrides }
}

function makeStore(links: Link[] = [makeLink()]) {
  const state = { links: structuredClone(links) as Link[] }
  const calls = { setEnrichment: 0, setExpiry: 0 }
  const store: Store = {
    upsertLink: async () => {
      throw new Error('not implemented')
    },
    getLink: async (id) => state.links.find((l) => l.id === id) ?? null,
    getLinkByUrlHash: async () => null,
    listLinks: async () => state.links,
    countLinks: async () => state.links.length,
    updateStatus: async () => 0,
    deleteLinks: async () => 0,
    setEnrichment: async (id, enrichment: Enrichment) => {
      calls.setEnrichment += 1
      const link = state.links.find((l) => l.id === id)
      if (link) {
        link.enrichment = enrichment
        link.category = enrichment.category
        link.action = enrichment.action
        if (enrichment.expires_at) link.expiresAt = new Date(enrichment.expires_at)
      }
      return 1
    },
    setExpiry: async (id, expiresAt, expiryReason) => {
      calls.setExpiry += 1
      const link = state.links.find((l) => l.id === id)
      if (link) {
        link.expiresAt = expiresAt
        link.expiryReason = expiryReason
      }
      return 1
    },
    setExtractedContent: async () => 1,
    startRun: async (stage, inputCount) => ({
      id: 1,
      stage,
      startedAt: new Date(),
      finishedAt: null,
      inputCount,
      okCount: 0,
      errorCount: 0,
      durationMs: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
    }),
    finishRun: async () => {},
    addMetric: async () => {},
    listMetrics: async () => [],
    listProfiles: async () => [],
    getProfile: async () => null,
    upsertProfile: async () => {
      throw new Error('not implemented')
    },
    deleteProfile: async () => 0,
    getMeta: async () => null,
    setMeta: async () => {},
    schemaVersion: async () => '0',
    migrate: async () => {},
    close: async () => {},
  }
  return { store, state, calls }
}

describe('schema', () => {
  it('re-exports EnrichmentSchema from core', () => {
    expect(EnrichmentSchema.safeParse(validEnrichment).success).toBe(true)
    expect(EnrichmentSchema.safeParse({ ...validEnrichment, priority: 'urgent' }).success).toBe(false)
  })
})

describe('prompt', () => {
  it('includes today as an input', () => {
    const { system, user } = buildPrompt({ link: makeLink(), now: new Date('2026-10-29T12:00:00Z') })
    expect(system).toContain('2026-10-29')
    expect(user).toContain('Today: 2026-10-29')
    expect(user).toContain('https://example.com/job')
    expect(user).toContain('We are hiring')
  })

  it('truncates extracted content', () => {
    const link = makeLink({ extractedContent: 'x'.repeat(20000) })
    const { user } = buildPrompt({ link, contentMaxChars: 100 })
    expect(user).toContain('x'.repeat(100))
    expect(user.length).toBeLessThan(1000)
  })
})

describe('enrichLink', () => {
  it('returns enrichment, usage and modelId on valid output', async () => {
    const result = await enrichLink(makeLink(), { model: mockModel(validEnrichment), now })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.enrichment.category).toBe('job')
    expect(result.usage).toEqual({ tokensIn: 100, tokensOut: 40 })
    expect(result.modelId).toBe('mock-enricher')
  })

  it('returns an error result on invalid output', async () => {
    const result = await enrichLink(makeLink(), {
      model: mockModel({ ...validEnrichment, priority: 'urgent', confidence: 5 }),
      now,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe('parse')
    expect(typeof result.error).toBe('string')
  })

  it('returns an error result on model failure', async () => {
    const failing = new MockLanguageModelV3({
      provider: 'mock',
      modelId,
      doGenerate: async () => {
        throw new Error('gateway timeout')
      },
    })
    const result = await enrichLink(makeLink(), { model: failing, now })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe('model')
    expect(result.error).toContain('gateway timeout')
  })

  it('re-repairs via EnrichmentSchema so extra fields are stripped', async () => {
    const result = await enrichLink(makeLink(), {
      model: mockModel({ ...validEnrichment, extra: 'noise' }),
      now,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.enrichment).not.toHaveProperty('extra')
  })
})

describe('enrichPending', () => {
  it('enriches pending inbox links and records usage', async () => {
    const { store, state, calls } = makeStore([makeLink({ id: 1 }), makeLink({ id: 2, enrichment: validEnrichment })])
    const summary = await enrichPending(store, { model: mockModel(validEnrichment), now })
    expect(summary.processed).toBe(1)
    expect(summary.okCount).toBe(1)
    expect(summary.tokensIn).toBe(100)
    expect(calls.setEnrichment).toBe(1)
    const enriched = state.links.find((l) => l.id === 1)
    expect(enriched?.enrichment?.category).toBe('job')
    expect(enriched?.expiresAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z')
  })

  it('skips links without extracted content', async () => {
    const { store } = makeStore([makeLink({ extractedContent: null })])
    const summary = await enrichPending(store, { model: mockModel(validEnrichment), now })
    expect(summary.processed).toBe(0)
  })

  it('counts errors without throwing', async () => {
    const failing = new MockLanguageModelV3({
      provider: 'mock',
      modelId,
      doGenerate: async () => {
        throw new Error('boom')
      },
    })
    const { store, calls } = makeStore([makeLink({ id: 1 })])
    const summary = await enrichPending(store, { model: failing, now })
    expect(summary.processed).toBe(1)
    expect(summary.okCount).toBe(0)
    expect(summary.errorCount).toBe(1)
    expect(calls.setEnrichment).toBe(0)
  })

  it('respects limit', async () => {
    const { store, calls } = makeStore([makeLink({ id: 1 }), makeLink({ id: 2 })])
    const summary = await enrichPending(store, { model: mockModel(validEnrichment), now }, { limit: 1 })
    expect(summary.processed).toBe(1)
    expect(calls.setEnrichment).toBe(1)
  })
})

describe('createModelFromEnv', () => {
  it('builds a model from env config', () => {
    const model = createModelFromEnv({
      OPENAI_COMPAT_BASE_URL: 'https://gw.example.com/v1',
      OPENAI_COMPAT_API_KEY: 'sk-test',
      LINKINBOX_MODEL: 'some-model',
    })
    expect(model.modelId).toBe('some-model')
  })

  it('throws when env is missing', () => {
    expect(() => createModelFromEnv({})).toThrow(/OPENAI_COMPAT_BASE_URL/)
  })
})

describe('generateObject integration', () => {
  it('works end-to-end with the mock model', async () => {
    const result = await generateObject({
      model: mockModel(validEnrichment),
      schema: EnrichmentSchema,
      prompt: 'enrich this',
    })
    expect(result.object.category).toBe('job')
  })
})
