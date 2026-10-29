/**
 * Resilience command tests: status and breaker reset.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { capture, tempDb, unlimitedLimits, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { createProgram } from '../src/program.js'
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

/** Run the real commander program against a temp store. */
async function runProgram(
  db: TempDb,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const base = loadConfig({ LINKINBOX_DB: db.path })
  const program = createProgram({
    env: { LINKINBOX_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
    config: { ...base, limits: unlimitedLimits() },
  })
  program.exitOverride((err) => {
    throw err
  })
  return capture(async () => {
    await program.parseAsync(['node', 'linkinbox', ...args])
  })
}

describe('resilience commands', () => {
  it('status lists per-host budget, breaker state and reopen time', async () => {
    const db = await tempDb()
    try {
      await db.store.saveHostState({
        key: 'x.com',
        lastRequestAt: Date.now() - 30_000,
        windowStart: Date.now() - 60_000,
        windowCount: 12,
        consecutiveFailures: 0,
        breakerState: 'open',
        openedUntil: Date.now() + 6 * 60 * 60 * 1000,
        cooldownLevel: 1,
        lastError: 'http_429',
      })
      const out = await runProgram(db, ['status'])
      expect(out.stdout).toContain('x.com')
      expect(out.stdout).toContain('breaker=open')
      expect(out.stdout).toContain('reopens')
      expect(out.stdout).toContain('28/40 left')
      expect(out.stdout).toContain('last=http_429')
      expect(out.stdout).toContain('llm: breaker=closed')
    } finally {
      await db.cleanup()
    }
  })

  it('status --json emits the machine-readable rows', async () => {
    const db = await tempDb()
    try {
      const out = await runProgram(db, ['status', '--json'])
      const rows = JSON.parse(out.stdout) as Array<{ key: string; breakerState: string }>
      expect(rows.some((r) => r.key === 'llm')).toBe(true)
    } finally {
      await db.cleanup()
    }
  })

  it('breaker reset force-closes the breaker for a host', async () => {
    const db = await tempDb()
    try {
      await db.store.saveHostState({
        key: 'x.com',
        lastRequestAt: Date.now(),
        windowStart: Date.now(),
        windowCount: 5,
        consecutiveFailures: 3,
        breakerState: 'open',
        openedUntil: Date.now() + 60_000,
        cooldownLevel: 2,
        lastError: 'http_429',
      })
      const out = await runProgram(db, ['breaker', 'reset', 'x.com'])
      expect(out.stdout).toContain('closed')
      const state = await db.store.getHostState('x.com')
      expect(state?.breakerState).toBe('closed')
      expect(state?.cooldownLevel).toBe(0)
      expect(state?.consecutiveFailures).toBe(0)
    } finally {
      await db.cleanup()
    }
  })
})
