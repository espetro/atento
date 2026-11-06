/**
 * Pipeline overview + pipeline-filtered list tests, over a seeded store.
 * The routes are the data behind the "seeing everything" surface: the state
 * histogram, the busiest hosts and the per-row pipeline fields.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type SqliteStore } from '@linkinbox/db'
import { normalizeUrl, LINK_STATES, type LinkStateName } from '@linkinbox/core'
import { createApp } from '../src/index.js'

let store: SqliteStore
let dir: string

/** Upsert a link with an explicit FSM state + payload. */
async function seedState(
  url: string,
  state: LinkStateName,
  stateData: Record<string, unknown>,
  title?: string,
): Promise<number> {
  const { url: normalized, hash } = normalizeUrl(url)
  const link = await store.upsertLink({
    urlHash: hash,
    url: normalized,
    title,
    source: 'test',
    status: 'inbox',
    needsBrowser: false,
    state,
    stateData,
  })
  return link.id
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'linkinbox-server-pipeline-'))
  store = await openStore({ path: join(dir, 'test.db') })
  await seedState('https://a.example/one', 'created', {}, 'One')
  await seedState('https://a.example/two', 'created', {}, 'Two')
  await seedState(
    'https://gated.example/post',
    'needs_browser',
    { host: 'gated.example', reason: 'login_wall' },
    'Gated post',
  )
  await seedState(
    'https://slow.example/post',
    'deferred',
    {
      stage: 'extract',
      nextAttemptAt: '2026-10-30T12:00:00.000Z',
      attempts: 1,
      reason: 'throttled',
    },
    'Slow post',
  )
  await seedState(
    'https://broken.example/post',
    'errored',
    { stage: 'extract', error: 'boom', attempts: 3, retryable: false },
    'Broken post',
  )
})

afterAll(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

interface PipelineResponse {
  byState: Record<string, number>
  byParkReason: Record<string, number>
  byHost: {
    host: string
    total: number
    byState: Record<string, number>
    byParkReason: Record<string, number>
  }[]
}

describe('GET /api/pipeline', () => {
  it('returns every state with a count, zero included', async () => {
    const res = await createApp(store).request('/api/pipeline')
    expect(res.status).toBe(200)
    const body = (await res.json()) as PipelineResponse
    expect(Object.keys(body.byState).sort()).toEqual([...LINK_STATES].sort())
    expect(body.byState.created).toBe(2)
    expect(body.byState.needs_browser).toBe(1)
    expect(body.byState.deferred).toBe(1)
    expect(body.byState.errored).toBe(1)
    expect(body.byState.inbox).toBe(0)
  })

  it('returns the park reasons of the parked links', async () => {
    const res = await createApp(store).request('/api/pipeline')
    const body = (await res.json()) as PipelineResponse
    expect(Object.keys(body.byParkReason).sort()).toEqual([
      'bot_block',
      'http_error',
      'js_shell',
      'login_wall',
      'review_only',
      'skipped',
      'timeout',
      'unknown',
    ])
    // The gated link is parked behind a login wall.
    expect(body.byParkReason.login_wall).toBe(1)
    // A throttled link only waits, it is not parked.
    expect(body.byParkReason.unknown).toBe(0)
    expect(body.byParkReason.timeout).toBe(0)
  })

  it('returns the busiest hosts with a per-state breakdown', async () => {
    const res = await createApp(store).request('/api/pipeline')
    const body = (await res.json()) as PipelineResponse
    expect(body.byHost[0]).toEqual({
      host: 'a.example',
      total: 2,
      byState: expect.objectContaining({ created: 2 }),
      byParkReason: expect.objectContaining({ login_wall: 0 }),
    })
    const hosts = body.byHost.map((h) => h.host)
    expect(hosts).toContain('gated.example')
    expect(hosts).toContain('slow.example')
    const gated = body.byHost.find((h) => h.host === 'gated.example')
    expect(gated?.byState.needs_browser).toBe(1)
    expect(gated?.byParkReason.login_wall).toBe(1)
  })
})

interface PipelineLinkRow {
  id: number
  url: string
  host: string
  title: string
  state: string
  reason: string | null
  next_attempt_at: string | null
  updated_at: string
}

describe('GET /api/links pipeline fields and filters', () => {
  it('adds state, reason, host, next_attempt_at and updated_at to each row', async () => {
    const res = await createApp(store).request('/api/links?state=needs_browser')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: PipelineLinkRow[]; total: number }
    expect(body.total).toBe(1)
    const row = body.items[0]
    expect(row.state).toBe('needs_browser')
    expect(row.reason).toBe('login_wall')
    expect(row.host).toBe('gated.example')
    expect(row.next_attempt_at).toBeNull()
    expect(typeof row.updated_at).toBe('string')
    // The legacy summary keys stay untouched (additive change).
    expect(row).toHaveProperty('why_it_matters')
    expect(row).toHaveProperty('read_minutes')
  })

  it('surfaces the retry time for deferred links', async () => {
    const res = await createApp(store).request('/api/links?state=deferred')
    const body = (await res.json()) as { items: PipelineLinkRow[] }
    expect(body.items[0]?.next_attempt_at).toBe('2026-10-30T12:00:00.000Z')
    expect(body.items[0]?.reason).toBe('throttled')
  })

  it('filters by host', async () => {
    const res = await createApp(store).request('/api/links?host=a.example')
    const body = (await res.json()) as { items: PipelineLinkRow[]; total: number }
    expect(body.total).toBe(2)
    expect(body.items.every((i) => i.host === 'a.example')).toBe(true)
  })

  it('paginates with limit and offset', async () => {
    const app = createApp(store)
    const page = await app.request('/api/links?limit=2&offset=1')
    const body = (await page.json()) as { items: PipelineLinkRow[] }
    expect(body.items).toHaveLength(2)
  })

  it('rejects an unknown state', async () => {
    const res = await createApp(store).request('/api/links?state=nonsense')
    expect(res.status).toBe(400)
  })

  it('keeps the legacy callers working: status filter still answers', async () => {
    const res = await createApp(store).request('/api/links?status=inbox')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Record<string, unknown>[] }
    // The created links project onto inbox in the legacy column, so they are
    // still reachable through the old filter.
    expect(body.items.length).toBeGreaterThanOrEqual(2)
  })
})
