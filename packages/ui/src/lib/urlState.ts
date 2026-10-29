export interface UrlState {
  view: 'inbox' | 'sweep' | 'metrics'
  q: string
  status: string
  category: string
  selected: number | null
}

export function parseUrlState(search: URLSearchParams): UrlState {
  const v = search.get('view')
  const view = v === 'sweep' || v === 'metrics' ? v : 'inbox'
  const sel = search.get('selected')
  return {
    view,
    q: search.get('q') ?? '',
    status: search.get('status') ?? '',
    category: search.get('category') ?? '',
    selected: sel != null && sel !== '' && !Number.isNaN(Number(sel)) ? Number(sel) : null,
  }
}

export function toUrlState(state: UrlState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.view !== 'inbox') p.set('view', state.view)
  if (state.q) p.set('q', state.q)
  if (state.status) p.set('status', state.status)
  if (state.category) p.set('category', state.category)
  if (state.selected != null) p.set('selected', String(state.selected))
  return p
}
