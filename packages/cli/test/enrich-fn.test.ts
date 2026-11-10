/**
 * The enrich adapter is the seam with the separately built @atento/enrich
 * package. These tests pin the adaptation so the two halves can move
 * independently.
 */
import { describe, expect, it } from 'vitest'
import { adaptResult, createEnrichFn } from '../src/enrich-fn.js'

describe('enrich adapter', () => {
  it('adapts a successful result', () => {
    const result = adaptResult({
      ok: true,
      enrichment: {
        category: 'job',
        priority: 'high',
        why_it_matters: 'a job posting',
        read_minutes: 3,
        action: 'read_now',
        expires_at: '2026-12-01T00:00:00.000Z',
        expiry_reason: 'job posting',
        confidence: 0.9,
      },
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.002,
      modelId: 'some-model',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.tokensIn).toBe(100)
    expect(result.tokensOut).toBe(50)
    expect(result.costUsd).toBe(0.002)
    expect(result.modelId).toBe('some-model')
  })

  it('defaults missing token counts and model id', () => {
    const result = adaptResult({
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
    })
    if (!result.ok) throw new Error('expected success')
    expect(result.tokensIn).toBe(0)
    expect(result.tokensOut).toBe(0)
    expect(result.modelId).toBe('unknown')
    expect(result.costUsd).toBeUndefined()
  })

  it('adapts a failure result', () => {
    const result = adaptResult({ ok: false, error: 'model unavailable' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('model unavailable')
  })

  it('uses createEnrichFn from the module when present', async () => {
    const fn = await createEnrichFn({
      load: async () => ({
        createEnrichFn: () => async () => ({
          ok: true,
          enrichment: {
            category: 'from-factory',
            priority: 'normal',
            why_it_matters: 'x',
            read_minutes: 1,
            action: 'read_now',
            expires_at: null,
            expiry_reason: null,
            confidence: 0.5,
          },
          tokensIn: 1,
          tokensOut: 1,
          modelId: 'factory-model',
        }),
      }),
    })
    const result = await fn({
      id: 1,
      urlHash: 'h',
      url: 'https://example.com',
      title: null,
      source: 'test',
      addedAt: null,
      note: null,
      tags: null,
      extractedContent: null,
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
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(result.ok).toBe(true)
  })

  it('fails cleanly when the package is missing', async () => {
    const fn = await createEnrichFn({
      load: async () => {
        throw new Error('Cannot find module @atento/enrich')
      },
    })
    const result = await fn({
      id: 1,
      urlHash: 'h',
      url: 'https://example.com',
      title: null,
      source: 'test',
      addedAt: null,
      note: null,
      tags: null,
      extractedContent: null,
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
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('@atento/enrich')
  })

  it('falls back to runEnrich when there is no factory', async () => {
    const fn = await createEnrichFn({
      load: async () => ({
        runEnrich: async () => ({
          ok: true,
          enrichment: {
            category: 'from-run',
            priority: 'normal',
            why_it_matters: 'x',
            read_minutes: 1,
            action: 'read_now',
            expires_at: null,
            expiry_reason: null,
            confidence: 0.5,
          },
          tokensIn: 5,
          tokensOut: 2,
          model: 'run-model',
        }),
      }),
    })
    const result = await fn({
      id: 1,
      urlHash: 'h',
      url: 'https://example.com',
      title: null,
      source: 'test',
      addedAt: null,
      note: null,
      tags: null,
      extractedContent: null,
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
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    if (!result.ok) throw new Error('expected success')
    expect(result.modelId).toBe('run-model')
  })
})

describe('createEnrichFn with the real enrich entry point shape', () => {
  const link = { id: 1, url: 'https://example.com', extractedContent: 'body' } as never
  const enrichment = { category: 'job', priority: 'low', action: 'archive', confidence: 0.5 } as never

  it('builds the model from env, passes it as deps and maps usage', async () => {
    const seen: unknown[] = []
    const fn = await createEnrichFn({
      env: { ATENTO_MODEL: 'm' },
      load: async () => ({
        createModelFromEnv: () => ({ modelId: 'm' }),
        enrichLink: async (_l: unknown, deps: unknown) => {
          seen.push(deps)
          return { ok: true, enrichment, usage: { tokensIn: 7, tokensOut: 3 }, modelId: 'm' }
        },
      }),
    })
    const res = await fn(link)
    expect(seen).toEqual([{ model: { modelId: 'm' } }])
    expect(res).toMatchObject({ ok: true, tokensIn: 7, tokensOut: 3, modelId: 'm' })
  })

  it('reports missing model config as a per-link error', async () => {
    const fn = await createEnrichFn({
      load: async () => ({
        createModelFromEnv: () => {
          throw new Error('requires OPENAI_COMPAT_BASE_URL')
        },
        enrichLink: async () => ({ ok: true }),
      }),
    })
    const res = await fn(link)
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toContain('OPENAI_COMPAT_BASE_URL')
  })
})
