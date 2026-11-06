/**
 * Pipeline overview: the shape of the whole corpus at a glance.
 *
 * Every surface (CLI `overview`, MCP `links.overview`, the web UI Pipeline
 * tab) reads this one function, so the numbers can never disagree. The
 * overview is derived from the link rows themselves: the FSM state, the host
 * of the url and the reason carried in the state payload.
 */
import type { Store, LinkFilter, Status } from './store.js'
import { projectLink, type LinkField } from './ops.js'
import { hostOfUrl } from './url.js'
import { LINK_STATES, type LinkStateName } from './fsm/index.js'
import {
  emptyParkReasonCounts,
  PARK_REASONS,
  parkedReasonOf,
  type ParkReason,
} from './pipeline/park-reason.js'

/** How many hosts the overview reports. */
export const OVERVIEW_TOP_HOSTS = 50

/** One host row of the overview: the total plus the per-state breakdown. */
export interface OverviewHost {
  host: string
  total: number
  byState: Record<LinkStateName, number>
  /** The parked links of this host, broken down by park reason. */
  byParkReason: Record<ParkReason, number>
}

/**
 * The whole overview: a state histogram, a park-reason histogram and the
 * busiest hosts.
 */
export interface PipelineOverview {
  /** How many links sit in each state. Every state is present, even at zero. */
  byState: Record<LinkStateName, number>
  /**
   * How many parked links carry each park reason. Every reason is present,
   * even at zero: `login_wall`, `bot_block`, `js_shell`, `http_error`,
   * `timeout`, `review_only` and `unknown` (the legacy rows parked before
   * the classes existed).
   */
  byParkReason: Record<ParkReason, number>
  /** The busiest hosts first, capped at `topHosts`. */
  byHost: OverviewHost[]
  /** The number of links the overview covers. */
  total: number
}

/** An empty state histogram: every known state at zero. */
export function emptyStateCounts(): Record<LinkStateName, number> {
  const out = {} as Record<LinkStateName, number>
  for (const name of LINK_STATES) out[name] = 0
  return out
}

/**
 * The reason carried by a state payload, when there is one: `login_wall`,
 * `skip_host`, `throttled`, `private_404`, and so on. Returns null when the
 * state carries no reason.
 */
export function reasonOfStateData(
  stateData: Record<string, unknown> | null,
): string | null {
  if (!stateData) return null
  // needs_browser and deferred carry a `reason`; errored carries an `error`.
  const value = stateData['reason'] ?? stateData['error']
  if (typeof value !== 'string' || value === '') return null
  // Deferred reasons are prefixed by the guard (`blocked:login_wall`).
  const cleaned = value.replace(/^blocked:/, '')
  return cleaned === '' ? null : cleaned
}

/** One row of the pipeline list: the link plus its pipeline status. */
export interface PipelineRow {
  id: number
  url: string
  host: string
  title: string
  state: LinkStateName
  /** Why the link sits in this state, when the state records a reason. */
  reason: string | null
  /**
   * The park reason class of a parked link (`login_wall`, `bot_block`,
   * `js_shell`, `http_error`, `timeout`, `review_only`), or null when the
   * link is not parked. A legacy row without a stored reason parses as
   * `unknown`.
   */
  parkReason: ParkReason | null
  /** When the link is retried, for deferred links. */
  nextAttemptAt: string | null
  updatedAt: string
}

export interface PipelineListOptions {
  /** Filter on one FSM state. */
  state?: LinkStateName
  /** Filter on the host of the url. */
  host?: string
  /** Filter on the park reason class of the parked links. */
  parkReason?: ParkReason
  /** Free-text match over the url and the title. */
  q?: string
  limit?: number
  offset?: number
  /** The projection fields to ask the store for. Defaults to the pipeline row. */
  fields?: LinkField[]
}

/**
 * The projection fields a pipeline row needs. `stateData` carries the reason
 * and the next attempt time, `updatedAt` the last change.
 */
export const PIPELINE_FIELDS: LinkField[] = [
  'id',
  'url',
  'title',
  'state',
  'stateData',
  'updatedAt',
]

/** Build one pipeline row from a projected link. */
export function toPipelineRow(link: Record<string, unknown>): PipelineRow {
  const stateData = (link['stateData'] ?? null) as Record<string, unknown> | null
  const state = String(link['state'] ?? 'created') as LinkStateName
  const nextAttemptAt =
    stateData && typeof stateData['nextAttemptAt'] === 'string'
      ? (stateData['nextAttemptAt'] as string)
      : null
  const updated = link['updatedAt']
  return {
    id: Number(link['id']),
    url: String(link['url'] ?? ''),
    host: hostOfUrl(String(link['url'] ?? '')),
    title: String(link['title'] ?? ''),
    state,
    reason: reasonOfStateData(stateData),
    parkReason: parkedReasonOf(state, stateData),
    nextAttemptAt,
    updatedAt: typeof updated === 'string' ? updated : '',
  }
}

/**
 * List the links of the pipeline with their state, reason and retry time.
 * The state filter is pushed down to the store; the host filter and the
 * free-text query are applied here because the store does not index them.
 */
export async function listPipelineLinks(
  store: Store,
  options: PipelineListOptions = {},
): Promise<PipelineRow[]> {
  const filter: LinkFilter = {}
  if (options.state !== undefined) {
    filter.status = options.state as Status
    filter.byState = true
  }
  const links = await store.listLinks(filter)
  let rows = links.map((l) => toPipelineRow(projectLink(l, options.fields ?? PIPELINE_FIELDS)))
  if (options.host !== undefined && options.host !== '') {
    const host = options.host.toLowerCase()
    rows = rows.filter((r) => r.host === host)
  }
  if (options.parkReason !== undefined) {
    rows = rows.filter((r) => r.parkReason === options.parkReason)
  }
  if (options.q !== undefined && options.q !== '') {
    const q = options.q.toLowerCase()
    rows = rows.filter(
      (r) => r.url.toLowerCase().includes(q) || r.title.toLowerCase().includes(q),
    )
  }
  const offset = options.offset ?? 0
  if (offset > 0) rows = rows.slice(offset)
  if (options.limit !== undefined) rows = rows.slice(0, options.limit)
  return rows
}

/**
 * The pipeline overview: how many links sit in each state, how many parked
 * links carry each park reason, and the busiest hosts with their breakdowns.
 */
export async function pipelineOverview(
  store: Store,
  options: { topHosts?: number } = {},
): Promise<PipelineOverview> {
  const links = await store.listLinks({})
  const byState = emptyStateCounts()
  const byParkReason = emptyParkReasonCounts()
  const hosts = new Map<string, OverviewHost>()
  let total = 0

  for (const link of links) {
    const row = toPipelineRow(projectLink(link, PIPELINE_FIELDS))
    total += 1
    byState[row.state] = (byState[row.state] ?? 0) + 1
    // The park class comes from the row itself, not from the projection.
    const parkReason = parkedReasonOf(link.state, link.stateData)
    if (parkReason !== null) byParkReason[parkReason] += 1
    if (row.host === '') continue
    let host = hosts.get(row.host)
    if (!host) {
      host = {
        host: row.host,
        total: 0,
        byState: emptyStateCounts(),
        byParkReason: emptyParkReasonCounts(),
      }
      hosts.set(row.host, host)
    }
    host.total += 1
    host.byState[row.state] = (host.byState[row.state] ?? 0) + 1
    if (parkReason !== null) host.byParkReason[parkReason] += 1
  }

  const topHosts = options.topHosts ?? OVERVIEW_TOP_HOSTS
  const byHost = [...hosts.values()]
    .sort((a, b) => b.total - a.total || a.host.localeCompare(b.host))
    .slice(0, topHosts)

  return { byState, byParkReason, byHost, total }
}

/**
 * The park reasons that have parked links, in `PARK_REASONS` order. A reason
 * with no parked links offers nothing to filter on.
 */
export function parkReasonsWithLinks(byParkReason: Record<ParkReason, number>): ParkReason[] {
  return PARK_REASONS.filter((reason) => (byParkReason[reason] ?? 0) > 0)
}
