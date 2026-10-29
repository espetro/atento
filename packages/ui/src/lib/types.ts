export type LinkStatus = 'inbox' | 'scheduled' | 'archived' | 'discarded'
export type Priority = 'low' | 'normal' | 'high'
export type LinkAction = 'read_now' | 'schedule' | 'archive' | 'discard'

export interface LinkSummary {
  id: number
  title: string
  url: string
  category: string
  priority: Priority
  why_it_matters: string
  read_minutes: number
  status: LinkStatus
  expires_at: string | null
  expiry_reason: string | null
  action: LinkAction
}

export interface LinkDetail extends LinkSummary {
  extracted_content: string
  enrichment: Record<string, unknown>
  confidence: number
}

export interface LinksResponse {
  items: LinkSummary[]
  total: number
}

export interface SweepGroup {
  category: string
  links: LinkSummary[]
}

export interface SweepResponse {
  groups: SweepGroup[]
}

export interface StageMetrics {
  stage: string
  runs: number
  ok: number
  errors: number
  p50_ms: number
  p95_ms: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
}

export interface DailyMetrics {
  date: string
  tokens: number
  cost_usd: number
}

export interface MetricsResponse {
  stages: StageMetrics[]
  daily: DailyMetrics[]
}

export interface TriageRequest {
  ids: number[]
  action: LinkAction
}

export interface TriageResponse {
  updated: number
}
