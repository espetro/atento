/**
 * M3 use cases: link patch, run journal reads, the link_events cursor
 * stream, artifact reads and single-link re-extract.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLinkinboxOps,
  loadConfig,
  type AppConfig,
  type EnrichFn,
  type ExtractFn,
} from '../src/index.js'
import { openStore, type SqliteStore } from '@linkinbox/db'
import type { Enrichment } from '@linkinbox/core'

const dirs: string[] = []
const stores: SqliteStore[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linkinbox-m3-'))
  dirs.push(dir)
  return dir
}

async function opsFor(dir: string, deps: { extractFn?: ExtractFn; enrichFn?: EnrichFn } = {}) {
  const store = await openStore({ path: join(dir, 'links.db') })
  stores.push(store)
  const config = loadConfig({ LINKINBOX_HOME: dir } as NodeJS.ProcessEnv) as AppConfig
  const ops = createLinkinboxOps(config, {
    store,
    env: {},
    spoolDir: join(dir, 'spool'),
    ...(deps.extractFn ? { extractFn: deps.extractFn } : {}),
    ...(deps.enrichFn ? { enrichFn: deps.enrichFn } : {}),
  })
  return { store, ops }
}

const okExtract: ExtractFn = async (url) => ({
  markdown: `# ${url}\nbody`,
  extractor: 'fake',
})

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('patchLink', () => {
  it('patches title, note and tags; returns the updated link', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir)
    const link = await store.upsertLink({
      urlHash: 'h1',
      url: 'https://example.com/a',
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
    })
    const updated = await ops.patchLink(link.id, {
      title: 'New title',
      note: 'a note',
      tags: ['x', 'y'],
    })
    expect(updated?.title).toBe('New title')
    expect(updated?.note).toBe('a note')
    expect(updated?.tags).toEqual(['x', 'y'])
    expect(await ops.patchLink(9999, { note: 'nope' })).toBeNull()
  })
})

describe('getRun / listEvents', () => {
  it('reads the run journal and the link_events cursor stream', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir, { extractFn: okExtract })
    const link = await store.upsertLink({
      urlHash: 'h2',
      url: 'https://example.com/b',
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
    })
    const result = await ops.extract({ linkIds: [link.id], guard: null })
    expect(result.outcomes[0]?.ok).toBe(true)

    const runs = await store.listRuns()
    expect(runs.length).toBeGreaterThan(0)
    const run = await ops.getRun(runs[0]!.id)
    expect(run?.stage).toBe('extract')
    expect(await ops.getRun(999999)).toBeNull()

    const events = await ops.listEvents()
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.id > 0)).toBe(true)
    const max = Math.max(...events.map((e) => e.id))
    const delta = await ops.listEvents(max)
    expect(delta).toHaveLength(0)
    // The INGESTED/extract transitions are visible to the cursor stream.
    expect(events.some((e) => e.linkId === link.id)).toBe(true)
  })
})

describe('readArtifact', () => {
  it('serves files under <artifactsDir>/<linkId>/ and refuses traversal', async () => {
    const dir = tempDir()
    const { ops } = await opsFor(dir)
    const artifactDir = join(dir, '.linkinbox', 'artifacts', '7')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'shot.png'), Buffer.from([1, 2, 3]))
    const hit = await ops.readArtifact(7, 'shot.png')
    expect(hit?.contentType).toBe('image/png')
    expect(hit?.body).toEqual(Buffer.from([1, 2, 3]))
    expect(await ops.readArtifact(7, 'missing.png')).toBeNull()
    expect(await ops.readArtifact(7, '../shot.png')).toBeNull()
    expect(await ops.readArtifact(7, 'a/b')).toBeNull()
  })
})

describe('reextractLink', () => {
  const enrichment: Enrichment = {
    category: 'article',
    priority: 'normal',
    why_it_matters: 'test',
    read_minutes: 2,
    action: 'read_now',
    expires_at: null,
    expiry_reason: null,
    confidence: 0.9,
  }

  it('re-extracts a created link through the extract stage', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir, { extractFn: okExtract })
    const link = await store.upsertLink({
      urlHash: 'h3',
      url: 'https://example.com/c',
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
    })
    const result = await ops.reextractLink(link.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.outcome?.ok).toBe(true)
      expect(result.state).toBe('extracted')
    }
    const after = await store.getLink(link.id)
    expect(after?.extractedContent).toContain('example.com/c')
  })

  it('sends an enriched inbox link back through the queue (RETRY edge)', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir, { extractFn: okExtract })
    const link = await store.upsertLink({
      urlHash: 'h4',
      url: 'https://example.com/d',
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
      enrichment,
      category: 'article',
    })
    expect(link.state).toBe('inbox')
    const result = await ops.reextractLink(link.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.state).toBe('extracted')
  })

  it('refuses deleted links and reports missing ids', async () => {
    const dir = tempDir()
    const { store, ops } = await opsFor(dir, { extractFn: okExtract })
    const link = await store.upsertLink({
      urlHash: 'h5',
      url: 'https://example.com/e',
      source: 'test',
      status: 'inbox',
      needsBrowser: false,
    })
    await store.applyEvent(link.id, { type: 'DELETE', at: new Date().toISOString() })
    const deleted = await ops.reextractLink(link.id)
    expect(deleted.ok).toBe(false)
    if (!deleted.ok) expect(deleted.reason).toBe('deleted')
    const missing = await ops.reextractLink(424242)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('not_found')
  })
})
