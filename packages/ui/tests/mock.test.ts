import { describe, expect, it } from 'vitest'
import { createMockState, listLinks, pipelineOverview, collectionsSummary, collectionOf, triageLinks, restoreLinks, ingestUrls, runPipeline, getLink } from '../src/mock/data'
import { PIPELINE_STATES, COLLECTION_NAMES } from '../src/lib/types'

describe('mock data', () => {
  it('creates 128 links with first 100 in inbox', () => {
    const state = createMockState()
    expect(state.links).toHaveLength(128)
    expect(state.links.filter((l) => l.status === 'inbox').length).toBeGreaterThanOrEqual(100)
    for (const l of state.links) {
      expect(l.title).toBeTruthy()
      expect(l.url).toMatch(/^https?:\/\//)
      expect(l.why_it_matters).toBeTruthy()
      expect(l.read_minutes).toBeGreaterThan(0)
      expect(['read_now', 'schedule', 'archive', 'discard']).toContain(l.action)
    }
  })

  it('listLinks filters by category, status, q, stale with total', () => {
    const state = createMockState()
    const all = listLinks(state, new URLSearchParams())
    expect(all.items.length).toBeGreaterThan(0)
    expect(all.total).toBe(128)

    const cat = listLinks(state, new URLSearchParams({ category: state.links[0].category }))
    expect(cat.items.every((l) => l.category === state.links[0].category)).toBe(true)

    const q = listLinks(state, new URLSearchParams({ q: 'zzz-no-match' }))
    expect(q.total).toBe(0)

    const stale = listLinks(state, new URLSearchParams({ stale: '1' }))
    const now = Date.now()
    expect(stale.items.every((l) => l.expires_at && new Date(l.expires_at).getTime() < now)).toBe(
      true,
    )

    const paged = listLinks(state, new URLSearchParams({ limit: '10', offset: '5' }))
    expect(paged.items).toHaveLength(10)
    expect(paged.items[0].id).toBe(all.items[5].id)
  })

  it('mock links carry pipeline state, reason and host', () => {
    const state = createMockState()
    const withState = state.links.filter((l) => l.state !== 'inbox')
    expect(withState.length).toBeGreaterThan(0)
    for (const l of state.links) {
      expect(PIPELINE_STATES).toContain(l.state)
      expect(l.host).toBeTruthy()
      expect(typeof l.updated_at).toBe('string')
      if (l.state === 'needs_browser') expect(l.reason).toBe('login_wall')
      if (l.state === 'deferred') expect(l.next_attempt_at).toBeTruthy()
    }
  })

  it('listLinks filters by pipeline state and host', () => {
    const state = createMockState()
    const needsBrowser = listLinks(state, new URLSearchParams({ state: 'needs_browser' }))
    expect(needsBrowser.total).toBeGreaterThan(0)
    expect(needsBrowser.items.every((l) => l.state === 'needs_browser')).toBe(true)
    const byHost = listLinks(state, new URLSearchParams({ host: 'example.com' }))
    expect(byHost.items.every((l) => l.host === 'example.com')).toBe(true)
  })

  it('pipelineOverview counts every state and groups hosts', () => {
    const state = createMockState()
    const overview = pipelineOverview(state)
    expect(Object.keys(overview.byState).sort()).toEqual([...PIPELINE_STATES].sort())
    const sum = Object.values(overview.byState).reduce((a, b) => a + b, 0)
    expect(sum).toBe(state.links.length)
    expect(overview.byHost.length).toBeGreaterThan(0)
    expect(overview.byHost[0].total).toBeGreaterThanOrEqual(
      overview.byHost[overview.byHost.length - 1].total,
    )
  })

  it('collectionsSummary counts every collection and finds login hosts', () => {
    const state = createMockState()
    const summary = collectionsSummary(state)
    const sum = COLLECTION_NAMES.reduce((n, c) => n + (summary.collections[c] ?? 0), 0)
    expect(sum).toBe(state.links.filter((l) => collectionOf(l) !== null).length)
    expect(summary.needsLoginHosts.length).toBeGreaterThan(0)
  })

  it('listLinks filters by collection', () => {
    const state = createMockState()
    const enriched = listLinks(state, new URLSearchParams({ collection: 'enriched' }))
    expect(enriched.total).toBeGreaterThan(0)
    expect(enriched.items.every((l) => collectionOf(l) === 'enriched')).toBe(true)
  })

  it('triage moves links between collections', () => {
    const state = createMockState()
    const target = state.links.find((l) => collectionOf(l) === 'enriched')!
    triageLinks(state, [target.id], 'archive')
    expect(collectionOf(getLink(state, target.id)!)).toBe('triaged')
    // TRIAGE on a parked (archived) link is an illegal transition — the
    // mock must not resurrect it the way the old undo did.
    expect(triageLinks(state, [target.id], 'read_now')).toBe(0)
    expect(getLink(state, target.id)!.state).toBe('archived')
    // Restore is the legal path back to the inbox.
    const res = restoreLinks(state, [target.id])
    expect(res.updated).toBe(1)
    expect(getLink(state, target.id)!.state).toBe('inbox')
    expect(collectionOf(getLink(state, target.id)!)).toBe('enriched')
  })

  it('restore only accepts parked links', () => {
    const state = createMockState()
    const parked = state.links.find((l) => collectionOf(l) === 'triaged') ?? state.links[0]!
    const live = state.links.find((l) => l.state === 'inbox')!
    const res = restoreLinks(state, [parked.id, live.id, 999_999])
    expect(res.updated).toBe(parked.state === 'archived' || parked.state === 'discarded' ? 1 : 0)
    expect(res.blocked).toContain(live.id)
    expect(res.missing).toContain(999_999)
  })

  it('ingest adds pending links and a done job', () => {
    const state = createMockState()
    const before = state.links.length
    const { job, created } = ingestUrls(state, ['https://a.example/1', 'https://b.example/2'], 'urls')
    expect(created).toBe(2)
    expect(state.links.length).toBe(before + 2)
    expect(job.status).toBe('done')
    expect(collectionOf(state.links[0]!)).toBe('pending')
  })

  it('runPipeline returns a RunResult and journal rows', () => {
    const state = createMockState()
    const result = runPipeline(state)
    expect(result.runId).toContain('mock-run')
    expect(result.summary.extract.input).toBeGreaterThan(0)
    expect(state.runRows.length).toBeGreaterThanOrEqual(4)
  })
})
