export interface UrlState {
  view: 'inbox' | 'pipeline' | 'sweep' | 'metrics'
  q: string
  status: string
  category: string
  /** The FSM state filter of the Pipeline view. */
  state: string
  /** The host filter of the Pipeline view. */
  host: string
  selected: number | null
}

export function parseUrlState(search: URLSearchParams): UrlState {
  const v = search.get('view')
  const view = v === 'sweep' || v === 'metrics' || v === 'pipeline' ? v : 'inbox'
  const sel = search.get('selected')
  return {
    view,
    q: search.get('q') ?? '',
    status: search.get('status') ?? '',
    category: search.get('category') ?? '',
    state: search.get('state') ?? '',
    host: search.get('host') ?? '',
    selected: sel != null && sel !== '' && !Number.isNaN(Number(sel)) ? Number(sel) : null,
  }
}

export function toUrlState(state: UrlState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.view !== 'inbox') p.set('view', state.view)
  if (state.q) p.set('q', state.q)
  if (state.status) p.set('status', state.status)
  if (state.category) p.set('category', state.category)
  if (state.state) p.set('state', state.state)
  if (state.host) p.set('host', state.host)
  if (state.selected != null) p.set('selected', String(state.selected))
  return p
}
