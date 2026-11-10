/**
 * M2 ingest contract: app.ingest over file/text/urls/remote returns job
 * summaries only (never link payloads), and ingestStatus reports progress.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAtentoOps, loadConfig, type AppConfig } from '../src/index.js'
import { openStore, type SqliteStore } from '@atento/db'

const dirs: string[] = []
const stores: SqliteStore[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atento-ingest-'))
  dirs.push(dir)
  return dir
}

async function opsFor(dir: string) {
  const store = await openStore({ path: join(dir, 'links.db') })
  stores.push(store)
  const config = loadConfig({ ATENTO_HOME: dir } as NodeJS.ProcessEnv) as AppConfig
  return createAtentoOps(config, { store, env: {}, spoolDir: join(dir, 'spool') })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  while (stores.length > 0) await stores.pop()!.close()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('app.ingest', () => {
  it('ingest_file imports a url list and returns a job summary only', async () => {
    const dir = tempDir()
    const file = join(dir, 'links.txt')
    writeFileSync(file, 'https://example.com/a\nhttps://example.com/b\n')
    const ops = await opsFor(dir)

    const summary = await ops.ingest({ kind: 'file', path: file })
    expect(summary.status).toBe('done')
    expect(summary.jobId).toMatch(/^job-/)
    expect(summary.accepted).toBe(2)
    expect(summary.duplicates).toBe(0)
    expect(summary.rejected).toBe(0)
    // No link payloads in the summary.
    expect(JSON.stringify(summary)).not.toContain('example.com')

    const status = await ops.ingestStatus(summary.jobId)
    expect(status?.status).toBe('done')
    expect(status?.done).toBe(2)
    expect(status?.total).toBe(2)
    expect(await ops.list({})).toHaveLength(2)
  })

  it('ingest_text pulls urls out of markdown and bare url lines', async () => {
    const dir = tempDir()
    const ops = await opsFor(dir)
    const text = [
      '## Reading list',
      '- [An article](https://example.com/article)',
      'https://example.com/bare',
      'not a url at all',
    ].join('\n')
    const summary = await ops.ingest({ kind: 'text', text })
    expect(summary.status).toBe('done')
    expect(summary.accepted).toBe(2)
    expect(await ops.list({})).toHaveLength(2)
  })

  it('ingest_urls attaches note and tags, dedupes on re-ingest', async () => {
    const dir = tempDir()
    const ops = await opsFor(dir)
    const first = await ops.ingest({
      kind: 'urls',
      urls: ['https://example.com/a', 'https://example.com/b'],
      note: 'from the agent',
      tags: ['cli', 'batch'],
    })
    expect(first.accepted).toBe(2)
    const links = await ops.list({ fields: ['id', 'url', 'note', 'tags'] })
    expect(links).toHaveLength(2)
    expect(links.every((l) => l.note === 'from the agent')).toBe(true)
    expect(links.every((l) => Array.isArray(l.tags) && (l.tags as string[]).includes('cli'))).toBe(true)

    const second = await ops.ingest({ kind: 'urls', urls: ['https://example.com/a'] })
    expect(second.duplicates).toBe(1)
    expect(await ops.list({})).toHaveLength(2)
  })

  it('ingest_urls rejects more than 500 urls', async () => {
    const dir = tempDir()
    const ops = await opsFor(dir)
    const urls = Array.from({ length: 501 }, (_, i) => `https://example.com/${i}`)
    await expect(ops.ingest({ kind: 'urls', urls })).rejects.toThrow('at most 500')
  })

  it('ingest_remote fetches and parses a remote file', async () => {
    const dir = tempDir()
    const ops = await opsFor(dir)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('[{"url":"https://example.com/r1","title":"Remote"}]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const summary = await ops.ingest({ kind: 'remote', url: 'https://gist.example.com/list.json' })
    expect(summary.status).toBe('done')
    expect(summary.accepted).toBe(1)
    const links = await ops.list({})
    expect(links[0]?.url).toBe('https://example.com/r1')
  })

  it('ingestStatus returns null for an unknown job', async () => {
    const dir = tempDir()
    const ops = await opsFor(dir)
    expect(await ops.ingestStatus('job-nope')).toBeNull()
  })
})
