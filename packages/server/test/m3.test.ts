import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@atento/db'
import {
  createAtentoOps,
  DEFAULT_TTL_CONFIG,
  type ExtractFn,
  type AtentoOps,
} from '@atento/app'
import type { EnrichFn } from '@atento/core'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string
let ops: AtentoOps
let app: ReturnType<typeof createApp>

const fakeExtract: ExtractFn = async () => ({
  markdown: '# extracted',
  title: 'Extracted title',
})
const fakeEnrich: EnrichFn = async () => ({ ok: false, error: 'no enrich in test' })

async function seed(url: string, overrides: Record<string, unknown> = {}): Promise<number> {
  const suffix = Math.floor(Math.random() * 1e9)
  const link = await store.upsertLink({
    urlHash: `hash-${suffix}`,
    url,
    title: `Test ${suffix}`,
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
    ...overrides,
  })
  return link.id
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atento-m3-'))
  store = await openStore({ path: join(dir, 'links.db') })
  ops = createAtentoOps(
    { ttl: DEFAULT_TTL_CONFIG, dbPath: join(dir, 'links.db') },
    { store, env: {}, extractFn: fakeExtract, enrichFn: fakeEnrich },
  )
  app = createApp(store, { ops, env: {} })
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('PATCH /api/links/:id', () => {
  it('updates title, note and tags', async () => {
    const id = await seed(`https://example.com/patch-${Date.now()}`)
    const res = await app.request(`/api/links/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New title', note: 'a note', tags: ['a', 'b'] }),
    })
    expect(res.status).toBe(200)
    const link = (await res.json()) as Record<string, unknown>
    expect(link['title']).toBe('New title')

    const got = await store.getLink(id)
    expect(got?.note).toBe('a note')
    expect(got?.tags).toEqual(['a', 'b'])
  })

  it('rejects bad field types with 400', async () => {
    const id = await seed(`https://example.com/patchbad-${Date.now()}`)
    const res = await app.request(`/api/links/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: 'not-an-array' }),
    })
    expect(res.status).toBe(400)
  })

  it('404s on an unknown id and ignores pipeline fields', async () => {
    const res = await app.request('/api/links/999999', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)

    // Pipeline-owned columns are not user-editable: the app layer drops them.
    const id = await seed(`https://example.com/patchpipe-${Date.now()}`)
    const res2 = await app.request(`/api/links/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extractedContent: 'hacked', title: 'ok' }),
    })
    expect(res2.status).toBe(200)
    const got = await store.getLink(id)
    expect(got?.extractedContent ?? null).toBeNull()
  })
})

describe('GET /api/links/:id/artifacts/:name', () => {
  it('404s when the artifact is absent', async () => {
    const id = await seed(`https://example.com/art-${Date.now()}`)
    const res = await app.request(`/api/links/${id}/artifacts/nope.txt`)
    expect(res.status).toBe(404)
  })

  it('serves a stored artifact with its content type', async () => {
    const id = await seed(`https://example.com/artok-${Date.now()}`)
    const file = join(dir, 'artifacts', String(id), 'shot.txt')
    mkdirSync(join(dir, 'artifacts', String(id)), { recursive: true })
    writeFileSync(file, 'artifact-bytes')
    const res = await app.request(`/api/links/${id}/artifacts/shot.txt`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('artifact-bytes')
  })

  it('rejects traversal names', async () => {
    const id = await seed(`https://example.com/arttrav-${Date.now()}`)
    const res = await app.request(`/api/links/${id}/artifacts/..%2F..%2Fetc`)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/links/:id/reextract', () => {
  it('404s on an unknown link', async () => {
    const res = await app.request('/api/links/999999/reextract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  it('re-extracts a queued link through the injected extract fn', async () => {
    const id = await seed(`https://example.com/rex-${Date.now()}`)
    const res = await app.request(`/api/links/${id}/reextract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; state?: string | null }
    expect(body.ok).toBe(true)
    const got = await store.getLink(id)
    expect(got?.extractedContent).toBe('# extracted')
  })

  it('rejects a bad adapter type', async () => {
    const id = await seed(`https://example.com/rexbad-${Date.now()}`)
    const res = await app.request(`/api/links/${id}/reextract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adapter: 42 }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/run + GET /api/runs/:id', () => {
  it('runs a pass and exposes the journal row', async () => {
    const res = await app.request('/api/run', { method: 'POST' })
    expect(res.status).toBe(200)
    const result = (await res.json()) as {
      runId: string
      cursorBefore: number
      cursorAfter: number
      summary: { needsAction: boolean }
    }
    expect(result.runId).toMatch(/^run-/)
    expect(result.cursorAfter).toBeGreaterThanOrEqual(result.cursorBefore)

    const runs = await store.listRuns({ limit: 10 })
    expect(runs.length).toBeGreaterThan(0)
    const latest = runs[runs.length - 1]!
    const got = await app.request(`/api/runs/${latest.id}`)
    expect(got.status).toBe(200)
    const row = (await got.json()) as { id: number; stage: string }
    expect(row.id).toBe(latest.id)
    expect(row.stage).toBeTruthy()

    const missing = await app.request('/api/runs/999999999')
    expect(missing.status).toBe(404)
  })
})
