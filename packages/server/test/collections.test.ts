/**
 * M2 fix-round: the collections HTTP surface.
 *  - format=jsonl|md streams EVERY matching row via collectionScan (no
 *    200-row inline cap).
 *  - `cursor=` is accepted as an alias for `since=`.
 *  - multipart ingest filenames are basename-sanitized (no path traversal).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@linkinbox/db'
import type { Enrichment, LinkInput } from '@linkinbox/core'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string

const enrichment: Enrichment = {
  category: 'ai',
  priority: 'high',
  why_it_matters: 'stream me',
  read_minutes: 3,
  action: 'read_now',
  expires_at: null,
  expiry_reason: null,
  confidence: 0.9,
}

async function seedEnriched(tag: string): Promise<void> {
  const link = await store.upsertLink({
    urlHash: `hash-${tag}`,
    url: `https://${tag}.example.com/x`,
    title: `link ${tag}`,
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
    state: 'inbox',
    stateData: { enriched: true },
  } as LinkInput)
  await store.setEnrichment(link.id, enrichment)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-server-coll-'))
  store = await openStore({ path: join(dir, 'test.db') })
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/collections/:name', () => {
  it('format=jsonl streams all matching rows, past the 200-row inline cap', async () => {
    // 205 fresh enriched links on top of whatever earlier tests seeded.
    for (let i = 0; i < 205; i += 1) await seedEnriched(`bulk-${i}`)
    const res = await createApp(store).request('/api/collections/enriched?format=jsonl&fields=id,url')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('x-ndjson')
    const cursor = res.headers.get('x-linkinbox-cursor')
    expect(cursor).toMatch(/^\d+$/)
    const lines = (await res.text()).trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(205)
    for (const line of lines.slice(0, 3)) {
      const row = JSON.parse(line) as Record<string, unknown>
      expect(Object.keys(row).sort()).toEqual(['id', 'url'])
    }
  })

  it('format=md streams a table with the same cursor header', async () => {
    const res = await createApp(store).request('/api/collections/enriched?format=md&fields=id,url')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('markdown')
    const body = await res.text()
    expect(body).toContain('| id | url |')
    expect(res.headers.get('x-linkinbox-cursor')).toMatch(/^\d+$/)
  })

  it('accepts cursor= as an alias for since=', async () => {
    const app = createApp(store)
    const full = await app.request('/api/collections/enriched?format=json&limit=1')
    const { cursor } = (await full.json()) as { cursor: number }
    const delta = await app.request(`/api/collections/enriched?format=json&cursor=${cursor}`)
    expect(delta.status).toBe(200)
    const body = (await delta.json()) as { count: number; rows: unknown[] }
    expect(body.count).toBe(0)
  })

  it('format=tsv ends with a # cursor trailer line', async () => {
    const res = await createApp(store).request('/api/collections/enriched?format=tsv&fields=id,url')
    expect(res.status).toBe(200)
    const body = await res.text()
    const lines = body.trimEnd().split('\n')
    expect(lines.at(-1)).toMatch(/^# cursor: \d+$/)
    expect(res.headers.get('x-linkinbox-cursor')).toBe(
      lines.at(-1)!.replace('# cursor: ', ''),
    )
  })
})

describe('POST /api/ingest multipart', () => {
  it('sanitizes a path-traversal filename to a basename', async () => {
    // Craft the part with a traversal name by building the body manually.
    const boundary = '----linkinboxtest'
    const payload =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="../../tmp/links.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `https://safe.example.com/1\n` +
      `\r\n--${boundary}--\r\n`
    const res = await createApp(store).request('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: payload,
    })
    expect(res.status).toBe(200)
    const summary = (await res.json()) as { accepted: number; status: string }
    expect(summary.accepted).toBe(1)
    expect(summary.status).toBe('done')
  })
})
