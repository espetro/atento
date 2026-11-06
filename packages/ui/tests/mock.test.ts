import { describe, expect, it } from 'vitest'
import { createMockState, listLinks, pipelineOverview, sweep } from '../src/mock/data'
import { PIPELINE_STATES } from '../src/lib/types'

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

  it('sweep groups expired non-archived links by category', () => {
    const state = createMockState()
    const res = sweep(state)
    for (const g of res.groups) {
      expect(g.links.length).toBeGreaterThan(0)
      expect(g.links.every((l) => l.category === g.category)).toBe(true)
      const now = Date.now()
      expect(
        g.links.every((l) => l.expires_at && new Date(l.expires_at).getTime() < now),
      ).toBe(true)
      expect(g.links.every((l) => l.status !== 'archived' && l.status !== 'discarded')).toBe(true)
    }
  })
})
