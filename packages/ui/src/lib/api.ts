import { QueryClient } from '@tanstack/svelte-query'
import { m } from '../paraglide/messages.js'
import type {
  BrowserAdaptersResponse,
  CollectionsSummary,
  ConfigInfo,
  IngestJob,
  IngestJobSummary,
  LinkAction,
  LinkDetail,
  LinksResponse,
  MetricsResponse,
  PairCode,
  PairTokens,
  PipelineOverviewResponse,
  RunJournalRow,
  RunResult,
} from './types'

/** API failure carrying the HTTP status and the server's error string. */
export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = text
  }
  if (!res.ok) {
    const message =
      body !== null && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : m.api_error_fallback({ status: res.status, path })
    throw new ApiError(res.status, message, body)
  }
  return body as T
}

export interface LinkQuery {
  /** Pipeline collection filter (packages/core collections). */
  collection?: string
  status?: string
  category?: string
  q?: string
  stale?: boolean
  state?: string
  host?: string
  limit?: number
  offset?: number
}

export function linksQueryString(q: LinkQuery): string {
  const p = new URLSearchParams()
  if (q.collection) p.set('collection', q.collection)
  if (q.status) p.set('status', q.status)
  if (q.category) p.set('category', q.category)
  if (q.q) p.set('q', q.q)
  if (q.stale) p.set('stale', '1')
  if (q.state) p.set('state', q.state)
  if (q.host) p.set('host', q.host)
  if (q.limit != null) p.set('limit', String(q.limit))
  if (q.offset != null) p.set('offset', String(q.offset))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export type IngestInput =
  | { kind: 'urls'; urls: string[]; note?: string; tags?: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'remote'; url: string }
  | { kind: 'file'; path: string }

export const api = {
  links(q: LinkQuery) {
    return request<LinksResponse>(`/api/links${linksQueryString(q)}`)
  },
  collectionsSummary() {
    return request<CollectionsSummary>('/api/collections/summary')
  },
  pipeline() {
    return request<PipelineOverviewResponse>('/api/pipeline')
  },
  link(id: number) {
    return request<LinkDetail>(`/api/links/${id}`)
  },
  patchLink(id: number, patch: { title?: string | null; note?: string | null; tags?: string[] | null }) {
    return request<LinkDetail>(`/api/links/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  },
  triage(ids: number[], action: LinkAction) {
    return request<{ updated: number }>('/api/links/triage', {
      method: 'POST',
      body: JSON.stringify({ ids, action } satisfies { ids: number[]; action: LinkAction }),
    })
  },
  /** Restore parked (archived/discarded) links back to the inbox. */
  restore(ids: number[]) {
    return request<{ updated: number; missing: number[]; blocked: number[] }>(
      '/api/links/restore',
      { method: 'POST', body: JSON.stringify({ ids }) },
    )
  },
  reextract(id: number, options: { adapter?: string; limit?: number } = {}) {
    return request<{ ok: boolean; reason?: string }>(`/api/links/${id}/reextract`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },
  /** URL of one stored artifact (snapshot.png, ...); 404 means absent. */
  artifactUrl(id: number, name: string) {
    return `/api/links/${id}/artifacts/${encodeURIComponent(name)}`
  },
  /**
   * POST /api/ingest. `body` is a JSON IngestInput or FormData for file
   * uploads — the server picks the importer by content type.
   */
  ingest(body: IngestInput | FormData) {
    const isForm = body instanceof FormData
    return request<IngestJobSummary>('/api/ingest', {
      method: 'POST',
      ...(isForm ? { body } : { body: JSON.stringify(body) }),
      // FormData must not carry a JSON content-type; the boundary is set
      // by the browser. For JSON the header comes from request()'s default.
      ...(isForm ? { headers: {} } : {}),
    })
  },
  ingestJob(jobId: string) {
    return request<{ job: IngestJob }>(`/api/ingest/${encodeURIComponent(jobId)}`)
  },
  run() {
    return request<RunResult>('/api/run', { method: 'POST' })
  },
  runs(limit = 20) {
    return request<{ runs: RunJournalRow[] }>(`/api/runs?limit=${limit}`)
  },
  runJournal(id: number) {
    return request<RunJournalRow>(`/api/runs/${id}`)
  },
  metrics(last = '7d') {
    return request<MetricsResponse>(`/api/metrics?last=${encodeURIComponent(last)}`)
  },
  browsers() {
    return request<BrowserAdaptersResponse>('/api/browsers')
  },
  config() {
    return request<ConfigInfo>('/api/config')
  },
  pairCode() {
    return request<PairCode>('/api/pair/code')
  },
  pair(code: string) {
    return request<PairTokens>('/api/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
  },
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: 1,
      },
    },
  })
}
