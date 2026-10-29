/**
 * CLI behaviour tests: list, show, triage, login bookkeeping and config
 * resolution. Every command calls an ops function; these tests pin the
 * observable behaviour.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { capture, insertLink, tempDb, type TempDb } from './helpers.js'
import { createContext, type CliContext } from '../src/context.js'
import { runList, runShow, runTriage, applyFilter, runRetryHeadless } from '../src/commands/links.js'
import { runLoginClear, runLoginList, profileDirFor } from '../src/commands/login.js'
import { loadConfig, resolveDbPath, configDir } from '../src/config.js'

async function contextFor(db: TempDb): Promise<CliContext> {
  return createContext({
    env: { LINKINBOX_DB: db.path },
    store: db.store,
    quiet: true,
    logPath: join(db.dir, 'log.jsonl'),
  })
}

async function seeded(db: TempDb): Promise<void> {
  const a = await insertLink(db.store, 'https://example.com/alpha', { title: 'Alpha' })
  await db.store.setEnrichment(a.id, {
    category: 'guide',
    priority: 'normal',
    why_it_matters: 'useful',
    read_minutes: 3,
    action: 'read_now',
    expires_at: '2026-01-01T00:00:00.000Z',
    expiry_reason: 'old',
    confidence: 0.8,
  })
  await db.store.setExtractedContent(a.id, '# Alpha\n\nbody', false, new Date())

  const b = await insertLink(db.store, 'https://example.com/beta', { title: 'Beta' })
  await db.store.setEnrichment(b.id, {
    category: 'job',
    priority: 'high',
    why_it_matters: 'urgent',
    read_minutes: 1,
    action: 'read_now',
    expires_at: null,
    expiry_reason: null,
    confidence: 0.9,
  })
}

describe('cli list', () => {
  it('prints a table and a count', async () => {
    const db = await tempDb()
    try {
      await seeded(db)
      const ctx = await contextFor(db)
      const out = await capture(() => runList(ctx, {}))
      expect(out.stdout).toContain('id')
      expect(out.stdout).toContain('Alpha')
      expect(out.stdout).toContain('2 links')
    } finally {
      await db.cleanup()
    }
  })

  it('filters by status, category and staleness', async () => {
    const db = await tempDb()
    try {
      await seeded(db)
      const ctx = await contextFor(db)

      const byCategory = await capture(() => runList(ctx, { category: 'job' }))
      expect(byCategory.stdout).toContain('Beta')
      expect(byCategory.stdout).not.toContain('Alpha')

      const stale = await capture(() => runList(ctx, { stale: true, now: new Date() }))
      expect(stale.stdout).toContain('Alpha')
      expect(stale.stdout).not.toContain('Beta')

      const byStatus = await capture(() => runList(ctx, { status: 'archived' }))
      expect(byStatus.stdout).toContain('no links')
    } finally {
      await db.cleanup()
    }
  })

  it('prints json on request', async () => {
    const db = await tempDb()
    try {
      await seeded(db)
      const ctx = await contextFor(db)
      const out = await capture(() => runList(ctx, { json: true }))
      const parsed = JSON.parse(out.stdout) as Record<string, unknown>[]
      expect(parsed).toHaveLength(2)
      expect(parsed[0]).toHaveProperty('url')
      expect(parsed[0]).not.toHaveProperty('extracted_content')
    } finally {
      await db.cleanup()
    }
  })

  it('rejects an unknown status', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      await expect(runList(ctx, { status: 'nonsense' })).rejects.toThrow(/unknown status/)
    } finally {
      await db.cleanup()
    }
  })
})

describe('cli show', () => {
  it('prints the full record including extracted content', async () => {
    const db = await tempDb()
    try {
      await seeded(db)
      const ctx = await contextFor(db)
      const out = await capture(() => runShow(ctx, 1, false))
      expect(out.stdout).toContain('url: https://example.com/alpha')
      expect(out.stdout).toContain('--- extracted content ---')
      expect(out.stdout).toContain('# Alpha')
    } finally {
      await db.cleanup()
    }
  })

  it('prints the media report when the link has one', async () => {
    const db = await tempDb()
    try {
      await seeded(db)
      const ctx = await contextFor(db)
      await db.store.setMediaReport(1, {
        url: 'https://example.com/alpha',
        tiers: [
          { tier: 'caption', status: 'ok' },
          { tier: 'transcript', status: 'failed', error: 'no ASR provider configured' },
          { tier: 'frames', status: 'unsupported', reason: 'frame analysis not implemented' },
        ],
      })
      const out = await capture(() => runShow(ctx, 1, false))
      expect(out.stdout).toContain('--- media report ---')
      expect(out.stdout).toMatch(/caption\s+ok/)
      expect(out.stdout).toMatch(/transcript\s+failed\s+no ASR provider configured/)
      expect(out.stdout).toMatch(/frames\s+unsupported\s+frame analysis not implemented/)
    } finally {
      await db.cleanup()
    }
  })

  it('reports a missing link', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      const out = await capture(() => runShow(ctx, 999, false))
      expect(out.stderr).toContain('no link with id 999')
    } finally {
      await db.cleanup()
    }
  })
})

describe('cli triage', () => {
  it('triages a single link', async () => {
    const db = await tempDb()
    try {
      await seeded(db)
      const ctx = await contextFor(db)
      const out = await capture(() => runTriage(ctx, { action: 'archive', ids: [1] }))
      expect(out.stdout).toContain('1 link -> archived')
      expect((await db.store.getLink(1))?.status).toBe('archived')
    } finally {
      await db.cleanup()
    }
  })

  it('triages a batch by filter', async () => {
    const db = await tempDb()
    try {
      await seeded(db)
      const ctx = await contextFor(db)
      const out = await capture(() =>
        runTriage(ctx, { action: 'discard', batch: true, filter: 'category:job' }),
      )
      expect(out.stdout).toContain('1 link -> discarded')
      expect((await db.store.getLink(2))?.status).toBe('discarded')
      expect((await db.store.getLink(1))?.status).toBe('inbox')
    } finally {
      await db.cleanup()
    }
  })

  it('rejects an unknown action', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      await expect(runTriage(ctx, { action: 'nope', ids: [1] })).rejects.toThrow(/unknown action/)
    } finally {
      await db.cleanup()
    }
  })

  it('applies the batch filter syntax', () => {
    const rows = [
      { id: 1, status: 'inbox', category: 'job', title: 'One' },
      { id: 2, status: 'archived', category: 'guide', title: 'Two' },
    ]
    expect(applyFilter(rows, 'status:archived')).toHaveLength(1)
    expect(applyFilter(rows, 'category:job')).toHaveLength(1)
    expect(applyFilter(rows, 'status:inbox category:job')).toHaveLength(1)
    expect(applyFilter(rows, 'status:inbox category:guide')).toHaveLength(0)
    expect(applyFilter(rows, undefined)).toHaveLength(2)
  })
})

describe('cli login', () => {
  it('lists saved profiles', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      await db.store.upsertProfile({ host: 'x.com', path: '/tmp/profiles/x.com' })
      const out = await capture(() => runLoginList(ctx))
      expect(out.stdout).toContain('x.com')
      expect(out.stdout).toContain('/tmp/profiles/x.com')
    } finally {
      await db.cleanup()
    }
  })

  it('says so when there are no profiles', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      const out = await capture(() => runLoginList(ctx))
      expect(out.stdout).toContain('no saved profiles')
    } finally {
      await db.cleanup()
    }
  })

  it('clears a profile', async () => {
    const db = await tempDb()
    try {
      const ctx = await contextFor(db)
      await db.store.upsertProfile({ host: 'x.com', path: join(db.dir, 'profiles', 'x.com') })
      const out = await capture(() => runLoginClear(ctx, 'x.com'))
      expect(out.stdout).toContain('cleared profile for x.com')
      expect(await db.store.getProfile('x.com')).toBeNull()
    } finally {
      await db.cleanup()
    }
  })

  it('derives the profile path from the host', () => {
    expect(profileDirFor('/tmp/profiles', 'x.com')).toBe(join('/tmp/profiles', 'x.com'))
  })
})

describe('cli config', () => {
  it('resolves the db path from the environment', () => {
    expect(resolveDbPath({}, { LINKINBOX_DB: '/tmp/custom.db' })).toBe('/tmp/custom.db')
  })

  it('resolves the db path from the toml', () => {
    expect(resolveDbPath({ db: { path: '/tmp/from-toml.db' } }, {})).toBe('/tmp/from-toml.db')
  })

  it('falls back to the config dir', () => {
    expect(resolveDbPath({}, { LINKINBOX_CONFIG_DIR: '/tmp/cfg' })).toBe('/tmp/cfg/links.db')
  })

  it('resolves the config dir from the environment', () => {
    expect(configDir({ LINKINBOX_CONFIG_DIR: '/tmp/cfg' })).toBe('/tmp/cfg')
    expect(configDir({ LINKINBOX_HOME: '/home/x' })).toBe(join('/home/x', '.linkinbox'))
  })

  it('loads defaults when no config file exists', () => {
    const config = loadConfig({ LINKINBOX_CONFIG_DIR: '/tmp/does-not-exist-cfg' })
    expect(config.ttl.default_days).toBe(30)
    expect(config.ttl.delete_after_days).toBe(365)
    expect(config.dbPath).toBe('/tmp/does-not-exist-cfg/links.db')
  })
})

describe('cli retry --headless', () => {
  it('requeues a captured link for headless extraction', async () => {
    const db = await tempDb()
    try {
      const link = await insertLink(db.store, 'https://example.com/captured')
      await db.store.setExtractedContent(link.id, 'captured body', false, new Date())
      await db.store.applyEvent(link.id, {
        type: 'EXTRACTED',
        chars: 'captured body'.length,
        at: new Date().toISOString(),
      }, 'created')
      expect((await db.store.getLink(link.id))?.state).toBe('extracted')

      const ctx = await contextFor(db)
      const out = await capture(() => runRetryHeadless(ctx, { ids: [link.id], headless: true }))
      expect(out.stdout).toContain('requeued for headless extraction')
      expect((await db.store.getLink(link.id))?.state).toBe('created')
    } finally {
      await db.cleanup()
    }
  })

  it('refuses to run without --headless', async () => {
    const db = await tempDb()
    try {
      const link = await insertLink(db.store, 'https://example.com/no-headless')
      await db.store.setExtractedContent(link.id, 'body', false, new Date())
      await db.store.applyEvent(link.id, {
        type: 'EXTRACTED',
        chars: 'body'.length,
        at: new Date().toISOString(),
      }, 'created')
      const ctx = await contextFor(db)
      await expect(
        runRetryHeadless(ctx, { ids: [link.id], headless: false }),
      ).rejects.toThrow(/--headless/)
      expect((await db.store.getLink(link.id))?.state).toBe('extracted')
    } finally {
      await db.cleanup()
    }
  })

  it('reports missing and blocked ids', async () => {
    const db = await tempDb()
    try {
      const link = await insertLink(db.store, 'https://example.com/blocked-retry')
      await db.store.applyEvent(link.id, {
        type: 'DELETE',
        at: new Date().toISOString(),
      }, 'created')
      const ctx = await contextFor(db)
      const out = await capture(() => runRetryHeadless(ctx, { ids: [link.id, 999999], headless: true }))
      expect(out.stdout).toContain('missing: 999999')
      expect(out.stdout).toContain('blocked')
    } finally {
      await db.cleanup()
    }
  })
})
