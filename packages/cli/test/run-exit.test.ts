/**
 * M2 `run` exit codes: 0 all done, 2 finished-but-needs-you, 3 busy.
 * (1 is the thrown-failure path in bin.ts.) Exercised through runAll with
 * mock extract/enrich and an injected stage lock for the busy case.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnrichFn, ExtractFn } from '@linkinbox/core'
import { capture, tempDb, unlimitedLimits, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { runAll } from '../src/commands/pipeline.js'
import { loadConfig } from '../src/config.js'

const okExtract: ExtractFn = async (url) => ({
  markdown: `# ${url}\nbody`,
  extractor: 'fake',
})

const okEnrich: EnrichFn = async () => ({
  ok: true,
  enrichment: {
    category: 'article',
    priority: 'normal',
    why_it_matters: 'test',
    read_minutes: 1,
    action: 'read_now',
    expires_at: null,
    expiry_reason: null,
    confidence: 0.9,
  },
  tokensIn: 1,
  tokensOut: 1,
  modelId: 'mock',
})

const dbs: TempDb[] = []

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

async function fresh(): Promise<{ db: TempDb; ctx: CliContext; file: string }> {
  const db = await tempDb()
  dbs.push(db)
  const file = join(db.dir, 'links.txt')
  writeFileSync(file, 'https://a.example.com/1\nhttps://b.example.com/2\n')
  return { db, ctx: await contextFor(db), file }
}

afterEach(async () => {
  process.exitCode = undefined
  while (dbs.length > 0) await dbs.pop()!.cleanup()
})

describe('run exit codes', () => {
  it('0 when the pass finishes clean', async () => {
    const { ctx, file } = await fresh()
    const out = await capture(() => runAll(ctx, [file], okExtract, okEnrich))
    expect(out.result.extract?.okCount).toBe(2)
    expect(process.exitCode).toBeUndefined()
  })

  it('2 when links finish parked (needs_browser / blocked)', async () => {
    const { ctx, file } = await fresh()
    const parkExtract: ExtractFn = async () => ({
      markdown: '',
      needsBrowser: true,
      blockReason: 'login_wall',
    })
    const out = await capture(() => runAll(ctx, [file], parkExtract, okEnrich))
    expect(out.stdout).toContain('needs action')
    expect(process.exitCode).toBe(2)
  })

  it('3 when another run holds the extract lock', async () => {
    const { db, ctx, file } = await fresh()
    // A live pid keeps crash-reclaim from stealing the lock.
    await db.store.acquireRun('extract', { pid: process.pid })
    const out = await capture(() => runAll(ctx, [file], okExtract, okEnrich))
    expect(out.stdout).toContain('busy')
    expect(process.exitCode).toBe(3)
  })
})
