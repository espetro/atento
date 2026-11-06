/**
 * Tests for the login walk (`linkinbox login --all`, and the interactive
 * bare `login` walk) and the parked requeue backfill
 * (`linkinbox requeue --parked [--host <h>]`).
 *
 * Everything is offline: an injected launcher plays the browser login and an
 * injected prompt answers the walk prompts. No network, no real browser.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { capture, insertLink, tempDb, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import {
  runLoginWalk,
  runParkedRequeue,
  type WalkPrompt,
} from '../src/commands/login.js'

async function contextFor(db: TempDb): Promise<CliContext> {
  return createContext({
    env: { LINKINBOX_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
  })
}

/** Park a link in needs_browser with a login-wall reason. */
async function parkNeedsBrowser(db: TempDb, url: string): Promise<number> {
  const link = await insertLink(db.store, url)
  await db.store.applyEvent(link.id, {
    type: 'EXTRACT_STARTED',
    at: new Date().toISOString(),
  })
  const parked = await db.store.applyEvent(link.id, {
    type: 'NEEDS_BROWSER',
    host: new URL(url).host,
    at: new Date().toISOString(),
  })
  expect(parked.ok).toBe(true)
  return link.id
}

/** Park a link in deferred with an extract-stage backoff still pending. */
async function parkDeferred(db: TempDb, url: string, nextAttemptAt: Date): Promise<number> {
  const link = await insertLink(db.store, url)
  await db.store.applyEvent(link.id, { type: 'EXTRACT_STARTED', at: new Date().toISOString() })
  const d = await db.store.applyEvent(link.id, {
    type: 'DEFER',
    stage: 'extract',
    nextAttemptAt: nextAttemptAt.toISOString(),
    attempts: 1,
    reason: 'rate_limited',
    at: new Date().toISOString(),
  })
  expect(d.ok).toBe(true)
  return link.id
}

/** An ok launcher: pretends the login succeeded, records the host. */
function okLauncher(logged: string[]): any {
  return async (host: string) => {
    logged.push(host)
    return 0
  }
}

/** Prompt answers consumed in order; `default` when exhausted. */
function scriptedPrompt(answers: string[]): WalkPrompt {
  let i = 0
  return async () => answers[i++] ?? ''
}

describe('login walk', () => {
  it('walks pending hosts most parked links first, printing n of m with counts', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      await parkNeedsBrowser(db, 'https://x.com/b')
      await parkNeedsBrowser(db, 'https://instagram.com/c')
      const ctx = await contextFor(db)
      const logged: string[] = []
      const { stdout: out } = await capture(async () => {
        await runLoginWalk(ctx, {
          launch: okLauncher(logged),
          prompt: scriptedPrompt(['', '']),
        })
      })
      // most parked links first
      expect(logged).toEqual(['x.com', 'instagram.com'])
      expect(out).toContain('1 of 2: x.com (2 links)')
      expect(out).toContain('2 of 2: instagram.com (1 link)')
      expect(out).toMatch(/logged in to 2 hosts?, requeued 3 links?/)
      // links were requeued back to created
      const states = await db.store.listByStates(['created'])
      expect(states.length).toBe(3)
    } finally {
      await db.cleanup()
    }
  })

  it('requeues each host\'s links right after its login', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      const ctx = await contextFor(db)
      const logged: string[] = []
      await capture(async () => {
        await runLoginWalk(ctx, { launch: okLauncher(logged), prompt: scriptedPrompt(['']) })
      })
      const created = await db.store.listByStates(['created'])
      expect(created.map((l) => l.url)).toEqual(['https://x.com/a'])
    } finally {
      await db.cleanup()
    }
  })

  it('"s" skips a host for the rest of the run (remembered, not asked again)', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      await parkNeedsBrowser(db, 'https://instagram.com/c')
      const ctx = await contextFor(db)
      const logged: string[] = []
      const { stdout: out } = await capture(async () => {
        await runLoginWalk(ctx, { launch: okLauncher(logged), prompt: scriptedPrompt(['s']) })
      })
      expect(logged).toEqual(['x.com'])
      expect(out).toContain('1 of 2: instagram.com (1 link)')
      expect(out).toContain('2 of 2: x.com (1 link)')
      expect(out).toContain('skipped instagram.com for this run')
      expect(out).toMatch(/skipped 1 host/)
      const needs = await db.store.listByStates(['needs_browser'])
      expect(needs.length).toBe(1)
    } finally {
      await db.cleanup()
    }
  })

  it('"q" stops the walk immediately', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      await parkNeedsBrowser(db, 'https://instagram.com/c')
      const ctx = await contextFor(db)
      const logged: string[] = []
      const { stdout: out } = await capture(async () => {
        await runLoginWalk(ctx, { launch: okLauncher(logged), prompt: scriptedPrompt(['q']) })
      })
      expect(logged).toEqual([])
      expect(out).toMatch(/stopped after 0 of 2 hosts/)
      const needs = await db.store.listByStates(['needs_browser'])
      expect(needs.length).toBe(2)
    } finally {
      await db.cleanup()
    }
  })

  it('empty pending list prints a friendly nothing-to-do', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      const { stdout: out } = await capture(async () => {
        await runLoginWalk(ctx, { launch: okLauncher([]), prompt: scriptedPrompt([]) })
      })
      expect(out).toMatch(/no pending logins/)
    } finally {
      await db.cleanup()
    }
  })

  it('failed launcher (code -1) skips the host without requeueing', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      const ctx = await contextFor(db)
      const { stdout: out } = await capture(async () => {
        await runLoginWalk(ctx, {
          launch: async () => -1,
          prompt: scriptedPrompt(['']),
        })
      })
      const needs = await db.store.listByStates(['needs_browser'])
      expect(needs.length).toBe(1)
      expect(out).toMatch(/failed for x\.com/)
    } finally {
      await db.cleanup()
    }
  })
})

describe('parked requeue backfill', () => {
  it('moves needs_browser links back to created via RETRY, per-host counts', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      await parkNeedsBrowser(db, 'https://x.com/b')
      await parkNeedsBrowser(db, 'https://instagram.com/c')
      const ctx = await contextFor(db)
      const { stdout: out } = await capture(async () => {
        const result = await runParkedRequeue(ctx)
        expect(result).toEqual({ requeued: 3, counts: { 'x.com': 2, 'instagram.com': 1 } })
      })
      expect(out).toContain('x.com: 2')
      expect(out).toContain('instagram.com: 1')
      const states = await db.store.listByStates(['created'])
      expect(states.length).toBe(3)
    } finally {
      await db.cleanup()
    }
  })

  it('also requeues deferred links whose backoff is pending', async () => {
    const db = await tempDb()
    try {
      await parkDeferred(db, 'https://x.com/d', new Date(Date.now() + 3_600_000))
      const ctx = await contextFor(db)
      const result = await runParkedRequeue(ctx)
      expect(result.requeued).toBe(1)
      const created = await db.store.listByStates(['created'])
      expect(created.length).toBe(1)
    } finally {
      await db.cleanup()
    }
  })

  it('skips review-only hosts and skip-listed hosts', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://revolut.com/a')
      await parkNeedsBrowser(db, 'https://gemini.google.com/b')
      await parkNeedsBrowser(db, 'https://keepme.com/c')
      const ctx = await contextFor(db)
      ctx.config.limits = {
        ...ctx.config.limits,
        reviewHosts: ['revolut.com'],
        skipHosts: ['gemini.google.com'],
      }
      const result = await runParkedRequeue(ctx)
      expect(result.requeued).toBe(1)
      expect(result.counts).toEqual({ 'keepme.com': 1 })
      const needs = await db.store.listByStates(['needs_browser'])
      expect(needs.length).toBe(2)
    } finally {
      await db.cleanup()
    }
  })

  it('--host filters to one host', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      await parkNeedsBrowser(db, 'https://instagram.com/c')
      const ctx = await contextFor(db)
      const result = await runParkedRequeue(ctx, { host: 'x.com' })
      expect(result.requeued).toBe(1)
      expect(result.counts).toEqual({ 'x.com': 1 })
      const needs = await db.store.listByStates(['needs_browser'])
      expect(needs.map((l) => new URL(l.url).host)).toEqual(['instagram.com'])
    } finally {
      await db.cleanup()
    }
  })
})
