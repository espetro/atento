/**
 * `linkinbox backup`: the online backup API produces a consistent sqlite
 * snapshot that opens standalone and contains the data. The default
 * destination derives from the config dir (LINKINBOX_CONFIG_DIR /
 * LINKINBOX_HOME aware).
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openStore } from '@linkinbox/db'
import { normalizeUrl } from '@linkinbox/core'
import { insertLink, tempDb } from './helpers.js'
import { createContext } from '../src/context.js'
import { defaultBackupPath, runBackup } from '../src/commands/maintenance.js'

describe('backup command', () => {
  it('writes a valid sqlite backup containing the links', async () => {
    const db = await tempDb()
    try {
      const { url, hash } = normalizeUrl('https://example.com/backed-up')
      await insertLink(db.store, url, { title: 'Backed up' })

      const ctx = await createContext({
        env: { LINKINBOX_DB: db.path, LINKINBOX_CONFIG_DIR: db.dir },
        store: db.store,
        quiet: true,
        logPath: join(db.dir, 'log.jsonl'),
      })
      const dest = join(db.dir, 'snapshots', 'links-copy.db')
      const written = await runBackup(ctx, { out: dest })
      expect(written).toBe(dest)
      expect(existsSync(dest)).toBe(true)
      await ctx.close()

      // The backup opens as a normal store and has the row.
      const copy = await openStore({ path: dest })
      try {
        const link = await copy.getLinkByUrlHash(hash)
        expect(link?.url).toBe(url)
        expect(link?.title).toBe('Backed up')
      } finally {
        await copy.close()
      }
    } finally {
      await db.cleanup()
    }
  })

  it('defaults the destination under <config dir>/backups', async () => {
    const db = await tempDb()
    try {
      const ctx = await createContext({
        env: { LINKINBOX_DB: db.path, LINKINBOX_CONFIG_DIR: db.dir },
        store: db.store,
        quiet: true,
        logPath: join(db.dir, 'log.jsonl'),
      })
      const expected = defaultBackupPath(ctx, new Date('2026-11-07T12:34:56.789Z'))
      expect(expected).toBe(
        join(db.dir, 'backups', 'linkinbox-2026-11-07T12-34-56.db'),
      )
      const written = await runBackup(ctx, { now: new Date('2026-11-07T12:34:56.789Z') })
      expect(written).toBe(expected)
      expect(existsSync(written)).toBe(true)
      await ctx.close()
    } finally {
      await db.cleanup()
    }
  })
})
