/**
 * The eval command: runs the golden-set runner when one is present and says
 * so when it is not.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { capture, tempDb } from './helpers.js'
import { createContext } from '../src/context.js'
import { evalRunnerCandidates, runEval } from '../src/commands/metrics.js'
import { registerModules } from '../src/modules.js'

beforeAll(() => {
  registerModules({ evalLoader: (url) => import(url) })
})

describe('cli eval', () => {
  it('reports that evals are not available when no runner exists', async () => {
    const db = await tempDb()
    try {
      const ctx = await createContext({
        env: { ATENTO_DB: db.path },
        store: db.store,
        quiet: true,
        logPath: join(db.dir, 'log.jsonl'),
      })
      const out = await capture(() => runEval(ctx, join(db.dir, 'missing-runner.js')))
      expect(out.stdout).toContain('evals not available')
      expect(out.result.available).toBe(false)
      expect(out.result.exitCode).toBe(0)
    } finally {
      await db.cleanup()
    }
  })

  it('runs the runner when one is present and reports the result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atento-eval-'))
    const runnerPath = join(dir, 'runner.mjs')
    writeFileSync(
      runnerPath,
      `export async function runEval(opts) {
         return { passed: true, cases: 3, store: Boolean(opts?.store) }
       }
      `,
    )
    const db = await tempDb()
    try {
      const ctx = await createContext({
        env: { ATENTO_DB: db.path },
        store: db.store,
        quiet: true,
        logPath: join(db.dir, 'log.jsonl'),
      })
      const out = await capture(() => runEval(ctx, runnerPath))
      expect(out.result.available).toBe(true)
      expect(out.result.exitCode).toBe(0)
      const report = out.result.report as { passed: boolean; cases: number }
      expect(report.passed).toBe(true)
      expect(report.cases).toBe(3)
    } finally {
      await db.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits non zero when the runner reports a regression', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atento-eval-'))
    const runnerPath = join(dir, 'runner.mjs')
    writeFileSync(
      runnerPath,
      `export async function runEval() { return { passed: false, failed: 1 } }\n`,
    )
    const db = await tempDb()
    const previousExitCode = process.exitCode
    try {
      const ctx = await createContext({
        env: { ATENTO_DB: db.path },
        store: db.store,
        quiet: true,
        logPath: join(db.dir, 'log.jsonl'),
      })
      const out = await capture(() => runEval(ctx, runnerPath))
      expect(out.result.exitCode).toBe(1)
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = previousExitCode
      await db.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('looks for a runner in the repo evals directory', () => {
    const candidates = evalRunnerCandidates()
    expect(candidates.some((c) => c.endsWith('evals/runner.js'))).toBe(true)
    expect(evalRunnerCandidates('/tmp/custom.js')).toEqual(['/tmp/custom.js'])
  })
})
