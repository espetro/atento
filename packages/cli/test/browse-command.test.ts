/**
 * The browse command: the allowlist gate, the profile gate, the human
 * rendering, the hosts listing and the pacing. Everything runs against
 * fakes: the reader is injected, the guard sees a temp store, nothing
 * sleeps and nothing touches the network.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createProgram } from '@atento/cli'
import { guardDepsFromStore, DEFAULT_LIMITS, type AppConfig } from '@atento/core'
import type { BrowseReader } from '@atento/extractors'
import { capture, tempDb, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { browseDeps, renderBrowseResult } from '../src/commands/browse.js'
import { runBrowse, runBrowseHosts } from '../src/browse-fn.js'

const ALWAYS_OPEN_PACING = {
  dwellMedianS: 1,
  dwellMaxS: 1,
  breakEveryMin: 100,
  breakEveryMax: 100,
  breakMinS: 0,
  breakMaxS: 0,
  dailyCap: 40,
  hoursStart: 0,
  hoursEnd: 24,
}

function fakeClock(start = 1_000_000) {
  let now = start
  return {
    ms: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** A reader that records the urls it was asked for. */
function okReader(calls: string[] = []): BrowseReader {
  return async (url: string) => {
    calls.push(url)
    return { ok: true, markdown: `# page\n\ncontent of ${url}`, engine: 'fake' }
  }
}

/**
 * A CLI context over a temp store, with the browse deps wired to a fake
 * reader and a fake clock. The store is the real SQLite one, so the
 * profile rows and the host budget round-trip like in production.
 */
async function testCtx(share: string[], reader: BrowseReader): Promise<{
  ctx: CliContext
  db: TempDb
  deps: ReturnType<typeof browseDeps>
  clock: ReturnType<typeof fakeClock>
}> {
  const db = await tempDb()
  const ctx = await createContext({
    env: { ATENTO_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
  })
  ctx.config = {
    ...ctx.config,
    limits: { ...DEFAULT_LIMITS, hosts: { 'shared.example': { intervalMs: 0, dailyCap: 40, concurrency: 10 } } },
    pacing: ALWAYS_OPEN_PACING,
    share: { hosts: share },
    browser: { engine: 'agent-browser', stealthHosts: [] },
    profilesDir: join(db.dir, 'profiles'),
  } as AppConfig
  const clock = fakeClock()
  const deps = browseDeps(ctx, reader)
  deps.guard = guardDepsFromStore(db.store, {
    clock: () => clock.ms(),
    random: () => 0,
    sleep: async () => {},
    config: { limits: ctx.config.limits, pacing: ctx.config.pacing },
  })
  return { ctx, db, deps, clock }
}

describe('browse: the allowlist and the profile gate', () => {
  it('refuses a host that is not in the share list', async () => {
    const { deps, db } = await testCtx(['shared.example'], okReader())
    const result = await runBrowse('https://private.example/x', deps)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_shared')
    await db.cleanup()
  })

  it('refuses a shared host without a profile', async () => {
    const { deps, db } = await testCtx(['shared.example'], okReader())
    const result = await runBrowse('https://shared.example/a', deps)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no_profile')
    expect(result.detail).toContain('atento login')
    await db.cleanup()
  })

  it('reads a shared host with a profile', async () => {
    const calls: string[] = []
    const { db, deps } = await testCtx(['shared.example'], okReader(calls))
    await db.store.upsertProfile({ host: 'shared.example', path: '/tmp/p' })
    const result = await runBrowse('https://shared.example/a', deps)
    expect(result.ok).toBe(true)
    expect(result.markdown).toContain('content of https://shared.example/a')
    expect(result.host).toBe('shared.example')
    expect(calls).toEqual(['https://shared.example/a'])
    await db.cleanup()
  })

  it('writes nothing to the link store', async () => {
    const { db, deps } = await testCtx(['shared.example'], okReader())
    await db.store.upsertProfile({ host: 'shared.example', path: '/tmp/p' })
    await runBrowse('https://shared.example/a', deps)
    const links = await db.store.listLinks({ limit: 100 })
    expect(links).toHaveLength(0)
    await db.cleanup()
  })
})

describe('browse: the pacing budget is shared with the pipeline', () => {
  it('defers the read that would exceed the daily cap', async () => {
    const { db, deps, clock } = await testCtx(['shared.example'], okReader())
    await db.store.upsertProfile({ host: 'shared.example', path: '/tmp/p' })
    deps.guard = guardDepsFromStore(db.store, {
      clock: () => clock.ms(),
      random: () => 0,
      sleep: async () => {},
      config: {
        limits: DEFAULT_LIMITS,
        pacing: { ...ALWAYS_OPEN_PACING, dailyCap: 1 },
      },
    })
    const first = await runBrowse('https://shared.example/a', deps)
    expect(first.ok).toBe(true)
    clock.advance(10_000)
    const second = await runBrowse('https://shared.example/b', deps)
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('deferred')
    expect(second.detail).toBe('daily_cap')
    await db.cleanup()
  })
})

describe('browse: the human rendering', () => {
  it('prints the markdown on success', async () => {
    const { db, deps } = await testCtx(['shared.example'], okReader())
    await db.store.upsertProfile({ host: 'shared.example', path: '/tmp/p' })
    const result = await runBrowse('https://shared.example/a', deps)
    const out = await capture(async () => renderBrowseResult(result))
    expect(out.result).toContain('content of https://shared.example/a')
    await db.cleanup()
  })

  it('prints the reason on failure', async () => {
    const { db, deps } = await testCtx(['shared.example'], okReader())
    const result = await runBrowse('https://other.example/a', deps)
    const out = await capture(async () => renderBrowseResult(result))
    expect(out.result).toContain('browse failed: not_shared')
    await db.cleanup()
  })
})

describe('browse hosts', () => {
  it('marks each saved profile with its share verdict', async () => {
    const { db, ctx } = await testCtx(['shared.example'], okReader())
    await db.store.upsertProfile({ host: 'shared.example', path: '/tmp/p' })
    await db.store.upsertProfile({ host: 'private.example', path: '/tmp/q' })
    const rows = await runBrowseHosts(await db.store.listProfiles(), {
      share: ctx.config.share,
    })
    const byHost = new Map(rows.map((r) => [r.host, r]))
    expect(byHost.get('shared.example')?.shared).toBe(true)
    expect(byHost.get('shared.example')?.ready).toBe(true)
    expect(byHost.get('private.example')?.shared).toBe(false)
    expect(byHost.get('private.example')?.reason).toBe('not_shared')
    await db.cleanup()
  })
})

describe('the browse program wiring', () => {
  it('registers the browse command on the program', () => {
    const program = createProgram({ env: {}, quiet: true })
    expect(program.commands.map((c) => c.name())).toContain('browse')
  })
})
