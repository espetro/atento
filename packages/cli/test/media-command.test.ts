/**
 * Tests for the media command: tier parsing, link resolution and the report
 * table. The ASR provider and the download are faked at the mediaFn level.
 */
import { describe, expect, it } from 'vitest'
import { capture, insertLink, tempDb, unlimitedLimits, type TempDb } from './helpers.js'
import { createProgram } from '../src/program.js'
import { parseTiers, renderMediaTable, resolveLink } from '../src/commands/media.js'
import { normalizeUrl, type MediaConfig } from '@linkinbox/core'
import type { MediaReport } from '@linkinbox/media'

describe('parseTiers', () => {
  it('parses a comma-separated list', () => {
    expect(parseTiers('caption,transcript')).toEqual(['caption', 'transcript'])
  })

  it('rejects unknown tiers', () => {
    expect(() => parseTiers('caption,nope')).toThrow(/unknown tier "nope"/)
  })

  it('returns undefined when the option is absent', () => {
    expect(parseTiers(undefined)).toBeUndefined()
  })
})

const mediaDefaults: MediaConfig = {
  enabledTiers: ['caption', 'transcript'],
  dailyCap: 20,
  dailyCaps: {},
  maxDurationSeconds: 600,
  cookiesFromBrowser: false,
}

function cliConfig(db: TempDb) {
  return {
    dbPath: db.path,
    ttl: { default_days: 30, by_category: {}, archive_after_days: 90, delete_after_days: 365 },
    limits: unlimitedLimits(),
    media: mediaDefaults,
    profilesDir: '/tmp',
    dir: '/tmp',
  }
}

describe('media command', () => {
  it('prints a per-tier report table', async () => {
    const db = await tempDb()
    try {
      await insertLink(db.store, 'https://video.example/clips/1', {
        extractedContent: 'A demo clip #demo\n\nLikes: 5',
      })
      const report: MediaReport = {
        url: 'https://video.example/clips/1',
        tiers: [
          {
            kind: 'caption',
            tier: 'caption',
            status: 'ok',
            seconds: 0,
            text: 'A demo clip',
            hashtags: ['demo'],
            likeCount: 5,
          },
          {
            kind: 'transcript',
            tier: 'transcript',
            status: 'ok',
            seconds: 1.2,
            text: 'hello world',
          },
          {
            kind: 'unsupported',
            tier: 'frames',
            status: 'unsupported',
            seconds: 0,
            reason: 'frame analysis not implemented',
          },
        ],
      }
      const program = createProgram({
        config: cliConfig(db) as never,
        store: db.store,
        quiet: true,
        mediaFn: async () => ({ report, markdown: '' }),
      })
      const out = await capture(() =>
        program.parseAsync(['node', 'linkinbox', 'media', '1', '--tiers', 'caption,transcript,frames']),
      )
      expect(out.stderr).toBe('')
      expect(out.stdout).toContain('caption')
      expect(out.stdout).toContain('ok')
      expect(out.stdout).toContain('transcript')
      expect(out.stdout).toContain('frames')
      expect(out.stdout).toContain('unsupported')
      expect(out.stdout).toContain('frame analysis not implemented')
      expect(report.tiers).toHaveLength(3)
    } finally {
      await db.cleanup()
    }
  })

  it('emits JSON with --json', async () => {
    const db = await tempDb()
    try {
      const url = 'https://video.example/clips/2'
      await insertLink(db.store, url, { extractedContent: 'Clip two' })
      const program = createProgram({
        config: cliConfig(db) as never,
        store: db.store,
        quiet: true,
        mediaFn: async () => ({
          report: {
            url,
            tiers: [
              {
                kind: 'caption',
                tier: 'caption',
                status: 'ok',
                seconds: 0,
                text: 'Clip two',
                hashtags: [],
              },
              {
                kind: 'transcript',
                tier: 'transcript',
                status: 'ok',
                seconds: 0.5,
                text: 'words',
              },
            ],
          },
          markdown: '',
        }),
      })
      const out = await capture(() =>
        program.parseAsync(['node', 'linkinbox', 'media', url, '--json']),
      )
      const parsed = JSON.parse(out.stdout) as MediaReport
      expect(parsed.url).toBe(url)
      expect(parsed.tiers.map((t) => t.tier)).toEqual(['caption', 'transcript'])
      expect(parsed.tiers[0]?.status).toBe('ok')
      expect(parsed.tiers[1]?.status).toBe('ok')
    } finally {
      await db.cleanup()
    }
  })

  it('errors on an unknown link', async () => {
    const db = await tempDb()
    try {
      const program = createProgram({
        config: cliConfig(db) as never,
        store: db.store,
        quiet: true,
      })
      const out = await capture(() =>
        program.parseAsync(['node', 'linkinbox', 'media', '999']),
      )
      expect(out.stderr).toContain('no link found')
      expect(process.exitCode).toBe(1)
      process.exitCode = undefined
    } finally {
      await db.cleanup()
    }
  })
})

describe('resolveLink', () => {
  it('resolves by id and by url', async () => {
    const db = await tempDb()
    try {
      const link = await insertLink(db.store, 'https://video.example/clips/3', {
        extractedContent: 'content',
      })
      const ctx = {
        store: db.store,
      } as never
      const byId = await resolveLink(ctx, String(link.id))
      expect(byId?.url).toBe('https://video.example/clips/3')
      const { url } = normalizeUrl('https://video.example/clips/3')
      const byUrl = await resolveLink(ctx, url)
      expect(byUrl?.id).toBe(link.id)
      expect(await resolveLink(ctx, '99999')).toBeNull()
    } finally {
      await db.cleanup()
    }
  })
})

describe('renderMediaTable', () => {
  it('renders tier, status, seconds, chars and reason', () => {
    const table = renderMediaTable({
      url: 'https://x',
      tiers: [
        { kind: 'caption', tier: 'caption', status: 'ok', seconds: 0.1, text: 'abc' },
        {
          kind: 'unsupported',
          tier: 'frames',
          status: 'unsupported',
          seconds: 0,
          reason: 'frame analysis not implemented',
        },
      ],
    })
    expect(table).toContain('caption')
    expect(table).toContain('unsupported')
    expect(table).toContain('frame analysis not implemented')
  })
})
