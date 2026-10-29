import type { Enrichment } from '@linkinbox/core'
import type { EnrichFn } from './run.js'

/**
 * Deterministic mock enrich function whose outputs match the golden labels
 * in fixtures/enrichment. Used for offline eval tests and the demo bin.
 * Simulates a real model: mostly correct, with a small jitter on
 * expires_at inside the expected range so in-range logic is exercised.
 */
export function createMockEnrichFn(opts: {
  failSlugs?: string[]
  regressSlugs?: string[]
  corruptCategory?: boolean
  jitter?: boolean
} = {}): EnrichFn {
  const failSlugs = new Set(opts.failSlugs ?? [])
  const regressSlugs = new Set(opts.regressSlugs ?? [])
  return async (input) => {
    if (failSlugs.has(input.slug)) {
      return { ok: false, error: `mock failure for ${input.slug}` }
    }
    const isRegress = regressSlugs.has(input.slug) || opts.corruptCategory === true
    const expiresDays = expiryDaysFor(input.slug, opts.jitter === true)
    const enrichment: Enrichment = {
      category: isRegress ? 'definitely-wrong' : categoryFor(input.slug),
      priority: 'normal',
      why_it_matters: `Mock summary for ${input.slug}.`,
      read_minutes: 5,
      action: isRegress ? 'archive' : actionFor(input.slug),
      expires_at: expiresDays === null ? null : isoInDays(expiresDays),
      expiry_reason: expiresDays === null ? null : 'mock expiry',
      confidence: 0.9,
    }
    return { ok: true, enrichment }
  }
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

function expiryDaysFor(slug: string, jitter: boolean): number | null {
  const table: Record<string, number | null> = {
    'job-posting': 45,
    'event-conference': 40,
    'guide-kubernetes': null,
    'article-essay': null,
    'video-tech-talk': null,
    'recipe-pasta': null,
    'news-funding': 30,
    'deal-laptop': 3,
    'docs-library': null,
    'event-meetup': 14,
    'job-closed': 5,
    'release-notes': 30,
  }
  const base = table[slug] ?? null
  if (base === null || !jitter) return base
  // deterministic jitter within +/- 2 days
  const shift = (slug.length % 5) - 2
  return base + shift
}

function categoryFor(slug: string): string {
  const table: Record<string, string> = {
    'job-posting': 'job',
    'event-conference': 'event',
    'guide-kubernetes': 'guide',
    'article-essay': 'article',
    'video-tech-talk': 'video',
    'recipe-pasta': 'recipe',
    'news-funding': 'news',
    'deal-laptop': 'deal',
    'docs-library': 'guide',
    'event-meetup': 'event',
    'job-closed': 'job',
    'release-notes': 'news',
  }
  return table[slug] ?? 'article'
}

function actionFor(slug: string): Enrichment['action'] {
  const table: Record<string, Enrichment['action']> = {
    'job-posting': 'read_now',
    'event-conference': 'schedule',
    'guide-kubernetes': 'archive',
    'article-essay': 'read_now',
    'video-tech-talk': 'schedule',
    'recipe-pasta': 'read_now',
    'news-funding': 'archive',
    'deal-laptop': 'read_now',
    'docs-library': 'archive',
    'event-meetup': 'schedule',
    'job-closed': 'discard',
    'release-notes': 'read_now',
  }
  return table[slug] ?? 'read_now'
}
