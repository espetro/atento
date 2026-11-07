/**
 * M2 `app.run`: one full pass — ingest sources/files, extract until empty,
 * enrich until empty, sweep — returning cursors and a per-stage summary.
 * Busy locks surface in the summary, never as thrown errors.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLinkinboxOps,
  loadConfig,
  type AppConfig,
  type EnrichFn,
  type ExtractFn,
} from '../src/index.js'
import { openStore, type SqliteStore } from '@linkinbox/db'

const dirs: string[] = []
const stores: SqliteStore[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkinbox-run-'))
  dirs.push(dir)
  return dir
}

async function opsFor(dir: string, sources: string[] = []) {
  const store = await openStore({ path: join(dir, 'links.db') })
  stores.push(store)
  const config = loadConfig({ LINKINBOX_HOME: dir } as NodeJS.ProcessEnv) as AppConfig
  const ops = createLinkinboxOps({ ...config, sources }, {
    store,
    env: {},
    spoolDir: join(dir, 'spool'),
  })
  return { store, ops }
}

const okExtract: ExtractFn = async (url) => ({
  markdown: `# ${url}\nbody`,
  extractor: 'fake',
})

const okEnrich: EnrichFn = async (link) => ({
  ok: true,
  enrichment: {
    category: 'article',
    priority: 'normal',
    why_it_matters: 'test',
    read_minutes: 2,
    action: 'read_now',
    expires_at: null,
    expiry_reason: null,
    confidence: 0.9,
  },
  tokensIn: 5,
  tokensOut: 5,
  modelId: 'mock',
})

afterEach(async () => {
  while (stores.length > 0) await stores.pop()!.close()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('app.run', () => {
  it('runs a full pass over a file argument and returns cursors + summary', async () => {
    const dir = tempDir()
    const file = join(dir, 'links.txt')
    writeFileSync(file, 'https://a.example.com/1\nhttps://b.example.com/2\n')
    const { ops } = await opsFor(dir)

    const result = await ops.run({
      files: [file],
      extract: okExtract,
      enrich: okEnrich,
      sleep: async () => {},
    })

    expect(result.runId).toMatch(/^run-/)
    expect(result.cursorBefore).toBe(0)
    expect(result.cursorAfter).toBeGreaterThan(0)
    expect(result.summary.ingest.jobs).toHaveLength(1)
    expect(result.summary.ingest.jobs[0]!.accepted).toBe(2)
    expect(result.summary.extract.ok).toBe(2)
    expect(result.summary.enrich.ok).toBe(2)
    expect(result.summary.needsAction).toBe(false)
    expect(result.summary.collections.collections.enriched).toBe(2)
  })

  it('ingests configured [sources] without file arguments', async () => {
    const dir = tempDir()
    const file = join(dir, 'links.txt')
    writeFileSync(file, 'https://src.example.com/1\n')
    const { ops } = await opsFor(dir, [file])

    const result = await ops.run({
      extract: okExtract,
      enrich: okEnrich,
      sleep: async () => {},
    })
    expect(result.summary.ingest.jobs).toHaveLength(1)
    expect(result.summary.ingest.jobs[0]!.accepted).toBe(1)
  })

  it('flags needsAction when links park for login', async () => {
    const dir = tempDir()
    const file = join(dir, 'links.txt')
    writeFileSync(file, 'https://login.example.com/x\n')
    const { ops } = await opsFor(dir)
    const loginExtract: ExtractFn = async () => ({
      markdown: '',
      needsBrowser: true,
      blockReason: 'login_wall',
    })

    const result = await ops.run({
      files: [file],
      extract: loginExtract,
      enrich: okEnrich,
      sleep: async () => {},
    })
    expect(result.summary.needsAction).toBe(true)
    expect(result.summary.collections.collections.needs_login).toBe(1)
    expect(result.summary.collections.needsLoginHosts[0]!.host).toBe('login.example.com')
  })

  it('reports busy instead of throwing when the extract lock is held', async () => {
    const dir = tempDir()
    const file = join(dir, 'links.txt')
    writeFileSync(file, 'https://a.example.com/1\n')
    const { store, ops } = await opsFor(dir)
    // Hold the extract single-writer lock with a live pid.
    await store.acquireRun('extract', { pid: process.pid })

    const result = await ops.run({
      files: [file],
      extract: okExtract,
      enrich: okEnrich,
      sleep: async () => {},
    })
    expect(result.summary.extract.busy).toBeDefined()
    // Enrich still ran (its own lock was free) but had nothing to do.
    expect(result.summary.enrich.busy).toBeUndefined()
  })
})
