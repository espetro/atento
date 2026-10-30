import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import PipelineHarness from './helpers/PipelineHarness.svelte'
import type { UrlState } from '../src/lib/urlState'

const OVERVIEW = {
  byState: {
    created: 3,
    extracting: 0,
    extracted: 1,
    needs_browser: 2,
    deferred: 1,
    enriching: 0,
    inbox: 4,
    scheduled: 0,
    archived: 0,
    discarded: 0,
    errored: 1,
    deleted: 0,
  },
  byHost: [
    {
      host: 'gated.example',
      total: 2,
      byState: {
        created: 0,
        extracting: 0,
        extracted: 0,
        needs_browser: 2,
        deferred: 0,
        enriching: 0,
        inbox: 0,
        scheduled: 0,
        archived: 0,
        discarded: 0,
        errored: 0,
        deleted: 0,
      },
    },
  ],
}

const LINKS = {
  items: [
    {
      id: 1,
      title: 'Gated post',
      url: 'https://gated.example/post',
      category: '',
      priority: 'normal',
      why_it_matters: '',
      read_minutes: 0,
      status: 'inbox',
      expires_at: null,
      expiry_reason: null,
      action: 'read_now',
      state: 'needs_browser',
      reason: 'login_wall',
      host: 'gated.example',
      next_attempt_at: null,
      updated_at: '2026-10-30T00:00:00.000Z',
    },
    {
      id: 2,
      title: 'Slow post',
      url: 'https://slow.example/post',
      category: '',
      priority: 'normal',
      why_it_matters: '',
      read_minutes: 0,
      status: 'inbox',
      expires_at: null,
      expiry_reason: null,
      action: 'read_now',
      state: 'deferred',
      reason: 'throttled',
      host: 'slow.example',
      next_attempt_at: '2026-10-30T12:00:00.000Z',
      updated_at: '2026-10-30T00:00:00.000Z',
    },
  ],
  total: 2,
}

function urlState(overrides: Partial<UrlState> = {}): UrlState {
  return {
    view: 'pipeline',
    q: '',
    status: '',
    category: '',
    state: '',
    host: '',
    selected: null,
    ...overrides,
  }
}

/** Stub the two API calls the Pipeline view makes. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      const body = path.startsWith('/api/pipeline') ? OVERVIEW : LINKS
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

beforeEach(() => {
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Pipeline view', () => {
  it('renders a row per link with the state badge, reason and host', async () => {
    render(PipelineHarness, { props: { url: urlState(), setUrl: vi.fn() } })
    await waitFor(() => expect(screen.getAllByTestId('pipeline-row')).toHaveLength(2))
    const rows = screen.getAllByTestId('pipeline-row')
    expect(rows[0]?.textContent).toContain('needs_browser')
    expect(rows[0]?.textContent).toContain('login_wall')
    expect(rows[0]?.textContent).toContain('gated.example')
    expect(screen.getAllByTestId('state-badge')).toHaveLength(2)
  })

  it('shows the next retry time for deferred links', async () => {
    render(PipelineHarness, { props: { url: urlState(), setUrl: vi.fn() } })
    await waitFor(() => expect(screen.getAllByTestId('pipeline-row')).toHaveLength(2))
    const rows = screen.getAllByTestId('pipeline-row')
    expect(rows[1]?.textContent).toContain('2026-10-30 12:00')
  })

  it('renders a state chip per pipeline state with the counts', async () => {
    render(PipelineHarness, { props: { url: urlState(), setUrl: vi.fn() } })
    await waitFor(() => expect(screen.getAllByTestId('state-chip').length).toBeGreaterThan(12))
    const chips = screen.getAllByTestId('state-chip')
    const chip = chips.find((c) => c.getAttribute('data-state') === 'needs_browser')
    expect(chip?.textContent).toContain('needs_browser')
    // The count comes from the overview query, so it lands a tick later.
    await waitFor(() => expect(chip?.textContent).toContain('2'))
  })

  it('filters by state through setUrl', async () => {
    const setUrl = vi.fn()
    render(PipelineHarness, { props: { url: urlState(), setUrl } })
    await waitFor(() => expect(screen.getAllByTestId('state-chip').length).toBeGreaterThan(12))
    const chip = screen
      .getAllByTestId('state-chip')
      .find((c) => c.getAttribute('data-state') === 'deferred')
    await fireEvent.click(chip!)
    expect(setUrl).toHaveBeenCalledWith({ state: 'deferred' })
  })

  it('filters by host through setUrl', async () => {
    const setUrl = vi.fn()
    render(PipelineHarness, { props: { url: urlState(), setUrl } })
    await waitFor(() => expect(screen.getByTestId('host-filter')).toBeTruthy())
    // The options come from the overview query, so wait for one to land.
    await waitFor(() => expect(screen.getByTestId('host-filter').textContent).toContain('gated.example'))
    await fireEvent.change(screen.getByTestId('host-filter'), {
      target: { value: 'gated.example' },
    })
    expect(setUrl).toHaveBeenCalledWith({ host: 'gated.example' })
  })

  it('searches through setUrl', async () => {
    const setUrl = vi.fn()
    render(PipelineHarness, { props: { url: urlState(), setUrl } })
    await waitFor(() => expect(screen.getByTestId('pipeline-search')).toBeTruthy())
    await fireEvent.input(screen.getByTestId('pipeline-search'), {
      target: { value: 'gated' },
    })
    expect(setUrl).toHaveBeenCalledWith({ q: 'gated' })
  })

  it('opens the detail drawer on a row click', async () => {
    const setUrl = vi.fn()
    render(PipelineHarness, { props: { url: urlState(), setUrl } })
    await waitFor(() => expect(screen.getAllByTestId('pipeline-row')).toHaveLength(2))
    await fireEvent.click(screen.getAllByTestId('pipeline-row')[0]!)
    expect(setUrl).toHaveBeenCalledWith({ selected: 1 })
  })
})
