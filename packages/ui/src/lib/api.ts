import { QueryClient } from '@tanstack/svelte-query'
import type {
  LinkAction,
  LinkDetail,
  LinkStatus,
  LinkSummary,
  LinksResponse,
  MetricsResponse,
  SweepResponse,
  TriageResponse,
} from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`)
  return (await res.json()) as T
}

export interface LinkQuery {
  status?: LinkStatus | ''
  category?: string
  q?: string
  stale?: boolean
  limit?: number
  offset?: number
}

export function linksQueryString(q: LinkQuery): string {
  const p = new URLSearchParams()
  if (q.status) p.set('status', q.status)
  if (q.category) p.set('category', q.category)
  if (q.q) p.set('q', q.q)
  if (q.stale) p.set('stale', '1')
  if (q.limit != null) p.set('limit', String(q.limit))
  if (q.offset != null) p.set('offset', String(q.offset))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  links(q: LinkQuery) {
    return request<LinksResponse>(`/api/links${linksQueryString(q)}`)
  },
  link(id: number) {
    return request<LinkDetail>(`/api/links/${id}`)
  },
  triage(ids: number[], action: LinkAction) {
    return request<TriageResponse>('/api/links/triage', {
      method: 'POST',
      body: JSON.stringify({ ids, action } satisfies { ids: number[]; action: LinkAction }),
    })
  },
  sweep() {
    return request<SweepResponse>('/api/sweep')
  },
  sweepApply() {
    return request<{ archived: number }>('/api/sweep/apply', { method: 'POST' })
  },
  metrics(last = '7d') {
    return request<MetricsResponse>(`/api/metrics?last=${encodeURIComponent(last)}`)
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
