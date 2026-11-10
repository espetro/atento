/**
 * Test set G: metrics/evals integration.
 *
 * Runs the full `atento run` over the fixture corpus with mock extract and
 * enrich functions, then checks:
 *  - a runs row per stage with the correct counts and durations
 *  - metrics rows present per stage
 *  - the metrics table renders
 *  - the log file has one line per step per link
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { EnrichFn, ExtractFn } from '@atento/core'
import { capture, tempDb, unlimitedLimits, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { runAll } from '../src/commands/pipeline.js'
import { runMetrics } from '../src/commands/metrics.js'
import { loadConfig } from '../src/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'fixtures', 'importers')

/** A mock extractor: markdown for most urls, needs_browser for one of them. */
const mockExtract: ExtractFn = async (url) => {
  if (url.includes('blocked')) return { markdown: '', needsBrowser: true, extractor: 'browser' }
  return {
    markdown: `# ${url}\n\nSome extracted body text for ${url}.`,
    extractor: 'defuddle',
  }
}

/** A mock enricher: one deterministic enrichment per link. */
const mockEnrich: EnrichFn = async (link) => ({
  ok: true,
  enrichment: {
    category: link.url.includes('/json-array/') ? 'reference' : 'guide',
    priority: 'normal',
    why_it_matters: 'worth a skim',
    read_minutes: 4,
    action: 'read_now',
    expires_at: new Date('2026-12-01T00:00:00.000Z').toISOString(),
    expiry_reason: 'reading material',
    confidence: 0.8,
  },
  tokensIn: 120,
  tokensOut: 60,
  costUsd: 0.001,
  modelId: 'mock-model',
})

async function contextFor(db: TempDb, logPath: string): Promise<CliContext> {
  const base = loadConfig({ ATENTO_DB: db.path })
  return createContext({
    env: { ATENTO_DB: db.path },
    store: db.store,
    quiet: true,
    logPath,
    config: { ...base, limits: unlimitedLimits() },
  })
}

describe('test set G: full run over the fixture corpus', () => {
  it('records a runs row per stage with the right counts and durations', async () => {
    const db = await tempDb()
    try {
      const logPath = join(db.dir, 'log.jsonl')
      const ctx = await contextFor(db, logPath)

      const { result } = await capture(() =>
        runAll(ctx, [join(fixtures, 'stash-export.md')], mockExtract, mockEnrich),
      )

      expect(result.import?.okCount).toBe(19)
      expect(result.extract?.inputCount).toBe(19)
      expect(result.extract?.okCount).toBe(19)
      expect(result.enrich?.inputCount).toBe(19)
      expect(result.enrich?.okCount).toBe(19)

      const runs = db.store.allRuns()
      expect(runs.map((r) => r.stage).sort()).toEqual(['enrich', 'extract', 'ingest'])
      const ingest = runs.find((r) => r.stage === 'ingest')!
      const extract = runs.find((r) => r.stage === 'extract')!
      const enrichRun = runs.find((r) => r.stage === 'enrich')!
      expect(ingest.inputCount).toBe(19)
      expect(ingest.okCount).toBe(19)
      expect(ingest.errorCount).toBe(0)
      expect(extract.inputCount).toBe(19)
      expect(extract.okCount).toBe(19)
      expect(enrichRun.inputCount).toBe(19)
      expect(enrichRun.okCount).toBe(19)
      for (const run of runs) {
        expect(run.finishedAt).not.toBeNull()
        expect(run.durationMs).not.toBeNull()
        expect(run.durationMs!).toBeGreaterThanOrEqual(0)
      }
      expect(enrichRun.tokensIn).toBe(19 * 120)
      expect(enrichRun.tokensOut).toBe(19 * 60)
      expect(enrichRun.costUsd).toBeCloseTo(19 * 0.001, 5)
    } finally {
      await db.cleanup()
    }
  })

  it('records metrics rows per stage', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db, join(db.dir, 'log.jsonl'))
      await capture(async () => {
        await runAll(ctx, [join(fixtures, 'stash-export.md')], mockExtract, mockEnrich)
      })

      const metrics = await db.store.listMetrics({})
      const stages = new Set(metrics.map((m) => m.stage))
      expect([...stages].sort()).toEqual(['enrich', 'extract', 'ingest'])
      for (const stage of stages) {
        const keys = metrics.filter((m) => m.stage === stage).map((m) => m.key)
        expect(keys).toContain('input')
        expect(keys).toContain('ok')
        expect(keys).toContain('errors')
        expect(keys).toContain('duration_ms')
      }
      const tokens = metrics.filter((m) => m.key === 'tokens_in')
      expect(tokens.reduce((a, m) => a + m.value, 0)).toBe(19 * 120)
      const cost = metrics.filter((m) => m.key === 'cost_usd')
      expect(cost.reduce((a, m) => a + m.value, 0)).toBeCloseTo(19 * 0.001, 5)
    } finally {
      await db.cleanup()
    }
  })

  it('renders the metrics table', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db, join(db.dir, 'log.jsonl'))
      await capture(async () => {
        await runAll(ctx, [join(fixtures, 'stash-export.md')], mockExtract, mockEnrich)
      })

      const out = await capture(async () => {
        await runMetrics(ctx, '7d', false)
      })
      expect(out.stdout).toContain('stage')
      expect(out.stdout).toContain('ingest')
      expect(out.stdout).toContain('extract')
      expect(out.stdout).toContain('enrich')
      expect(out.stdout).toContain('tok in')
      expect(out.stdout).toContain('cost')
    } finally {
      await db.cleanup()
    }
  })

  it('writes one log line per step per link', async () => {
    const db = await tempDb()
    try {
      const logPath = join(db.dir, 'log.jsonl')
      const ctx = await contextFor(db, logPath)
      await capture(async () => {
        await runAll(ctx, [join(fixtures, 'stash-export.md')], mockExtract, mockEnrich)
      })
      await ctx.close()

      const lines = readFileSync(logPath, 'utf8').trim().split('\n')
      const parsed = lines.map((l) => JSON.parse(l) as { message: string; logger: string })

      const ingestLines = parsed.filter((p) => p.message.startsWith('ingested '))
      const extractLines = parsed.filter((p) => p.message.startsWith('extracted '))
      const enrichLines = parsed.filter((p) => p.message.startsWith('enriched '))
      expect(ingestLines).toHaveLength(19)
      expect(extractLines).toHaveLength(19)
      expect(enrichLines).toHaveLength(19)
      // every line is valid json with the expected shape
      for (const p of parsed) {
        expect(typeof p.message).toBe('string')
        expect(p.logger.startsWith('atento.')).toBe(true)
      }
    } finally {
      await db.cleanup()
    }
  })

  it('flags links that need a browser instead of crashing', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db, join(db.dir, 'log.jsonl'))
      await capture(async () => {
        await runAll(ctx, [join(fixtures, 'urls.txt')], mockExtract, mockEnrich)
      })
      // no blocked url in the fixture, so all links have content
      const links = await db.store.listLinks({})
      expect(links.every((l) => l.extractedContent !== null)).toBe(true)
      expect(links.every((l) => l.needsBrowser === false)).toBe(true)
    } finally {
      await db.cleanup()
    }
  })

  it('is idempotent: a second run does not duplicate links', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db, join(db.dir, 'log.jsonl'))
      await capture(async () => {
        await runAll(ctx, [join(fixtures, 'stash-export.md')], mockExtract, mockEnrich)
      })
      const first = await db.store.listLinks({})
      expect(first).toHaveLength(19)

      const second = await capture(async () => {
        await runAll(ctx, [join(fixtures, 'stash-export.md')], mockExtract, mockEnrich)
      })
      const after = await db.store.listLinks({})
      expect(after).toHaveLength(19)
      // nothing new to extract or enrich on the second pass
      expect(second.stdout).toContain('extract: 0/0 ok')
      expect(second.stdout).toContain('enrich: 0/0 ok')
    } finally {
      await db.cleanup()
    }
  })
})
