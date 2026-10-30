import type {
  LinkSummary,
  LinksResponse,
  MetricsResponse,
  PipelineOverviewResponse,
  PipelineState,
  Priority,
  LinkStatus as Status,
  SweepResponse,
} from '../lib/types'
import { PIPELINE_STATES } from '../lib/types'

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
paragraph of prose so the detail drawer has something meaningful to render.

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

/** The reason a link sits in a non-happy pipeline state. */
const PIPELINE_REASONS: Record<string, string> = {
  needs_browser: 'login_wall',
  deferred: 'throttled',
  errored: 'private_404',
  created: 'queued',
}

function makeLink(id: number): LinkSummary & { confidence: number; extracted_content: string } {
  const priority: Priority = pick(['low', 'normal', 'high'] as const)
  const status: Status =
    id <= 100 ? 'inbox' : pick(['inbox', 'inbox', 'scheduled', 'archived', 'discarded'] as const)
  const ageDays = Math.floor(rand() * 120)
  const expires = new Date(Date.now() - ageDays * 86_400_000)
  const hasExpiry = rand() > 0.25
  const minutes = 1 + Math.floor(rand() * 25)
  // The pipeline state mirrors the legacy status for the triage states; the
  // rest are the mid-pipeline states the Pipeline tab exists to show.
  const state: PipelineState =
    id % 11 === 0
      ? pick(['needs_browser', 'deferred', 'errored', 'created', 'extracting'] as const)
      : status === 'archived'
        ? 'archived'
        : status === 'discarded'
          ? 'discarded'
          : status === 'scheduled'
            ? 'scheduled'
            : 'inbox'
  const url = `${pick(DOMAINS)}/${pick(TITLES).toLowerCase().replace(/[^a-z]+/g, '-')}/${id}`
  return {
    id,
    title: `${pick(TITLES)} (${id})`,
    url,
    category: pick(CATEGORIES),
    priority,
    why_it_matters: pick(WHYS),
    read_minutes: minutes,
    status,
    expires_at: hasExpiry ? expires.toISOString() : null,
    expiry_reason: hasExpiry ? pick(REASONS) : null,
    action: pick(['read_now', 'schedule', 'archive', 'discard'] as const),
    confidence: Number((0.55 + rand() * 0.45).toFixed(3)),
    extracted_content: EXTRACTED.replace('the mock link inbox', `mock link inbox #${id}`),
    state,
    reason: PIPELINE_REASONS[state] ?? null,
    host: new URL(url).host,
    next_attempt_at:
      state === 'deferred'
        ? new Date(Date.now() + Math.floor(rand() * 3_600_000)).toISOString()
        : null,
    updated_at: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
  }
}

export interface MockState {
  links: (LinkSummary & { confidence: number; extracted_content: string })[]
}

export function createMockState(count = 128): MockState {
  return { links: Array.from({ length: count }, (_, i) => makeLink(i + 1)) }
}

export function listLinks(state: MockState, params: URLSearchParams): LinksResponse {
  const status = params.get('status')
  const category = params.get('category')
  const pipelineState = params.get('state')
  const host = params.get('host')
  const q = params.get('q')?.toLowerCase() ?? ''
  const stale = params.get('stale') === '1' || params.get('stale') === 'true'
  const limit = Number(params.get('limit') ?? 50)
  const offset = Number(params.get('offset') ?? 0)
  const now = Date.now()

  let items = state.links.filter((l) => {
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

/** The pipeline overview: the state histogram plus the busiest hosts. */
export function pipelineOverview(state: MockState): PipelineOverviewResponse {
  const byState = Object.fromEntries(PIPELINE_STATES.map((s) => [s, 0])) as Record<
    PipelineState,
    number
  >
  const hosts = new Map<string, { total: number; byState: Record<PipelineState, number> }>()
  for (const link of state.links) {
    const s = link.state ?? 'inbox'
    byState[s] = (byState[s] ?? 0) + 1
    const host = link.host ?? ''
    if (host === '') continue
    const row = hosts.get(host) ?? {
      total: 0,
      byState: Object.fromEntries(PIPELINE_STATES.map((x) => [x, 0])) as Record<
        PipelineState,
        number
      >,
    }
    row.total += 1
    row.byState[s] = (row.byState[s] ?? 0) + 1
    hosts.set(host, row)
  }
  return {
    byState,
    byHost: [...hosts.entries()]
      .map(([host, row]) => ({ host, total: row.total, byState: row.byState }))
      .sort((a, b) => b.total - a.total || a.host.localeCompare(b.host))
      .slice(0, 50),
  }
}

export function sweep(state: MockState): SweepResponse {
  const now = Date.now()
  const expired = state.links.filter(
    (l) => l.expires_at && new Date(l.expires_at).getTime() < now && l.status !== 'archived' && l.status !== 'discarded',
  )
  const byCategory = new Map<string, LinkSummary[]>()
  for (const l of expired) {
    const list = byCategory.get(l.category) ?? []
    list.push(l)
    byCategory.set(l.category, list)
  }
  return {
    groups: [...byCategory.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, links]) => ({ category, links })),
  }
}

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
