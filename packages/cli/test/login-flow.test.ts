/**
 * Login flow tests: the pending listing, the interactive picker with an
 * injected prompt and an injected browser launcher, and the non-interactive
 * JSON output. No real browser, no network: every external effect is a fake.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { capture, insertLink, tempDb, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import {
  profileDirFor,
  requeueHostLinks,
  renderLoginReport,
  runLoginFlow,
  runLoginPending,
  type LoginLauncher,
  type LoginPicker,
} from '../src/commands/login.js'
import { queryPendingLogins, profileAgeDays } from '../src/pending-logins.js'

async function contextFor(db: TempDb): Promise<CliContext> {
  return createContext({
    env: { LINKINBOX_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
  })
}

/** Park a link in needs_browser the way the extract stage does. */
async function parkNeedsBrowser(
  db: TempDb,
  url: string,
): Promise<number> {
  const link = await insertLink(db.store, url)
  const outcome = await db.store.applyEvent(link.id, {
    type: 'EXTRACT_STARTED',
    at: new Date().toISOString(),
  })
  expect(outcome.ok).toBe(true)
  const parked = await db.store.applyEvent(link.id, {
    type: 'NEEDS_BROWSER',
    host: new URL(url).host,
    at: new Date().toISOString(),
  })
  expect(parked.ok).toBe(true)
  return link.id
}

describe('pending logins query', () => {
  it('groups needs_browser links by host with counts', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      await parkNeedsBrowser(db, 'https://x.com/b')
      await parkNeedsBrowser(db, 'https://instagram.com/c')
      const logins = await queryPendingLogins(db.store)
      expect(logins.pending.map((p) => p.host)).toEqual(['x.com', 'instagram.com'])
      expect(logins.pending[0]!.linkCount).toBe(2)
      expect(logins.pending[0]!.reason).toBe('login_wall')
      expect(logins.done).toEqual([])
    } finally {
      await db.cleanup()
    }
  })

  it('orders pending hosts by waiting links, most first', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://low.com/one')
      await parkNeedsBrowser(db, 'https://high.com/a')
      await parkNeedsBrowser(db, 'https://high.com/b')
      await parkNeedsBrowser(db, 'https://high.com/c')
      const logins = await queryPendingLogins(db.store)
      expect(logins.pending.map((p) => p.host)).toEqual(['high.com', 'low.com'])
    } finally {
      await db.cleanup()
    }
  })

  it('lists hosts with a saved profile as done with the profile age', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      await db.store.upsertProfile({
        host: 'x.com',
        path: '/tmp/profiles/x.com',
        updatedAt: new Date(Date.now() - 3 * 86_400_000),
      })
      const logins = await queryPendingLogins(db.store)
      expect(logins.pending).toEqual([])
      expect(logins.done).toEqual([{ host: 'x.com', profileAgeDays: 3 }])
    } finally {
      await db.cleanup()
    }
  })

  it('computes the profile age in whole days, never negative', () => {
    const now = new Date('2026-10-29T12:00:00.000Z')
    expect(profileAgeDays(new Date('2026-10-29T11:00:00.000Z'), now)).toBe(0)
    expect(profileAgeDays(new Date('2026-10-27T11:00:00.000Z'), now)).toBe(2)
    expect(profileAgeDays(new Date('2026-11-05T00:00:00.000Z'), now)).toBe(0)
  })
})

describe('login listing', () => {
  it('returns the pending/done report shape', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      const ctx = await contextFor(db)
      const report = await runLoginPending(ctx)
      expect(report.pending).toEqual([{ host: 'x.com', links: 1, reason: 'login_wall' }])
      expect(report.done).toEqual([])
    } finally {
      await db.cleanup()
    }
  })

  it('renders pending first and done separately', () => {
    const text = renderLoginReport({
      pending: [{ host: 'x.com', links: 4, reason: 'login_wall' }],
      done: [{ host: 'news.ycombinator.com', profileAgeDays: 12 }],
    })
    expect(text.indexOf('x.com')).toBeLessThan(text.indexOf('news.ycombinator.com'))
    expect(text).toContain('login_wall')
    expect(text).toContain('4')
    expect(text).toContain('12')
  })
})

describe('non-interactive login flow', () => {
  it('prints JSON and never opens a browser', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      const ctx = await contextFor(db)
      let launched = 0
      const launch: LoginLauncher = async () => {
        launched += 1
        return 0
      }
      const out = await capture(() =>
        runLoginFlow(ctx, { launch, nonInteractive: true }),
      )
      expect(launched).toBe(0)
      const report = JSON.parse(out.stdout) as {
        pending: { host: string; links: number; reason: string }[]
        done: unknown[]
      }
      expect(report.pending).toEqual([{ host: 'x.com', links: 1, reason: 'login_wall' }])
      expect(report.done).toEqual([])
    } finally {
      await db.cleanup()
    }
  })
})

describe('interactive login flow', () => {
  function fakePicker(
    answer: { selected: string[]; quit: boolean } | null,
    seen: { pending?: unknown[]; done?: unknown[] } = {},
  ): LoginPicker {
    return async (pending, done) => {
      seen.pending = pending
      seen.done = done
      return answer
    }
  }

  it('logs the selected host in, saves the profile and requeues its links', async () => {
    const db = await tempDb()
    try {
      const id = await parkNeedsBrowser(db, 'https://x.com/a')
      const ctx = await contextFor(db)
      const launchedHosts: string[] = []
      const launch: LoginLauncher = async (host, profilePath) => {
        launchedHosts.push(host)
        expect(profilePath).toBe(profileDirFor(ctx.config.profilesDir, host))
        return 0
      }
      const pick = fakePicker({ selected: ['x.com'], quit: false })
      const out = await capture(() =>
        runLoginFlow(ctx, { launch, pick, isInteractive: () => true }),
      )
      expect(launchedHosts).toEqual(['x.com'])
      expect(out.stdout).toContain('saved profile for x.com')
      expect(out.stdout).toContain('requeued 1 link')
      const state = await db.store.getState(id)
      expect(state?.state).toBe('created')
      expect(await db.store.getProfile('x.com')).not.toBeNull()
      expect(out.stdout).toContain('logged in to 1 host, requeued 1 link')
      // the host moved out of pending
      const after = await queryPendingLogins(db.store)
      expect(after.pending).toEqual([])
      expect(after.done.map((d) => d.host)).toEqual(['x.com'])
    } finally {
      await db.cleanup()
    }
  })

  it('requeues only the logged-in host, leaving others parked', async () => {
    const db = await tempDb()
    try {
      const x = await parkNeedsBrowser(db, 'https://x.com/a')
      const ig = await parkNeedsBrowser(db, 'https://instagram.com/b')
      const ctx = await contextFor(db)
      const pick = fakePicker({ selected: ['x.com'], quit: false })
      await capture(() =>
        runLoginFlow(ctx, {
          launch: async () => 0,
          pick,
          isInteractive: () => true,
        }),
      )
      expect((await db.store.getState(x))?.state).toBe('created')
      expect((await db.store.getState(ig))?.state).toBe('needs_browser')
    } finally {
      await db.cleanup()
    }
  })

  it('logs in to every pending host with all', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      await parkNeedsBrowser(db, 'https://instagram.com/b')
      const ctx = await contextFor(db)
      const launched: string[] = []
      const out = await capture(() =>
        runLoginFlow(ctx, {
          launch: async (host) => {
            launched.push(host)
            return 0
          },
          pick: async () => {
            throw new Error('must not prompt with all: true')
          },
          isInteractive: () => true,
          all: true,
        }),
      )
      expect(launched.sort()).toEqual(['instagram.com', 'x.com'])
      expect(out.stdout).toContain('logged in to 2 hosts, requeued 2 links')
      expect((await db.store.listByStates(['needs_browser'])).length).toBe(0)
    } finally {
      await db.cleanup()
    }
  })

  it('quits without opening a browser on q', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      const ctx = await contextFor(db)
      let launched = 0
      const out = await capture(() =>
        runLoginFlow(ctx, {
          launch: async () => {
            launched += 1
            return 0
          },
          pick: fakePicker({ selected: [], quit: true }),
          isInteractive: () => true,
        }),
      )
      expect(launched).toBe(0)
      expect(out.stdout).toContain('quit; nothing logged in')
      expect(await db.store.getProfile('x.com')).toBeNull()
    } finally {
      await db.cleanup()
    }
  })

  it('skips without opening a browser on s', async () => {
    const db = await tempDb()
    try {
      await parkNeedsBrowser(db, 'https://x.com/a')
      const ctx = await contextFor(db)
      let launched = 0
      const out = await capture(() =>
        runLoginFlow(ctx, {
          launch: async () => {
            launched += 1
            return 0
          },
          pick: fakePicker({ selected: [], quit: false }),
          isInteractive: () => true,
        }),
      )
      expect(launched).toBe(0)
      expect((await db.store.listByStates(['needs_browser'])).length).toBe(1)
      expect(out.stdout).toContain('logged in to 0 hosts')
    } finally {
      await db.cleanup()
    }
  })

  it('does nothing when nothing is pending', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      let launched = 0
      const out = await capture(() =>
        runLoginFlow(ctx, {
          launch: async () => {
            launched += 1
            return 0
          },
          pick: fakePicker(null),
          isInteractive: () => true,
        }),
      )
      expect(launched).toBe(0)
      expect(out.stdout).toContain('no logins pending')
    } finally {
      await db.cleanup()
    }
  })
})

describe('requeue', () => {
  it('moves only the given host back to created', async () => {
    const db = await tempDb()
    try {
      const x = await parkNeedsBrowser(db, 'https://x.com/a')
      const other = await parkNeedsBrowser(db, 'https://other.com/b')
      const ctx = await contextFor(db)
      const n = await requeueHostLinks(ctx, 'x.com')
      expect(n).toBe(1)
      expect((await db.store.getState(x))?.state).toBe('created')
      expect((await db.store.getState(other))?.state).toBe('needs_browser')
    } finally {
      await db.cleanup()
    }
  })
})
