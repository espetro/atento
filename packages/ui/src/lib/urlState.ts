import { COLLECTION_NAMES, LAYOUT_MODES, type CollectionName, type LayoutMode } from './types'

export type { LayoutMode } from './types'

export type ViewName = 'triage' | 'attention' | 'run' | 'settings' | 'metrics'

export const VIEW_NAMES: readonly ViewName[] = ['triage', 'attention', 'run', 'settings', 'metrics']

export const DEFAULT_COLLECTION: CollectionName = 'enriched'

export const DEFAULT_LAYOUT: LayoutMode = 'right'

export interface UrlState {
  view: ViewName
  /** Pipeline collection the list shows; '' = the view's default. */
  collection: string
  /** Free-text search over url+title. */
  q: string
  /** FSM state filter. */
  state: string
  category: string
  host: string
  stale: boolean
  selected: number | null
  /** Preview panel placement: right column | bottom dock | hidden. */
  layout: LayoutMode
  /** Open dialog, e.g. 'ingest' or 'help'. */
  dialog: '' | 'ingest' | 'help'
}

const COLLECTION_SET = new Set<string>(COLLECTION_NAMES)
const LAYOUT_SET = new Set<string>(LAYOUT_MODES)

export function parseUrlState(search: URLSearchParams): UrlState {
  const v = search.get('view')
  const view = (VIEW_NAMES as readonly string[]).includes(v ?? '') ? (v as ViewName) : 'triage'
  const sel = search.get('selected')
  const layout = search.get('layout')
  const dialog = search.get('dialog')
  const collection = search.get('collection') ?? ''
  return {
    view,
    collection: COLLECTION_SET.has(collection) ? collection : '',
    q: search.get('q') ?? '',
    state: search.get('state') ?? '',
    category: search.get('category') ?? '',
    host: search.get('host') ?? '',
    stale: search.get('stale') === '1' || search.get('stale') === 'true',
    selected: sel != null && sel !== '' && !Number.isNaN(Number(sel)) ? Number(sel) : null,
    layout: LAYOUT_SET.has(layout ?? '') ? (layout as LayoutMode) : DEFAULT_LAYOUT,
    dialog: dialog === 'ingest' || dialog === 'help' ? dialog : '',
  }
}

/** The collection a view actually lists when ?collection= is absent. */
export function effectiveCollection(url: UrlState): string {
  if (url.collection !== '') return url.collection
  if (url.view === 'attention') return 'needs_login'
  return DEFAULT_COLLECTION
}

export function toUrlState(state: UrlState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.view !== 'triage') p.set('view', state.view)
  // Only explicit collections serialize; the view default fills the gap.
  if (state.collection !== '') p.set('collection', state.collection)
  if (state.q) p.set('q', state.q)
  if (state.state) p.set('state', state.state)
  if (state.category) p.set('category', state.category)
  if (state.host) p.set('host', state.host)
  if (state.stale) p.set('stale', '1')
  if (state.selected != null) p.set('selected', String(state.selected))
  if (state.layout !== DEFAULT_LAYOUT) p.set('layout', state.layout)
  if (state.dialog) p.set('dialog', state.dialog)
  return p
}
