import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@linkinbox/db'
import type { Enrichment, LinkInput } from '@linkinbox/core'
import { createApp, createFullApp, startServer } from '../src/index.js'

let store: SqliteStore
let dir: string

const enrichment: Enrichment = {
  category: 'ai',
  priority: 'high',
  why_it_matters: 'shapes the inbox ranking',
  read_minutes: 7,
  action: 'schedule',
  expires_at: '2020-01-01T00:00:00.000Z',
  expiry_reason: 'stale test fixture',
  confidence: 0.92,
}

async function seed(overrides: Partial<LinkInput> = {}): Promise<number> {
  const suffix = Math.floor(Math.random() * 1e9)
  const link = await store.upsertLink({
    urlHash: `hash-${suffix}`,
    url: `https://example.com/${suffix}`,
    title: `Test link ${suffix}`,
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
    ...overrides,
  })
  await store.setEnrichment(link.id, enrichment)
  return link.id
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-server-'))
  store = await openStore({ path: join(dir, 'test.db') })
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/links', () => {
  it('returns { items, total } matching the UI LinkSummary shape', async () => {
    await seed()
    const res = await createApp(store).request('/api/links')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Record<string, unknown>[]
      total: number
    }
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.total).toBeGreaterThanOrEqual(body.items.length)
    const item = body.items[0]
    for (const key of [
      'id', 'title', 'url', 'category', 'priority', 'why_it_matters',
      'read_minutes', 'status', 'expires_at', 'expiry_reason', 'action',
    ]) {
      expect(item, key).toHaveProperty(key)
    }
    expect(item['why_it_matters']).toBe('shapes the inbox ranking')
    expect(item['read_minutes']).toBe(7)
    expect(item).not.toHaveProperty('extracted_content')
    expect(item).not.toHaveProperty('enrichment')
  })

  it('filters by status, category, q, stale and paginates', async () => {
    const app = createApp(store)
    const fresh = await seed()
    const res = await app.request('/api/links?status=inbox&category=ai&limit=1&offset=0')
    const body = (await res.json()) as { items: { id: number }[]; total: number }
    expect(res.status).toBe(200)
    expect(body.items.length).toBeLessThanOrEqual(1)
    expect(body.items.every((i) => i.id === fresh || body.items.length > 0)).toBe(true)

    const byQ = await app.request('/api/links?q=nonexistent-needle-xyz')
    expect(((await byQ.json()) as { total: number }).total).toBe(0)

    const staleRes = await app.request('/api/links?stale=1')
    const staleBody = (await staleRes.json()) as { items: { id: number }[] }
    // seeded enrichment expired in 2020 so everything enriched is stale
    expect(staleBody.items.length).toBeGreaterThan(0)

    const invalid = await app.request('/api/links?status=bogus')
    expect(invalid.status).toBe(400)
  })

  it('total reflects the filter, not the page size', async () => {
    await seed()
    const res = await createApp(store).request('/api/links?category=ai&limit=1')
    const body = (await res.json()) as { items: unknown[]; total: number }
    expect(body.total).toBeGreaterThanOrEqual(2)
    expect(body.items.length).toBe(1)
  })
})

describe('GET /api/links/:id', () => {
  it('returns the LinkDetail shape with extracted_content, enrichment fields and confidence', async () => {
    const id = await seed()
    const res = await createApp(store).request(`/api/links/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['id']).toBe(id)
    expect(body['why_it_matters']).toBe('shapes the inbox ranking')
    expect(body['confidence']).toBe(0.92)
    expect(typeof body['extracted_content']).toBe('string')
    expect(body['enrichment']).toMatchObject({ category: 'ai', why_it_matters: 'shapes the inbox ranking' })
  })

  it('404s for unknown and non-numeric ids', async () => {
    const app = createApp(store)
    const missing = await app.request('/api/links/999999999')
    expect(missing.status).toBe(404)
  })
})

describe('POST /api/links/triage', () => {
  it('updates status per action and returns { updated }', async () => {
    const a = await seed()
    const b = await seed()
    const app = createApp(store)
    const res = await app.request('/api/links/triage', {
      method: 'POST',
      body: JSON.stringify({ ids: [a, b], action: 'archive' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { updated: number }).toEqual({ updated: 2 })
    expect((await store.getLink(a))!.status).toBe('archived')
    expect((await store.getLink(b))!.status).toBe('archived')
  })

  it('maps read_now to inbox and reports 0 for unknown ids', async () => {
    const res = await createApp(store).request('/api/links/triage', {
      method: 'POST',
      body: JSON.stringify({ ids: [424242424], action: 'read_now' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { updated: number }).toEqual({ updated: 0 })
  })

  it('rejects malformed bodies', async () => {
    const app = createApp(store)
    const badIds = await app.request('/api/links/triage', {
      method: 'POST',
      body: JSON.stringify({ ids: 'nope', action: 'archive' }),
    })
    expect(badIds.status).toBe(400)
    const badAction = await app.request('/api/links/triage', {
      method: 'POST',
      body: JSON.stringify({ ids: [1], action: 'delete' }),
    })
    expect(badAction.status).toBe(400)
  })
})

describe('POST /api/links/restore', () => {
  it('restores archived links to the inbox and reports counts', async () => {
    const app = createApp(store)
    const a = await seed()
    const b = await seed()
    await app.request('/api/links/triage', {
      method: 'POST',
      body: JSON.stringify({ ids: [a, b], action: 'archive' }),
    })
    const res = await app.request('/api/links/restore', {
      method: 'POST',
      body: JSON.stringify({ ids: [a, b] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { updated: number; missing: number[]; blocked: number[] }
    expect(body.updated).toBe(2)
    expect(body.blocked).toEqual([])
    expect((await store.getLink(a))!.state).toBe('inbox')
    expect((await store.getLink(b))!.state).toBe('inbox')
  })

  it('blocks links that are not parked and reports missing ids', async () => {
    const app = createApp(store)
    const live = await seed()
    const res = await app.request('/api/links/restore', {
      method: 'POST',
      body: JSON.stringify({ ids: [live, 424242424] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { updated: number; missing: number[]; blocked: number[] }
    expect(body.updated).toBe(0)
    expect(body.blocked).toContain(live)
    expect(body.missing).toContain(424242424)
    // Untouched: a non-parked link keeps its FSM state (seed default 'created').
    expect((await store.getLink(live))!.state).toBe('created')
  })

  it('rejects malformed bodies', async () => {
    const app = createApp(store)
    const res = await app.request('/api/links/restore', {
      method: 'POST',
      body: JSON.stringify({ ids: 'nope' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('sweep', () => {
  it('GET /api/sweep groups stale links by category with UI-shaped links', async () => {
    const res = await createApp(store).request('/api/sweep')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      groups: { category: string; links: Record<string, unknown>[] }[]
    }
    expect(body.groups.length).toBeGreaterThan(0)
    for (const g of body.groups) {
      expect(typeof g.category).toBe('string')
      expect(g.links.length).toBeGreaterThan(0)
      expect(g.links[0]).toHaveProperty('why_it_matters')
      expect(g.links[0]).toHaveProperty('expires_at')
    }
    const categories = body.groups.map((g) => g.category)
    expect([...categories].sort()).toEqual(categories)
  })

  it('POST /api/sweep/apply archives only, never deletes', async () => {
    const id = await seed()
    const app = createApp(store)
    const res = await app.request('/api/sweep/apply', { method: 'POST' })
    expect(res.status).toBe(200)
    const { archived } = (await res.json()) as { archived: number }
    expect(archived).toBeGreaterThan(0)
    const link = await store.getLink(id)
    expect(link).not.toBeNull()
    expect(link!.status).toBe('archived')

    // applying again sweeps nothing new
    const second = await app.request('/api/sweep/apply', { method: 'POST' })
    expect(((await second.json()) as { archived: number }).archived).toBe(0)
  })
})

describe('GET /api/metrics', () => {
  it('returns { stages, daily } matching the UI metrics shape', async () => {
    await store.startRun('ingest', 2)
    await store.addMetric({ timestamp: new Date(), stage: 'ingest', key: 'tokens_in', value: 100 })
    await store.addMetric({ timestamp: new Date(), stage: 'ingest', key: 'tokens_out', value: 40 })
    await store.addMetric({ timestamp: new Date(), stage: 'ingest', key: 'cost_usd', value: 0.5 })
    const res = await createApp(store).request('/api/metrics?last=7d')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      stages: Record<string, unknown>[]
      daily: { date: string; tokens: number; cost_usd: number }[]
    }
    const stage = body.stages.find((s) => s['stage'] === 'ingest')
    expect(stage).toBeDefined()
    for (const key of [
      'stage', 'runs', 'ok', 'errors', 'p50_ms', 'p95_ms',
      'tokens_in', 'tokens_out', 'cost_usd',
    ]) {
      expect(stage, key).toHaveProperty(key)
    }
    expect(stage!['tokens_in']).toBe(100)
    expect(body.daily.length).toBeGreaterThan(0)
    const today = body.daily[body.daily.length - 1]
    expect(today.tokens).toBe(140)
    expect(today.cost_usd).toBeCloseTo(0.5)
  })

  it('rejects invalid ranges', async () => {
    const res = await createApp(store).request('/api/metrics?last=fortnight')
    expect(res.status).toBe(400)
  })
})

describe('static serving', () => {
  function makeDist(): string {
    const dist = join(dir, `dist-${Math.floor(Math.random() * 1e9)}`)
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>linkinbox</title>')
    writeFileSync(join(dist, 'app.js'), 'console.log(1)')
    return dist
  }

  it('serves files from uiDist and falls back to index.html (SPA)', async () => {
    const app = createFullApp({ store, uiDist: makeDist() })
    const index = await app.request('/')
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('linkinbox')
    const asset = await app.request('/app.js')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('console.log(1)')
    const spa = await app.request('/some/client/route')
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('linkinbox')
  })

  it('returns a helpful message when the ui dist is missing', async () => {
    const app = createFullApp({ store, uiDist: join(dir, 'does-not-exist') })
    const res = await app.request('/')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('ui dist not found')
    expect(body.error).toContain('@linkinbox/ui build')
    // api still works
    const links = await app.request('/api/links')
    expect(links.status).toBe(200)
  })
})

describe('startServer smoke', () => {
  it('serves api and static on one ephemeral port', async () => {
    const dist = join(dir, 'smoke-dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<html>smoke</html>')
    const started = await startServer({ store, uiDist: dist, port: 0 })
    try {
      const links = await fetch(`http://127.0.0.1:${started.port}/api/links`)
      expect(links.status).toBe(200)
      const body = (await links.json()) as { items: unknown[] }
      expect(Array.isArray(body.items)).toBe(true)
      const root = await fetch(`http://127.0.0.1:${started.port}/`)
      expect(root.status).toBe(200)
      expect(await root.text()).toContain('smoke')
    } finally {
      await started.close()
    }
  })
})
