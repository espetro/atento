/**
 * Per-extractor and per-importer error counts flow into the metrics table
 * with tags and are surfaced by the metrics summary and CLI table.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtractFn } from '@atento/core'
import { capture, tempDb, unlimitedLimits, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { runExtract, runImport } from '../src/commands/pipeline.js'
import { runMetrics } from '../src/commands/metrics.js'
import { loadConfig } from '../src/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'fixtures', 'importers')

async function contextFor(db: TempDb): Promise<CliContext> {
  const base = loadConfig({ ATENTO_DB: db.path })
  return createContext({
    env: { ATENTO_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
    config: { ...base, limits: unlimitedLimits() },
  })
}

describe('metrics: per-extractor and per-importer error attribution', () => {
  it('records extraction errors tagged by extractor', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      await capture(() => runImport(ctx, [join(fixtures, 'urls.txt')]))

      const extractFn: ExtractFn = async (url) => {
        if (url.endsWith('/1')) {
          return Promise.reject(new Error('fetch timeout'))
        }
        if (url.endsWith('/2')) {
          return { markdown: '', needsBrowser: true, extractor: 'browser' }
        }
        return { markdown: `content for ${url}`, extractor: 'defuddle' }
      }

      await capture(() => runExtract(ctx, extractFn))

      const metrics = await ctx.store.listMetrics({ stage: 'extract' })
      const tagged = metrics.find((m) => m.key === 'errors' && m.tags)
      expect(tagged?.tags).toEqual({ extractor: 'unknown' })
      expect(tagged?.value).toBe(1)

      // needs_browser is counted separately, per extractor
      const needsBrowser = metrics.find((m) => m.key === 'needs_browser' && !m.tags)
      expect(needsBrowser?.value).toBe(1)
      const browserTagged = metrics.find((m) => m.key === 'needs_browser' && m.tags)
      expect(browserTagged?.tags).toEqual({ extractor: 'browser' })

      // the summary groups them under errorsByTag
      const out = await capture(() => runMetrics(ctx, '7d', true))
      const summary = JSON.parse(out.stdout) as {
        stages: {
          stage: string
          errorsByTag: Record<string, number>
          countsByTag: Record<string, number>
          errors: number
        }[]
      }
      const extractSummary = summary.stages.find((s) => s.stage === 'extract')!
      expect(extractSummary.errorsByTag).toEqual({ 'extractor:unknown': 1 })
      // the untagged errors metric is the stage total (the tagged row is the
      // per-source breakdown, not an extra error)
      expect(extractSummary.errors).toBe(1)
      expect(extractSummary.countsByTag['needs_browser extractor:browser']).toBe(1)
    } finally {
      await db.cleanup()
    }
  })

  it('shows tagged errors in the human readable table', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      await capture(() => runImport(ctx, [join(fixtures, 'urls.txt')]))

      const extractFn: ExtractFn = async () => {
        throw new Error('dns failure')
      }
      await capture(() => runExtract(ctx, extractFn))

      const out = await capture(() => runMetrics(ctx, '7d', false))
      expect(out.stdout).toContain('extract errors by source')
      expect(out.stdout).toContain('extractor:unknown=3')
    } finally {
      await db.cleanup()
    }
  })

  it('importer failures come back as warnings, not crashes', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      // importing a missing file yields zero links plus a warning
      const out = await capture(() => runImport(ctx, [join(db.dir, 'no-such-file.md')]))
      expect(out.stdout).toContain('no-such-file.md: 0 links')
      expect((await ctx.store.listLinks({}))).toHaveLength(0)

      // the healthy import still works afterwards
      const healthy = await capture(() => runImport(ctx, [join(fixtures, 'urls.txt')]))
      expect(healthy.stdout).toContain('ingest: 3/3 ok')
    } finally {
      await db.cleanup()
    }
  })
})
