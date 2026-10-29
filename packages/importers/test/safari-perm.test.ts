import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSafariReadingList } from '../src/safari-reading-list.js'

describe('safari reading list importer: TCC probe', () => {
  it('maps EACCES to a Full Disk Access hint and returns [] with a warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'linkinbox-fda-'))
    const plistPath = join(dir, 'Bookmarks.plist')
    writeFileSync(plistPath, 'bplist00placeholder')
    try {
      chmodSync(plistPath, 0o000)
      const result = await importSafariReadingList(plistPath)
      expect(result.links).toEqual([])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('Full Disk Access')
      expect(result.warnings[0]).toContain('EACCES')
    } finally {
      chmodSync(plistPath, 0o644)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a pure function of its inputs and never throws on directories', async () => {
    const result = await importSafariReadingList(tmpdir())
    expect(result.links).toEqual([])
    expect(result.warnings).toHaveLength(1)
  })
})
