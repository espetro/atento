/**
 * `runExtract` with `--until-empty`: repeats batches until the created queue
 * is empty, prints one summary line per batch plus a final per-state summary.
 * Offline: a temp SQLite store and a fake extract fn, no network.
 */
import { describe, expect, it } from 'vitest'
import type { ExtractFn, RawLink } from '@linkinbox/core'
import { ingest } from '@linkinbox/core'
import { capture, tempDb, unlimitedLimits, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { runExtract } from '../src/commands/pipeline.js'
import { loadConfig } from '../src/config.js'

async function contextFor(db: TempDb): Promise<CliContext> {
  const base = loadConfig({ LINKINBOX_DB: db.path })
  return createContext({
    env: { LINKINBOX_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
    config: { ...base, limits: unlimitedLimits() },
  })
}

import { join } from 'node:path'

const raw = (url: string, extra: Partial<RawLink> = {}): RawLink => ({
  url,
  source: 'test',
  ...extra,
})

describe('extract --until-empty', () => {
  it('drains the queue across batches and prints batch plus final summaries', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      await ingest(db.store, [
        ...Array.from({ length: 8 }, (_, i) => raw(`https://one.example.com/${i}`)),
        ...Array.from({ length: 8 }, (_, i) => raw(`https://two.example.com/${i}`)),
      ])
      const extractFn: ExtractFn = async (url) => ({
        markdown: `content for ${url}`,
        needsBrowser: false,
        extractor: 'fake',
      })

      const out = await capture(() => runExtract(ctx, extractFn, undefined, undefined, undefined, true))

      expect(out.lines.some((l) => l.startsWith('batch 1:'))).toBe(true)
      expect(out.lines.some((l) => l.includes('extracted: 16'))).toBe(true)
      expect((await db.store.countByState())['extracted']).toBe(16)
      expect((await db.store.countByState())['created']).toBe(0)
    } finally {
      await db.cleanup()
    }
  })

  it('single-batch mode still works (no --until-empty)', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      await ingest(db.store, [raw('https://solo.example.com/1')])
      const extractFn: ExtractFn = async () => ({
        markdown: 'content',
        needsBrowser: false,
        extractor: 'fake',
      })
      const out = await capture(() => runExtract(ctx, extractFn))
      expect(out.lines.some((l) => l.startsWith('batch '))).toBe(false)
      expect(out.lines.some((l) => l.includes('1/1 ok'))).toBe(true)
    } finally {
      await db.cleanup()
    }
  })
})
