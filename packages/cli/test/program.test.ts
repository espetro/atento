/**
 * Program level tests: the commander program wires commands to the ops and
 * pipeline functions. These run the real command surface against a temp
 * database.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type { EnrichFn, ExtractFn } from '@linkinbox/core'
import { capture, tempDb, type TempDb } from './helpers.js'
import { createProgram } from '../src/program.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', '..', 'fixtures', 'importers')

const mockExtract: ExtractFn = async (url) => ({
  markdown: `# ${url}\n\nbody text`,
  extractor: 'defuddle',
})

const mockEnrich: EnrichFn = async () => ({
  ok: true,
  enrichment: {
    category: 'guide',
    priority: 'normal',
    why_it_matters: 'worth reading',
    read_minutes: 2,
    action: 'read_now',
    expires_at: null,
    expiry_reason: null,
    confidence: 0.9,
  },
  tokensIn: 10,
  tokensOut: 5,
  modelId: 'mock-model',
})

async function runProgram(
  db: TempDb,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const program = createProgram({
    env: { LINKINBOX_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
    extractFn: mockExtract,
    enrichFn: mockEnrich,
  })
  program.exitOverride((err) => {
    throw err
  })
  return capture(async () => {
    await program.parseAsync(['node', 'linkinbox', ...args])
  })
}

describe('program: run then list then triage', () => {
  it('runs the pipeline and lists the results', async () => {
    const db = await tempDb()
    try {
      const run = await runProgram(db, ['run', join(fixtures, 'urls.txt')])
      expect(run.stdout).toContain('ingest: 3/3 ok')
      expect(run.stdout).toContain('extract: 3/3 ok')
      expect(run.stdout).toContain('enrich: 3/3 ok')

      const list = await runProgram(db, ['list'])
      expect(list.stdout).toContain('https://example.com/list/1')

      const json = await runProgram(db, ['list', '--json'])
      const parsed = JSON.parse(json.stdout) as Record<string, unknown>[]
      expect(parsed).toHaveLength(3)
      expect(parsed[0]).toHaveProperty('category', 'guide')
    } finally {
      await db.cleanup()
    }
  })

  it('triages a link through the command surface', async () => {
    const db = await tempDb()
    try {
      await runProgram(db, ['run', join(fixtures, 'urls.txt')])
      const out = await runProgram(db, ['triage', '1', '--action', 'archive'])
      expect(out.stdout).toContain('1 link -> archived')

      const list = await runProgram(db, ['list', '--status', 'archived'])
      expect(list.stdout).toContain('https://example.com/list/1')
      expect(list.stdout).toContain('1 link')
    } finally {
      await db.cleanup()
    }
  })

  it('shows one link in full', async () => {
    const db = await tempDb()
    try {
      await runProgram(db, ['run', join(fixtures, 'urls.txt')])
      const out = await runProgram(db, ['show', '1'])
      expect(out.stdout).toContain('url: https://example.com/list/1')
      expect(out.stdout).toContain('--- extracted content ---')
    } finally {
      await db.cleanup()
    }
  })

  it('prints the metrics table after a run', async () => {
    const db = await tempDb()
    try {
      await runProgram(db, ['run', join(fixtures, 'urls.txt')])
      const out = await runProgram(db, ['metrics', '--last', '7d'])
      expect(out.stdout).toContain('ingest')
      expect(out.stdout).toContain('extract')
      expect(out.stdout).toContain('enrich')
    } finally {
      await db.cleanup()
    }
  })

  it('reports that evals are not available when no runner exists', async () => {
    const db = await tempDb()
    try {
      const out = await runProgram(db, ['eval'])
      expect(out.stdout).toContain('evals not available')
    } finally {
      await db.cleanup()
    }
  })

  it('reports that the server is not available when the package is missing', async () => {
    const db = await tempDb()
    try {
      const out = await runProgram(db, ['serve'])
      expect(out.stdout).toContain('server not available')
    } finally {
      await db.cleanup()
    }
  })

  it('lists login profiles through the command surface', async () => {
    const db = await tempDb()
    try {
      const out = await runProgram(db, ['login', 'list'])
      expect(out.stdout).toContain('no saved profiles')
    } finally {
      await db.cleanup()
    }
  })
})
