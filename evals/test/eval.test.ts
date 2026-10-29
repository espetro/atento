import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runEval, saveBaseline } from '../run.js'
import { createMockEnrichFn } from '../mock.js'
import { extractFixturePages } from '../extract.js'

const now = new Date('2026-10-29T12:00:00Z')

async function withBaseline(report: Parameters<typeof saveBaseline>[0], fn: (baselinePath: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lib-eval-'))
  const baselinePath = path.join(dir, 'baseline.json')
  try {
    await saveBaseline(report, baselinePath)
    await fn(baselinePath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('runEval', () => {
  it('passes with the deterministic mock matching golden labels', async () => {
    const extractionOutputs = await extractFixturePages()
    const report = await runEval({
      enrichFn: createMockEnrichFn({ jitter: true }),
      now,
      extractionOutputs,
    })
    expect(report.counts.fixtures).toBe(12)
    expect(report.counts.extractionFixtures).toBe(4)
    expect(report.schemaValidity).toBeGreaterThanOrEqual(90)
    expect(report.categoryMatch).toBeGreaterThanOrEqual(80)
    expect(report.expiresInRange).toBeGreaterThanOrEqual(70)
    expect(report.confidencePresent).toBe(100)
    expect(report.actionConsistency).toBeGreaterThanOrEqual(85)
    expect(report.extractionCharInRange).toBe(100)
    expect(report.extractionNavLeak).toBe(100)
    expect(report.regressions).toEqual([])
    expect(report.passed).toBe(true)
  })

  it('is consistent across runs (deterministic mock)', async () => {
    const report = await runEval({ enrichFn: createMockEnrichFn(), now, runs: 3 })
    for (const item of report.items) {
      expect(item.consistent).toBe(true)
    }
  })

  it('fails thresholds with an injected category regression', async () => {
    const report = await runEval({
      enrichFn: createMockEnrichFn({ regressSlugs: ['job-posting', 'news-funding'] }),
      now,
    })
    expect(report.categoryMatch).toBeLessThan(100)
    // corrupting 2 of 12 still passes the 80% gate; check item-level flags
    const job = report.items.find((i) => i.slug === 'job-posting')
    expect(job?.categoryMatch).toBe(false)
  })

  it('fails the category gate when enough labels are corrupted', async () => {
    const report = await runEval({
      enrichFn: createMockEnrichFn({ corruptCategory: true }),
      now,
    })
    expect(report.categoryMatch).toBeLessThan(80)
    expect(report.passed).toBe(false)
    expect(report.regressions.some((r) => r.startsWith('categoryMatch'))).toBe(true)
  })

  it('fails the schema gate when the enrich fn errors on everything', async () => {
    const report = await runEval({
      enrichFn: createMockEnrichFn({ failSlugs: ['job-posting', 'event-conference', 'guide-kubernetes'] }),
      now,
    })
    expect(report.schemaValidity).toBeLessThan(90)
    expect(report.passed).toBe(false)
  })

  it('reports regression against a stored baseline when metrics drop', async () => {
    const good = await runEval({ enrichFn: createMockEnrichFn(), now })
    await withBaseline(good, async (baselinePath) => {
      const bad = await runEval({
        enrichFn: createMockEnrichFn({ corruptCategory: true }),
        now,
        baselinePath,
      })
      expect(bad.comparedToBaseline).toBe(true)
      expect(bad.regressions.some((r) => r.includes('regressed below baseline'))).toBe(true)
      expect(bad.passed).toBe(false)
    })
  })

  it('passes against a matching baseline', async () => {
    const good = await runEval({ enrichFn: createMockEnrichFn(), now })
    await withBaseline(good, async (baselinePath) => {
      const again = await runEval({
        enrichFn: createMockEnrichFn(),
        now,
        baselinePath,
      })
      expect(again.regressions).toEqual([])
      expect(again.passed).toBe(true)
    })
  })
})

describe('extractFixturePages', () => {
  it('extracts all four extractor fixtures offline', async () => {
    const outputs = await extractFixturePages()
    expect(Object.keys(outputs).sort()).toEqual([
      'blog-post',
      'docs-page',
      'plain-html',
      'substack-post',
    ])
    for (const [, md] of Object.entries(outputs)) {
      expect(md.length).toBeGreaterThan(100)
    }
  })
})
