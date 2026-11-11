/**
 * Shared operations layer. BOTH the CLI and the future MCP server call these
 * functions; neither formats rows or builds queries itself. Projections are
 * compact by default: `extracted_content` (the bulky field) is included only
 * when `fields` asks for it.
 */
import type { Store, LinkFilter } from './store.js'
import type { Link, Status, Enrichment } from './types.js'
import type { LinkStateName, LinkState } from './fsm/index.js'
import type { LinkHistoryEntry } from './store.js'
import { isTerminal, parseLinkState } from './fsm/index.js'
import { planSweep, planPrune, type SweepPlan, type PrunePlan } from './sweep.js'
import { hostOfUrl } from './url.js'
import { collectionOfLink, type CollectionName } from './collections.js'
import type { TtlConfig } from './ttl.js'

/** Fields a caller can request in a link projection. */
export type LinkField =
  | 'id'
  | 'url'
  | 'urlHash'
  | 'title'
  | 'source'
  | 'addedAt'
  | 'note'
  | 'tags'
  | 'extracted_content'
  | 'extractedAt'
  | 'enrichment'
  | 'expiresAt'
  | 'expiryReason'
  | 'status'
  | 'category'
  | 'priority'
  | 'action'
  | 'confidence'
  | 'readMinutes'
  | 'needsBrowser'
  | 'createdAt'
  | 'updatedAt'
  | 'state'
  | 'stateData'
  | 'mediaReport'

/** Default projection: identity + triage state, no bulky content. */
export const DEFAULT_LINK_FIELDS: LinkField[] = [
  'id',
  'url',
  'title',
  'status',
  'category',
  'priority',
  'action',
  'expiresAt',
  'expiryReason',
  'readMinutes',
  'needsBrowser',
]

/** Compact link projection: only requested fields, extracted content opt-in. */
export type LinkProjection = Record<string, unknown>

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString()
}

/** Build a compact projection of one link. */
export function projectLink(link: Link, fields?: LinkField[]): LinkProjection {
  const wanted = new Set<LinkField>(fields && fields.length > 0 ? fields : DEFAULT_LINK_FIELDS)
  const out: Record<string, unknown> = {}
  for (const field of wanted) {
    switch (field) {
      case 'id': out.id = link.id; break
      case 'url': out.url = link.url; break
      case 'urlHash': out.urlHash = link.urlHash; break
      case 'title': out.title = link.title; break
      case 'source': out.source = link.source; break
      case 'addedAt': out.addedAt = iso(link.addedAt); break
      case 'note': out.note = link.note; break
      case 'tags': out.tags = link.tags; break
      case 'extracted_content': out.extracted_content = link.extractedContent; break
      case 'extractedAt': out.extractedAt = iso(link.extractedAt); break
      case 'enrichment': out.enrichment = link.enrichment; break
      case 'expiresAt': out.expiresAt = iso(link.expiresAt); break
      case 'expiryReason': out.expiryReason = link.expiryReason; break
      case 'status': out.status = link.status; break
      case 'category': out.category = link.category; break
      case 'priority': out.priority = link.priority; break
      case 'action': out.action = link.action; break
      case 'confidence': out.confidence = link.confidence; break
      case 'readMinutes': out.readMinutes = link.readMinutes; break
      case 'needsBrowser': out.needsBrowser = link.needsBrowser; break
      case 'createdAt': out.createdAt = iso(link.createdAt); break
      case 'updatedAt': out.updatedAt = iso(link.updatedAt); break
      case 'state': out.state = link.state; break
      case 'stateData': out.stateData = link.stateData; break
      case 'mediaReport': out.mediaReport = link.mediaReport; break
    }
  }
  return out
}

/**
 * The fields the web UI's `LinkSummary` type needs, as a projection field list.
 * `why_it_matters` comes from the enrichment blob, the rest are flattened
 * columns.
 */
export const UI_SUMMARY_FIELDS: LinkField[] = [
  'id',
  'url',
  'title',
  'status',
  'category',
  'priority',
  'action',
  'expiresAt',
  'expiryReason',
  'readMinutes',
  'enrichment',
]

/** The UI detail fields plus the fields the preview pane edits or reads:
 * note/tags (PATCH targets), source, the FSM state payload (frameable,
 * park error detail) and the lifecycle stamps. */
export const UI_DETAIL_FIELDS: LinkField[] = [
  ...UI_SUMMARY_FIELDS,
  'extracted_content',
  'confidence',
  'note',
  'tags',
  'source',
  'stateData',
  'needsBrowser',
  'createdAt',
  'updatedAt',
  'extractedAt',
]

/**
 * Shape one projected link the way the UI types expect: snake_case field
 * names (`expires_at`, `expiry_reason`, `read_minutes`), the enrichment
 * fields lifted to the top level (`why_it_matters`) and no nulls where the
 * UI types demand a value.
 */
export function shapeForUi(
  link: LinkProjection,
  options: { keepEnrichment?: boolean } = {},
): LinkProjection {
  const enrichment = (link['enrichment'] ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = { ...link }
  out['why_it_matters'] = (enrichment['why_it_matters'] as string | undefined) ?? ''
  if (options.keepEnrichment) out['enrichment'] = enrichment
  else delete out['enrichment']
  out['expires_at'] = link['expiresAt'] ?? null
  out['expiry_reason'] = link['expiryReason'] ?? null
  out['read_minutes'] = link['readMinutes'] ?? 0
  delete out['expiresAt']
  delete out['expiryReason']
  delete out['readMinutes']
  if (out['category'] == null) out['category'] = ''
  if (out['priority'] == null) out['priority'] = 'normal'
  if (out['action'] == null) out['action'] = 'read_now'
  if (out['title'] == null) out['title'] = ''
  // Detail-only fields stay absent unless the projection asked for them.
  if ('extracted_content' in link && out['extracted_content'] == null) {
    out['extracted_content'] = ''
  }
  if ('confidence' in link && out['confidence'] == null) out['confidence'] = 0
  return out
}

/** Filter accepted by ops.listLinks (a superset of the store filter). */
export interface ListLinksOptions {
  status?: Status
  /** Filter on the FSM state instead of the legacy status projection. */
  state?: LinkStateName
  category?: string
  /** Include only links whose expiresAt has passed as of now. */
  stale?: boolean
  /** Free-text query: FTS5 match over title/url/note/tags/summary. */
  q?: string
  /**
   * Ordering. 'relevance' ranks q hits by bm25 (sqlite stores); 'newest'
   * is created_at DESC, id DESC. When q is present and sort is absent the
   * order defaults to relevance — pass 'newest' to keep chronological
   * order. Ignored without q.
   */
  sort?: 'relevance' | 'newest'
  /** Filter on the host of the url, e.g. `example.com`. */
  host?: string
  /** Restrict to links belonging to one pipeline collection. */
  collection?: CollectionName
  fields?: LinkField[]
  limit?: number
  offset?: number
  now?: Date
}

/** List links as compact projections. */
export async function listLinks(
  store: Store,
  options: ListLinksOptions = {},
): Promise<LinkProjection[]> {
  const now = options.now ?? new Date()
  // The host filter and the collection filter are post-filters over full
  // link rows, so they share one store read; limit/offset are applied after
  // filtering (correct pages). The free-text query is pushed down to the
  // store (`match`), which answers it with the FTS5 index — it narrows the
  // candidates before the post-filters run. Ordering: an explicit
  // sort='newest' keeps chronological order; otherwise a present q
  // defaults to relevance (bm25 rank), matching the spec's "q present —
  // then relevance". When only q is present the store paginates directly.
  const postFilter = options.host !== undefined || options.collection !== undefined
  const sort =
    options.sort === 'newest'
      ? 'newest'
      : options.q
        ? 'relevance'
        : options.sort
  const filter: LinkFilter = {
    status: options.state !== undefined ? (options.state as Status) : options.status,
    byState: options.state !== undefined,
    category: options.category,
    staleAsOf: options.stale ? now : undefined,
    match: options.q ? options.q : undefined,
    sort,
    offset: postFilter ? undefined : options.offset,
  }
  const links = await store.listLinks(
    postFilter ? filter : { ...filter, limit: options.limit },
  )
  let out = links
  if (options.collection !== undefined) {
    out = out.filter((l) => collectionOfLink(l) === options.collection)
  }
  if (options.host !== undefined && options.host !== '') {
    const host = options.host.toLowerCase()
    out = out.filter((l) => hostOfUrl(l.url) === host)
  }
  if (postFilter && options.offset !== undefined && options.offset > 0) {
    out = out.slice(options.offset)
  }
  if (options.limit !== undefined) out = out.slice(0, options.limit)
  return out.map((l) => projectLink(l, options.fields))
}

/** Full record for one link. Extracted content included only when asked for. */
export async function getLink(
  store: Store,
  id: number,
  fields?: LinkField[],
): Promise<LinkProjection | null> {
  const link = await store.getLink(id)
  if (!link) return null
  return projectLink(link, fields)
}

export type TriageAction = Enrichment['action']

/** Mapping from triage action to lifecycle status. */
export const ACTION_TO_STATUS: Record<TriageAction, Status> = {
  read_now: 'inbox',
  schedule: 'scheduled',
  archive: 'archived',
  discard: 'discarded',
}

export interface TriageResult {
  requested: number[]
  updated: number
  status: Status
  missing: number[]
}

/**
 * Apply a triage action to link ids. `read_now` keeps the link in the inbox
 * (it flags intent), the rest move to their mapped status.
 */
export async function triage(
  store: Store,
  ids: number[],
  action: TriageAction,
  now: Date = new Date(),
): Promise<TriageResult> {
  const status = ACTION_TO_STATUS[action]
  const unique = [...new Set(ids)]
  if (unique.length === 0) return { requested: [], updated: 0, status, missing: [] }
  const updated = await triageViaEvents(store, unique, action, now)
  const missing: number[] = []
  for (const id of unique) {
    if (!(await store.getLink(id))) missing.push(id)
  }
  return { requested: unique, updated, status, missing }
}

/**
 * Apply a triage action through the FSM. Every link moves with one TRIAGE
 * event, so the history records exactly what the user did.
 */
async function triageViaEvents(
  store: Store,
  ids: number[],
  action: TriageAction,
  now: Date,
): Promise<number> {
  let updated = 0
  for (const id of ids) {
    const outcome = await store.applyEvent(id, {
      type: 'TRIAGE',
      action,
      at: now.toISOString(),
    })
    if (outcome.ok) updated += 1
  }
  return updated
}

export type { SweepPlan, PrunePlan }

export interface SweepOpsOptions {
  now?: Date
  /** Statuses to consider. Default: inbox + scheduled. */
  statuses?: Status[]
}

/**
 * Sweep: propose archiving stale links, grouped by category. Dry-run by
 * construction; applying is the caller's decision (`applySweep`).
 */
export async function sweep(
  store: Store,
  ttl: TtlConfig,
  options: SweepOpsOptions = {},
): Promise<SweepPlan> {
  const now = options.now ?? new Date()
  const links = await store.listLinks({})
  return planSweep(links, { now, ttl, statuses: options.statuses })
}

/** Execute a sweep plan: archive the stale ids. Never deletes. */
export async function applySweep(
  store: Store,
  plan: SweepPlan,
  now: Date = new Date(),
): Promise<number> {
  const ids = plan.groups.flatMap((g) => g.items.map((i) => i.linkId))
  if (ids.length === 0) return 0
  return store.updateStatus(ids, 'archived', now)
}

/** Prune proposal: the only delete path. No deletion happens here. */
export async function prune(
  store: Store,
  ttl: TtlConfig,
  options: SweepOpsOptions = {},
): Promise<PrunePlan> {
  const now = options.now ?? new Date()
  const links = await store.listLinks({})
  return planPrune(links, { now, ttl })
}

/**
 * Execute a prune plan. FSM semantics: the row is NOT removed. The link moves
 * to the terminal `deleted` state and the bulky content is purged, but
 * `url_hash` is kept so a re-import of the same URL is a no-op and can never
 * resurrect it. This refines the plan's hard-delete wording.
 */
export async function applyPrune(store: Store, plan: PrunePlan): Promise<number> {
  const ids = plan.items.map((i) => i.linkId)
  if (ids.length === 0) return 0
  return store.deleteLinks(ids)
}

/** Restore links to the inbox. Only parked states are restorable. */
export async function restore(
  store: Store,
  ids: number[],
  now: Date = new Date(),
): Promise<{ requested: number[]; updated: number; missing: number[]; blocked: number[] }> {
  const unique = [...new Set(ids)]
  const missing: number[] = []
  const blocked: number[] = []
  let updated = 0
  for (const id of unique) {
    const link = await store.getLink(id)
    if (!link) {
      missing.push(id)
      continue
    }
    const state = parseLinkState(link.state, link.stateData)
    if (isTerminal(state)) {
      blocked.push(id)
      continue
    }
    const outcome = await store.applyEvent(id, { type: 'RESTORE', at: now.toISOString() })
    if (outcome.ok) updated += 1
    else blocked.push(id)
  }
  return { requested: unique, updated, missing, blocked }
}

export interface RetryHeadlessResult {
  /** Links that were requeued for headless extraction. */
  updated: number[]
  /** Ids that do not exist. */
  missing: number[]
  /** Ids that exist but cannot be requeued from their current state. */
  blocked: number[]
}

/**
 * Re-trigger headless extraction for one or more links. This is an explicit,
 * never-automatic action: a captured link normally skips the headless extract
 * step entirely, and this is the escape hatch for when the user wants the
 * pipeline to fetch the page itself.
 *
 * The link goes back to the `created` queue with a RETRY event, which is the
 * state the extract stage claims.
 */
export async function retryHeadless(
  store: Store,
  ids: number[],
  now: Date = new Date(),
): Promise<RetryHeadlessResult> {
  const unique = [...new Set(ids)]
  const updated: number[] = []
  const missing: number[] = []
  const blocked: number[] = []
  for (const id of unique) {
    const link = await store.getLink(id)
    if (!link) {
      missing.push(id)
      continue
    }
    const outcome = await store.applyEvent(id, {
      type: 'RETRY',
      stage: 'extract',
      at: now.toISOString(),
    })
    if (outcome.ok) updated.push(id)
    else blocked.push(id)
  }
  return { updated, missing, blocked }
}

/** Append-only transition history for one link. */
export async function linkHistory(
  store: Store,
  id: number,
): Promise<LinkHistoryEntry[]> {
  return store.getHistory(id)
}

/** Current FSM state of one link. */
export async function linkState(store: Store, id: number): Promise<LinkState | null> {
  return store.getState(id)
}

/** Histogram: how many links sit in each state. */
export async function stateHistogram(
  store: Store,
): Promise<Record<LinkStateName, number>> {
  return store.countByState()
}

/** Range strings accepted by metricsSummary: `24h`, `7d`, `30d`, `2w`. */
export function parseRange(s: string): { ms: number; label: string } {
  const m = /^(\d+)\s*(h|d|w)$/.exec(s.trim())
  if (!m) throw new TypeError(`invalid range "${s}"; expected e.g. 24h, 7d, 30d`)
  const n = Number(m[1])
  const unit = m[2] as 'h' | 'd' | 'w'
  const hours = unit === 'h' ? n : unit === 'd' ? n * 24 : n * 24 * 7
  return { ms: hours * 60 * 60 * 1000, label: s.trim() }
}

export interface StageSummary {
  stage: string
  runs: number
  input: number
  ok: number
  errors: number
  avgDurationMs: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** Error counts keyed by `<kind>:<name>`, e.g. `extractor:defuddle`. */
  errorsByTag: Record<string, number>
  /** Counts keyed by `<kind>:<name>` for the other tagged metrics. */
  countsByTag: Record<string, number>
}

export interface MetricsSummary {
  since: string
  until: string
  stages: StageSummary[]
  /** Histogram of links per FSM state. */
  states: Record<LinkStateName, number>
}

/**
 * Aggregate metrics over a time range, one row per stage. Derived from the
 * `metrics` table so any Store implementation works.
 *
 * Aggregate counters are stored untagged (`errors`), per-source breakdowns
 * are stored tagged (`errors` with `{importer|extractor|model}`). Only the
 * untagged rows feed the totals so the two never double count.
 */
export async function metricsSummary(
  store: Store,
  range = '7d',
  now: Date = new Date(),
): Promise<MetricsSummary> {
  const { ms } = parseRange(range)
  const since = new Date(now.getTime() - ms)
  const rows = await store.listMetrics({ since })

  const byStage = new Map<string, StageSummary>()
  const stageOf = (stage: string): StageSummary => {
    let row = byStage.get(stage)
    if (!row) {
      row = {
        stage,
        runs: 0,
        input: 0,
        ok: 0,
        errors: 0,
        avgDurationMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        errorsByTag: {},
        countsByTag: {},
      }
      byStage.set(stage, row)
    }
    return row
  }

  const durations = new Map<string, number[]>()

  for (const row of rows) {
    const s = stageOf(row.stage)
    switch (row.key) {
      case 'input':
        s.runs += 1
        s.input += row.value
        break
      case 'ok':
        s.ok += row.value
        break
      case 'errors':
        if (row.tags && Object.keys(row.tags).length > 0) {
          for (const [kind, name] of Object.entries(row.tags)) {
            const key = `${kind}:${name}`
            s.errorsByTag[key] = (s.errorsByTag[key] ?? 0) + row.value
          }
        } else {
          s.errors += row.value
        }
        break
      case 'duration_ms': {
        const list = durations.get(row.stage) ?? []
        list.push(row.value)
        durations.set(row.stage, list)
        break
      }
      case 'tokens_in': s.tokensIn += row.value; break
      case 'tokens_out': s.tokensOut += row.value; break
      case 'cost_usd': s.costUsd += row.value; break
      default: {
        // Any other tagged metric (needs_browser, extractions, ...) lands in
        // countsByTag; untagged ones are ignored here.
        if (row.tags && Object.keys(row.tags).length > 0) {
          for (const [kind, name] of Object.entries(row.tags)) {
            const key = `${row.key} ${kind}:${name}`
            s.countsByTag[key] = (s.countsByTag[key] ?? 0) + row.value
          }
        }
        break
      }
    }
  }

  for (const [stage, list] of durations) {
    const s = byStage.get(stage)
    if (s && list.length > 0) {
      s.avgDurationMs = list.reduce((a, b) => a + b, 0) / list.length
    }
  }

  const stages = [...byStage.values()].sort((a, b) => (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0))
  const states = await store.countByState()
  return { since: since.toISOString(), until: now.toISOString(), stages, states }
}
