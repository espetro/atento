/**
 * Pipeline overview tests: the state histogram, the host breakdown and the
 * pipeline row projection (state, reason, next retry time).
 */
import { describe, expect, it } from 'vitest'
import {
  emptyStateCounts,
  hostOfUrl,
  listPipelineLinks,
  pipelineOverview,
  reasonOfStateData,
  toPipelineRow,
  LINK_STATES,
} from '../src/index.js'
import { FakeStore, seedLink } from './fake-store.js'

async function store(): Promise<FakeStore> {
  return new FakeStore()
}

describe('pipeline overview', () => {
  it('counts every state, including the ones with no links', async () => {
    const s = await store()
    await seedLink(s, 'https://example.com/one')
    const overview = await pipelineOverview(s)
    expect(Object.keys(overview.byState).sort()).toEqual([...LINK_STATES].sort())
    expect(overview.total).toBe(1)
    // A fresh link with no content sits in the extraction queue.
    expect(overview.byState.created).toBe(1)
    expect(overview.byState.inbox).toBe(0)
  })

  it('groups links by host with a per-state breakdown, busiest host first', async () => {
    const s = await store()
    await seedLink(s, 'https://a.example/1', { state: 'created', stateData: {} })
    await seedLink(s, 'https://a.example/2', { state: 'created', stateData: {} })
    await seedLink(s, 'https://b.example/1', {
      state: 'needs_browser',
      stateData: { host: 'b.example', reason: 'login_wall' },
    })
    const overview = await pipelineOverview(s)
    expect(overview.total).toBe(3)
    expect(overview.byHost.map((h) => h.host)).toEqual(['a.example', 'b.example'])
    expect(overview.byHost[0]?.total).toBe(2)
    expect(overview.byHost[0]?.byState.created).toBe(2)
    expect(overview.byHost[1]?.byState.needs_browser).toBe(1)
  })

  it('caps the host list at the requested number', async () => {
    const s = await store()
    for (let i = 0; i < 5; i++) await seedLink(s, `https://h${i}.example/x`)
    const overview = await pipelineOverview(s, { topHosts: 2 })
    expect(overview.byHost).toHaveLength(2)
    expect(overview.total).toBe(5)
  })

  it('ignores links with an unparseable url when grouping by host', async () => {
    const s = await store()
    await seedLink(s, 'not-a-url')
    const overview = await pipelineOverview(s)
    expect(overview.total).toBe(1)
    expect(overview.byHost).toHaveLength(0)
  })
})

describe('pipeline rows', () => {
  it('carries the state, the reason and the next retry time', async () => {
    const s = await store()
    await seedLink(s, 'https://gated.example/post', {
      state: 'needs_browser',
      stateData: { host: 'gated.example', reason: 'login_wall' },
    })
    await seedLink(s, 'https://slow.example/post', {
      state: 'deferred',
      stateData: {
        stage: 'extract',
        nextAttemptAt: '2026-10-30T12:00:00.000Z',
        attempts: 1,
        reason: 'throttled',
      },
    })
    const rows = await listPipelineLinks(s)
    const gated = rows.find((r) => r.host === 'gated.example')
    expect(gated?.state).toBe('needs_browser')
    expect(gated?.reason).toBe('login_wall')
    expect(gated?.nextAttemptAt).toBeNull()

    const slow = rows.find((r) => r.host === 'slow.example')
    expect(slow?.state).toBe('deferred')
    expect(slow?.reason).toBe('throttled')
    expect(slow?.nextAttemptAt).toBe('2026-10-30T12:00:00.000Z')
  })

  it('filters by state, host and free text', async () => {
    const s = await store()
    await seedLink(s, 'https://a.example/alpha', {
      state: 'created',
      stateData: {},
      title: 'Alpha guide',
    })
    await seedLink(s, 'https://b.example/beta', {
      state: 'extracted',
      stateData: { chars: 10 },
      title: 'Beta notes',
    })
    const created = await listPipelineLinks(s, { state: 'created' })
    expect(created).toHaveLength(1)
    expect(created[0]?.host).toBe('a.example')

    const byHost = await listPipelineLinks(s, { host: 'b.example' })
    expect(byHost).toHaveLength(1)
    expect(byHost[0]?.title).toBe('Beta notes')

    const byText = await listPipelineLinks(s, { q: 'alpha' })
    expect(byText).toHaveLength(1)
    expect(byText[0]?.id).toBe(created[0]?.id)
  })

  it('paginates with limit and offset', async () => {
    const s = await store()
    for (let i = 0; i < 5; i++) await seedLink(s, `https://example.com/${i}`)
    const all = await listPipelineLinks(s)
    const page = await listPipelineLinks(s, { limit: 2, offset: 1 })
    expect(page).toHaveLength(2)
    expect(page.map((r) => r.id)).toEqual(all.slice(1, 3).map((r) => r.id))
  })
})

describe('overview helpers', () => {
  it('reads the host of a url', () => {
    expect(hostOfUrl('https://Example.com/path')).toBe('example.com')
    expect(hostOfUrl('nope')).toBe('')
  })

  it('reads the reason of a state payload', () => {
    expect(reasonOfStateData({ reason: 'login_wall' })).toBe('login_wall')
    expect(reasonOfStateData({ reason: 'blocked:login_wall' })).toBe('login_wall')
    expect(reasonOfStateData({ error: 'boom' })).toBe('boom')
    expect(reasonOfStateData({})).toBeNull()
    expect(reasonOfStateData(null)).toBeNull()
  })

  it('builds an empty histogram with every known state', () => {
    const counts = emptyStateCounts()
    expect(Object.keys(counts)).toHaveLength(LINK_STATES.length)
    expect(counts.inbox).toBe(0)
  })

  it('projects a raw row into a pipeline row', () => {
    const row = toPipelineRow({
      id: 3,
      url: 'https://x.example/a',
      title: 'A',
      state: 'errored',
      stateData: { stage: 'extract', error: 'timeout', attempts: 2 },
      updatedAt: '2026-10-30T00:00:00.000Z',
    })
    expect(row.state).toBe('errored')
    expect(row.reason).toBe('timeout')
    expect(row.host).toBe('x.example')
    expect(row.updatedAt).toBe('2026-10-30T00:00:00.000Z')
  })
})
