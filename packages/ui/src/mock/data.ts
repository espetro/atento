import type {
  BrowserAdaptersResponse,
  CollectionName,
  CollectionsSummary,
  ConfigInfo,
  IngestJob,
  LinkSummary,
  LinksResponse,
  MetricsResponse,
  PipelineOverviewResponse,
  PipelineState,
  Priority,
  LinkStatus as Status,
  RunJournalRow,
  RunResult,
} from '../lib/types'
import { COLLECTION_NAMES, PIPELINE_STATES } from '../lib/types'

const CATEGORIES = [
  'ai',
  'engineering',
  'design',
  'product',
  'security',
  'ops',
  'reading',
]

const DOMAINS = [
  'https://example.com',
  'https://blog.acme.dev',
  'https://news.ycombinator.com',
  'https://docs.internal.example.org',
  'https://research.paper.io',
  'https://weekly.example.net',
  'https://x.com',
  'https://linkedin.com',
]

const TITLES = [
  'Streaming structured outputs at scale',
  'A practical guide to agent memory',
  'Why boring infrastructure wins',
  'Designing triage interfaces for humans',
  'The quiet return of static sites',
  'Observability for LLM pipelines',
  'Notes on retrieval quality',
  'Building resilient webhooks',
  'Cost control for inference workloads',
  'A field guide to prompt evaluation',
  'Understanding expiry semantics',
  'Ranking without retraining',
  'Lessons from migrating a monolith',
  'The economics of reading lists',
  'Structured logging for pipelines',
  'Small models, sharp prompts',
  'Debugging flaky extractions',
  'How teams triage information',
  'Caching strategies for embeddings',
  'Progressive disclosure in dense UIs',
  'Sweeping stale knowledge bases',
]

const WHYS = [
  'Directly affects how we rank inbox items.',
  'Reframes the approach we took last quarter.',
  'Contains a benchmark we can reuse.',
  'Explains a failure mode we hit last sprint.',
  'Useful background for the upcoming rewrite.',
  'Has a decision framework we lack internally.',
  'Compares three tools we already evaluate.',
  'Short enough to skim before the meeting.',
]

const REASONS = [
  'Event-driven content, expires after the conference.',
  'Version-specific API behaviour.',
  'Timeboxed announcement window.',
  'Pricing changes periodically.',
  'Reference material, still useful.',
]

const EXTRACTED = `## Overview

This is extracted article body text for the mock link inbox. It contains a
paragraph of prose so the reader tab has something meaningful to render.

- Bullet one
- Bullet two

\`\`\`ts
const answer = 42
\`\`\`

> A pull quote for visual rhythm.

Read more at the source.
`

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(20261029)

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]
}

/** Park reason strings the mock assigns to non-happy states. */
const STATE_REASONS: Record<string, { reason: string; reasonClass?: string }> = {
  needs_browser: { reason: 'login_wall', reasonClass: 'login_wall' },
  deferred: { reason: 'throttled', reasonClass: 'rate_limit' },
  errored: { reason: 'private_404', reasonClass: 'http_error' },
  created: { reason: 'queued', reasonClass: 'unknown' },
}

export interface MockLink extends LinkSummary {
  confidence: number
  extracted_content: string
  enrichment: Record<string, unknown>
  note: string | null
  tags: string[] | null
  source: string
  needsBrowser: boolean
  stateData: Record<string, unknown> | null
}

function makeLink(id: number, stateOverride?: PipelineState): MockLink {
  const priority: Priority = pick(['low', 'normal', 'high'] as const)
  const status: Status =
    stateOverride === 'archived' || stateOverride === 'discarded' || stateOverride === 'scheduled'
      ? (stateOverride as Status)
      : id <= 100
        ? 'inbox'
        : pick(['inbox', 'inbox', 'scheduled', 'archived', 'discarded'] as const)
  const ageDays = Math.floor(rand() * 120)
  const expires = new Date(Date.now() - ageDays * 86_400_000)
  const hasExpiry = rand() > 0.25
  const minutes = 1 + Math.floor(rand() * 25)
  const state: PipelineState =
    stateOverride ??
    (id % 11 === 0
      ? pick(['needs_browser', 'deferred', 'errored', 'created', 'extracting'] as const)
      : status === 'archived'
        ? 'archived'
        : status === 'discarded'
          ? 'discarded'
          : status === 'scheduled'
            ? 'scheduled'
            : 'inbox')
  const url = `${pick(DOMAINS)}/${pick(TITLES).toLowerCase().replace(/[^a-z]+/g, '-')}/${id}`
  const category = pick(CATEGORIES)
  const why = pick(WHYS)
  const enrichment: Record<string, unknown> = {
    category,
    priority,
    why_it_matters: why,
    read_minutes: minutes,
    action: 'read_now',
    expires_at: hasExpiry ? expires.toISOString() : null,
    expiry_reason: hasExpiry ? pick(REASONS) : null,
    confidence: Number((0.55 + rand() * 0.45).toFixed(3)),
  }
  const parked = STATE_REASONS[state]
  return {
    id,
    title: `${pick(TITLES)} (${id})`,
    url,
    category,
    priority,
    why_it_matters: why,
    read_minutes: minutes,
    status,
    expires_at: hasExpiry ? expires.toISOString() : null,
    expiry_reason: hasExpiry ? pick(REASONS) : null,
    action: pick(['read_now', 'schedule', 'archive', 'discard'] as const),
    confidence: Number((0.55 + rand() * 0.45).toFixed(3)),
    extracted_content: EXTRACTED.replace('the mock link inbox', `mock link inbox #${id}`),
    enrichment,
    state,
    reason: parked?.reason ?? null,
    stateData: parked
      ? { reason: parked.reason, reasonClass: parked.reasonClass ?? 'unknown', stage: 'extract' }
      : state === 'inbox'
        ? { frameable: id % 3 === 0 }
        : null,
    host: new URL(url).host,
    next_attempt_at:
      state === 'deferred'
        ? new Date(Date.now() + Math.floor(rand() * 3_600_000)).toISOString()
        : null,
    updated_at: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
    note: null,
    tags: null,
    source: 'seed',
    needsBrowser: state === 'needs_browser',
  }
}

export interface MockState {
  links: MockLink[]
  nextId: number
  ingestJobs: Map<string, import('../lib/types').IngestJob>
  runRows: RunJournalRow[]
}

export function createMockState(count = 128): MockState {
  return {
    links: Array.from({ length: count }, (_, i) => makeLink(i + 1)),
    nextId: count + 1,
    ingestJobs: new Map(),
    runRows: [],
  }
}

// ---- collections (mirrors packages/core/src/collections.ts) ----------------

/** Demo review hosts — parked review_only links land in the review collection. */
const REVIEW_HOSTS = new Set(['x.com', 'linkedin.com'])

function reasonClassOf(link: CollectionLink): string {
  const data = link.stateData
  if (data && typeof data['reasonClass'] === 'string') return data['reasonClass'] as string
  return 'unknown'
}

export interface CollectionLink {
  state?: string
  stateData?: Record<string, unknown> | null
  host?: string
  category: string
}

export function collectionOf(link: CollectionLink): CollectionName | null {
  switch (link.state) {
    case 'created':
    case 'extracting':
    case 'extracted':
    case 'enriching':
      return 'pending'
    case 'inbox':
      return link.category != null ? 'enriched' : 'pending'
    case 'deferred': {
      const cls = reasonClassOf(link)
      if (link.host != null && REVIEW_HOSTS.has(link.host)) return 'review'
      if (cls === 'login_wall') return 'needs_login'
      if (cls === 'rate_limit') return 'pending'
      if (cls === 'unknown') return 'pending'
      return 'blocked'
    }
    case 'needs_browser': {
      const cls = reasonClassOf(link)
      if (link.host != null && REVIEW_HOSTS.has(link.host)) return 'review'
      if (cls === 'login_wall') return 'needs_login'
      return 'blocked'
    }
    case 'errored':
      return 'errored'
    case 'scheduled':
    case 'archived':
    case 'discarded':
      return 'triaged'
    default:
      return null
  }
}

export function collectionsSummary(state: MockState): CollectionsSummary {
  const collections: Partial<Record<CollectionName, number>> = {}
  const loginHosts = new Map<string, number>()
  for (const name of COLLECTION_NAMES) collections[name] = 0
  for (const l of state.links) {
    const c = collectionOf(l)
    if (!c) continue
    collections[c] = (collections[c] ?? 0) + 1
    if (c === 'needs_login' && l.host) {
      loginHosts.set(l.host, (loginHosts.get(l.host) ?? 0) + 1)
    }
  }
  return {
    total: state.links.length,
    collections,
    needsLoginHosts: [...loginHosts.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count),
  }
}

// ---- links ------------------------------------------------------------------

export function listLinks(state: MockState, params: URLSearchParams): LinksResponse {
  const status = params.get('status')
  const category = params.get('category')
  const pipelineState = params.get('state')
  const collection = params.get('collection')
  const host = params.get('host')
  const q = params.get('q')?.toLowerCase() ?? ''
  const stale = params.get('stale') === '1' || params.get('stale') === 'true'
  const limit = Number(params.get('limit') ?? 50)
  const offset = Number(params.get('offset') ?? 0)
  const now = Date.now()

  let items = state.links.filter((l) => {
    if (collection && collectionOf(l) !== collection) return false
    if (status && l.status !== status) return false
    if (category && l.category !== category) return false
    if (pipelineState && l.state !== pipelineState) return false
    if (host && l.host !== host) return false
    if (q && !(`${l.title} ${l.url} ${l.why_it_matters}`.toLowerCase().includes(q))) return false
    if (stale && !(l.expires_at && new Date(l.expires_at).getTime() < now)) return false
    return true
  })

  const total = items.length
  items = items.slice(offset, offset + limit)
  return { items, total }
}

export function getLink(state: MockState, id: number): MockLink | undefined {
  return state.links.find((l) => l.id === id)
}

export function patchLink(
  state: MockState,
  id: number,
  patch: { title?: string | null; note?: string | null; tags?: string[] | null },
): MockLink | undefined {
  const l = getLink(state, id)
  if (!l) return undefined
  if (patch.title !== undefined) l.title = patch.title ?? ''
  if (patch.note !== undefined) l.note = patch.note
  if (patch.tags !== undefined) l.tags = patch.tags
  l.updated_at = new Date().toISOString()
  return l
}

/** Triage mutates state so collection membership follows. */
export function triageLinks(
  state: MockState,
  ids: number[],
  action: 'read_now' | 'schedule' | 'archive' | 'discard',
): number {
  const nextState: Record<string, PipelineState> = {
    read_now: 'inbox',
    schedule: 'scheduled',
    archive: 'archived',
    discard: 'discarded',
  }
  let updated = 0
  for (const l of state.links) {
    // FSM legality (mirrors packages/core/src/fsm/table.ts): parked
    // terminal states only accept RESTORE/DELETE — a TRIAGE action on an
    // archived/discarded/deleted link is an ILLEGAL_TRANSITION no-op.
    if (l.state === 'archived' || l.state === 'discarded' || l.state === 'deleted') continue
    if (ids.includes(l.id)) {
      l.state = nextState[action] ?? 'inbox'
      l.status = (action === 'read_now' ? 'inbox' : action + 'd') as Status
      if (action === 'read_now') l.status = 'inbox'
      if (action === 'schedule') l.status = 'scheduled'
      if (action === 'archive') l.status = 'archived'
      if (action === 'discard') l.status = 'discarded'
      l.updated_at = new Date().toISOString()
      updated++
    }
  }
  return updated
}

/**
 * Restore parked links to the inbox — mirrors ops.restore: only
 * archived/discarded links are restorable; everything else is blocked.
 */
export function restoreLinks(
  state: MockState,
  ids: number[],
): { updated: number; missing: number[]; blocked: number[] } {
  const missing: number[] = []
  const blocked: number[] = []
  let updated = 0
  const seen = new Set<number>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const l = getLink(state, id)
    if (!l) {
      missing.push(id)
      continue
    }
    if (l.state !== 'archived' && l.state !== 'discarded') {
      blocked.push(id)
      continue
    }
    l.state = 'inbox'
    l.status = 'inbox' as Status
    l.updated_at = new Date().toISOString()
    updated += 1
  }
  return { updated, missing, blocked }
}

/** Ingest: add links in `created` (pending) and return a job record. */
export function ingestUrls(
  state: MockState,
  urls: string[],
  source: string,
): { job: import('../lib/types').IngestJob; created: number } {
  const now = new Date().toISOString()
  const jobId = `mock-${Date.now().toString(36)}`
  let created = 0
  for (const u of urls.slice(0, 500)) {
    const id = state.nextId++
    const link = makeLink(id, 'created')
    link.url = u
    try {
      link.host = new URL(u).host
    } catch {
      /* keep generated host */
    }
    link.title = u
    link.source = source
    link.stateData = { reason: 'queued', reasonClass: 'unknown', stage: 'import' }
    state.links.unshift(link)
    created++
  }
  const job: import('../lib/types').IngestJob = {
    jobId,
    source,
    status: 'done',
    total: created,
    done: created,
    cursor: created,
    runId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
  }
  state.ingestJobs.set(jobId, job)
  return { job, created }
}

// ---- pipeline overview -------------------------------------------------------

export function pipelineOverview(state: MockState): PipelineOverviewResponse {
  const byState = Object.fromEntries(PIPELINE_STATES.map((s) => [s, 0])) as Record<
    PipelineState,
    number
  >
  const hosts = new Map<string, { total: number; byState: Record<string, number> }>()
  for (const link of state.links) {
    const s = (link.state ?? 'inbox') as PipelineState
    byState[s] = (byState[s] ?? 0) + 1
    const host = link.host ?? ''
    if (host === '') continue
    const row = hosts.get(host) ?? { total: 0, byState: {} }
    row.total += 1
    row.byState[s] = (row.byState[s] ?? 0) + 1
    hosts.set(host, row)
  }
  return {
    byState,
    byParkReason: {},
    byHost: [...hosts.entries()]
      .map(([host, row]) => ({ host, total: row.total, byState: row.byState }))
      .sort((a, b) => b.total - a.total || a.host.localeCompare(b.host))
      .slice(0, 50),
  }
}

// ---- runs --------------------------------------------------------------------

export function listRuns(state: MockState, limit = 20): RunJournalRow[] {
  return [...state.runRows].sort((a, b) => b.id - a.id).slice(0, limit)
}

export function addRunRow(state: MockState, stage: string, status: string): RunJournalRow {
  const now = new Date()
  const row: RunJournalRow = {
    id: (state.runRows.at(-1)?.id ?? 400) + 1,
    stage,
    status,
    pid: null,
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    finishedAt: now.toISOString(),
    inputCount: 0,
    okCount: 0,
    errorCount: 0,
    durationMs: 1000,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
  }
  state.runRows.push(row)
  return row
}

export function runPipeline(state: MockState): RunResult {
  const before = state.links.length
  // A demo pass: promote a few pending links to enriched.
  let promoted = 0
  for (const l of state.links) {
    if (promoted >= 5) break
    if (l.state === 'created' || l.state === 'extracting') {
      l.state = 'inbox'
      l.status = 'inbox'
      l.extracted_content = EXTRACTED
      l.category = l.category ?? pick(CATEGORIES)
      promoted++
    }
  }
  for (const stage of ['ingest', 'extract', 'enrich', 'sweep']) {
    const row = addRunRow(state, stage, 'done')
    row.inputCount = stage === 'enrich' ? before : Math.max(0, before - promoted)
    row.okCount = row.inputCount
    row.durationMs = 8_000 + Math.floor(rand() * 20_000)
    if (stage === 'enrich') {
      row.tokensIn = 12_000
      row.tokensOut = 3_400
      row.costUsd = 0.021
    }
  }
  const summary = collectionsSummary(state)
  const needsAction =
    (summary.collections.needs_login ?? 0) +
      (summary.collections.blocked ?? 0) +
      (summary.collections.errored ?? 0) +
      (summary.collections.review ?? 0) >
    0
  return {
    runId: `mock-run-${Date.now().toString(36)}`,
    cursorBefore: before,
    cursorAfter: state.links.length,
    summary: {
      ingest: { jobs: [] },
      extract: { input: before, ok: before - promoted, errors: 0, deferred: 0, needsBrowser: 0 },
      enrich: { input: before - promoted, ok: before - promoted - 1, errors: 1, deferred: 0 },
      swept: 0,
      needsAction,
      collections: summary as unknown as RunResult['summary']['collections'],
    },
  }
}

// ---- settings -----------------------------------------------------------------

export function browsers(): BrowserAdaptersResponse {
  return {
    adapters: [
      {
        id: 'headless',
        kind: 'agent-browser',
        roles: ['reader'],
        caps: { stealth: false, headless: true, persistentProfile: true },
        defaultFor: { reader: true, login: false },
        inEscalate: false,
        health: { ok: true, detail: 'chromium found' },
      },
      {
        id: 'stealth',
        kind: 'patchright',
        roles: ['reader', 'login'],
        caps: { stealth: true, headless: true, persistentProfile: true },
        defaultFor: { reader: false, login: false },
        inEscalate: true,
        health: { ok: true, detail: 'ok' },
      },
    ],
    hostMappings: { 'x.com': 'stealth', 'linkedin.com': 'stealth' },
    reader: 'headless',
    login: 'stealth',
    escalate: ['headless', 'stealth'],
  }
}

export function configInfo(): ConfigInfo {
  const dir = '~/.atento'
  return {
    dir,
    configPath: `${dir}/config.toml`,
    sources: ['~/exports/stash.md', '~/Documents/links.txt'],
    capture: {
      tokenEnv: 'ATENTO_CAPTURE_TOKEN',
      tokenConfigured: false,
      allowedOrigins: ['http://127.0.0.1:4173', 'http://localhost:4173'],
    },
    server: {
      tokenEnv: 'ATENTO_SERVER_TOKEN',
      tokenConfigured: false,
    },
    bind: {
      hostname: '127.0.0.1',
      port: 4173,
      tokenRequired: false,
    },
  }
}

// ---- metrics ------------------------------------------------------------------

export function metrics(): MetricsResponse {
  const stages = ['import', 'extract', 'enrich', 'metrics'].map((stage) => ({
    stage,
    runs: 4 + Math.floor(rand() * 20),
    ok: 20 + Math.floor(rand() * 200),
    errors: Math.floor(rand() * 12),
    p50_ms: 200 + Math.floor(rand() * 900),
    p95_ms: 1500 + Math.floor(rand() * 5000),
    tokens_in: Math.floor(rand() * 400000),
    tokens_out: Math.floor(rand() * 120000),
    cost_usd: Number((rand() * 40).toFixed(4)),
  }))
  const daily = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86_400_000)
    return {
      date: d.toISOString().slice(0, 10),
      tokens: 20_000 + Math.floor(rand() * 200_000),
      cost_usd: Number((rand() * 12).toFixed(4)),
    }
  })
  return { stages, daily }
}
